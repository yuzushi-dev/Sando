import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import * as benchmarkRunner from '../../../scripts/run-sando-benchmark.mjs';

import {
  buildBenchmarkPlan,
  blockedBenchmarkReceipt,
  evaluateSuccessCriteria,
  materializeTaskRepository,
  normalizeBenchmarkUsage,
  runBenchmark,
  snapshotProtectedFiles,
  verifyProtectedFiles,
} from '../../../scripts/run-sando-benchmark.mjs';

const manifest = JSON.parse(fs.readFileSync(
  path.resolve(import.meta.dirname, '../benchmarks/sando-v1.json'), 'utf8'));
const v2ManifestPath = path.resolve(import.meta.dirname, '../benchmarks/sando-v2.json');
const v1LedgerPath = path.resolve(import.meta.dirname, '../benchmarks/results/sando-v1-events.jsonl');

function smallManifest(taskCount = 1) {
  return {
    ...manifest,
    repetitionsPerArm: 1,
    tasks: manifest.tasks.slice(0, taskCount).map((task) => ({
      ...task, schedule: [task.schedule[0]],
    })),
  };
}

function completedAttempt(run) {
  return {
    schemaVersion: 'sando.benchmark-attempt.v1', benchmarkId: run.benchmarkId,
    taskId: run.taskId, arm: run.arm, repetition: run.repetition,
    orderPosition: run.orderPosition, outcome: 'passed', successVerified: true,
    attempts: 1, durationMs: 1, toolCalls: 1, artifactRetrievals: 0,
    cache: { status: 'unavailable', readInputTokens: null, writeInputTokens: null },
    cost: { status: 'incomplete', estimatedApiCostUsd: null, supportedSubtotalUsd: null },
  };
}

test('run plan expands the frozen counterbalanced schedule to 100 runs', () => {
  const plan = buildBenchmarkPlan(manifest);
  assert.equal(plan.length, 100);
  assert.deepEqual(plan.slice(0, 4).map(({ taskId, repetition, arm, orderPosition }) => (
    [taskId, repetition, arm, orderPosition]
  )), [
    ['locate-log-failure', 1, 'control', 1],
    ['locate-log-failure', 1, 'apply', 2],
    ['locate-log-failure', 2, 'apply', 1],
    ['locate-log-failure', 2, 'control', 2],
  ]);
  assert.deepEqual(plan.reduce((counts, run) => {
    counts[run.arm] += 1;
    return counts;
  }, { apply: 0, control: 0 }), { apply: 50, control: 50 });
});

test('run plan rejects unsafe and duplicate task IDs', () => {
  assert.throws(() => buildBenchmarkPlan({
    ...smallManifest(),
    tasks: [{ ...smallManifest().tasks[0], id: '../../victim' }],
  }), /task id/i);
  const repeated = smallManifest().tasks[0];
  assert.throws(() => buildBenchmarkPlan({
    ...smallManifest(), tasks: [repeated, { ...repeated }],
  }), /duplicate task id/i);
});

test('future native records preserve the cache-write alias', () => {
  assert.deepEqual(normalizeBenchmarkUsage({
    input_tokens: 100,
    cached_input_tokens: 80,
    cache_write_input_tokens: 10,
    output_tokens: 20,
  }), {
    inputTokens: 100,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 10,
    outputTokens: 20,
  });
});

test('missing metered relay fails closed before any model request', () => {
  assert.deepEqual(blockedBenchmarkReceipt(manifest, 20), {
    schemaVersion: 'sando.benchmark-run-receipt.v1',
    benchmarkId: 'sando-v1',
    status: 'not-run',
    reason: 'api-key-required-for-input-token-preflight',
    budgetCapUsd: 20,
    attemptedRuns: 0,
    modelRequests: 0,
    estimatedApiCostUsd: 0,
  });
});

test('materialized arms start from identical clean synthetic git commits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-materialize-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const task = manifest.tasks[0];
  const left = materializeTaskRepository(path.join(root, 'left'), task);
  const right = materializeTaskRepository(path.join(root, 'right'), task);
  assert.equal(left.commit, right.commit);
  assert.equal(left.dirty, false);
  assert.equal(right.dirty, false);
  assert.equal(fs.readFileSync(path.join(root, 'left/service.log'), 'utf8'), task.fixture.files['service.log']);
});

test('materialization rejects fixture paths outside the synthetic workspace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-materialize-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => materializeTaskRepository(root, {
    ...manifest.tasks[0], fixture: { files: { '../escape.txt': 'blocked' } },
  }), /fixture path/);
});

test('protected fixture changes invalidate success', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-protected-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const task = manifest.tasks.find(({ id }) => id === 'repair-csv-parser');
  materializeTaskRepository(root, task);
  const snapshot = snapshotProtectedFiles(root, task.protectedPaths);
  assert.equal(verifyProtectedFiles(root, snapshot).passed, true);
  fs.appendFileSync(path.join(root, 'parse.test.mjs'), '// weakened\n');
  assert.deepEqual(verifyProtectedFiles(root, snapshot), {
    passed: false,
    changed: ['parse.test.mjs'],
  });
});

test('success checks require all commands and file assertions to pass', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-checks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'answer.txt'), 'expected evidence\n');
  const passed = evaluateSuccessCriteria(root, [
    { type: 'command', command: 'node -e "process.exit(0)"' },
    { type: 'file_contains', path: 'answer.txt', value: 'expected' },
    { type: 'file_not_contains', path: 'answer.txt', value: 'secret' },
  ]);
  assert.equal(passed.passed, true);
  assert.equal(passed.checks.length, 3);
  const failed = evaluateSuccessCriteria(root, [
    { type: 'command', command: 'node -e "process.exit(7)"' },
    { type: 'file_contains', path: 'missing.txt', value: 'anything' },
  ]);
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.checks.map(({ passed: value }) => value), [false, false]);
  fs.writeFileSync(path.join(root, 'protected.txt'), 'expected evidence\n');
  fs.symlinkSync(path.join(root, 'protected.txt'), path.join(root, 'symlink-answer.txt'));
  fs.linkSync(path.join(root, 'protected.txt'), path.join(root, 'hard-link-answer.txt'));
  assert.equal(evaluateSuccessCriteria(root, [
    { type: 'file_contains', path: 'symlink-answer.txt', value: 'expected evidence' },
  ]).passed, false);
  assert.equal(evaluateSuccessCriteria(root, [
    { type: 'file_contains', path: 'hard-link-answer.txt', value: 'expected evidence' },
  ], { protectedPaths: ['protected.txt'] }).passed, false);
});

test('v2 documentation grading reads the named protected changelog but rejects its hard-link alias', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-protected-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const v2 = JSON.parse(fs.readFileSync(v2ManifestPath, 'utf8'));
  const task = v2.tasks.find(({ id }) => id === 'reconcile-documentation');
  materializeTaskRepository(root, task);
  const protectedSnapshot = snapshotProtectedFiles(root, task.protectedPaths);
  fs.writeFileSync(path.join(root, 'README.md'),
    '# Client\n\nThe default timeout is 30 seconds.\n\nSource: config.mjs.\n');
  fs.linkSync(path.join(root, 'CHANGELOG.md'), path.join(root, 'answer.md'));

  assert.equal(evaluateSuccessCriteria(root, task.successCriteria, {
    protectedPaths: task.protectedPaths,
  }).passed, true);
  assert.equal(verifyProtectedFiles(root, protectedSnapshot).passed, true);
  assert.equal(evaluateSuccessCriteria(root, [
    { type: 'file_contains', path: 'answer.md', value: 'from 15 to 30 seconds' },
  ], { protectedPaths: task.protectedPaths }).passed, false);
});

test('orchestrator persists started and completed events for exact scheduled coverage', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-orchestrator-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerPath = path.join(root, 'events.jsonl');
  const result = await runBenchmark({
    manifest: smallManifest(), ledgerPath, workRoot: path.join(root, 'work'), concurrency: 1,
    execute: async (run) => ({ attempt: completedAttempt(run), quotaFailure: false }),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.attempts.length, 2);
  const events = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(({ type }) => type), ['started', 'completed', 'started', 'completed']);
});

test('resume records a stale started run as failed and does not rerun it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerPath = path.join(root, 'events.jsonl');
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    schemaVersion: 'sando.benchmark-run-event.v1', type: 'started',
    runKey: 'locate-log-failure:1:control',
    startedAt: '2026-09-30T12:00:00.000Z',
  })}\n`);
  const executed = [];
  const result = await runBenchmark({
    manifest: smallManifest(), ledgerPath, workRoot: path.join(root, 'work'), concurrency: 1,
    execute: async (run) => {
      executed.push(run.arm);
      return { attempt: completedAttempt(run), quotaFailure: false };
    },
  });
  assert.deepEqual(executed, ['apply']);
  const interrupted = result.attempts.find(({ arm }) => arm === 'control');
  assert.equal(interrupted.successVerified, false);
  assert.equal(interrupted.startedAt, '2026-09-30T12:00:00.000Z');
  assert.equal(typeof interrupted.finishedAt, 'string');
  assert.equal(interrupted.durationMs, null);
  assert.equal(interrupted.toolCalls, null);
  assert.equal(interrupted.artifactRetrievals, null);
  assert.equal(result.status, 'complete');
});

test('resume fails closed on a truncated ledger event', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-ledger-corrupt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerPath = path.join(root, 'events.jsonl');
  fs.writeFileSync(ledgerPath, [
    JSON.stringify({
      schemaVersion: 'sando.benchmark-run-event.v1', type: 'started',
      runKey: 'locate-log-failure:1:control', startedAt: '2026-09-30T12:00:00.000Z',
    }),
    '{"schemaVersion":"sando.benchmark-run-event.v1","type":"completed"',
  ].join('\n'));
  await assert.rejects(runBenchmark({
    manifest: smallManifest(), ledgerPath, workRoot: path.join(root, 'work'), concurrency: 1,
    execute: async () => assert.fail('must not rerun from a corrupt ledger'),
  }), /invalid benchmark ledger JSON at line 2/i);
});

test('unknown ledger keys are rejected and quota failure stops future scheduled runs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unknown = path.join(root, 'unknown.jsonl');
  fs.writeFileSync(unknown, `${JSON.stringify({ type: 'completed', runKey: 'unknown:1:control', attempt: {} })}\n`);
  await assert.rejects(runBenchmark({
    manifest: smallManifest(), ledgerPath: unknown, workRoot: path.join(root, 'unknown-work'), concurrency: 1,
    execute: async () => assert.fail('must not execute'),
  }), /unknown run key/);

  let calls = 0;
  const stopped = await runBenchmark({
    manifest: smallManifest(2), ledgerPath: path.join(root, 'stop.jsonl'),
    workRoot: path.join(root, 'stop-work'), concurrency: 1,
    execute: async (run) => {
      calls += 1;
      return { attempt: completedAttempt(run), quotaFailure: true };
    },
  });
  assert.equal(calls, 1);
  assert.equal(stopped.status, 'partial');
  assert.equal(stopped.attempts.length, 1);
});

test('v2 freezes complete source-line citations without changing v1 grading', () => {
  assert.equal(createHash('sha256').update(fs.readFileSync(
    path.resolve(import.meta.dirname, '../benchmarks/sando-v1.json'))).digest('hex'),
  '2fb5ae5ccda5433b4674dcadb8e19d7d983602b73e6873a4bbd1f73fac900eb0');
  assert.equal(fs.existsSync(v2ManifestPath), true, 'sando-v2.json must exist');
  const v2 = JSON.parse(fs.readFileSync(v2ManifestPath, 'utf8'));
  assert.equal(v2.id, 'sando-v2');
  assert.equal(buildBenchmarkPlan(v2).length, 100);
  assert.match(v2.statusReason, /v1.+not directly comparable/i);

  const v1Log = manifest.tasks.find(({ id }) => id === 'locate-log-failure');
  assert.equal(v1Log.successCriteria.some(({ value }) => value === '004 WARN request=req-17 worker=payment retry=2 upstream_timeout'), false);
  const v2Log = v2.tasks.find(({ id }) => id === 'locate-log-failure');
  assert.match(v2Log.prompt, /entire preceding retry and error lines/i);
  assert.deepEqual(v2Log.successCriteria.slice(-2).map(({ value }) => value), [
    '004 WARN request=req-17 worker=payment retry=2 upstream_timeout',
    '005 ERROR request=req-17 worker=payment retry=2 code=E_PAYMENT_LOCKED stopped',
  ]);

  const v2Artifact = v2.tasks.find(({ id }) => id === 'recover-artifact-evidence');
  assert.match(v2Artifact.prompt, /complete cited source lines/i);
  assert.deepEqual(v2Artifact.successCriteria.slice(-3).map(({ value }) => value), [
    '2 target=staging-eu',
    '4 check=database-migrations status=failed',
    '6 rollback_revision=7fa21c9',
  ]);
});

test('the private v1 benchmark ledger retains its frozen digest', {
  skip: fs.existsSync(v1LedgerPath) ? false : 'private historical v1 ledger is unavailable',
}, () => {
  assert.equal(createHash('sha256').update(fs.readFileSync(v1LedgerPath)).digest('hex'),
    'aa91be7fcf2c1226b95c0caad2795788fef5e24d68bf446769108c19925e85dc');
});

test('v2 exact-line grader accepts surrounding prose and rejects ambiguous answers', (t) => {
  assert.equal(fs.existsSync(v2ManifestPath), true, 'sando-v2.json must exist');
  const v2 = JSON.parse(fs.readFileSync(v2ManifestPath, 'utf8'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-v2-grading-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logTask = v2.tasks.find(({ id }) => id === 'locate-log-failure');
  const valid = [
    'Analysis follows.',
    '004 WARN request=req-17 worker=payment retry=2 upstream_timeout',
    '005 ERROR request=req-17 worker=payment retry=2 code=E_PAYMENT_LOCKED stopped',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'report.md'), valid);
  assert.equal(evaluateSuccessCriteria(root, logTask.successCriteria).passed, true);

  for (const invalid of [
    'req-17 E_PAYMENT_LOCKED retry=2 lines 004 and 005',
    '004 WARN request=req-17 worker=payment retry=1 upstream_timeout\n005 ERROR request=req-17 worker=payment retry=2 code=E_PAYMENT_LOCKED stopped',
    '005 ERROR request=req-17 worker=payment retry=2 code=E_PAYMENT_LOCKED stopped\n004 WARN request=req-17 worker=payment retry=2 fabricated',
    '',
  ]) {
    fs.writeFileSync(path.join(root, 'report.md'), invalid);
    assert.equal(evaluateSuccessCriteria(root, logTask.successCriteria).passed, false, invalid);
  }

  const artifactTask = v2.tasks.find(({ id }) => id === 'recover-artifact-evidence');
  fs.writeFileSync(path.join(root, 'evidence.md'), [
    'Complete citations:',
    '2 target=staging-eu',
    '4 check=database-migrations status=failed',
    '6 rollback_revision=7fa21c9',
  ].join('\n'));
  assert.equal(evaluateSuccessCriteria(root, artifactTask.successCriteria).passed, true);
  for (const invalid of [
    '4 target=staging-eu\n2 check=database-migrations status=failed\n6 rollback_revision=7fa21c9',
    '2 target=staging-eu\n4 check=database-migrations status=passed\n6 rollback_revision=7fa21c9',
    'staging-eu database-migrations 7fa21c9 line 2 line 4 line 6',
    '',
  ]) {
    fs.writeFileSync(path.join(root, 'evidence.md'), invalid);
    assert.equal(evaluateSuccessCriteria(root, artifactTask.successCriteria).passed, false, invalid);
  }
});

test('manifest-derived paths isolate v2 from the immutable v1 ledger', (t) => {
  assert.equal(typeof benchmarkRunner.resolveBenchmarkPaths, 'function');
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const v2 = { ...manifest, id: 'sando-v2' };
  const paths = benchmarkRunner.resolveBenchmarkPaths({ repoRoot, manifestPath: v2ManifestPath, manifest: v2 });
  assert.match(paths.ledgerPath, /sando-v2-events\.jsonl$/);
  assert.doesNotMatch(paths.ledgerPath, /sando-v1-events\.jsonl$/);
  assert.throws(() => benchmarkRunner.resolveBenchmarkPaths({
    repoRoot, manifestPath: v2ManifestPath, manifest: v2,
    ledgerPath: path.join(repoRoot, 'packages/sando/benchmarks/sando-v1.json'),
  }), /historical sando-v1/i);
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-results-alias-'));
  t.after(() => fs.rmSync(aliasRoot, { recursive: true, force: true }));
  const sharedOutput = path.join(aliasRoot, 'shared-output');
  assert.throws(() => benchmarkRunner.resolveBenchmarkPaths({
    repoRoot, manifestPath: v2ManifestPath, manifest: v2,
    ledgerPath: sharedOutput, evidenceRoot: sharedOutput,
  }), /must differ/i);
  assert.throws(() => benchmarkRunner.resolveBenchmarkPaths({
    repoRoot, manifestPath: v2ManifestPath, manifest: v2,
    ledgerPath: path.join(sharedOutput, 'events.jsonl'), evidenceRoot: sharedOutput,
  }), /must differ/i);
  const syntheticRepo = path.join(aliasRoot, 'repo');
  const syntheticResults = path.join(syntheticRepo, 'packages/sando/benchmarks/results');
  fs.mkdirSync(syntheticResults, { recursive: true });
  fs.writeFileSync(path.join(syntheticRepo, 'packages/sando/benchmarks/sando-v1.json'), '{}');
  const historicalResult = path.join(syntheticResults, 'sando-v1-summary.jsonl');
  const hardLinkAlias = path.join(aliasRoot, 'hard-link-ledger.jsonl');
  fs.writeFileSync(historicalResult, '{}\n');
  fs.linkSync(historicalResult, hardLinkAlias);
  assert.throws(() => benchmarkRunner.resolveBenchmarkPaths({
    repoRoot: syntheticRepo, manifestPath: v2ManifestPath, manifest: v2, ledgerPath: hardLinkAlias,
  }), /historical sando-v1/i);
  const historicalArchive = path.join(syntheticResults, 'sando-v1-evidence');
  fs.mkdirSync(path.join(historicalArchive, 'attempt'), { recursive: true });
  fs.writeFileSync(path.join(historicalArchive, 'attempt/evidence.json'), '{}\n');
  for (const [field, target] of [
    ['ledgerPath', path.join(historicalArchive, 'attempt/new-events.jsonl')],
    ['evidenceRoot', path.join(historicalArchive, 'attempt/new-evidence')],
  ]) {
    assert.throws(() => benchmarkRunner.resolveBenchmarkPaths({
      repoRoot: syntheticRepo, manifestPath: v2ManifestPath, manifest: v2, [field]: target,
    }), /historical sando-v1/i);
  }
  for (const id of ['../sando-v2', '/tmp/sando-v2', 'sando_v2', 'sando-v2/escape']) {
    assert.throws(() => benchmarkRunner.resolveBenchmarkPaths({
      repoRoot, manifestPath: v2ManifestPath, manifest: { ...manifest, id },
    }), /benchmark id/i);
  }
  assert.throws(() => benchmarkRunner.resolveBenchmarkPaths({
    repoRoot, manifestPath: v2ManifestPath, manifest: v2,
    ledgerPath: path.join(repoRoot, 'scripts/run-sando-benchmark.mjs'),
  }), /protected benchmark input/i);
  assert.throws(() => benchmarkRunner.resolveBenchmarkPaths({
    repoRoot, manifestPath: v2ManifestPath, manifest: v2,
    evidenceRoot: path.join(repoRoot, 'adapters/codex/sando/benchmark-output'),
  }), /protected benchmark input/i);
});

test('v2 paths cannot reuse existing private v1 benchmark outputs', {
  skip: fs.existsSync(v1LedgerPath) ? false : 'private historical v1 ledger is unavailable',
}, (t) => {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const v2 = { ...manifest, id: 'sando-v2' };
  assert.throws(() => benchmarkRunner.resolveBenchmarkPaths({
    repoRoot, manifestPath: v2ManifestPath, manifest: v2, ledgerPath: v1LedgerPath,
  }), /collision/i);
  const historicalResults = fs.readdirSync(path.dirname(v1LedgerPath))
    .filter((name) => name.startsWith('sando-v1'))
    .map((name) => path.join(path.dirname(v1LedgerPath), name));
  for (const ledgerPath of historicalResults) {
    assert.throws(() => benchmarkRunner.resolveBenchmarkPaths({
      repoRoot, manifestPath: v2ManifestPath, manifest: v2, ledgerPath,
    }), /historical sando-v1/i, ledgerPath);
  }
  assert.throws(() => benchmarkRunner.resolveBenchmarkPaths({
    repoRoot, manifestPath: v2ManifestPath, manifest: v2,
    evidenceRoot: path.dirname(v1LedgerPath),
  }), /historical sando-v1/i);
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-results-alias-'));
  t.after(() => fs.rmSync(aliasRoot, { recursive: true, force: true }));
  const resultsAlias = path.join(aliasRoot, 'results');
  fs.symlinkSync(path.dirname(v1LedgerPath), resultsAlias);
  assert.throws(() => benchmarkRunner.resolveBenchmarkPaths({
    repoRoot, manifestPath: v2ManifestPath, manifest: v2,
    ledgerPath: path.join(resultsAlias, path.basename(v1LedgerPath)),
  }), /collision/i);
});

test('synthetic evidence retains only declared regular outputs within caps', (t) => {
  assert.equal(typeof benchmarkRunner.retainSyntheticEvidence, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'report.md'), 'token=sk-live-secret\n' + 'x'.repeat(80));
  fs.writeFileSync(path.join(workspace, 'raw.log'), 'protected secret');
  fs.symlinkSync(path.join(workspace, 'raw.log'), path.join(workspace, 'linked.md'));
  fs.linkSync(path.join(workspace, 'raw.log'), path.join(workspace, 'hard-linked.md'));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'escaped.md'), 'must not retain');
  fs.symlinkSync(outside, path.join(workspace, 'linked-directory'));
  fs.mkdirSync(path.join(workspace, '.codex'));
  fs.writeFileSync(path.join(workspace, '.codex/auth.json'), '{"access_token":"must-not-retain"}');
  const task = {
    id: 'evidence-task', protectedPaths: ['raw.log'],
    successCriteria: [
      { type: 'file_contains', path: 'report.md', value: 'x' },
      { type: 'file_contains', path: 'linked.md', value: 'x' },
      { type: 'file_contains', path: 'hard-linked.md', value: 'x' },
      { type: 'file_contains', path: 'linked-directory/escaped.md', value: 'x' },
      { type: 'file_contains', path: 'nested/../raw.log', value: 'x' },
      { type: 'file_contains', path: '.codex/auth.json', value: 'x' },
      { type: 'command', command: 'true' },
    ],
  };
  const receipt = benchmarkRunner.retainSyntheticEvidence({
    workspace, evidenceRoot, task,
    run: { benchmarkId: 'sando-v2', taskId: task.id, repetition: 1, arm: 'apply', orderPosition: 1 },
    verification: { passed: true, checks: [] },
    provenance: { manifestSha256: 'a'.repeat(64), runnerSha256: 'b'.repeat(64), authentication: 'chatgpt-subscription' },
    diagnostics: {
      finalMessage: 'Bearer abc-secret access_token=xyz-secret OPENAI_API_KEY=env-secret {"refresh_token":"json-secret","id_token":"id-secret"}',
      stdout: 'must not retain',
    },
    limits: { perFileBytes: 64, perAttemptBytes: 4096, totalBytes: 8192 },
  });
  assert.equal(receipt.status, 'available');
  assert.equal(receipt.files.length, 1);
  assert.equal(receipt.files[0].path, 'report.md');
  assert.equal(receipt.files[0].truncated, true);
  const evidenceDirectory = path.dirname(receipt.metadataPath);
  assert.equal(fs.statSync(evidenceDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(evidenceDirectory, receipt.files[0].storedAs)).mode & 0o777, 0o600);
  const metadata = JSON.parse(fs.readFileSync(receipt.metadataPath, 'utf8'));
  assert.equal(metadata.diagnostics.finalMessage.text.includes('abc-secret'), false);
  assert.equal(metadata.diagnostics.finalMessage.text.includes('xyz-secret'), false);
  assert.equal(metadata.diagnostics.finalMessage.text.includes('json-secret'), false);
  assert.equal(metadata.diagnostics.finalMessage.text.includes('id-secret'), false);
  assert.equal(metadata.diagnostics.finalMessage.text.includes('env-secret'), false);
  assert.equal('stdout' in metadata.diagnostics, false);
  assert.equal(fs.existsSync(path.join(evidenceDirectory, 'raw.log')), false);
});

test('synthetic evidence excludes a protected file explicitly named by success criteria', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-protected-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'CHANGELOG.md'),
    'Changed the default timeout from 15 to 30 seconds.\n');

  const receipt = benchmarkRunner.retainSyntheticEvidence({
    workspace, evidenceRoot: path.join(root, 'evidence'),
    task: {
      id: 'protected-evidence',
      protectedPaths: ['CHANGELOG.md'],
      successCriteria: [
        { type: 'file_contains', path: 'CHANGELOG.md', value: 'from 15 to 30 seconds' },
      ],
    },
    run: {
      benchmarkId: 'sando-v2', taskId: 'protected-evidence', repetition: 1,
      arm: 'control', orderPosition: 1,
    },
    verification: { passed: true, checks: [] },
    limits: { perFileBytes: 4096, perAttemptBytes: 8192, totalBytes: 16384 },
  });

  assert.equal(receipt.status, 'available');
  assert.deepEqual(receipt.files, []);
  assert.equal(fs.existsSync(path.join(path.dirname(receipt.metadataPath), 'outputs/CHANGELOG.md')), false);
});

test('evidence scrubs exact current auth values but preserves synthetic fixture strings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-evidence-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const accessToken = 'real.header.payload.signature';
  const rotatedToken = 'rotated.header.payload.signature';
  fs.writeFileSync(path.join(workspace, 'report.md'),
    `access=${accessToken}\nrotated=${rotatedToken}\nsynthetic=sk-live-secret\n`);
  const receipt = benchmarkRunner.retainSyntheticEvidence({
    workspace, evidenceRoot: path.join(root, 'evidence'),
    task: { id: 'auth-task', protectedPaths: [], successCriteria: [
      { type: 'file_contains', path: 'report.md', value: 'synthetic' },
    ] },
    run: { benchmarkId: 'sando-v2', taskId: 'auth-task', repetition: 1, arm: 'control', orderPosition: 1 },
    verification: { passed: false, checks: [] }, provenance: {},
    diagnostics: { finalMessage: `tokens ${accessToken} ${rotatedToken} sk-live-secret` },
    credentialValues: [accessToken, rotatedToken],
    limits: { perFileBytes: 4096, perAttemptBytes: 8192, totalBytes: 16384 },
  });
  assert.equal(receipt.status, 'available');
  const evidenceDirectory = path.dirname(receipt.metadataPath);
  const output = fs.readFileSync(path.join(evidenceDirectory, receipt.files[0].storedAs), 'utf8');
  const metadataText = fs.readFileSync(receipt.metadataPath, 'utf8');
  assert.equal(output.includes(accessToken), false);
  assert.equal(output.includes(rotatedToken), false);
  assert.match(output, /synthetic=sk-live-secret/);
  assert.equal(metadataText.includes(accessToken), false);
  assert.equal(metadataText.includes(rotatedToken), false);
  assert.equal(receipt.files[0].redacted, true);
  assert.equal(receipt.files[0].credentialRedactions, 2);
});

test('diagnostic retention marks final-message, command, and count truncation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-diagnostic-caps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const receipt = benchmarkRunner.retainSyntheticEvidence({
    workspace, evidenceRoot: path.join(root, 'evidence'),
    task: { id: 'diagnostic-task', protectedPaths: [], successCriteria: [] },
    run: { benchmarkId: 'sando-v2', taskId: 'diagnostic-task', repetition: 1, arm: 'control', orderPosition: 1 },
    verification: { passed: false, checks: [] }, provenance: {},
    diagnostics: {
      finalMessage: `${'f'.repeat(32 * 1024 - 1)}€${'f'.repeat(1024)}`,
      commands: ['c'.repeat(3 * 1024), ...Array.from({ length: 64 }, (_, index) => `command-${index}`)],
    },
    limits: { perFileBytes: 64 * 1024, perAttemptBytes: 256 * 1024, totalBytes: 512 * 1024 },
  });
  assert.equal(receipt.status, 'available');
  assert.equal(receipt.overflow, true);
  const metadata = JSON.parse(fs.readFileSync(receipt.metadataPath, 'utf8'));
  assert.equal(metadata.diagnostics.finalMessage.truncated, true);
  assert.equal(Buffer.byteLength(metadata.diagnostics.finalMessage.text) <= 32 * 1024, true);
  assert.equal(metadata.diagnostics.finalMessage.text.includes('\uFFFD'), false);
  assert.equal(metadata.diagnostics.commands.items[0].truncated, true);
  assert.equal(metadata.diagnostics.commands.omittedCount, 1);
});

test('evidence cap and write failures are explicit', (t) => {
  assert.equal(typeof benchmarkRunner.retainSyntheticEvidence, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-evidence-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'out.md'), 'x'.repeat(1800));
  const common = {
    workspace,
    task: { id: 'task', protectedPaths: [], successCriteria: [{ type: 'file_contains', path: 'out.md', value: 'x' }] },
    run: { benchmarkId: 'sando-v2', taskId: 'task', repetition: 1, arm: 'control', orderPosition: 1 },
    verification: { passed: true, checks: [] }, provenance: {}, diagnostics: {},
  };
  const capped = benchmarkRunner.retainSyntheticEvidence({
    ...common, evidenceRoot: path.join(root, 'capped'),
    limits: { perFileBytes: 1800, perAttemptBytes: 2048, totalBytes: 4096 },
  });
  assert.equal(capped.status, 'available');
  assert.equal(capped.overflow, true);
  const retainedAttemptBytes = fs.readdirSync(path.dirname(capped.metadataPath), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce((total, entry) => total + fs.statSync(path.join(entry.parentPath, entry.name)).size, 0);
  assert.equal(retainedAttemptBytes <= 2048, true);
  fs.writeFileSync(path.join(root, 'not-a-directory'), 'x');
  const failed = benchmarkRunner.retainSyntheticEvidence({
    ...common, evidenceRoot: path.join(root, 'not-a-directory'),
    limits: { perFileBytes: 64, perAttemptBytes: 256, totalBytes: 512 },
  });
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /Error$/);
});

test('ledger lock rejects a competing supervisor and recovers a verified stale owner', (t) => {
  assert.equal(typeof benchmarkRunner.acquireLedgerLock, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerPath = path.join(root, 'events.jsonl');
  const first = benchmarkRunner.acquireLedgerLock(ledgerPath, { pid: process.pid, startedAt: '2026-09-30T12:00:00.000Z' });
  assert.throws(() => benchmarkRunner.acquireLedgerLock(ledgerPath), /active supervisor/i);
  first.release();

  const lockPath = `${ledgerPath}.lock`;
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'corrupt.json'), 'not-json');
  assert.throws(() => benchmarkRunner.acquireLedgerLock(ledgerPath), /cannot verify stale/i);
  fs.rmSync(lockPath, { recursive: true });

  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'stale.json'), JSON.stringify({
    pid: 2147483647, startedAt: '2000-01-01T00:00:00.000Z', token: 'stale-token',
  }));
  const recovered = benchmarkRunner.acquireLedgerLock(ledgerPath);
  assert.equal(recovered.recoveredStale, true);
  recovered.release();
});

test('Codex executable receipt resolves and hashes the native binary behind a shell wrapper', (t) => {
  assert.equal(typeof benchmarkRunner.codexExecutableReceipt, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'codex-package');
  const launcher = path.join(packageRoot, 'bin/codex.js');
  const native = path.join(packageRoot, 'node_modules/@openai/codex-linux-x64/vendor/test-target/bin/codex');
  const wrapper = path.join(root, 'codex');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(launcher, '#!/usr/bin/env node\nprocess.stdout.write("codex-cli 0.159.2\\n");\n');
  fs.chmodSync(launcher, 0o700);
  fs.writeFileSync(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]));
  fs.chmodSync(native, 0o700);
  fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nexec "${launcher}" "$@"\n`);
  fs.chmodSync(wrapper, 0o700);
  const receipt = benchmarkRunner.codexExecutableReceipt(wrapper, {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  });
  assert.equal(receipt.binaryPath, fs.realpathSync(native));
  assert.equal(receipt.binarySha256, createHash('sha256').update(fs.readFileSync(native)).digest('hex'));
  assert.deepEqual(receipt.chain.map(({ realpath }) => realpath), [
    fs.realpathSync(wrapper), fs.realpathSync(launcher), fs.realpathSync(native),
  ]);
  fs.appendFileSync(launcher, '// drift\n');
  const changed = benchmarkRunner.codexExecutableReceipt(wrapper, {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  });
  assert.throws(() => benchmarkRunner.assertExecutionProvenance(
    { runnerSha256: 'a', bundleSha256: 'b', sourceSha256: 'c', codex: receipt },
    { runnerSha256: 'a', bundleSha256: 'b', sourceSha256: 'c', codex: changed },
  ), /execution provenance drift/i);
});

test('bounded local child timeout terminates only its owned process group', async (t) => {
  assert.equal(typeof benchmarkRunner.boundedProcess, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-child-group-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'parent.mjs');
  const descendantPidPath = path.join(root, 'descendant.pid');
  fs.writeFileSync(script, [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "fs.writeFileSync(process.argv[2], String(child.pid));",
    "setInterval(() => {}, 1000);",
  ].join('\n'));
  const result = await benchmarkRunner.boundedProcess(process.execPath, [script, descendantPidPath], {
    cwd: root, env: process.env, timeoutMs: 100,
  });
  assert.equal(result.timedOut, true);
  const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
  await delay(50);
  let state = null;
  try { state = fs.readFileSync(`/proc/${descendantPid}/stat`, 'utf8').split(' ')[2]; } catch {}
  assert.equal(state === null || state === 'Z', true, `descendant state: ${state}`);
});

test('bounded local child drains its owned process group after a normal leader exit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-child-group-close-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'parent.mjs');
  const descendantPidPath = path.join(root, 'descendant.pid');
  fs.writeFileSync(script, [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "child.unref();",
    "fs.writeFileSync(process.argv[2], String(child.pid));",
  ].join('\n'));
  const result = await benchmarkRunner.boundedProcess(process.execPath, [script, descendantPidPath], {
    cwd: root, env: process.env, timeoutMs: 5_000,
  });
  assert.equal(result.status, 0);
  const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
  await delay(150);
  let state = null;
  try { state = fs.readFileSync(`/proc/${descendantPid}/stat`, 'utf8').split(' ')[2]; } catch {}
  assert.equal(state === null || state === 'Z', true, `descendant state: ${state}`);
});

test('execution provenance rejects runner, bundle, launcher, and binary drift', () => {
  const frozen = {
    runnerSha256: 'a', bundleSha256: 'b', sourceSha256: 'c',
    codex: { version: '0.159.2', launcherPath: '/launcher', launcherSha256: 'd', binaryPath: '/binary', binarySha256: 'e' },
  };
  assert.doesNotThrow(() => benchmarkRunner.assertExecutionProvenance(frozen, structuredClone(frozen)));
  for (const mutate of [
    (value) => { value.runnerSha256 = 'changed'; },
    (value) => { value.bundleSha256 = 'changed'; },
    (value) => { value.codex.launcherSha256 = 'changed'; },
    (value) => { value.codex.binarySha256 = 'changed'; },
  ]) {
    const observed = structuredClone(frozen);
    mutate(observed);
    assert.throws(() => benchmarkRunner.assertExecutionProvenance(frozen, observed), /execution provenance drift/i);
  }
});

test('runtime freeze comparison covers repository, runtime, and execution configuration', () => {
  const frozen = {
    repository: { head: 'abc', dirty: true },
    runtime: { node: 'v22.22.0', platform: 'linux', arch: 'x64' },
    execution: { sandbox: 'workspace-write', approvalPolicy: 'never', ignoreRules: true },
  };
  assert.doesNotThrow(() => benchmarkRunner.assertRuntimeFreeze(frozen, structuredClone(frozen)));
  for (const observed of [
    { ...structuredClone(frozen), repository: { head: 'def', dirty: true } },
    { ...structuredClone(frozen), runtime: { ...frozen.runtime, node: 'v23.0.0' } },
    { ...structuredClone(frozen), execution: { ...frozen.execution, sandbox: 'danger-full-access' } },
  ]) {
    assert.throws(() => benchmarkRunner.assertRuntimeFreeze(frozen, observed), /runtime freeze drift/i);
  }
});

test('runtime freeze ignores its own untracked ledger in a clean repository', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-runtime-freeze-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'packages/sando/benchmarks/sando-v2.json');
  for (const relative of [
    'packages/sando/benchmarks/sando-v1.json',
    'scripts/run-sando-benchmark.mjs',
    'scripts/codex-subscription-contract.mjs',
    'scripts/codex-loopback-contract.mjs',
    'adapters/codex/sando/cli.mjs',
  ]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{}\n');
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, '{}\n');
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Sando Test', GIT_AUTHOR_EMAIL: 'test@sando.invalid',
    GIT_COMMITTER_NAME: 'Sando Test', GIT_COMMITTER_EMAIL: 'test@sando.invalid',
  };
  for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'fixture']]) {
    assert.equal(spawnSync('git', args, { cwd: root, env: gitEnv }).status, 0);
  }
  const testManifest = { execution: {
    client: 'codex-cli 0.159.2', model: 'gpt-6.1-sol', reasoningEffort: 'low',
    sandbox: 'workspace-write', approvalPolicy: 'never', authentication: 'chatgpt-subscription',
    pairConcurrency: 2, wallTimeoutMsPerRun: 300000, ephemeral: true,
    ignoreUserConfig: true, ignoreRules: true,
  } };
  const before = benchmarkRunner.runtimeFreezeReceipt(root, testManifest, manifestPath);
  const ledgerPath = path.join(root, 'packages/sando/benchmarks/results/sando-v2-events.jsonl');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, '{}\n');
  const after = benchmarkRunner.runtimeFreezeReceipt(root, testManifest, manifestPath);
  assert.deepEqual(after, before);
  assert.equal(before.repository.dirty, false);
});

test('abort stops scheduling after the current run and resume never duplicates it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-abort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerPath = path.join(root, 'events.jsonl');
  const controller = new AbortController();
  let calls = 0;
  const first = await runBenchmark({
    manifest: smallManifest(2), ledgerPath, workRoot: path.join(root, 'work'), concurrency: 1,
    signal: controller.signal,
    execute: async (run) => {
      calls += 1;
      controller.abort();
      return { attempt: completedAttempt(run), quotaFailure: false };
    },
  });
  assert.equal(calls, 1);
  assert.equal(first.status, 'partial');
  await runBenchmark({
    manifest: smallManifest(2), ledgerPath, workRoot: path.join(root, 'work-2'), concurrency: 1,
    execute: async (run) => ({ attempt: completedAttempt(run), quotaFailure: false }),
  });
  const completed = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(({ type }) => type === 'completed').map(({ runKey }) => runKey);
  assert.equal(completed.length, new Set(completed).size);
});

test('fake-client run persists evidence before owned workspace cleanup and records failures', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-fake-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selected = smallManifest();
  selected.tasks[0] = {
    ...selected.tasks[0],
    successCriteria: [{ type: 'file_contains', path: 'report.md', value: 'complete line' }],
  };
  const ledgerPath = path.join(root, 'events.jsonl');
  const workRoot = path.join(root, 'work');
  const result = await runBenchmark({
    manifest: selected, ledgerPath, workRoot, concurrency: 1,
    evidenceRoot: path.join(root, 'evidence'),
    evidenceLimits: { perFileBytes: 64 * 1024, perAttemptBytes: 256 * 1024, totalBytes: 1024 * 1024 },
    provenance: { manifestSha256: 'a'.repeat(64), runnerSha256: 'b'.repeat(64), authenticationMode: 'fake-local' },
    execute: async (run) => {
      const workspace = path.join(workRoot, `${run.taskId}-r${run.repetition}-${run.arm}`);
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, 'report.md'), 'complete line\n');
      return {
        attempt: {
          ...completedAttempt(run),
          startedAt: '2026-09-30T12:00:00.000Z',
          finishedAt: '2026-09-30T12:00:01.000Z',
          model: { requested: 'fake', observed: 'fake' },
          process: { outputTruncated: false },
          verification: { passed: true, checks: [] },
        },
        diagnostics: { finalMessage: 'done' },
        quotaFailure: false,
      };
    },
  });
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts.every(({ evidence }) => evidence.status === 'available'), true);
  const firstEvidence = JSON.parse(fs.readFileSync(result.attempts[0].evidence.metadataPath, 'utf8'));
  const fullPrompt = `${selected.sharedInstructions}\n\nProtected fixture files: ${selected.tasks[0].protectedPaths.join(', ')}.\n\nTask:\n${selected.tasks[0].prompt}`;
  assert.equal(firstEvidence.provenance.promptSha256,
    createHash('sha256').update(fullPrompt).digest('hex'));
  assert.equal(fs.readdirSync(workRoot).length, 0);
  const completedEvents = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(({ type }) => type === 'completed');
  assert.equal(completedEvents.every(({ attempt }) => attempt.evidence.status === 'available'), true);

  const brokenEvidenceRoot = path.join(root, 'broken-evidence');
  fs.writeFileSync(brokenEvidenceRoot, 'not a directory');
  const failed = await runBenchmark({
    manifest: smallManifest(), ledgerPath: path.join(root, 'failed-events.jsonl'),
    workRoot: path.join(root, 'failed-work'), concurrency: 1, evidenceRoot: brokenEvidenceRoot,
    execute: async (run) => ({ attempt: completedAttempt(run), quotaFailure: false }),
  });
  assert.equal(failed.attempts.every(({ evidence }) => evidence.status === 'error'), true);
});

test('auth capture failure records unavailable evidence without reading workspace outputs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-auth-evidence-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workRoot = path.join(root, 'work');
  const evidenceRoot = path.join(root, 'evidence');
  const result = await runBenchmark({
    manifest: smallManifest(), ledgerPath: path.join(root, 'events.jsonl'), workRoot,
    concurrency: 1, evidenceRoot,
    execute: async (run) => {
      const workspace = path.join(workRoot, `${run.taskId}-r${run.repetition}-${run.arm}`);
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, 'report.md'), 'rotated-real-credential');
      return {
        attempt: { ...completedAttempt(run), outcome: 'failed', successVerified: false,
          failure: 'auth-credential-capture-failed' },
        suppressEvidence: true, fatalFailure: true, quotaFailure: false,
      };
    },
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.attempts.length, 1);
  assert.deepEqual(result.attempts[0].evidence, {
    status: 'error', error: 'AuthCredentialCaptureFailed', overflow: false,
  });
  assert.equal(fs.existsSync(evidenceRoot), false);
  assert.equal(fs.readdirSync(workRoot).length, 0);
});
