import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startAppServer } from '../../../scripts/codex-loopback-contract.mjs';
import { prepareSubscriptionEnvironment } from '../../../scripts/codex-subscription-contract.mjs';

import {
  boundedExecuteSession,
  buildCacheSessionPlan,
  cacheRequiredSourceFiles,
  cleanupOwnedApp,
  normalizeUsageBreakdown,
  runCacheBenchmark,
  snapshotOwnedProcessTree,
  verifyCacheSourceReceipt,
} from '../../../scripts/run-sando-cache-benchmark.mjs';

function task(id = 'logs') {
  return {
    id,
    turns: Array.from({ length: 6 }, (_, index) => `turn ${index + 1}`),
    fixture: { files: { 'input.txt': 'immutable\n', 'result.txt': 'pending\n' } },
    protectedPaths: ['input.txt'],
    successCriteria: [{ type: 'file_contains', path: 'result.txt', value: 'done' }],
  };
}

function manifest(tasks = [task('logs'), task('search'), task('table')]) {
  const value = {
    schemaVersion: 'sando.benchmark-manifest.v1',
    id: 'sando-cache-v1',
    execution: {
      client: 'codex-cli 0.159.2', model: 'gpt-6.1-sol', reasoningEffort: 'low',
      sandbox: 'workspace-write', approvalPolicy: 'never', authentication: 'chatgpt-subscription',
      forbidMeteredApiFallback: true, wallTimeoutMsPerTurn: 180000, turnsPerSession: 6,
      totalSessions: tasks.length * 10, pairConcurrency: 1, ephemeral: true,
      ignoreUserConfig: true, ignoreRules: true,
    },
    repetitionsPerArm: 5,
    tasks,
  };
  value.schedule = Array.from({ length: 5 }, (_, repetitionIndex) => tasks.map((entry, taskIndex) => ({
    repetition: repetitionIndex + 1,
    task: entry.id,
    arms: (repetitionIndex * tasks.length + taskIndex) % 2 === 0
      ? ['control', 'apply'] : ['apply', 'control'],
  }))).flat();
  return value;
}

function recoveryManifest() {
  const value = manifest([task('noisy-log-incident')]);
  value.id = 'sando-recovery-v1';
  value.repetitionsPerArm = 10;
  value.execution.totalSessions = 20;
  value.schedule = Array.from({ length: 10 }, (_, repetitionIndex) => ({
    repetition: repetitionIndex + 1,
    task: value.tasks[0].id,
    arms: repetitionIndex % 2 === 0 ? ['control', 'apply'] : ['apply', 'control'],
  }));
  return value;
}

function lunaRecoveryManifest() {
  const value = recoveryManifest();
  value.id = 'sando-recovery-luna-v1';
  value.execution.model = 'gpt-6-luna';
  return value;
}

function fakePrepared(root, hookLog) {
  let cleaned = false;
  return {
    codexPath: '/fake/codex', env: {}, hookLog,
    credentialValues: () => ['never-store-this-credential'],
    cleanup() { cleaned = true; },
    get cleaned() { return cleaned; },
  };
}

function fakeApp({
  workspace, hookLog, failAt = null, waitForeverAt = null, noUsageAt = null,
  omitCacheWrite = false, turnStartDelayMs = 0, approvalAt = null, onTurnStart = null,
  commands = null, extraCommands = null,
} = {}) {
  const notifications = [];
  const serverRequests = [];
  const requests = [];
  let turns = 0;
  let closed = false;
  let waitCalls = 0;
  return {
    child: { pid: -1 }, notifications, serverRequests, requests,
    async initialize(options) { requests.push({ method: 'initialize', options }); },
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'thread/start') return {
        thread: { id: 'thread-1' }, model: 'gpt-6.1-sol', modelProvider: 'openai',
        reasoningEffort: 'low', sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'never',
        serviceTier: null,
      };
      if (method === 'turn/interrupt') return {};
      if (method !== 'turn/start') throw new Error(`unexpected request ${method}`);
      turns += 1;
      const turnId = `turn-${turns}`;
      onTurnStart?.(turns);
      if (turns === approvalAt) serverRequests.push({ method: 'item/commandExecution/requestApproval' });
      const total = {
        totalTokens: 110 * turns, inputTokens: 100 * turns, cachedInputTokens: 80 * turns,
        ...(omitCacheWrite ? {} : { cacheWriteInputTokens: 0 }),
        outputTokens: 10 * turns, reasoningOutputTokens: 2 * turns,
      };
      const last = {
        totalTokens: 110, inputTokens: 100, cachedInputTokens: 80,
        ...(omitCacheWrite ? {} : { cacheWriteInputTokens: 0 }),
        outputTokens: 10, reasoningOutputTokens: 2,
      };
      if (turns !== noUsageAt) notifications.push({
          method: 'thread/tokenUsage/updated',
          params: { threadId: 'thread-1', turnId, tokenUsage: { total, last, modelContextWindow: 200000 } },
        });
      notifications.push({
        method: 'item/completed',
        params: {
          threadId: 'thread-1', turnId,
          item: {
            id: `command-${turns}`, type: 'commandExecution', command: commands?.[turns - 1] ?? `inspect-${turns}`,
            aggregatedOutput: `output-${turns}`,
          },
        },
      });
      for (const [index, command] of (extraCommands?.[turns - 1] ?? []).entries()) notifications.push({
        method: 'item/completed',
        params: {
          threadId: 'thread-1', turnId,
          item: { id: `extra-command-${turns}-${index}`, type: 'commandExecution', command, aggregatedOutput: '' },
        },
      });
      notifications.push({
        method: 'item/completed',
        params: { threadId: 'thread-1', turnId, item: { id: `message-${turns}`, type: 'agentMessage', text: `answer-${turns}` } },
      });
      if (hookLog) fs.appendFileSync(hookLog, `${JSON.stringify({ mode: 'rewrite' })}\n`);
      if (turns === 6 && workspace) fs.writeFileSync(path.join(workspace, 'result.txt'), 'done\n');
      if (turns !== waitForeverAt) notifications.push({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: turnId, status: turns === failAt ? 'failed' : 'completed', error: turns === failAt ? { message: 'failed' } : null, items: [] },
        },
      });
      if (turnStartDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, turnStartDelayMs));
      return { turn: { id: turnId } };
    },
    async waitForNotification(method, predicate) {
      waitCalls += 1;
      const found = notifications.find((entry) => entry.method === method && predicate(entry.params));
      if (found) return found;
      return new Promise(() => {});
    },
    async close() { closed = true; return { exited: true, stderr: '' }; },
    get closed() { return closed; },
    get waitCalls() { return waitCalls; },
  };
}

test('builds the frozen 30-session schedule with a six-session pilot prefix', () => {
  const frozen = manifest([task('logs'), task('search'), task('table')]);
  const plan = buildCacheSessionPlan(frozen);
  assert.equal(plan.length, 30);
  assert.deepEqual(plan.slice(0, 6).map(({ taskId, repetition, arm }) => [taskId, repetition, arm]), [
    ['logs', 1, 'control'], ['logs', 1, 'apply'],
    ['search', 1, 'apply'], ['search', 1, 'control'],
    ['table', 1, 'control'], ['table', 1, 'apply'],
  ]);
  assert.deepEqual(plan.slice(6, 12).map(({ taskId, repetition, arm }) => [taskId, repetition, arm]), [
    ['logs', 2, 'apply'], ['logs', 2, 'control'],
    ['search', 2, 'control'], ['search', 2, 'apply'],
    ['table', 2, 'apply'], ['table', 2, 'control'],
  ]);
});

test('builds only the frozen alternating 20-session recovery protocol', () => {
  const frozen = recoveryManifest();
  const plan = buildCacheSessionPlan(frozen);
  assert.equal(plan.length, 20);
  assert.deepEqual(plan.slice(0, 6).map(({ taskId, repetition, arm }) => [taskId, repetition, arm]), [
    ['noisy-log-incident', 1, 'control'], ['noisy-log-incident', 1, 'apply'],
    ['noisy-log-incident', 2, 'apply'], ['noisy-log-incident', 2, 'control'],
    ['noisy-log-incident', 3, 'control'], ['noisy-log-incident', 3, 'apply'],
  ]);
  assert.throws(() => buildCacheSessionPlan({
    ...frozen,
    repetitionsPerArm: 9,
    execution: { ...frozen.execution, totalSessions: 18 },
    schedule: frozen.schedule.slice(0, 9),
  }), /unsupported cache benchmark manifest|recovery benchmark|dimensions are not frozen/);
});

test('accepts only gpt-6-luna for the frozen Luna recovery protocol', () => {
  const frozen = lunaRecoveryManifest();
  assert.equal(buildCacheSessionPlan(frozen).length, 20);
  assert.throws(() => buildCacheSessionPlan({
    ...frozen,
    execution: { ...frozen.execution, model: 'gpt-6.1-sol' },
  }), /execution contract is not frozen/);
  assert.throws(() => buildCacheSessionPlan({
    ...frozen,
    execution: { ...frozen.execution, model: 'gpt-6-luna-preview' },
  }), /execution contract is not frozen/);
});

test('requires the Luna pricing profile only for Luna source receipts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const solPath = path.join(root, 'sol.json');
  const lunaPath = path.join(root, 'luna.json');
  fs.writeFileSync(solPath, JSON.stringify({ id: 'sando-recovery-v1' }));
  fs.writeFileSync(lunaPath, JSON.stringify({ id: 'sando-recovery-luna-v1' }));
  const solFiles = cacheRequiredSourceFiles({ repoRoot: root, manifestPath: solPath });
  const lunaFiles = cacheRequiredSourceFiles({ repoRoot: root, manifestPath: lunaPath });
  const profile = 'packages/sando/pricing/openai-gpt-6-luna-standard-2026-10-01.json';
  assert.equal(solFiles.includes(profile), false);
  assert.equal(lunaFiles.includes(profile), true);
});

test('preserves omitted cache-write usage as unknown', () => {
  assert.deepEqual(normalizeUsageBreakdown({
    totalTokens: 9, inputTokens: 7, cachedInputTokens: 5, outputTokens: 2, reasoningOutputTokens: 1,
  }), {
    totalTokens: 9, inputTokens: 7, cachedInputTokens: 5,
    cacheWriteInputTokens: null, outputTokens: 2, reasoningOutputTokens: 1,
  });
});

test('runs exactly six turns on one thread and records cumulative usage without double counting', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const hookLog = path.join(root, 'hooks.jsonl');
  const prepared = fakePrepared(root, hookLog);
  const app = fakeApp({ workspace, hookLog });
  let appOptions;
  const frozen = manifest();
  const run = buildCacheSessionPlan(frozen)[0];

  const result = await boundedExecuteSession({
    manifest: frozen, run, workspace, evidenceRoot: path.join(root, 'evidence'),
    prepared, appFactory: (_codexPath, options) => { appOptions = options; return app; },
    sourceGuard: () => ({ sourceSha256: 'fixed' }),
  });

  assert.equal(result.attempt.outcome, 'passed');
  assert.match(result.attempt.threadIdDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.attempt.turns.length, 6);
  assert.equal(result.attempt.usage.total.inputTokens, 600);
  assert.equal(result.attempt.usage.total.cachedInputTokens, 480);
  assert.deepEqual(result.attempt.turns.map((turn) => turn.usage.delta.inputTokens), Array(6).fill(100));
  assert.deepEqual(result.attempt.turns.map((turn) => turn.usage.requests.length), Array(6).fill(1));
  assert.equal(result.attempt.turns.reduce((sum, turn) => sum + turn.toolCalls, 0), 6);
  assert.equal(result.attempt.hooks.total, 6);
  assert.deepEqual(result.attempt.turns.flatMap(({ commands }) => commands.map(({ command }) => command)),
    Array.from({ length: 6 }, (_, index) => `inspect-${index + 1}`));
  assert.deepEqual(result.attempt.turns[0].commands[0].aggregatedOutput,
    { text: 'output-1', truncated: false, originalBytes: 8 });
  assert.deepEqual(result.attempt.turns.flatMap(({ finalMessages }) => finalMessages.map(({ text }) => text)),
    Array.from({ length: 6 }, (_, index) => `answer-${index + 1}`));
  assert.equal(result.attempt.observedExecution.model, 'gpt-6.1-sol');
  assert.equal(result.attempt.observedExecution.reasoningEffort, 'low');
  assert.equal(app.requests.filter(({ method }) => method === 'thread/start').length, 1);
  assert.deepEqual(app.requests.find(({ method }) => method === 'initialize').options,
    { experimentalApi: true });
  assert.equal(app.requests.filter(({ method }) => method === 'turn/start').length, 6);
  assert.equal(app.waitCalls, 0);
  assert.ok(app.requests.filter(({ method }) => method === 'turn/start').every(({ params }) => (
    params.threadId === 'thread-1' && params.effort === 'low'
  )));
  const threadParams = app.requests.find(({ method }) => method === 'thread/start').params;
  assert.equal(threadParams.config.model_reasoning_effort, 'low');
  assert.equal(threadParams.ephemeral, true);
  assert.equal(threadParams.approvalPolicy, 'never');
  assert.equal(threadParams.sandbox, 'workspace-write');
  assert.equal(prepared.cleaned, true);
  assert.equal(app.closed, true);
  assert.equal(appOptions.detached, true);
  assert.equal(result.evidence.status, 'available');
});

test('counts only direct or shell-wrapped bare and absolute sando artifact retrieval commands', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-retrievals-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const frozen = manifest();
  const workspace = path.join(root, 'workspace');
  const commands = [
    'sando artifact get --ref sando:sha256:abc',
    '/opt/sando/bin/sando artifact get --ref sando:sha256:def',
    "'/opt/tools with spaces/bin/sando' artifact get --ref sando:sha256:123",
    '/opt/sando/bin/sando-helper artifact get --ref sando:sha256:456',
    'sando get --ref sando:sha256:789',
    "echo 'sando artifact get --ref sando:sha256:not-a-command'",
  ];
  const result = await boundedExecuteSession({
    manifest: frozen, run: buildCacheSessionPlan(frozen)[0], workspace,
    prepared: fakePrepared(root, path.join(root, 'hooks.jsonl')),
    appFactory: () => fakeApp({
      workspace,
      commands,
      extraCommands: [["/bin/bash -lc '/opt/tools/bin/sando artifact get --ref sando:sha256:wrapped'"]],
    }),
  });

  assert.deepEqual(result.attempt.turns.map(({ artifactRetrievals }) => artifactRetrievals), [2, 1, 1, 0, 0, 0]);
});

test('does not retry a failed turn and retains its cumulative usage', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-failed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const prepared = fakePrepared(root, path.join(root, 'hooks.jsonl'));
  const app = fakeApp({ workspace, failAt: 2 });

  const result = await boundedExecuteSession({
    manifest: manifest(), run: buildCacheSessionPlan(manifest())[0], workspace,
    prepared, appFactory: () => app, sourceGuard: () => ({ sourceSha256: 'fixed' }),
  });

  assert.equal(result.attempt.outcome, 'failed');
  assert.equal(result.attempt.turns.length, 2);
  assert.equal(result.attempt.usage.total.inputTokens, 200);
  assert.equal(app.requests.filter(({ method }) => method === 'turn/start').length, 2);
});

test('fails closed if approval is requested under the frozen never policy', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-approval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const frozen = manifest();
  const workspace = path.join(root, 'workspace');
  const result = await boundedExecuteSession({
    manifest: frozen, run: buildCacheSessionPlan(frozen)[0], workspace,
    prepared: fakePrepared(root, path.join(root, 'hooks.jsonl')),
    appFactory: () => fakeApp({ workspace, approvalAt: 1 }),
  });
  assert.equal(result.attempt.failure, 'unexpected-approval-request');
  assert.equal(result.attempt.turns.length, 1);
  assert.equal(result.attempt.turns[0].approvalRequests, 1);
});

test('keeps missing usage fields and missing turn usage incomplete', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const frozen = manifest();
  const workspace = path.join(root, 'workspace');
  const result = await boundedExecuteSession({
    manifest: frozen, run: buildCacheSessionPlan(frozen)[0], workspace,
    prepared: fakePrepared(root, path.join(root, 'hooks.jsonl')),
    appFactory: () => fakeApp({ workspace, omitCacheWrite: true, noUsageAt: 3 }),
  });
  assert.equal(result.attempt.outcome, 'passed');
  assert.equal(result.attempt.usage.status, 'incomplete');
  assert.equal(result.attempt.usage.total.cacheWriteInputTokens, null);
  assert.equal(result.attempt.turns[1].usage.delta.cacheWriteInputTokens, null);
  assert.equal(result.attempt.turns[2].usage.status, 'incomplete');
});

test('marks session usage incomplete when any completed turn has no usage notification', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-missing-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const frozen = manifest();
  const workspace = path.join(root, 'workspace');
  const result = await boundedExecuteSession({
    manifest: frozen, run: buildCacheSessionPlan(frozen)[0], workspace,
    prepared: fakePrepared(root, path.join(root, 'hooks.jsonl')),
    appFactory: () => fakeApp({ workspace, noUsageAt: 3 }),
  });
  assert.equal(result.attempt.usage.total.cacheWriteInputTokens, 0);
  assert.equal(result.attempt.turns[2].usage.status, 'incomplete');
  assert.equal(result.attempt.usage.status, 'incomplete');
});

test('interrupts an active turn on cancellation and cleans private state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const controller = new AbortController();
  const prepared = fakePrepared(root, path.join(root, 'hooks.jsonl'));
  const app = fakeApp({ workspace, waitForeverAt: 1, onTurnStart: () => setTimeout(() => controller.abort(), 10) });

  const result = await boundedExecuteSession({
    manifest: manifest(), run: buildCacheSessionPlan(manifest())[0], workspace,
    prepared, appFactory: () => app, sourceGuard: () => ({ sourceSha256: 'fixed' }),
    signal: controller.signal,
  });

  assert.equal(result.attempt.outcome, 'failed');
  assert.equal(result.attempt.failure, 'interrupted');
  assert.equal(app.requests.filter(({ method }) => method === 'turn/interrupt').length, 1);
  assert.equal(prepared.cleaned, true);
  assert.equal(app.closed, true);
});

test('bounds a stalled turn, retains observed usage, and does not retry', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const prepared = fakePrepared(root, path.join(root, 'hooks.jsonl'));
  const app = fakeApp({ workspace, waitForeverAt: 1 });
  const frozen = manifest();
  const result = await boundedExecuteSession({
    manifest: frozen, run: buildCacheSessionPlan(frozen)[0], workspace,
    prepared, appFactory: () => app, turnTimeoutMs: 20,
  });
  assert.equal(result.attempt.failure, 'timeout');
  assert.equal(result.attempt.turns.length, 1);
  assert.equal(result.attempt.turns[0].usage.delta.inputTokens, 100);
  assert.equal(app.requests.filter(({ method }) => method === 'turn/start').length, 1);
  assert.equal(app.requests.filter(({ method }) => method === 'turn/interrupt').length, 1);
  assert.equal(prepared.cleaned, true);
});

test('applies one wall-clock deadline across turn submission and completion', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-deadline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const frozen = manifest();
  let turnStartedAt = null;
  const result = await boundedExecuteSession({
    manifest: frozen, run: buildCacheSessionPlan(frozen)[0], workspace,
    prepared: fakePrepared(root, path.join(root, 'hooks.jsonl')),
    appFactory: () => fakeApp({
      workspace, turnStartDelayMs: 100, waitForeverAt: 1,
      onTurnStart: () => { turnStartedAt = Date.now(); },
    }),
    turnTimeoutMs: 120,
  });
  assert.equal(result.attempt.failure, 'timeout');
  assert.ok(turnStartedAt !== null);
  assert.ok(Date.now() - turnStartedAt < 190, 'turn submission and wait used separate timeout budgets');
});

test('resumes the six-session pilot into the same frozen 30-session plan without retries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const frozen = manifest();
  const options = {
    manifest: frozen, manifestPath: path.join(root, 'manifest.json'),
    ledgerPath: path.join(root, 'events.jsonl'), evidenceRoot: path.join(root, 'evidence'),
    workRoot: path.join(root, 'work'),
  };
  const calls = [];
  const execute = async ({ run }) => {
    calls.push(run.runKey);
    return { attempt: { schemaVersion: 'sando.cache-session-attempt.v1' } };
  };
  const pilot = await runCacheBenchmark({ ...options, sessionLimit: 6, execute });
  const full = await runCacheBenchmark({ ...options, execute });
  assert.deepEqual(pilot, { totalSessions: 30, completedSessions: 6, launchedSessions: 6, remainingSessions: 24 });
  assert.deepEqual(full, { totalSessions: 30, completedSessions: 30, launchedSessions: 24, remainingSessions: 0 });
  assert.equal(calls.length, 30);
  assert.equal(new Set(calls).size, 30);
  assert.equal(fs.readFileSync(options.ledgerPath, 'utf8').split('\n').filter((line) => line.includes('"type":"header"')).length, 1);
});

test('fails closed on malformed or unknown ledger records', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-ledger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = path.join(root, 'events.jsonl');
  fs.writeFileSync(ledger, '{bad json}\n', { mode: 0o600 });
  await assert.rejects(runCacheBenchmark({
    manifest: manifest(), manifestPath: path.join(root, 'manifest.json'), ledgerPath: ledger,
    evidenceRoot: path.join(root, 'evidence'), workRoot: path.join(root, 'work'),
    execute: async () => assert.fail('must not execute'),
  }), /invalid cache benchmark ledger JSON at line 1/);

  fs.rmSync(ledger, { force: true });
  await runCacheBenchmark({
    manifest: manifest(), manifestPath: path.join(root, 'manifest.json'), ledgerPath: ledger,
    evidenceRoot: path.join(root, 'evidence'), workRoot: path.join(root, 'work'), sessionLimit: 0,
    execute: async () => assert.fail('must not execute'),
  });
  fs.appendFileSync(ledger, `${JSON.stringify({ type: 'completed', runKey: 'unknown:1:control', attempt: {} })}\n`);
  await assert.rejects(runCacheBenchmark({
    manifest: manifest(), manifestPath: path.join(root, 'manifest.json'), ledgerPath: ledger,
    evidenceRoot: path.join(root, 'evidence'), workRoot: path.join(root, 'work'),
    execute: async () => assert.fail('must not execute'),
  }), /unknown run key/);
});

test('verifies every frozen source receipt file and archive before execution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'results'));
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"id":"sando-cache-v1"}\n');
  fs.writeFileSync(path.join(root, 'results', 'source.tar.gz'), 'archive\n');
  const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const required = cacheRequiredSourceFiles({ repoRoot: root, manifestPath: path.join(root, 'manifest.json') });
  for (const relative of required) {
    const target = path.join(root, relative);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `source ${relative}\n`);
  }
  const receipt = {
    schemaVersion: 'sando.cache-benchmark-source-receipt.v1', benchmarkId: 'sando-cache-v1',
    manifestSha256: digest(path.join(root, 'manifest.json')),
    archivePath: 'results/source.tar.gz', archiveSha256: digest(path.join(root, 'results/source.tar.gz')),
    files: Object.fromEntries(required.map((relative) => [relative, digest(path.join(root, relative))])),
    codex: {}, runtime: { node: process.version, platform: process.platform, arch: process.arch },
  };
  const receiptPath = path.join(root, 'receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.doesNotThrow(() => verifyCacheSourceReceipt({
    repoRoot: root, manifestPath: path.join(root, 'manifest.json'), sourceReceiptPath: receiptPath,
  }));
  const recoveryReceipt = { ...receipt, files: { ...receipt.files }, benchmarkId: 'sando-recovery-v1' };
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"id":"sando-recovery-v1"}\n');
  recoveryReceipt.manifestSha256 = digest(path.join(root, 'manifest.json'));
  recoveryReceipt.files['manifest.json'] = recoveryReceipt.manifestSha256;
  fs.writeFileSync(receiptPath, `${JSON.stringify(recoveryReceipt)}\n`);
  assert.doesNotThrow(() => verifyCacheSourceReceipt({
    repoRoot: root, manifestPath: path.join(root, 'manifest.json'), sourceReceiptPath: receiptPath,
  }));
  fs.writeFileSync(receiptPath, `${JSON.stringify({ ...recoveryReceipt, benchmarkId: 'sando-cache-v1' })}\n`);
  assert.throws(() => verifyCacheSourceReceipt({
    repoRoot: root, manifestPath: path.join(root, 'manifest.json'), sourceReceiptPath: receiptPath,
  }), /frozen source receipt is invalid/);
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"id":"sando-cache-v1"}\n');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  const verified = verifyCacheSourceReceipt({
    repoRoot: root, manifestPath: path.join(root, 'manifest.json'), sourceReceiptPath: receiptPath,
  });
  assert.equal(verified.archiveSha256, receipt.archiveSha256);
  delete receipt.files['scripts/run-sando-cache-benchmark.mjs'];
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.throws(() => verifyCacheSourceReceipt({
    repoRoot: root, manifestPath: path.join(root, 'manifest.json'), sourceReceiptPath: receiptPath,
  }), /frozen source receipt is missing required files/);
  receipt.files['scripts/run-sando-cache-benchmark.mjs'] = digest(path.join(root, 'scripts/run-sando-cache-benchmark.mjs'));
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  fs.writeFileSync(path.join(root, 'scripts', 'run-sando-cache-benchmark.mjs'), 'drift\n');
  assert.throws(() => verifyCacheSourceReceipt({
    repoRoot: root, manifestPath: path.join(root, 'manifest.json'), sourceReceiptPath: receiptPath,
  }), /frozen source receipt mismatch/);
});

test('rejects output paths that overlap immutable benchmark inputs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-overlap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest())}\n`);
  await assert.rejects(runCacheBenchmark({
    manifest: manifest(), manifestPath, ledgerPath: manifestPath,
    evidenceRoot: path.join(root, 'evidence'), workRoot: path.join(root, 'work'),
    execute: async () => assert.fail('must not execute'),
  }), /output path overlaps immutable input/);
});

test('rejects symlinked or public ledger and evidence outputs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-unsafe-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerTarget = path.join(root, 'target.jsonl');
  fs.writeFileSync(ledgerTarget, '', { mode: 0o600 });
  const ledger = path.join(root, 'events.jsonl');
  fs.symlinkSync(ledgerTarget, ledger);
  await assert.rejects(runCacheBenchmark({
    manifest: manifest(), manifestPath: path.join(root, 'manifest.json'), ledgerPath: ledger,
    evidenceRoot: path.join(root, 'evidence'), workRoot: path.join(root, 'work'), sessionLimit: 0,
  }), /ledger must be a private regular file/);
  fs.rmSync(ledger);
  fs.mkdirSync(path.join(root, 'evidence'), { mode: 0o755 });
  await assert.rejects(runCacheBenchmark({
    manifest: manifest(), manifestPath: path.join(root, 'manifest.json'), ledgerPath: ledger,
    evidenceRoot: path.join(root, 'evidence'), workRoot: path.join(root, 'work'), sessionLimit: 0,
  }), /evidence root must be a private directory/);
});

test('cleans the verified app root and captured descendants when close fails', async (t) => {
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const subprocess = spawn('sleep', ['60']);
    process.stdout.write(String(subprocess.pid) + '\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const descendantPid = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) resolve(Number(text.trim()));
    });
    child.once('error', reject);
  });
  const captured = snapshotOwnedProcessTree(child.pid);
  assert.ok(captured.some(({ pid }) => pid === child.pid));
  assert.ok(captured.some(({ pid }) => pid === descendantPid));
  await cleanupOwnedApp({
    app: { child: { pid: child.pid }, close: async () => { throw new Error('close failed'); } },
    rootIdentity: captured.find(({ pid }) => pid === child.pid),
    snapshots: captured,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
  assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
});

test('starts an app-server in an owned process group only when requested', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-detached-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'fake-app-server');
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n`, { mode: 0o700 });
  const app = startAppServer(executable, { cwd: root, env: process.env, detached: true });
  const identity = snapshotOwnedProcessTree(app.child.pid)[0];
  assert.equal(identity.processGroup, identity.pid);
  await app.close();
});

test('bounds stalled hook discovery and removes private subscription state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-prepare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const authPath = path.join(root, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: `x.${payload}.x` } }));
  let privateRoot;
  let closed = false;
  await assert.rejects(prepareSubscriptionEnvironment({
    workspace, arm: 'apply', codexPath: '/fake/codex', sourceAuthPath: authPath,
    startupTimeoutMs: 20,
    appFactory(_codexPath, { env }) {
      privateRoot = path.dirname(env.CODEX_HOME);
      return {
        initialize: async () => {}, request: async () => new Promise(() => {}),
        close: async () => { closed = true; },
      };
    },
  }), (error) => error.code === 'SUBSCRIPTION_SETUP_TIMEOUT');
  assert.equal(closed, true);
  assert.equal(fs.existsSync(privateRoot), false);
});

test('cleans a captured detached-group child after the leader exits', async (t) => {
  const leader = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const subprocess = spawn('sleep', ['60']);
    process.stdout.write(String(subprocess.pid) + '\\n');
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { process.kill(leader.pid, 'SIGKILL'); } catch {} });
  const childPid = await new Promise((resolve) => leader.stdout.once('data', (chunk) => resolve(Number(chunk.toString().trim()))));
  const captured = snapshotOwnedProcessTree(leader.pid);
  const rootIdentity = captured.find(({ pid }) => pid === leader.pid);
  assert.ok(captured.some(({ pid }) => pid === childPid));
  process.kill(leader.pid, 'SIGTERM');
  await new Promise((resolve) => leader.once('close', resolve));
  await cleanupOwnedApp({
    app: { child: { pid: leader.pid }, close: async () => ({ exited: true }) },
    rootIdentity,
    snapshots: captured,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
});

test('does not inspect a reused or identity-mismatched process id', () => {
  const current = snapshotOwnedProcessTree(process.pid)[0];
  assert.ok(current);
  assert.deepEqual(snapshotOwnedProcessTree(process.pid, { ...current, startTime: 'wrong' }), []);
});
