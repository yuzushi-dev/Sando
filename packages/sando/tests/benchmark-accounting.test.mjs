import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { summarizeBenchmarkAttempts } from '../src/benchmark-accounting.mjs';

const manifestPath = path.resolve(import.meta.dirname, '../benchmarks/sando-v1.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function attempt(overrides = {}) {
  return {
    schemaVersion: 'sando.benchmark-attempt.v1',
    benchmarkId: 'sando-v1',
    taskId: 'locate-log-failure',
    arm: 'control',
    repetition: 1,
    orderPosition: 1,
    outcome: 'passed',
    successVerified: true,
    attempts: 1,
    durationMs: 1_000,
    toolCalls: 2,
    artifactRetrievals: 0,
    cache: { status: 'observed', readInputTokens: 10, writeInputTokens: 2 },
    cost: { status: 'complete', estimatedApiCostUsd: 0.4, supportedSubtotalUsd: 0.4 },
    ...overrides,
  };
}

test('frozen manifest defines usable tasks and a globally counterbalanced five-repeat schedule', () => {
  assert.equal(manifest.schemaVersion, 'sando.benchmark-manifest.v1');
  assert.equal(manifest.status, 'not-run');
  assert.equal(manifest.repetitionsPerArm, 5);
  assert.ok(manifest.tasks.length >= 10);
  assert.equal(new Set(manifest.tasks.map(({ id }) => id)).size, manifest.tasks.length);

  const firstCounts = { control: 0, apply: 0 };
  for (const task of manifest.tasks) {
    assert.ok(task.prompt.length > 40, task.id);
    assert.ok(Object.keys(task.fixture.files).length > 0, task.id);
    assert.ok(task.successCriteria.length > 0, task.id);
    assert.equal(task.schedule.length, 5, task.id);
    for (const [index, order] of task.schedule.entries()) {
      assert.deepEqual([...order].sort(), ['apply', 'control'], `${task.id} repetition ${index + 1}`);
      firstCounts[order[0]] += 1;
    }
    for (const check of task.successCriteria) {
      assert.ok(['command', 'file_contains', 'file_not_contains'].includes(check.type), task.id);
      assert.ok(check.command || check.path, task.id);
    }
  }
  assert.equal(firstCounts.apply, firstCounts.control);
});

test('task checks are syntactically usable and reject each untouched fixture', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-benchmark-'));
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const task of manifest.tasks) {
    const workspace = path.join(root, task.id);
    fs.mkdirSync(workspace, { recursive: true });
    for (const [relativePath, contents] of Object.entries(task.fixture.files)) {
      const target = path.join(workspace, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }

    const results = task.successCriteria.map((check) => {
      if (check.type === 'command') {
        assert.equal(spawnSync('sh', ['-n', '-c', check.command]).status, 0, `${task.id}: invalid check command`);
        return spawnSync('sh', ['-c', check.command], {
          cwd: workspace, env: childEnv, stdio: 'ignore',
        }).status === 0;
      }
      assert.equal(typeof check.value, 'string', `${task.id}: missing check value`);
      const target = path.join(workspace, check.path);
      if (!fs.existsSync(target)) return false;
      const found = fs.readFileSync(target, 'utf8').includes(check.value);
      return check.type === 'file_contains' ? found : !found;
    });
    assert.ok(results.includes(false), `${task.id}: fixture is already solved`);
  }
});

test('cost per successful completion includes failed and retried run cost', () => {
  const summary = summarizeBenchmarkAttempts([
    attempt(),
    attempt({ repetition: 2, orderPosition: 2, outcome: 'failed', attempts: 2, durationMs: 2_000,
      toolCalls: 4, artifactRetrievals: 1,
      cache: { status: 'observed', readInputTokens: 5, writeInputTokens: 0 },
      cost: { status: 'complete', estimatedApiCostUsd: 0.6, supportedSubtotalUsd: 0.6 } }),
  ]);

  assert.deepEqual(summary.groups[0], {
    benchmarkId: 'sando-v1',
    taskId: 'locate-log-failure',
    arm: 'control',
    runs: 2,
    successfulCompletions: 1,
    failedCompletions: 1,
    unverifiedFailures: 0,
    totalAttempts: 3,
    durationMs: 3_000,
    supportedDurationMs: 3_000,
    observedDurationRuns: 2,
    toolCalls: 6,
    supportedToolCalls: 6,
    observedToolCallRuns: 2,
    artifactRetrievals: 1,
    supportedArtifactRetrievals: 1,
    observedArtifactRuns: 2,
    cache: { observedRuns: 2, unavailableRuns: 0, readInputTokens: 15, writeInputTokens: 2 },
    allAttemptsCost: { status: 'determined', totalUsd: 1, supportedSubtotalUsd: 1 },
    costPerSuccessfulCompletion: { status: 'determined', usd: 1 },
  });
});

test('incomplete monetary data makes totals indeterminate while retaining supported subtotal', () => {
  const summary = summarizeBenchmarkAttempts([
    attempt(),
    attempt({ repetition: 2, orderPosition: 2, outcome: 'failed',
      cache: { status: 'unavailable', readInputTokens: null, writeInputTokens: null },
      cost: { status: 'incomplete', estimatedApiCostUsd: null, supportedSubtotalUsd: 0.1 } }),
  ]);

  assert.deepEqual(summary.groups[0].allAttemptsCost, {
    status: 'indeterminate', totalUsd: null, supportedSubtotalUsd: 0.5,
  });
  assert.deepEqual(summary.groups[0].costPerSuccessfulCompletion, {
    status: 'indeterminate', usd: null,
  });
  assert.deepEqual(summary.groups[0].cache, {
    observedRuns: 1, unavailableRuns: 1, readInputTokens: 10, writeInputTokens: 2,
  });
});

test('fully unavailable subscription pricing remains null instead of zero', () => {
  const summary = summarizeBenchmarkAttempts([
    attempt({ cost: { status: 'incomplete', estimatedApiCostUsd: null, supportedSubtotalUsd: null } }),
  ]);
  assert.deepEqual(summary.groups[0].allAttemptsCost, {
    status: 'indeterminate', totalUsd: null, supportedSubtotalUsd: null,
  });
});

test('an interrupted run nulls full metrics while retaining verified supported totals in either order', () => {
  const interrupted = attempt({
      repetition: 2,
      orderPosition: 2,
      outcome: 'failed',
      successVerified: false,
      failure: 'interrupted-before-completion',
      durationMs: null,
      toolCalls: null,
      artifactRetrievals: null,
      cache: { status: 'unavailable', readInputTokens: null, writeInputTokens: null },
      cost: { status: 'incomplete', estimatedApiCostUsd: null, supportedSubtotalUsd: null },
    });
  for (const values of [[attempt(), interrupted], [interrupted, attempt()]]) {
    const group = summarizeBenchmarkAttempts(values).groups[0];
    assert.equal(group.runs, 2);
    assert.equal(group.successfulCompletions, 1);
    assert.equal(group.failedCompletions, 1);
    assert.equal(group.unverifiedFailures, 1);
    assert.equal(group.durationMs, null);
    assert.equal(group.supportedDurationMs, 1_000);
    assert.equal(group.observedDurationRuns, 1);
    assert.equal(group.toolCalls, null);
    assert.equal(group.supportedToolCalls, 2);
    assert.equal(group.artifactRetrievals, null);
    assert.equal(group.supportedArtifactRetrievals, 0);
  }
});

test('summaries keep tasks and arms separate', () => {
  const summary = summarizeBenchmarkAttempts([
    attempt(),
    attempt({ arm: 'apply', orderPosition: 2 }),
    attempt({ taskId: 'repair-parser', arm: 'apply', orderPosition: 2 }),
  ]);
  assert.deepEqual(summary.groups.map(({ taskId, arm }) => [taskId, arm]), [
    ['locate-log-failure', 'apply'],
    ['locate-log-failure', 'control'],
    ['repair-parser', 'apply'],
  ]);
});

test('invalid or unverifiable attempt records are rejected', () => {
  assert.throws(() => summarizeBenchmarkAttempts([attempt({ successVerified: false })]), /successVerified/);
  assert.throws(() => summarizeBenchmarkAttempts([attempt({
    outcome: 'failed', successVerified: false,
  })]), /failure/);
  assert.throws(() => summarizeBenchmarkAttempts([attempt({ toolCalls: null })]), /toolCalls/);
  assert.throws(() => summarizeBenchmarkAttempts([attempt({ orderPosition: 3 })]), /orderPosition/);
  assert.throws(() => summarizeBenchmarkAttempts([attempt({
    cost: { status: 'complete', estimatedApiCostUsd: null, supportedSubtotalUsd: 0 },
  })]), /estimatedApiCostUsd/);
});

test('aggregate counters and costs reject numeric overflow', () => {
  assert.throws(() => summarizeBenchmarkAttempts([
    attempt({ toolCalls: Number.MAX_SAFE_INTEGER }),
    attempt({ repetition: 2, orderPosition: 2, toolCalls: 1 }),
  ]), /ToolCalls overflow/);
  assert.throws(() => summarizeBenchmarkAttempts([
    attempt({ cost: { status: 'complete', estimatedApiCostUsd: Number.MAX_VALUE, supportedSubtotalUsd: Number.MAX_VALUE } }),
    attempt({ repetition: 2, orderPosition: 2,
      cost: { status: 'complete', estimatedApiCostUsd: Number.MAX_VALUE, supportedSubtotalUsd: Number.MAX_VALUE } }),
  ]), /cost overflow/);
});
