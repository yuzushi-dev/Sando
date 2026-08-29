import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeWeightedUsage,
  pairedArmFromEnv,
  pairedExperimentFromEnv,
  pairedWorkloadFromEnv,
  summarizePairedSessions,
} from '../src/paired-accounting.mjs';

function usage({ sessionId, arm, experimentId = 'fixture', workloadId, turnId, inputTokens, cachedInputTokens = 0,
  cacheWriteInputTokens = 0, outputTokens = 0, reasoningOutputTokens = 0 }) {
  return {
    host: 'codex', sessionId, turnId, arm, experimentId, workloadId,
    inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens,
  };
}

test('computes cache-aware weighted usage without calling it dollars', () => {
  assert.deepEqual(computeWeightedUsage(usage({
    sessionId: 's1', arm: 'apply', turnId: 't1', inputTokens: 100,
    cachedInputTokens: 40, cacheWriteInputTokens: 20, outputTokens: 10,
  })), {
    freshInputTokens: 40,
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 20,
    outputTokens: 10,
    reasoningOutputTokens: 0,
    costUnits: 79,
  });
});

test('rejects cache counters that exceed provider input', () => {
  assert.throws(() => computeWeightedUsage(usage({
    sessionId: 's1', arm: 'apply', turnId: 't1', inputTokens: 10,
    cachedInputTokens: 8, cacheWriteInputTokens: 3,
  })), /usage counters are invalid/);
});

test('summarizes paired sessions and keeps turns separate from cost', () => {
  const sessions = summarizePairedSessions([
    usage({ sessionId: 'control-1', arm: 'control', turnId: 't1', inputTokens: 10, outputTokens: 2 }),
    usage({ sessionId: 'control-1', arm: 'control', turnId: 't2', inputTokens: 20, outputTokens: 3 }),
    usage({ sessionId: 'apply-1', arm: 'apply', turnId: 't1', inputTokens: 15, outputTokens: 2 }),
  ], { host: 'codex', experimentId: 'fixture' });

  assert.deepEqual(sessions.map(({ sessionId, arm, costUnits, turns }) => ({ sessionId, arm, costUnits, turns })), [
    { sessionId: 'apply-1', arm: 'apply', costUnits: 17, turns: 1 },
    { sessionId: 'control-1', arm: 'control', costUnits: 35, turns: 2 },
  ]);
});

test('keeps interaction counters unavailable when a host did not measure them', () => {
  const [session] = summarizePairedSessions([
    usage({ sessionId: 's1', arm: 'apply', turnId: 't1', inputTokens: 10, outputTokens: 2 }),
    usage({ sessionId: 's1', arm: 'apply', turnId: 't2', inputTokens: 10, outputTokens: 2 }),
  ], { host: 'codex', experimentId: 'fixture' });

  assert.equal(session.totalToolCalls, null);
  assert.equal(session.nativeToolCalls, null);
  assert.equal(session.sandoMcpCalls, null);
  assert.equal(session.mechanicalContextTrimmedBytes, null);
});

test('applies explicit provider-relative weights to session summaries', () => {
  const sessions = summarizePairedSessions([
    usage({ sessionId: 's1', arm: 'apply', turnId: 't1', inputTokens: 10, outputTokens: 2 }),
  ], { host: 'codex', experimentId: 'fixture', pricing: { freshInput: 2, output: 3 } });

  assert.equal(sessions[0].costUnits, 26);
});

test('ignores records without an explicit paired arm', () => {
  assert.deepEqual(summarizePairedSessions([
    usage({ sessionId: 's1', arm: undefined, turnId: 't1', inputTokens: 100 }),
  ], { host: 'codex', experimentId: 'fixture' }), []);
});

test('reads safe paired-control metadata from the environment', () => {
  assert.equal(pairedArmFromEnv({ SANDO_EXPERIMENT_ARM: 'control' }), 'control');
  assert.equal(pairedExperimentFromEnv({ SANDO_EXPERIMENT: 'exp-1' }), 'exp-1');
  assert.equal(pairedWorkloadFromEnv({ SANDO_EXPERIMENT_WORKLOAD: 'work-1' }), 'work-1');
  assert.equal(pairedArmFromEnv({ SANDO_EXPERIMENT_ARM: 'other' }), null);
});
