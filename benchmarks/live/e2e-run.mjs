#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { auditMetadata, digestPrompt } from '../lib/audit.mjs';
import { assertQualityGate, summarizeRuns } from '../lib/metrics.mjs';
import { parseClaudeUsage } from './adapters.mjs';
import { countInteractions } from './interaction-counts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE_ROOT = path.join(ROOT, 'benchmarks/live/evidence');
const HOOK = path.join(ROOT, 'adapters/claude/sando/hooks/post-tool-use.mjs');
const SCENARIO = 'claude-tool-result';
const REQUIRED_FACTS = ['SANDO_E2E_HEAD_FACT', 'SANDO_E2E_TAIL_FACT'];
const ARTIFACT_FACTS = ['SANDO_E2E_MIDDLE_FACT'];
export const MAX_REPETITIONS = 15;
const SECRET = 'sk-test-01234567890123456789';
const SCENARIO_DIGEST = digestPrompt(JSON.stringify({ SCENARIO, REQUIRED_FACTS, ARTIFACT_FACTS }));
const POLICY = { mode: 'apply', maxInlineBytes: 768, maxArtifactBytes: 4096, maxColumns: 768, redact: true };
export const CLAUDE_NO_COST_BLOCKER = 'Claude Code cannot provide a no-cost end-to-end fixture: PostToolUse is emitted only after a live Claude tool call, and the --print CLI requires a provider request to produce that tool call; no local/mock provider can produce Claude model-visible tool-call evidence. The existing prompt-level runner disables tools and embeds context, so it cannot establish model-visible or hook lifecycle evidence.';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function secretLeak(value) {
  return /(?:api[_-]?key|authorization|password|secret)\s*[:=]\s*(?!\[REDACTED\])\S+|\b(?:sk|gh[pousr])-[A-Za-z0-9_-]{12,}/i.test(String(value ?? ''));
}

function textFromValue(value, seen = new Set()) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  const text = Object.values(value).map((child) => textFromValue(child, seen)).filter(Boolean).join('\n');
  seen.delete(value);
  return text;
}

function updatedToolOutput(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    if (typeof value !== 'string') return null;
    try { return updatedToolOutput(JSON.parse(value), seen); } catch { return null; }
  }
  if (Object.hasOwn(value, 'updatedToolOutput')) return value.updatedToolOutput;
  seen.add(value);
  for (const child of Object.values(value)) {
    const found = updatedToolOutput(child, seen);
    if (found !== null) return found;
  }
  seen.delete(value);
  return null;
}

function updatedToolOutputFromStream(stdout) {
  for (const document of jsonDocuments(stdout).slice().reverse()) {
    const replacement = updatedToolOutput(document);
    if (replacement !== null) return replacement;
  }
  return null;
}

function jsonDocuments(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return [];
  try { return [JSON.parse(stdout)]; } catch {}
  const documents = [];
  for (const line of stdout.trim().split('\n')) {
    try { documents.push(JSON.parse(line)); } catch {}
  }
  return documents;
}

function containsObject(value, predicate, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  if (predicate(value)) return true;
  seen.add(value);
  const found = Object.values(value).some((child) => containsObject(child, predicate, seen));
  seen.delete(value);
  return found;
}

function toolResultText(documents) {
  for (const document of documents) {
    let result = null;
    const visit = (value, seen = new Set()) => {
      if (result !== null || !value || typeof value !== 'object' || seen.has(value)) return;
      if (value.type === 'tool_result' || Object.hasOwn(value, 'tool_result')) {
        result = textFromValue(value.content ?? value.tool_result);
        return;
      }
      seen.add(value);
      Object.values(value).forEach((child) => visit(child, seen));
      seen.delete(value);
    };
    visit(document);
    if (result !== null) return result;
  }
  return '';
}

function toolResultObserved(documents) {
  return documents.some((document) => containsObject(document, (value) => value.type === 'tool_use' && value.name === 'Bash'))
    && documents.some((document) => containsObject(document, (value) => value.type === 'tool_result'));
}

function artifactReferences(value) {
  return [...new Set(textFromValue(value).match(/\.sando\/sando\/artifacts\/[A-Za-z0-9._-]+/g) ?? [])];
}

async function readArtifacts(cwd, references) {
  const contents = [];
  const resolved = [];
  for (const reference of references) {
    const absolute = path.resolve(cwd, reference);
    const relative = path.relative(cwd, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    try {
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      contents.push(await fs.readFile(absolute, 'utf8'));
      resolved.push(relative);
    } catch {}
  }
  return { contents, resolved };
}

export async function analyzeProbeEvidence({ replacement, modelResult, requiredFacts, artifactFacts, cwd }) {
  if (!replacement || typeof cwd !== 'string' || !cwd) throw new TypeError('probe evidence input is invalid');
  const replacementText = textFromValue(replacement);
  const facts = Array.isArray(modelResult?.facts) ? modelResult.facts : [];
  const modelVisibleQuality = modelResult?.status === 'ok'
    && requiredFacts.every((fact) => replacementText.includes(fact) && facts.includes(fact)) ? 'pass' : 'fail';
  const references = artifactReferences(replacement);
  const artifacts = await readArtifacts(cwd, references);
  const artifactResolvable = artifactFacts.length === 0
    || artifacts.contents.length > 0 && artifactFacts.every((fact) => artifacts.contents.some((content) => content.includes(fact)));
  return {
    modelVisibleQuality, artifactResolvable,
    secretLeak: secretLeak(`${replacementText}\n${artifacts.contents.join('\n')}\n${JSON.stringify(modelResult ?? null)}`),
    artifactReferences: references, resolvedArtifacts: artifacts.resolved,
  };
}

export function buildClaudeE2EArgs({ prompt, pluginDir, model, maxBudgetUsd, settingSources } = {}) {
  if (typeof prompt !== 'string' || !prompt) throw new TypeError('prompt is required');
  return [
    ...(model ? ['--model', model] : []), '--print', '--no-session-persistence', '--disable-slash-commands', '--no-chrome',
    '--tools', 'Bash', '--allowed-tools', 'Bash', '--permission-mode', 'dontAsk', '--strict-mcp-config',
    '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    ...(settingSources !== undefined ? ['--setting-sources', settingSources] : []),
    ...(pluginDir ? ['--plugin-dir', pluginDir] : []),
    ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : []), prompt,
  ];
}

export function buildClaudeE2EEnv({ variant, workspace, baseEnv = process.env }) {
  const env = {
    ...baseEnv,
    SANDO_MODE: variant === 'optimized' ? 'apply' : 'observe',
    SANDO_METRICS_PATH: path.join(workspace, 'metrics.json'),
  };
  if (variant === 'optimized') env.SANDO_POLICY = JSON.stringify(POLICY);
  else delete env.SANDO_POLICY;
  return env;
}

function runCommand(command, args, { cwd, env = process.env, input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    child.stdin.end(input);
  });
}

function fixturePayload({ includeSecret = true } = {}) {
  return [
    REQUIRED_FACTS[0], ...Array.from({ length: 320 }, () => 'noise:repeated'), ARTIFACT_FACTS[0],
    ...Array.from({ length: 320 }, () => 'noise:repeated'), REQUIRED_FACTS[1],
    ...(includeSecret ? [`API_KEY=${SECRET}`] : []),
  ].join('\n') + '\n';
}

async function createProbeScript(workspace, options) {
  const script = path.join(workspace, 'probe-output.mjs');
  await fs.writeFile(script, `process.stdout.write(${JSON.stringify(fixturePayload(options))});\n`, { mode: 0o700 });
  return script;
}

async function runHook({ cwd, mode, toolResponse }) {
  const result = await runCommand(process.execPath, [HOOK], {
    cwd, input: `${JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: toolResponse, cwd })}\n`,
    env: { ...process.env, SANDO_MODE: mode, SANDO_POLICY: JSON.stringify({ ...POLICY, mode }), SANDO_METRICS_PATH: path.join(cwd, 'metrics.json') },
    timeoutMs: 10_000,
  });
  if (result.code !== 0) throw new Error(`PostToolUse probe failed (${result.code ?? result.signal})`);
  try { return JSON.parse(result.stdout); } catch { throw new Error('PostToolUse probe returned malformed JSON'); }
}

async function ompComparison() {
  const localRoot = process.env.SANDO_OMP_ROOT;
  const installedRoot = process.env.SANDO_OMP_INSTALLED_ROOT;
  const localEvidence = localRoot && path.join(localRoot, 'docs/security.md');
  const localHook = localRoot && path.join(localRoot, 'adapters/omp-ohmy-pi/bounded-hook.mjs');
  const installedPackage = installedRoot && path.join(installedRoot, 'package.json');
  const installedHookTypes = installedRoot && path.join(installedRoot, 'dist/types/extensibility/hooks/types.d.ts');
  let version = null, localVerified = false, installedVerified = false;
  try { if (installedPackage) version = JSON.parse(await fs.readFile(installedPackage, 'utf8')).version; } catch {}
  try { if (localEvidence && localHook) localVerified = /RPC transport/i.test(await fs.readFile(localEvidence, 'utf8')) && /tool_result/i.test(await fs.readFile(localHook, 'utf8')); } catch {}
  try { if (installedHookTypes) installedVerified = /Hooks can modify the result/i.test(await fs.readFile(installedHookTypes, 'utf8')); } catch {}
  return {
    officialRepository: 'https://github.com/can1357/oh-my-pi',
    localEvidence: { configured: Boolean(localRoot), verified: localVerified },
    installed: { configured: Boolean(installedRoot), version, verified: installedVerified },
    conclusion: 'OMP tool_result evidence is host-local and does not establish Claude PostToolUse evidence.',
  };
}

export async function runDeterministicProbe({ outputPath = path.join(EVIDENCE_ROOT, 'e2e-deterministic.json'), cwd: suppliedCwd } = {}) {
  const ownsCwd = typeof suppliedCwd !== 'string' || !suppliedCwd;
  const cwd = ownsCwd ? await fs.mkdtemp(path.join(os.tmpdir(), 'sando-e2e-')) : suppliedCwd;
  try {
    const script = await createProbeScript(cwd);
    const fixture = await runCommand(process.execPath, [script], { cwd, timeoutMs: 10_000 });
    if (fixture.code !== 0) throw new Error('deterministic fixture tool failed');
    const toolResponse = { stdout: fixture.stdout, stderr: '', exitCode: 0 };
    const observed = await runHook({ cwd, mode: 'observe', toolResponse });
    const applied = await runHook({ cwd, mode: 'apply', toolResponse });
    const replacement = applied?.hookSpecificOutput?.updatedToolOutput;
    const replacementText = textFromValue(replacement);
    const references = artifactReferences(replacement);
    const artifacts = await readArtifacts(cwd, references);
    const baselineText = textFromValue(toolResponse);
    const optimized = {
      variant: 'optimized', replacementCaptured: Boolean(replacement), probeVisibleQuality: REQUIRED_FACTS.every((fact) => replacementText.includes(fact)) ? 'pass' : 'fail',
      modelVisibleQuality: 'unverified', artifactResolvable: artifacts.contents.length > 0 && ARTIFACT_FACTS.every((fact) => artifacts.contents.some((content) => content.includes(fact))),
      secretLeak: secretLeak(`${replacementText}\n${artifacts.contents.join('\n')}`), artifactReferences: references, resolvedArtifacts: artifacts.resolved,
      inputTokens: Math.ceil(Buffer.byteLength(replacementText) / 4), modelTurns: 0, totalToolCalls: 0,
      nativeToolCalls: 0, sandoMcpCalls: 0, mechanicalContextTrimmedBytes: Math.max(0,
        Buffer.byteLength(baselineText ?? '', 'utf8') - Buffer.byteLength(replacementText, 'utf8')), quality: 'pass',
      audit: { measurement: { mode: 'deterministic-hook-probe', hookEndToEnd: false, providerObserved: false }, tokenAccounting: { source: 'estimate', providerObserved: false } },
    };
    optimized.quality = optimized.probeVisibleQuality === 'pass' && optimized.artifactResolvable && !optimized.secretLeak ? 'pass' : 'fail';
    const baseline = {
      variant: 'baseline', replacementCaptured: false, probeVisibleQuality: 'pass', modelVisibleQuality: 'unverified', artifactResolvable: true,
      secretLeak: secretLeak(baselineText), artifactReferences: [], resolvedArtifacts: [], inputTokens: Math.ceil(Buffer.byteLength(baselineText) / 4),
      modelTurns: 0, totalToolCalls: 0, nativeToolCalls: 0, sandoMcpCalls: 0, mechanicalContextTrimmedBytes: 0, quality: 'pass',
      audit: { ...optimized.audit },
    };
    const report = {
      schema: 'sando-live-e2e/v1', status: 'blocked', blocker: CLAUDE_NO_COST_BLOCKER,
      measurement: { mode: 'deterministic-hook-probe', hookEndToEnd: false, modelObserved: false, providerObserved: false, label: 'not-end-to-end' },
      live: { status: 'blocked', blocker: CLAUDE_NO_COST_BLOCKER, modelVisibleQuality: 'unverified' }, comparison: await ompComparison(),
      pair: { baseline, optimized }, pairs: [{ baseline, optimized }], runs: [baseline, optimized],
      probe: { tool: 'Bash', requiredFacts: REQUIRED_FACTS, artifactFacts: ARTIFACT_FACTS, observeHookCaptured: Boolean(observed) },
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    if (ownsCwd) await fs.rm(cwd, { recursive: true, force: true });
  }
}

export function parseModelProbeResult(stdout) {
  const documents = jsonDocuments(stdout);
  const terminal = documents.slice().reverse().find((document) => document?.type === 'result');
  if (!terminal || terminal.type !== 'result' || terminal.subtype !== 'success') throw new Error('Claude probe returned no successful result');
  let value = terminal.structured_output ?? terminal.result;
  if (typeof value === 'string') {
    const text = value.trim();
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidates = [fenced ? fenced[1] : text];
    const statusStart = text.lastIndexOf('{"status"');
    if (statusStart >= 0) candidates.push(text.slice(statusStart));
    let parsed = null;
    for (const candidate of candidates) {
      try { parsed = JSON.parse(candidate); break; } catch {}
    }
    if (parsed === null) throw new Error('Claude probe returned invalid JSON');
    value = parsed;
  }
  if (!value || typeof value !== 'object' || value.status !== 'ok' || !Array.isArray(value.facts)) throw new Error('Claude probe returned invalid fact result');
  const usage = parseClaudeUsage(stdout, { tolerateMalformed: true });
  if (!usage) throw new Error('Claude probe returned no provider usage');
  return { ...value, usage };
}

async function createCapturePlugin(pluginDir, capturePath) {
  await fs.mkdir(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  await fs.mkdir(path.join(pluginDir, 'hooks'), { recursive: true });
  await fs.writeFile(path.join(pluginDir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'sando-live-capture', version: '0.0.0' }));
  await fs.writeFile(path.join(pluginDir, 'hooks/hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/capture.mjs"', timeout: 10 }] }] } }));
  await fs.writeFile(path.join(pluginDir, 'hooks/capture.mjs'), `import fs from 'node:fs/promises'; import { spawnSync } from 'node:child_process'; const input = await fs.readFile(0, 'utf8'); const result = spawnSync(process.execPath, [${JSON.stringify(HOOK)}], { input, encoding: 'utf8', env: process.env }); const event = JSON.parse(input); const hook = JSON.parse(result.stdout || '{}'); await fs.writeFile(${JSON.stringify(capturePath)}, JSON.stringify({ hookEventName: event.hook_event_name, updatedToolOutput: hook.hookSpecificOutput?.updatedToolOutput ?? null })); process.stdout.write(result.stdout || '{}');`);
}

async function runVariant({ variant, workspace, script, pluginDir, capturePath, model, maxBudgetUsd, timeoutMs, clientVersion }) {
  const prompt = `Use Bash exactly once to run: node ${script}\nReturn exactly JSON with status "ok" and facts exactly ${JSON.stringify(REQUIRED_FACTS)} in that order. Use no descriptions, extra facts, or Markdown fences. Do not repeat tool output.`;
  const args = buildClaudeE2EArgs({ prompt, pluginDir, model, maxBudgetUsd });
  const result = await runCommand('claude', args, { cwd: workspace, timeoutMs, env: buildClaudeE2EEnv({ variant, workspace }) });
  const audit = auditMetadata({ host: 'claude', variant, prompt, args, result, cwd: ROOT, clientVersion, scenarioDigest: SCENARIO_DIGEST, resolvedModel: null, measurement: { mode: 'end-to-end', hookEndToEnd: true } });
  if (result.code !== 0) return { variant, measurement: 'end-to-end', tokenAccounting: 'provider-reported', inputTokens: 0, modelTurns: 0, totalToolCalls: 0, nativeToolCalls: 0, sandoMcpCalls: 0, mechanicalContextTrimmedBytes: 0, quality: 'fail', modelVisibleQuality: 'fail', artifactResolvable: false, secretLeak: null, toolResultObserved: false, postToolUseCaptured: false, audit, error: `Claude ${variant} failed` };
  let probe;
  try { probe = parseModelProbeResult(result.stdout); } catch (error) { return { variant, measurement: 'end-to-end', tokenAccounting: 'provider-reported', inputTokens: 0, modelTurns: 0, totalToolCalls: 0, nativeToolCalls: 0, sandoMcpCalls: 0, mechanicalContextTrimmedBytes: 0, quality: 'fail', modelVisibleQuality: 'fail', artifactResolvable: false, secretLeak: null, toolResultObserved: false, postToolUseCaptured: false, audit, error: error.message }; }
  const documents = jsonDocuments(result.stdout);
  const initModel = documents.slice().reverse().find((document) => document?.type === 'system' && document.subtype === 'init')?.model;
  const providerUsage = initModel ? { ...probe.usage, resolvedModel: initModel } : probe.usage;
  const observed = toolResultObserved(documents);
  let replacement;
  if (variant === 'optimized') {
    try { replacement = JSON.parse(await fs.readFile(capturePath, 'utf8')).updatedToolOutput; }
    catch { replacement = updatedToolOutputFromStream(result.stdout); }
  }
  else replacement = toolResultText(documents);
  const interactions = countInteractions(documents, 'claude');
  const sourceToolText = toolResultText(documents);
  const mechanicalContextTrimmedBytes = variant === 'optimized'
    ? Math.max(0, Buffer.byteLength(sourceToolText, 'utf8') - Buffer.byteLength(textFromValue(replacement), 'utf8')) : 0;
  const visibleEvidence = await analyzeProbeEvidence({ replacement: toolResultText(documents), modelResult: probe, requiredFacts: REQUIRED_FACTS, artifactFacts: [], cwd: workspace });
  const replacementEvidence = await analyzeProbeEvidence({ replacement: replacement ?? '', modelResult: probe, requiredFacts: REQUIRED_FACTS, artifactFacts: variant === 'optimized' ? ARTIFACT_FACTS : [], cwd: workspace });
  audit.resolvedModel = providerUsage.resolvedModel ?? model ?? null;
  audit.tokenAccounting = { source: 'provider-reported', providerObserved: true };
  return { host: 'claude', scenario: SCENARIO, repetition: 0, variant, resolvedModel: audit.resolvedModel, clientVersion, measurement: 'end-to-end', tokenAccounting: 'provider-reported', providerUsage, inputTokens: providerUsage.inputTokens, outputTokens: providerUsage.outputTokens, totalTokens: providerUsage.totalTokens, ...interactions, mechanicalContextTrimmedBytes, quality: observed && probe.status === 'ok' ? 'pass' : 'fail', modelVisibleQuality: visibleEvidence.modelVisibleQuality, artifactResolvable: variant === 'baseline' || replacementEvidence.artifactResolvable, secretLeak: visibleEvidence.secretLeak || replacementEvidence.secretLeak, toolResultObserved: observed, postToolUseCaptured: variant === 'optimized' && Boolean(replacement), promptDigest: audit.promptDigest, audit };
}

async function runLive({ outputPath, model, maxBudgetUsd, repetitions, timeoutMs }) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sando-claude-e2e-'));
  const script = await createProbeScript(workspace, { includeSecret: false });
  const pluginDir = path.join(workspace, 'plugin');
  const capturePath = path.join(workspace, 'post-tool-use.json');
  await createCapturePlugin(pluginDir, capturePath);
  const version = await runCommand('claude', ['--version'], { cwd: ROOT, timeoutMs: 10_000 });
  const clientVersion = version.stdout.trim().split('\n').find(Boolean) ?? 'unresolved';
  const runs = [];
  try {
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const baseline = await runVariant({ variant: 'baseline', workspace, script, pluginDir, capturePath, model, maxBudgetUsd, timeoutMs, clientVersion });
      baseline.repetition = repetition; runs.push(baseline);
      await fs.rm(capturePath, { force: true });
      const optimized = await runVariant({ variant: 'optimized', workspace, script, pluginDir, capturePath, model, maxBudgetUsd, timeoutMs, clientVersion });
      optimized.repetition = repetition; runs.push(optimized);
    }
    let failure = null;
    for (const optimized of runs.filter((run) => run.variant === 'optimized')) {
      try {
        const baseline = runs.find((run) => run.variant === 'baseline' && run.repetition === optimized.repetition);
        assertQualityGate({ baseline, optimized });
        if (optimized.modelVisibleQuality !== 'pass' || !optimized.toolResultObserved || !optimized.postToolUseCaptured) throw new Error('end-to-end evidence gate failed');
      } catch (error) { failure = { status: 'blocked', message: error.message }; break; }
    }
    let summary = null;
    if (!failure) {
      try { summary = summarizeRuns(runs); }
      catch (error) { failure = { status: 'blocked', message: error.message }; }
    }
    const output = { schema: 'sando-live-e2e/v1', status: failure ? 'blocked' : 'passed', host: 'claude', clientVersion, scenario: SCENARIO, audit: { measurement: { mode: 'end-to-end', hookEndToEnd: true }, tokenAccounting: { source: 'provider-reported', providerObserved: true }, note: 'Tool-enabled Claude Bash and PostToolUse replacement were observed.' }, runs, summary, ...(failure ? { failure } : {}) };
    await fs.mkdir(path.dirname(outputPath), { recursive: true }); await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`); return output;
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
}

async function main() {
  const mode = option('mode', 'deterministic');
  if (mode === 'deterministic') {
    const outputPath = path.resolve(option('out', path.join(EVIDENCE_ROOT, 'e2e-deterministic.json')));
    const output = await runDeterministicProbe({ outputPath }); process.stdout.write(`${JSON.stringify({ outputPath, status: output.status, measurement: output.measurement }, null, 2)}\n`); return;
  }
  if (!process.argv.includes('--confirm-cost')) throw new Error('live E2E benchmark requires --confirm-cost');
  const maxBudgetUsd = option('max-budget-usd');
  if (!maxBudgetUsd && !process.argv.includes('--unlimited-budget')) throw new Error('Claude live E2E benchmark requires --max-budget-usd or --unlimited-budget');
  const repetitions = Number(option('repetitions', '1'));
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) throw new Error(`--repetitions must be 1..${MAX_REPETITIONS}`);
  const output = await runLive({ outputPath: path.resolve(option('out', path.join(EVIDENCE_ROOT, 'live-e2e.json'))), model: option('model'), maxBudgetUsd, repetitions, timeoutMs: Number(option('timeout-ms', '120000')) });
  process.stdout.write(`${JSON.stringify({ status: output.status }, null, 2)}\n`); if (output.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`live E2E benchmark: ${error.message}\n`); process.exitCode = 1; });

export { secretLeak };
