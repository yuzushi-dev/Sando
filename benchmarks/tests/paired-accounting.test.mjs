import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPairedAccounting } from '../lib/metrics.mjs';

const promptDigest = `sha256:${'1'.repeat(64)}`;
const scenarioDigest = `sha256:${'2'.repeat(64)}`;

function run(variant, overrides = {}) {
  const providerUsage = variant === 'baseline'
    ? { inputTokens: 100, uncachedInputTokens: 70, cacheCreationInputTokens: 10, cacheReadInputTokens: 20, outputTokens: 8, reasoningOutputTokens: 2, totalTokens: 108, totalCostUsd: 0.2 }
    : { inputTokens: 60, uncachedInputTokens: 30, cacheCreationInputTokens: 5, cacheReadInputTokens: 25, outputTokens: 8, reasoningOutputTokens: 3, totalTokens: 68, totalCostUsd: 0.12 };
  return {
    host: 'codex', scenario: 'paired-fixture', scenarioDigest, repetition: 0, variant,
    resolvedModel: 'codex-test', clientVersion: 'codex 1.0', promptDigest,
    inputTokens: providerUsage.inputTokens, outputTokens: providerUsage.outputTokens,
    totalTokens: providerUsage.totalTokens, providerUsage, quality: 'pass',
    measurement: 'end-to-end-tools', tokenAccounting: 'provider-reported',
    modelTurns: variant === 'baseline' ? 2 : 3,
    totalToolCalls: variant === 'baseline' ? 3 : 4,
    nativeToolCalls: variant === 'baseline' ? 3 : 1,
    sandoMcpCalls: variant === 'baseline' ? 0 : 3,
    mechanicalContextTrimmedBytes: variant === 'baseline' ? 0 : 400,
    audit: {
      host: 'codex', resolvedModel: 'codex-test', clientVersion: 'codex 1.0', promptDigest, scenarioDigest,
      commit: 'abc123', workingTreeDirty: false, diffDigest: null, workingTreeProvenance: 'clean',
      measurement: { mode: 'end-to-end-tools', hookEndToEnd: true },
      tokenAccounting: { source: 'provider-reported', providerObserved: true },
    },
    modelVisibleQuality: 'pass', artifactResolvable: true, secretLeak: false,
    ...overrides,
  };
}

test('paired accounting compares control and treatment across provider and interaction counters', () => {
  const result = buildPairedAccounting([run('baseline'), run('optimized')]);

  assert.equal(result.control.uncachedInputTokens, 70);
  assert.equal(result.treatment.cacheReadInputTokens, 25);
  assert.equal(result.treatment.reasoningOutputTokens, 3);
  assert.equal(result.control.modelTurns, 2);
  assert.equal(result.treatment.totalToolCalls, 4);
  assert.equal(result.treatment.sandoMcpCalls, 3);
  assert.equal(result.treatment.nativeToolCalls, 1);
  assert.equal(result.delta.uncachedInputTokens, 40);
  assert.equal(result.delta.mechanicalContextTrimmedBytes, 400);
  assert.equal(result.delta.billedCostUsd, 0.08);
  assert.equal(result.cost.status, 'provider-reported');
  assert.equal(result.replay.counterfactual, false);
});

test('paired accounting labels replay estimates and unavailable billed cost explicitly', () => {
  const estimateAudit = {
    ...run('baseline').audit,
    host: 'local', resolvedModel: null, clientVersion: null,
    measurement: { mode: 'local-replay', hookEndToEnd: false },
    tokenAccounting: { source: 'estimate', formula: 'ceil(UTF-8 bytes / 4)', providerObserved: false },
  };
  const baseline = {
    ...run('baseline'), host: 'local', resolvedModel: null, clientVersion: null,
    measurement: 'local-replay', tokenAccounting: 'estimate', providerUsage: undefined,
    audit: estimateAudit, inputTokens: 100, mechanicalContextTrimmedBytes: 0,
  };
  const treatment = {
    ...baseline, variant: 'optimized', inputTokens: 60, outputTokens: 8, totalTokens: 68,
    modelTurns: 1, totalToolCalls: 0, nativeToolCalls: 0, sandoMcpCalls: 0,
    mechanicalContextTrimmedBytes: 400,
    audit: { ...estimateAudit },
  };
  const result = buildPairedAccounting([baseline, treatment]);

  assert.equal(result.cost.status, 'unavailable');
  assert.equal(result.cost.billedCostUsd, null);
  assert.equal(result.delta.billedCostUsd, null);
  assert.equal(result.replay.counterfactual, true);
  assert.equal(result.replay.providerBilledCost, 'unavailable');
});
