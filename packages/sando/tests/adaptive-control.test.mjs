import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeUsageCost,
  decideAdaptiveRouting,
  adaptiveArmFromEnv,
  adaptiveExperimentFromEnv,
  adaptiveWorkloadFromEnv,
  summarizeAdaptiveSessions,
} from '../src/adaptive-control.mjs';

function usage({ sessionId, arm, experimentId = 'fixture', workloadId, turnId, inputTokens, cachedInputTokens = 0,
  cacheWriteInputTokens = 0, outputTokens = 0, reasoningOutputTokens = 0 }) {
  return {
    host: 'codex', sessionId, turnId, arm, experimentId, workloadId,
    inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens,
  };
}

test('computes cache-aware weighted usage without calling it dollars', () => {
  assert.deepEqual(computeUsageCost(usage({
    sessionId: 's1', arm: 'apply', turnId: 't1', inputTokens: 100,
    cachedInputTokens: 40, cacheWriteInputTokens: 20, outputTokens: 10,
  })), {
    freshInputTokens: 40,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 20,
    outputTokens: 10,
    reasoningOutputTokens: 0,
    costUnits: 79,
  });
});

test('rejects cache counters that exceed provider input', () => {
  assert.throws(() => computeUsageCost(usage({
    sessionId: 's1', arm: 'apply', turnId: 't1', inputTokens: 10,
    cachedInputTokens: 8, cacheWriteInputTokens: 3,
  })), /usage counters are invalid/);
});

test('summarizes sessions and counts turns separately from cost', () => {
  const sessions = summarizeAdaptiveSessions([
    usage({ sessionId: 'control-1', arm: 'control', turnId: 't1', inputTokens: 10, outputTokens: 2 }),
    usage({ sessionId: 'control-1', arm: 'control', turnId: 't2', inputTokens: 20, outputTokens: 3 }),
    usage({ sessionId: 'apply-1', arm: 'apply', turnId: 't1', inputTokens: 15, outputTokens: 2 }),
  ], { host: 'codex', experimentId: 'fixture' });

  assert.deepEqual(sessions, [
    { sessionId: 'apply-1', arm: 'apply', costUnits: 17, turns: 1 },
    { sessionId: 'control-1', arm: 'control', costUnits: 35, turns: 2 },
  ]);
});

test('applies explicit provider-relative weights to session summaries', () => {
  const sessions = summarizeAdaptiveSessions([
    usage({ sessionId: 's1', arm: 'apply', turnId: 't1', inputTokens: 10, outputTokens: 2 }),
  ], { host: 'codex', experimentId: 'fixture', pricing: { freshInput: 2, output: 3 } });

  assert.equal(sessions[0].costUnits, 26);
});

test('keeps routing enabled until both arms have enough evidence', () => {
  const decision = decideAdaptiveRouting({
    records: [usage({ sessionId: 'control-1', arm: 'control', turnId: 't1', inputTokens: 10 })],
    host: 'codex', experimentId: 'fixture', minSessions: 2,
  });

  assert.equal(decision.enabled, true);
  assert.equal(decision.reason, 'insufficient-evidence');
});

test('backs off when apply costs more per session than control', () => {
  const records = [
    ['control-1', 'control', 100, 2], ['control-2', 'control', 110, 2],
    ['apply-1', 'apply', 130, 2], ['apply-2', 'apply', 140, 2],
  ].flatMap(([sessionId, arm, inputTokens, turns]) => Array.from({ length: turns }, (_, index) => usage({
    sessionId, arm, turnId: `${sessionId}-${index}`, inputTokens: Math.floor(inputTokens / turns),
  })));

  const decision = decideAdaptiveRouting({ records, host: 'codex', experimentId: 'fixture', minSessions: 2 });

  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, 'cost-backoff');
  assert.equal(decision.control.sessions, 2);
  assert.equal(decision.apply.sessions, 2);
});

test('backs off when extra turns outweigh a lower weighted cost', () => {
  const records = [
    ['control-1', 'control', 100, 2], ['control-2', 'control', 100, 2],
    ['apply-1', 'apply', 90, 4], ['apply-2', 'apply', 90, 4],
  ].flatMap(([sessionId, arm, inputTokens, turns]) => Array.from({ length: turns }, (_, index) => usage({
    sessionId, arm, turnId: `${sessionId}-${index}`, inputTokens: Math.floor(inputTokens / turns),
  })));

  const decision = decideAdaptiveRouting({ records, host: 'codex', experimentId: 'fixture', minSessions: 2 });

  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, 'turn-backoff');
});

test('ignores records without an explicit adaptive arm', () => {
  const decision = decideAdaptiveRouting({
    records: [usage({ sessionId: 's1', arm: undefined, turnId: 't1', inputTokens: 100 })],
    host: 'codex', experimentId: 'fixture', minSessions: 1,
  });

  assert.equal(decision.reason, 'insufficient-evidence');
});

test('scopes evidence to the selected workload', () => {
  const records = [
    ['control-a', 'control', 'work-a', 100], ['control-b', 'control', 'work-a', 100], ['control-c', 'control', 'work-a', 100],
    ['apply-a', 'apply', 'work-a', 80], ['apply-b', 'apply', 'work-a', 80], ['apply-c', 'apply', 'work-a', 80],
    ['control-x', 'control', 'work-b', 100], ['control-y', 'control', 'work-b', 100], ['control-z', 'control', 'work-b', 100],
    ['apply-x', 'apply', 'work-b', 300], ['apply-y', 'apply', 'work-b', 300], ['apply-z', 'apply', 'work-b', 300],
  ].map(([sessionId, arm, workloadId, inputTokens]) => usage({
    sessionId, arm, workloadId, turnId: 't1', inputTokens,
  }));

  const decision = decideAdaptiveRouting({
    records, host: 'codex', experimentId: 'fixture', workloadId: 'work-a',
  });

  assert.equal(decision.enabled, true);
  assert.equal(decision.reason, 'evidence-favorable');
});

test('reads safe control metadata from the environment', () => {
  assert.equal(adaptiveArmFromEnv({ SANDO_ADAPTIVE_ARM: 'control' }), 'control');
  assert.equal(adaptiveExperimentFromEnv({ SANDO_ADAPTIVE_EXPERIMENT: 'exp-1' }), 'exp-1');
  assert.equal(adaptiveWorkloadFromEnv({ SANDO_ADAPTIVE_WORKLOAD: 'work-1' }), 'work-1');
  assert.equal(adaptiveArmFromEnv({ SANDO_ADAPTIVE_ARM: 'other' }), null);
});
