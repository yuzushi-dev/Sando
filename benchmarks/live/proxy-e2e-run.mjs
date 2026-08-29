#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { auditMetadata, digestPrompt } from '../lib/audit.mjs';
import { assertQualityGate, summarizeRuns } from '../lib/metrics.mjs';
import { createProviderProxy } from '../../packages/sando/src/proxy.mjs';
import { formatChildFailure, parseClaudeUsage, parseCodexUsage } from './adapters.mjs';
import { countInteractions } from './interaction-counts.mjs';
import { parseModelProbeResult } from './e2e-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_POLICY = { maxHistoryTokens: 1000 };
const CLAUDE_UPSTREAM = 'https://api.anthropic.com';
const CODEX_UPSTREAM = 'https://chatgpt.com/backend-api/codex';
const FINAL_FACT = 'SANDO_PROXY_FINAL_FACT';
const HEAD_FACT = 'SANDO_PROXY_HEAD_FACT';
const TAIL_FACT = 'SANDO_PROXY_TAIL_FACT';
export const MAX_REPETITIONS = 15;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function runCommand(command, args, { cwd, env = process.env, timeoutMs = 180_000 } = {}) {
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
  try { return [JSON.parse(stdout)]; } catch {}
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

function finalCodexFacts(stdout) {
  for (const document of jsonDocuments(stdout).slice().reverse()) {
    if (document?.type !== 'item.completed' || document.item?.type !== 'agent_message') continue;
    try { return JSON.parse(document.item.text); } catch {}
  }
  return null;
}

function toolEvidence(stdout, host) {
  const documents = jsonDocuments(stdout);
  if (host === 'claude') {
    return documents.filter((document) => contains(document, (value) => value.type === 'tool_use' && value.name === 'Bash')).length >= 2
      && documents.some((document) => contains(document, (value) => value.type === 'tool_result'));
  }
  return documents.filter((document) => contains(document, (value) => value.type === 'command_execution')).length >= 2;
}

export function buildProxyPrompt({ host, script } = {}) {
  if (typeof host !== 'string' || typeof script !== 'string' || !script) throw new TypeError('host and script are required');
  const tool = host === 'claude' ? 'Bash' : 'the built-in shell tool';
  const command = `node ${script}`;
  return [
    'This is a paired provider-request token-accounting benchmark.',
    `Use ${tool} exactly twice, sequentially: first run ${JSON.stringify(command)}, then run ${JSON.stringify("printf 'SANDO_PROXY_FINAL_FACT\\n'")}.`,
    'Do not use any other tool and do not repeat either tool result.',
    `After both tool results, return exactly JSON: {"status":"ok","facts":["${FINAL_FACT}"]}. Do not include Markdown or other text.`,
  ].join('\n');
}

export function buildClaudeProxyArgs({ prompt, model, maxBudgetUsd } = {}) {
  if (typeof prompt !== 'string' || !prompt) throw new TypeError('prompt is required');
  return [
    ...(model ? ['--model', model] : []), '--print', '--no-session-persistence', '--disable-slash-commands', '--no-chrome',
    '--setting-sources', '', '--tools', 'Bash', '--allowed-tools', 'Bash', '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : []), prompt,
  ];
}

export function buildClaudeProxyEnv({ variant, proxyUrl, policy, baseEnv = process.env } = {}) {
  const env = { ...baseEnv };
  delete env.ANTHROPIC_BASE_URL;
  delete env.SANDO_CONTEXT_POLICY;
  if (variant === 'optimized') {
    env.ANTHROPIC_BASE_URL = proxyUrl;
    env.SANDO_CONTEXT_POLICY = JSON.stringify(policy);
  }
  return env;
}

export function buildCodexProxyArgs({ prompt, model, optimized, proxyUrl } = {}) {
  if (typeof prompt !== 'string' || !prompt) throw new TypeError('prompt is required');
  const args = [
    'exec', ...(model ? ['--model', model] : []), '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--skip-git-repo-check', '--approve-for-me', '--json',
  ];
  if (optimized) {
    if (typeof proxyUrl !== 'string' || !proxyUrl) throw new TypeError('proxyUrl is required');
    args.push(
      '-c', 'model_provider="sando_proxy"',
      '-c', 'model_providers.sando_proxy.name="OpenAI via Sando"',
      '-c', `model_providers.sando_proxy.base_url="${proxyUrl}"`,
      '-c', 'model_providers.sando_proxy.wire_api="responses"',
      '-c', 'model_providers.sando_proxy.requires_openai_auth=true',
    );
  }
  args.push(prompt);
  return args;
}

export function buildCodexProxyEnv({ variant, policy, baseEnv = process.env } = {}) {
  const env = { ...baseEnv };
  delete env.SANDO_CONTEXT_POLICY;
  if (variant === 'optimized') env.SANDO_CONTEXT_POLICY = JSON.stringify(policy);
  return env;
}

async function createFixture(workspace) {
  const script = path.join(workspace, 'proxy-fixture.mjs');
  const lines = [HEAD_FACT, ...Array.from({ length: 900 }, () => 'proxy-noise'), TAIL_FACT];
  await fs.writeFile(script, `process.stdout.write(${JSON.stringify(`${lines.join('\n')}\n`)});\n`, { mode: 0o700 });
  return script;
}

function failedRun({ host, variant, repetition, prompt, args, result, clientVersion, message, scenario }) {
  const audit = auditMetadata({
    host, variant, prompt, args, result, clientVersion, cwd: ROOT,
    scenarioDigest: digestPrompt(prompt), measurement: { mode: 'end-to-end-proxy', hookEndToEnd: false, providerProxy: variant === 'optimized' },
  });
  audit.tokenAccounting = { source: 'provider-reported', providerObserved: false };
  return {
    host, scenario, repetition, variant, clientVersion, measurement: 'end-to-end-proxy', tokenAccounting: 'provider-reported',
    inputTokens: 0, outputTokens: 0, totalTokens: 0, providerUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    quality: 'fail', modelVisibleQuality: 'fail', artifactResolvable: false, secretLeak: null, toolEvidence: false,
    proxyChanged: variant === 'baseline' ? null : false, audit, error: message,
    modelTurns: 0, totalToolCalls: 0, nativeToolCalls: 0, sandoMcpCalls: 0, mechanicalContextTrimmedBytes: 0,
  };
}

async function runClaudeVariant({ variant, repetition, workspace, script, model, maxBudgetUsd, clientVersion, policy, upstream }) {
  const prompt = buildProxyPrompt({ host: 'claude', script });
  let proxy;
  try {
    proxy = variant === 'optimized' ? await createProviderProxy({ upstream, policy }) : null;
    const args = buildClaudeProxyArgs({ prompt, model, maxBudgetUsd });
    const env = buildClaudeProxyEnv({ variant, proxyUrl: proxy?.url, policy });
    const result = await runCommand('claude', args, { cwd: workspace, env });
    const audit = auditMetadata({
      host: 'claude', variant, prompt, args, result, clientVersion, cwd: ROOT,
      scenarioDigest: digestPrompt(prompt), measurement: { mode: 'end-to-end-proxy', hookEndToEnd: false, providerProxy: variant === 'optimized' },
    });
    if (result.code !== 0) return failedRun({ host: 'claude', variant, repetition, prompt, args, result, clientVersion, scenario: 'claude-proxy-history', message: formatChildFailure('claude', variant, result) });
    let probe;
    try { probe = parseModelProbeResult(result.stdout); }
    catch (error) { return failedRun({ host: 'claude', variant, repetition, prompt, args, result, clientVersion, scenario: 'claude-proxy-history', message: error.message }); }
    const initModel = jsonDocuments(result.stdout).find((document) => document?.type === 'system' && document.subtype === 'init')?.model;
    const usage = initModel ? { ...probe.usage, resolvedModel: initModel } : probe.usage;
    const factsPass = probe.status === 'ok' && probe.facts.includes(FINAL_FACT);
    const evidence = toolEvidence(result.stdout, 'claude');
    const proxyStats = proxy?.lastStats ?? null;
    const proxyChanged = variant === 'baseline' ? null : proxyStats?.changed === true;
    const quality = factsPass && evidence && (variant === 'baseline' || proxyChanged);
    const interactions = countInteractions(result.stdout, 'claude');
    const mechanicalContextTrimmedBytes = variant === 'optimized' ? proxyStats?.mechanicalContextTrimmedBytes ?? null : 0;
    audit.resolvedModel = usage.resolvedModel ?? model ?? null;
    audit.tokenAccounting = { source: 'provider-reported', providerObserved: true };
    return {
      host: 'claude', scenario: 'claude-proxy-history', repetition, variant, resolvedModel: audit.resolvedModel, clientVersion,
      measurement: 'end-to-end-proxy', tokenAccounting: 'provider-reported', providerUsage: usage,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
      quality: quality ? 'pass' : 'fail', modelVisibleQuality: factsPass ? 'pass' : 'fail', artifactResolvable: true,
      secretLeak: false, toolEvidence: evidence, ...interactions, mechanicalContextTrimmedBytes, proxyChanged, proxyStats, promptDigest: audit.promptDigest, audit,
    };
  } finally {
    if (proxy) await proxy.close();
  }
}

async function runCodexVariant({ variant, repetition, workspace, script, model, clientVersion, policy, upstream }) {
  const prompt = buildProxyPrompt({ host: 'codex', script });
  let proxy;
  try {
    proxy = variant === 'optimized' ? await createProviderProxy({ upstream, policy }) : null;
    const args = buildCodexProxyArgs({ prompt, model, optimized: variant === 'optimized', proxyUrl: proxy?.url });
    const env = buildCodexProxyEnv({ variant, policy });
    const result = await runCommand('codex', args, { cwd: workspace, env });
    const audit = auditMetadata({
      host: 'codex', variant, prompt, args, result, clientVersion, cwd: ROOT,
      scenarioDigest: digestPrompt(prompt), measurement: { mode: 'end-to-end-proxy', hookEndToEnd: false, providerProxy: variant === 'optimized' },
    });
    if (result.code !== 0) return failedRun({ host: 'codex', variant, repetition, prompt, args, result, clientVersion, scenario: 'codex-proxy-history', message: formatChildFailure('codex', variant, result) });
    const usage = parseCodexUsage(result.stdout);
    if (!usage) return failedRun({ host: 'codex', variant, repetition, prompt, args, result, clientVersion, scenario: 'codex-proxy-history', message: 'Codex returned no provider usage' });
    const facts = finalCodexFacts(result.stdout);
    const factsPass = facts?.status === 'ok' && facts.facts?.includes(FINAL_FACT);
    const evidence = toolEvidence(result.stdout, 'codex');
    const proxyStats = proxy?.lastStats ?? null;
    const proxyChanged = variant === 'baseline' ? null : proxyStats?.changed === true;
    const quality = factsPass && evidence && (variant === 'baseline' || proxyChanged);
    const interactions = countInteractions(result.stdout, 'codex');
    const mechanicalContextTrimmedBytes = variant === 'optimized' ? proxyStats?.mechanicalContextTrimmedBytes ?? null : 0;
    audit.resolvedModel = usage.resolvedModel ?? model ?? null;
    audit.tokenAccounting = { source: 'provider-reported', providerObserved: true };
    return {
      host: 'codex', scenario: 'codex-proxy-history', repetition, variant, resolvedModel: audit.resolvedModel, clientVersion,
      measurement: 'end-to-end-proxy', tokenAccounting: 'provider-reported', providerUsage: usage,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
      quality: quality ? 'pass' : 'fail', modelVisibleQuality: factsPass ? 'pass' : 'fail', artifactResolvable: true,
      secretLeak: false, toolEvidence: evidence, ...interactions, mechanicalContextTrimmedBytes, proxyChanged, proxyStats, promptDigest: audit.promptDigest, audit,
    };
  } finally {
    if (proxy) await proxy.close();
  }
}

async function clientVersion(host, cwd) {
  const result = await runCommand(host, ['--version'], { cwd, timeoutMs: 10_000 });
  return result.stdout.trim().split('\n').find(Boolean) ?? 'unresolved';
}

export async function runProxyBenchmark({ host, outputPath, model, repetitions, maxBudgetUsd, policy = DEFAULT_POLICY, upstream } = {}) {
  if (!['claude', 'codex'].includes(host)) throw new TypeError('host must be claude or codex');
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) throw new TypeError('invalid repetitions');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `sando-${host}-proxy-`));
  const script = await createFixture(workspace);
  const version = await clientVersion(host, workspace);
  const runs = [];
  const selectedUpstream = upstream ?? (host === 'claude' ? CLAUDE_UPSTREAM : CODEX_UPSTREAM);
  try {
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const common = { repetition, workspace, script, model, clientVersion: version, policy, upstream: selectedUpstream };
      const baseline = host === 'claude'
        ? await runClaudeVariant({ ...common, variant: 'baseline', maxBudgetUsd })
        : await runCodexVariant({ ...common, variant: 'baseline' });
      runs.push(baseline);
      if (baseline.quality !== 'pass') break;
      const optimized = host === 'claude'
        ? await runClaudeVariant({ ...common, variant: 'optimized', maxBudgetUsd })
        : await runCodexVariant({ ...common, variant: 'optimized' });
      runs.push(optimized);
      if (optimized.quality !== 'pass') break;
    }
    let failure = null;
    for (const optimized of runs.filter((run) => run.variant === 'optimized')) {
      try { assertQualityGate({ baseline: runs.find((run) => run.repetition === optimized.repetition && run.variant === 'baseline'), optimized }); }
      catch (error) { failure = { status: 'blocked', message: error.message, repetition: optimized.repetition }; break; }
    }
    if (!failure && runs.length !== repetitions * 2) failure = { status: 'blocked', message: 'incomplete paired proxy runs' };
    const report = {
      schema: 'sando-live-proxy/v1', status: failure ? 'blocked' : 'passed', host, clientVersion: version,
      upstream: selectedUpstream, policy, repetitions,
      audit: { measurement: { mode: 'end-to-end-proxy', hookEndToEnd: false, providerProxy: true }, tokenAccounting: { source: 'provider-reported', providerObserved: true } },
      runs, summary: failure ? null : summarizeRuns(runs), ...(failure ? { failure } : {}),
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  if (!process.argv.includes('--confirm-cost')) throw new Error('proxy live benchmark requires --confirm-cost');
  const host = option('host', 'claude');
  const maxBudgetUsd = option('max-budget-usd');
  if (host === 'claude' && !maxBudgetUsd && !process.argv.includes('--unlimited-budget')) throw new Error('Claude proxy benchmark requires --max-budget-usd or --unlimited-budget');
  const repetitions = Number(option('repetitions', '1'));
  const policy = { maxHistoryTokens: Number(option('max-history-tokens', String(DEFAULT_POLICY.maxHistoryTokens))) };
  const outputPath = path.resolve(option('out', path.join(ROOT, 'benchmarks/results', `live-proxy-${host}.json`)));
  const report = await runProxyBenchmark({
    host, outputPath, model: option('model'), repetitions, maxBudgetUsd, policy,
    upstream: option('upstream', host === 'claude' ? CLAUDE_UPSTREAM : CODEX_UPSTREAM),
  });
  process.stdout.write(`${JSON.stringify({ outputPath, status: report.status, summary: report.summary, failure: report.failure }, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`proxy live benchmark: ${error.message}\n`); process.exitCode = 1; });
}
