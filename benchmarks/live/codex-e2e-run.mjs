#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { auditMetadata, digestPrompt } from '../lib/audit.mjs';
import { assertQualityGate, summarizeRuns } from '../lib/metrics.mjs';
import { formatChildFailure, parseCodexUsage } from './adapters.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CODEX_TOOL_MEASUREMENT = 'end-to-end-tools';
export const MAX_REPETITIONS = 15;
const REQUIRED_FACTS = ['SANDO_AB_HEAD_FACT', 'SANDO_AB_TAIL_FACT'];
const FIXTURE_COMMAND = "printf 'SANDO_AB_HEAD_FACT\\n'; i=0; while [ \"$i\" -lt 1100 ]; do printf 'noise:%s\\n' \"$i\"; i=$((i+1)); done; printf 'SANDO_AB_TAIL_FACT\\n'";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function validateRepetitions(value) {
  const repetitions = Number(value);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) {
    throw new Error(`--repetitions must be 1..${MAX_REPETITIONS}`);
  }
  return repetitions;
}

export function buildCodexToolArgs({ prompt, model, optimized, serverPath }) {
  if (typeof prompt !== 'string' || !prompt) throw new TypeError('prompt is required');
  const args = [
    'exec', ...(model ? ['--model', model] : []), '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--skip-git-repo-check', '--approve-for-me', '--json',
  ];
  if (optimized) {
    if (typeof serverPath !== 'string' || !path.isAbsolute(serverPath)) throw new TypeError('absolute MCP server path is required');
    args.push('-c', 'mcp_servers.sando.command="node"', '-c', `mcp_servers.sando.args=${JSON.stringify([serverPath])}`);
  }
  args.push(prompt);
  return args;
}

function runCommand(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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

function toolOutputHasFacts(stdout, variant) {
  return contains(jsonDocuments(stdout), (value) => {
    const text = typeof value.aggregated_output === 'string'
      ? value.aggregated_output
      : JSON.stringify(value.result ?? '');
    const isTool = variant === 'optimized'
      ? ['mcp_tool_call', 'mcp_tool_call_output'].includes(value.type) && (value.name === 'sando_exec' || value.tool === 'sando_exec')
      : value.type === 'command_execution' || value.item?.type === 'command_execution';
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

function promptFor({ variant }) {
  const command = FIXTURE_COMMAND;
  const route = variant === 'optimized'
    ? `Use the Sando MCP tool sando_exec exactly once with command ${JSON.stringify(command)} and workdir ".". Do not use the built-in shell.`
    : `Use the built-in shell tool exactly once to run ${JSON.stringify(command)}. Do not use MCP tools.`;
  return [
    'This is a paired token-accounting benchmark.',
    route,
    `After the tool result, return exactly JSON with status "ok" and facts containing ${REQUIRED_FACTS.join(' and ')}. Do not include any other keys or repeat the tool output.`,
  ].join('\n');
}

function runEvidence({ variant, stdout }) {
  const facts = finalFacts(stdout);
  const pathPass = variant === 'optimized' ? usedTool(stdout, 'sando_exec') : usedBuiltinShell(stdout);
  const resultPass = toolOutputHasFacts(stdout, variant);
  const modelVisibleQuality = facts?.status === 'ok' && Array.isArray(facts.facts)
    && REQUIRED_FACTS.every((fact) => facts.facts.includes(fact)) ? 'pass' : 'fail';
  return {
    modelVisibleQuality,
    artifactResolvable: true,
    secretLeak: false,
    toolPath: pathPass ? (variant === 'optimized' ? 'sando_exec' : 'builtin-shell') : 'missing',
    quality: modelVisibleQuality === 'pass' && pathPass && resultPass ? 'pass' : 'fail',
  };
}

function failedRun({ variant, repetition, prompt, args, result, clientVersion, scenarioDigest, message }) {
  const audit = auditMetadata({
    host: 'codex', variant, prompt, args, result, clientVersion, scenarioDigest,
    measurement: { mode: CODEX_TOOL_MEASUREMENT, hookEndToEnd: true, toolPath: 'missing' }, cwd: ROOT,
  });
  audit.tokenAccounting = { source: 'provider-reported', providerObserved: false };
  return {
    host: 'codex', scenario: 'codex-tool-noise', scenarioDigest, repetition, variant,
    resolvedModel: null, clientVersion, measurement: CODEX_TOOL_MEASUREMENT, tokenAccounting: 'provider-reported',
    providerUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    quality: 'fail', modelVisibleQuality: 'fail', artifactResolvable: false, secretLeak: null,
    promptDigest: audit.promptDigest, audit, error: message,
  };
}

async function runVariant({ variant, repetition, workspace, serverPath, model, timeoutMs, clientVersion }) {
  const prompt = promptFor({ variant });
  const args = buildCodexToolArgs({ prompt, model, optimized: variant === 'optimized', serverPath });
  const started = Date.now();
  const result = await runCommand('codex', args, { cwd: workspace, timeoutMs });
  const scenarioDigest = digestPrompt(FIXTURE_COMMAND);
  const audit = auditMetadata({
    host: 'codex', variant, prompt, args, result, clientVersion, scenarioDigest,
    measurement: { mode: CODEX_TOOL_MEASUREMENT, hookEndToEnd: true, toolPath: variant === 'optimized' ? 'sando_exec' : 'builtin-shell' }, cwd: ROOT,
  });
  if (result.code !== 0) return failedRun({ variant, repetition, prompt, args, result, clientVersion, scenarioDigest, message: formatChildFailure('codex', variant, result) });
  const usage = parseCodexUsage(result.stdout);
  if (!usage) return failedRun({ variant, repetition, prompt, args, result, clientVersion, scenarioDigest, message: 'Codex returned no provider usage' });
  audit.resolvedModel = usage.resolvedModel ?? model ?? null;
  audit.tokenAccounting = { source: 'provider-reported', providerObserved: true };
  const evidence = runEvidence({ variant, stdout: result.stdout });
  return {
    host: 'codex', scenario: 'codex-tool-noise', scenarioDigest, repetition, variant,
    resolvedModel: usage.resolvedModel ?? model ?? null, clientVersion, measurement: CODEX_TOOL_MEASUREMENT,
    tokenAccounting: 'provider-reported', providerUsage: usage, inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, latencyMs: Date.now() - started,
    ...evidence, promptDigest: audit.promptDigest, audit,
  };
}

export async function runCodexToolBenchmark({ outputPath, model, repetitions, timeoutMs = 120_000, serverPath = path.join(ROOT, 'plugins/sando/mcp/server.mjs') }) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sando-codex-e2e-'));
  const version = await runCommand('codex', ['--version'], { cwd: ROOT, timeoutMs: 10_000 });
  const clientVersion = version.stdout.trim().split('\n').find(Boolean) ?? 'unresolved';
  const runs = [];
  try {
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (const variant of ['baseline', 'optimized']) {
        const run = await runVariant({ variant, repetition, workspace, serverPath, model, timeoutMs, clientVersion });
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
      scenario: 'codex-tool-noise', repetitions, audit: { measurement: { mode: CODEX_TOOL_MEASUREMENT, hookEndToEnd: true, toolPaths: ['builtin-shell', 'sando_exec'] }, tokenAccounting: { source: 'provider-reported', providerObserved: true } },
      runs, summary: failure ? null : summarizeRuns(runs), ...(failure ? { failure } : {}),
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    return output;
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
}

async function main() {
  if (!process.argv.includes('--confirm-cost')) throw new Error('Codex live E2E benchmark requires --confirm-cost');
  const outputPath = path.resolve(option('out', path.join(ROOT, 'benchmarks/results/live-codex-tools.json')));
  const output = await runCodexToolBenchmark({
    outputPath, model: option('model'), repetitions: validateRepetitions(option('repetitions', '1')),
    timeoutMs: Number(option('timeout-ms', '120000')), serverPath: path.resolve(option('server-path', path.join(ROOT, 'plugins/sando/mcp/server.mjs'))),
  });
  process.stdout.write(`${JSON.stringify({ outputPath, status: output.status, summary: output.summary }, null, 2)}\n`);
  if (output.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`Codex live E2E benchmark: ${error.message}\n`); process.exitCode = 1; });
}
