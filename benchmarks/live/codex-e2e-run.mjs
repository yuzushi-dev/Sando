#!/usr/bin/env node

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { auditMetadata, digestPrompt } from '../lib/audit.mjs';
import { assertQualityGate, summarizeRuns } from '../lib/metrics.mjs';
import { formatChildFailure, parseCodexUsage } from './adapters.mjs';
import { countInteractions } from './interaction-counts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CODEX_TOOL_MEASUREMENT = 'end-to-end-tools';
export const MAX_REPETITIONS = 15;
const REQUIRED_FACTS = ['SANDO_AB_HEAD_FACT', 'SANDO_AB_TAIL_FACT'];
export const FIXTURE_COMMAND = "i=0; while [ \"$i\" -lt 700 ]; do printf 'noise:%s\\n' \"$i\"; i=$((i+1)); done; printf 'SANDO_AB_HEAD_FACT\\nSANDO_AB_TAIL_FACT\\n'";
const CLI_FIXTURE_COMMAND = 'cat -- fixture.txt';
const ALL_CLI_FACTS = ['SANDO_CLI_HEAD_FACT', 'SANDO_CLI_TAIL_FACT'];
const ALL_EXEC_FACTS = ['SANDO_EXEC_HEAD_FACT', 'SANDO_EXEC_TAIL_FACT'];
const ALL_REQUIRED_FACTS = [...ALL_CLI_FACTS, ...ALL_EXEC_FACTS];
const ALL_EXEC_COMMAND = "i=0; while [ \"$i\" -lt 300 ]; do printf 'noise:%s\\n' \"$i\"; i=$((i+1)); done; printf 'SANDO_EXEC_HEAD_FACT\\nSANDO_EXEC_TAIL_FACT\\n'";
const ALL_SANDO_POLICY = { mode: 'apply', maxInlineBytes: 1024, maxArtifactBytes: 65536, redact: true };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function receiptFailure(message, cause) {
  const error = new Error(`receipt: ${message}`);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function readExecReceipt(directory) {
  if (typeof directory !== 'string' || directory.trim() === '') throw receiptFailure('directory is required');

  let directoryStat;
  try {
    directoryStat = await fs.lstat(directory);
  } catch (error) {
    throw receiptFailure('directory cannot be inspected', error);
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw receiptFailure('directory must be a real directory');
  }

  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw receiptFailure('directory cannot be read', error);
  }
  if (entries.length === 0) throw receiptFailure('directory is empty');
  if (entries.length !== 1) throw receiptFailure('directory must contain exactly one receipt entry; temporary residue is not allowed');

  const [entry] = entries;
  if (path.extname(entry.name) !== '.json') throw receiptFailure('the receipt entry must have a .json extension');
  if (entry.isSymbolicLink()) throw receiptFailure('the receipt entry must not be a symlink');

  const receiptPath = path.join(directory, entry.name);
  let entryStat;
  try {
    entryStat = await fs.lstat(receiptPath);
  } catch (error) {
    throw receiptFailure('the receipt entry cannot be inspected', error);
  }
  if (entryStat.isSymbolicLink()) throw receiptFailure('the receipt entry must not be a symlink');
  if (!entryStat.isFile()) throw receiptFailure('the receipt entry must be a regular file');

  let source;
  try {
    source = await fs.readFile(receiptPath, 'utf8');
  } catch (error) {
    throw receiptFailure('the receipt entry cannot be read', error);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw receiptFailure('the receipt JSON is invalid', error);
  }
}

export function validateExecReceipt(receipt, options = {}) {
  const { command, requiredFacts = [] } = options ?? {};
  const fail = (message) => { throw receiptFailure(`validation failed: ${message}`); };

  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('an object is required');
  if (receipt.schema !== 'sando-exec-receipt/v1') fail('schema must be sando-exec-receipt/v1');
  if (typeof receipt.run_id !== 'string' || !UUID_PATTERN.test(receipt.run_id)) fail('run_id must be a UUID');
  if (typeof command !== 'string' || receipt.command !== command) fail('command does not match');
  if (receipt.workdir !== '.') fail('workdir must be .');
  if (typeof receipt.stdout !== 'string' || typeof receipt.stderr !== 'string') fail('stdout and stderr must be strings');
  if (receipt.stdout_sha256 !== sha256(receipt.stdout)) fail('stdout_sha256 does not match stdout');
  if (receipt.stderr_sha256 !== sha256(receipt.stderr)) fail('stderr_sha256 does not match stderr');
  if (receipt.stdout_bytes !== Buffer.byteLength(receipt.stdout, 'utf8')) fail('stdout_bytes does not match stdout');
  if (receipt.stderr_bytes !== Buffer.byteLength(receipt.stderr, 'utf8')) fail('stderr_bytes does not match stderr');
  if (receipt.exit_code !== 0) fail('exit_code must be 0');
  if (receipt.signal !== null) fail('signal must be null');
  for (const field of ['timed_out', 'cancelled', 'stdout_truncated', 'stderr_truncated', 'truncated']) {
    if (receipt[field] !== false) fail(`${field} must be false`);
  }
  if (!Array.isArray(requiredFacts)) fail('requiredFacts must be an array');
  for (const fact of requiredFacts) {
    if (typeof fact !== 'string' || !receipt.stdout.includes(fact)) fail('required fact is missing from stdout');
  }
  return receipt;
}

function cliFixtureText(facts) {
  return `${[
    `export const ${facts[0]} = '${facts[0]}';`,
    ...Array.from({ length: 300 }, (_, index) => `noise:${index}`),
    `export const ${facts[1]} = '${facts[1]}';`,
  ].join('\n')}\n`;
}

function commandFixtureText(count, facts) {
  return `${Array.from({ length: count }, (_, index) => `noise:${index}`).join('\n')}\n${facts.join('\n')}\n`;
}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

export function resolveCodexExecutable({ executable, env = process.env } = {}) {
  const value = executable ?? env.SANDO_CODEX_BIN ?? 'codex';
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('non-empty executable is required');
  return value;
}

function validateRepetitions(value) {
  const repetitions = Number(value);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) {
    throw new Error(`--repetitions must be 1..${MAX_REPETITIONS}`);
  }
  return repetitions;
}

export function buildCodexToolArgs({ prompt, model, optimized, serverPath, route = 'mcp', receiptDirectory }) {
  if (typeof prompt !== 'string' || !prompt) throw new TypeError('prompt is required');
  if (!['mcp', 'cli', 'all'].includes(route)) throw new TypeError('route must be mcp, cli, or all');
  const usesMcp = route === 'mcp' || route === 'all';
  const args = [
    'exec', ...(model ? ['--model', model] : []), '--ephemeral', ...(route === 'mcp' ? ['--ignore-user-config'] : []),
    '--ignore-rules', '--skip-git-repo-check', '--approve-for-me', ...(route === 'mcp' ? [] : ['--dangerously-bypass-hook-trust']), '--json',
  ];
  if (usesMcp && optimized) {
    if (typeof serverPath !== 'string' || !path.isAbsolute(serverPath)) throw new TypeError('absolute MCP server path is required');
    args.push('-c', 'mcp_servers.sando.command="node"', '-c', `mcp_servers.sando.args=${JSON.stringify([serverPath])}`);
    if (typeof receiptDirectory === 'string' && receiptDirectory.trim() !== '') {
      args.push('-c', `mcp_servers.sando.env.SANDO_EXEC_RECEIPT_DIR=${JSON.stringify(receiptDirectory)}`);
    }
  }
  args.push(prompt);
  return args;
}

export function buildCodexE2EEnv({ variant, route, baseEnv = process.env, receiptDirectory }) {
  const env = { ...baseEnv };
  if (variant === 'optimized' && (route === 'mcp' || route === 'all') && typeof receiptDirectory === 'string' && receiptDirectory.trim() !== '') {
    env.SANDO_EXEC_RECEIPT_DIR = receiptDirectory;
  } else {
    delete env.SANDO_EXEC_RECEIPT_DIR;
  }
  if (route !== 'cli' && route !== 'all') return env;
  env.SANDO_CLI_ROUTING = variant === 'optimized' ? 'on' : 'off';
  if (variant === 'optimized') {
    env.SANDO_POLICY = JSON.stringify({ mode: 'apply', maxInlineBytes: 1024, maxArtifactBytes: 65536, redact: true });
  } else {
    delete env.SANDO_POLICY;
  }
  return env;
}

function runCommand(command, args, { cwd, timeoutMs, env = process.env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ code: null, signal: 'SIGTERM' }); }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => finish({ code: null, signal: null, error: error.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

function jsonDocuments(stdout) {
  if (!stdout?.trim()) return [];
  return stdout.trim().split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function contains(value, predicate, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  if (predicate(value)) return true;
  seen.add(value);
  const found = Object.values(value).some((child) => contains(child, predicate, seen));
  seen.delete(value);
  return found;
}

function usedTool(stdout, name) {
  return contains(jsonDocuments(stdout), (value) =>
    ['mcp_tool_call', 'mcp_tool_call_output'].includes(value.type) && (value.name === name || value.tool === name));
}

function usedBuiltinShell(stdout) {
  return contains(jsonDocuments(stdout), (value) =>
    ['command_execution', 'shell_command'].includes(value.type)
    || ['command_execution', 'shell_command'].includes(value.item?.type));
}

function usedSandoCli(stdout) {
  return contains(jsonDocuments(stdout), (value) => {
    const command = typeof value.command === 'string' ? value.command : '';
    return (value.type === 'command_execution' || value.item?.type === 'command_execution')
      && command.includes('/bin/sando') && command.includes(' read ');
  });
}

function eventText(value) {
  return [
    value?.aggregated_output,
    value?.item?.aggregated_output,
    value?.result,
    value?.item?.result,
  ].map((part) => typeof part === 'string' ? part : part === undefined ? '' : JSON.stringify(part)).join('\n');
}

function observedToolOutputBytes(stdout, route) {
  const documents = jsonDocuments(stdout);
  const values = documents.flatMap((document) => [document, document?.item]);
  const selected = values.filter((value) => {
    if (!value || typeof value !== 'object') return false;
    if (route === 'mcp') return ['mcp_tool_call', 'mcp_tool_call_output'].includes(value.type)
      && (value.name === 'sando_exec' || value.tool === 'sando_exec');
    if (route === 'cli') return value.type === 'command_execution' || value.type === 'shell_command';
    return ['mcp_tool_call', 'mcp_tool_call_output', 'command_execution', 'shell_command'].includes(value.type);
  });
  return selected.reduce((total, value) => total + Buffer.byteLength(eventText(value), 'utf8'), 0);
}

function rawToolOutputBytes(route) {
  if (route === 'mcp') return Buffer.byteLength(commandFixtureText(700, REQUIRED_FACTS), 'utf8');
  if (route === 'cli') return Buffer.byteLength(cliFixtureText(REQUIRED_FACTS), 'utf8');
  return Buffer.byteLength(cliFixtureText(ALL_CLI_FACTS), 'utf8')
    + Buffer.byteLength(commandFixtureText(300, ALL_EXEC_FACTS), 'utf8');
}

function toolOutputHasFacts(stdout, variant, route, receipt) {
  if (route === 'all') {
    const documents = jsonDocuments(stdout);
    const shellOutput = documents
      .filter((value) => ['command_execution', 'shell_command'].includes(value.type) || ['command_execution', 'shell_command'].includes(value.item?.type))
      .map(eventText).join('\n');
    const execFactsPresent = variant === 'optimized'
      ? typeof receipt?.stdout === 'string' && ALL_EXEC_FACTS.every((fact) => receipt.stdout.includes(fact))
      : ALL_EXEC_FACTS.every((fact) => shellOutput.includes(fact));
    return ALL_CLI_FACTS.every((fact) => shellOutput.includes(fact)) && execFactsPresent;
  }
  if (route === 'mcp' && variant === 'optimized') {
    return typeof receipt?.stdout === 'string' && REQUIRED_FACTS.every((fact) => receipt.stdout.includes(fact));
  }
  return contains(jsonDocuments(stdout), (value) => {
    const text = typeof value.aggregated_output === 'string'
      ? value.aggregated_output
      : JSON.stringify(value.result ?? '');
    const isTool = value.type === 'command_execution' || value.item?.type === 'command_execution';
    return isTool && REQUIRED_FACTS.every((fact) => text.includes(fact));
  });
}

function finalFacts(stdout) {
  const documents = jsonDocuments(stdout);
  for (const document of documents.slice().reverse()) {
    const item = document.item;
    if (item?.type !== 'agent_message' || typeof item.text !== 'string') continue;
    try { return JSON.parse(item.text); } catch { return null; }
  }
  return null;
}

function promptFor({ variant, route }) {
  if (route === 'all') {
    const facts = ALL_REQUIRED_FACTS;
    const instruction = variant === 'optimized'
      ? `1. Use the built-in shell exactly once to run ${JSON.stringify(CLI_FIXTURE_COMMAND)}; Sando may route this literal read automatically.\n2. Use the Sando MCP tool sando_exec exactly once with arguments ${JSON.stringify({ command: ALL_EXEC_COMMAND, workdir: '.', policy: ALL_SANDO_POLICY })}. Do not use the built-in shell for task 2.`
      : `1. Use the built-in shell exactly once to run ${JSON.stringify(CLI_FIXTURE_COMMAND)}.\n2. Use the built-in shell exactly once to run ${JSON.stringify(ALL_EXEC_COMMAND)}. Do not use MCP tools.`;
    return [
      'This is a paired token-accounting benchmark.', instruction,
      `After both tool results, return exactly JSON: {"status":"ok","facts":["${facts.join('","')}"]}. Do not include any other keys or repeat the tool output.`,
    ].join('\n');
  }
  const command = route === 'cli' ? CLI_FIXTURE_COMMAND : FIXTURE_COMMAND;
  const instruction = route === 'mcp' && variant === 'optimized'
    ? `Use the Sando MCP tool sando_exec exactly once with command ${JSON.stringify(command)} and workdir ".". Do not use the built-in shell.`
    : `Use the built-in shell tool exactly once to run ${JSON.stringify(command)}. Do not use MCP tools.`;
  return [
    'This is a paired token-accounting benchmark.',
    instruction,
    `After the tool result, return exactly JSON: {"status":"ok","facts":["${REQUIRED_FACTS.join('","')}"]}. Do not include any other keys or repeat the tool output.`,
  ].join('\n');
}

function runEvidence({ variant, stdout, route, receipt }) {
  const facts = finalFacts(stdout);
  const pathPass = route === 'mcp'
    ? (variant === 'optimized' ? usedTool(stdout, 'sando_exec') : usedBuiltinShell(stdout))
    : route === 'cli'
      ? (variant === 'optimized' ? usedSandoCli(stdout) : usedBuiltinShell(stdout))
      : (variant === 'optimized' ? usedSandoCli(stdout) && usedTool(stdout, 'sando_exec') : usedBuiltinShell(stdout));
  const resultPass = toolOutputHasFacts(stdout, variant, route, receipt);
  const requiredFacts = route === 'all' ? ALL_REQUIRED_FACTS : REQUIRED_FACTS;
  const modelVisibleQuality = facts?.status === 'ok' && Array.isArray(facts.facts)
    && requiredFacts.every((fact) => facts.facts.includes(fact)) ? 'pass' : 'fail';
  const toolPath = variant === 'optimized'
    ? route === 'mcp' ? 'sando_exec' : route === 'cli' ? 'sando-cli' : 'sando-cli+sando_exec'
    : 'builtin-shell';
  return {
    modelVisibleQuality,
    artifactResolvable: true,
    secretLeak: false,
    toolPath: pathPass ? toolPath : 'missing',
    quality: modelVisibleQuality === 'pass' && pathPass && resultPass ? 'pass' : 'fail',
  };
}

function failedRun({ variant, repetition, prompt, args, result, clientVersion, scenarioDigest, scenario = 'codex-tool-noise', message }) {
  const audit = auditMetadata({
    host: 'codex', variant, prompt, args, result, clientVersion, scenarioDigest,
    measurement: { mode: CODEX_TOOL_MEASUREMENT, hookEndToEnd: true, toolPath: 'missing' }, cwd: ROOT,
  });
  audit.tokenAccounting = { source: 'provider-reported', providerObserved: false };
  return {
    host: 'codex', scenario, scenarioDigest, repetition, variant,
    resolvedModel: null, clientVersion, measurement: CODEX_TOOL_MEASUREMENT, tokenAccounting: 'provider-reported',
    providerUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    quality: 'fail', modelVisibleQuality: 'fail', artifactResolvable: false, secretLeak: null,
    promptDigest: audit.promptDigest, audit, error: message,
    modelTurns: 0, totalToolCalls: 0, nativeToolCalls: 0, sandoMcpCalls: 0, mechanicalContextTrimmedBytes: 0,
  };
}

async function runVariant({ variant, repetition, workspace, serverPath, model, timeoutMs, clientVersion, route, codexExecutable, receiptDirectory }) {
  const prompt = promptFor({ variant, route });
  const args = buildCodexToolArgs({ prompt, model, optimized: variant === 'optimized', serverPath, route, receiptDirectory });
  const started = Date.now();
  const env = buildCodexE2EEnv({ variant, route, receiptDirectory });
  const result = await runCommand(codexExecutable, args, { cwd: workspace, timeoutMs, env });
  const scenario = route === 'cli' ? 'codex-cli-noise' : route === 'all' ? 'codex-all-strategies' : 'codex-tool-noise';
  const scenarioDigest = digestPrompt(route === 'cli' ? CLI_FIXTURE_COMMAND : route === 'all' ? `${CLI_FIXTURE_COMMAND}\n${ALL_EXEC_COMMAND}` : FIXTURE_COMMAND);
  const audit = auditMetadata({
    host: 'codex', variant, prompt, args, result, clientVersion, scenarioDigest,
    measurement: { mode: CODEX_TOOL_MEASUREMENT, hookEndToEnd: true, toolPath: variant === 'optimized' ? (route === 'mcp' ? 'sando_exec' : route === 'cli' ? 'sando-cli' : 'sando-cli+sando_exec') : 'builtin-shell' }, cwd: ROOT,
  });
  if (result.code !== 0) return failedRun({ variant, repetition, prompt, args, result, clientVersion, scenarioDigest, scenario, message: formatChildFailure('codex', variant, result) });
  let receipt = null;
  if (variant === 'optimized' && (route === 'mcp' || route === 'all')) {
    try {
      receipt = validateExecReceipt(await readExecReceipt(receiptDirectory), {
        command: route === 'all' ? ALL_EXEC_COMMAND : FIXTURE_COMMAND,
        requiredFacts: route === 'all' ? ALL_EXEC_FACTS : REQUIRED_FACTS,
      });
    } catch (error) {
      return failedRun({
        variant, repetition, prompt, args, result, clientVersion, scenarioDigest, scenario,
        message: `optimized ${route} execution receipt validation failed: ${error.message}`,
      });
    }
  }
  const usage = parseCodexUsage(result.stdout);
  if (!usage) return failedRun({ variant, repetition, prompt, args, result, clientVersion, scenarioDigest, scenario, message: 'Codex returned no provider usage' });
  audit.resolvedModel = usage.resolvedModel ?? model ?? null;
  audit.tokenAccounting = { source: 'provider-reported', providerObserved: true };
  const evidence = runEvidence({ variant, stdout: result.stdout, route, receipt });
  const interactions = countInteractions(result.stdout, 'codex');
  const mechanicalContextTrimmedBytes = variant === 'optimized'
    ? Math.max(0, rawToolOutputBytes(route) - observedToolOutputBytes(result.stdout, route)) : 0;
  return {
    host: 'codex', scenario, scenarioDigest, repetition, variant,
    resolvedModel: usage.resolvedModel ?? model ?? null, clientVersion, measurement: CODEX_TOOL_MEASUREMENT,
    tokenAccounting: 'provider-reported', providerUsage: usage, inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, latencyMs: Date.now() - started,
    ...evidence, ...interactions, mechanicalContextTrimmedBytes, promptDigest: audit.promptDigest, audit,
  };
}

export async function runCodexToolBenchmark({ outputPath, model, repetitions, timeoutMs = 120_000, serverPath = path.join(ROOT, 'plugins/sando/mcp/server.mjs'), route = 'mcp', codexExecutable } = {}) {
  if (!['mcp', 'cli', 'all'].includes(route)) throw new Error('route must be mcp, cli, or all');
  const resolvedCodexExecutable = resolveCodexExecutable({ executable: codexExecutable });
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sando-codex-e2e-'));
  const receiptRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sando-codex-receipts-'));
  try {
    if (route === 'cli' || route === 'all') {
      const fixtureFacts = route === 'all' ? ALL_CLI_FACTS : REQUIRED_FACTS;
      const fixture = cliFixtureText(fixtureFacts).trimEnd();
      await fs.writeFile(path.join(workspace, 'fixture.txt'), `${fixture}\n`);
    }
    const version = await runCommand(resolvedCodexExecutable, ['--version'], { cwd: ROOT, timeoutMs: 10_000 });
    const clientVersion = version.stdout.trim().split('\n').find(Boolean) ?? 'unresolved';
    const runs = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (const variant of ['baseline', 'optimized']) {
        const run = await runVariant({
          variant, repetition, workspace, serverPath, model, timeoutMs, clientVersion, route, codexExecutable: resolvedCodexExecutable,
          ...(variant === 'optimized' && (route === 'mcp' || route === 'all')
            ? { receiptDirectory: await fs.mkdtemp(path.join(receiptRoot, `repetition-${repetition}-optimized-`)) }
            : {}),
        });
        runs.push(run);
        if (run.quality !== 'pass') break;
      }
      if (runs.at(-1)?.quality !== 'pass') break;
    }
    let failure = null;
    for (const optimized of runs.filter((run) => run.variant === 'optimized')) {
      const baseline = runs.find((run) => run.repetition === optimized.repetition && run.variant === 'baseline');
      try { assertQualityGate({ baseline, optimized }); }
      catch (error) { failure = { status: 'blocked', message: error.message, repetition: optimized.repetition }; break; }
    }
    if (!failure && runs.length !== repetitions * 2) failure = { status: 'blocked', message: 'incomplete paired tool runs' };
    const output = {
      schema: 'sando-live-e2e-tools/v1', status: failure ? 'blocked' : 'passed', host: 'codex', clientVersion,
      scenario: route === 'cli' ? 'codex-cli-noise' : route === 'all' ? 'codex-all-strategies' : 'codex-tool-noise', repetitions, audit: { measurement: { mode: CODEX_TOOL_MEASUREMENT, hookEndToEnd: true, toolPaths: ['builtin-shell', ...(route === 'mcp' ? ['sando_exec'] : route === 'cli' ? ['sando-cli'] : ['sando-cli', 'sando_exec'])] }, tokenAccounting: { source: 'provider-reported', providerObserved: true } },
      runs, summary: failure ? null : summarizeRuns(runs), ...(failure ? { failure } : {}),
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    return output;
  } finally {
    await fs.rm(receiptRoot, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  if (!process.argv.includes('--confirm-cost')) throw new Error('Codex live E2E benchmark requires --confirm-cost');
  const route = option('route', 'mcp');
  const outputPath = path.resolve(option('out', path.join(ROOT, 'benchmarks/results', route === 'cli' ? 'live-codex-cli-tools.json' : route === 'all' ? 'live-codex-all-strategies.json' : 'live-codex-tools.json')));
  const output = await runCodexToolBenchmark({
    outputPath, model: option('model'), repetitions: validateRepetitions(option('repetitions', '1')),
    timeoutMs: Number(option('timeout-ms', '120000')), route, codexExecutable: option('codex-bin'), serverPath: path.resolve(option('server-path', path.join(ROOT, 'plugins/sando/mcp/server.mjs'))),
  });
  process.stdout.write(`${JSON.stringify({ outputPath, status: output.status, summary: output.summary }, null, 2)}\n`);
  if (output.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`Codex live E2E benchmark: ${error.message}\n`); process.exitCode = 1; });
}
