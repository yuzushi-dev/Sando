import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateTokens,
  pairDelta,
  summarizeRuns,
  assertQualityGate,
} from '../lib/metrics.mjs';

test('estimates tokens deterministically and never returns less than one for text', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('€'), 1);
});

test('pairs baseline and optimized runs by scenario and repetition', () => {
  const delta = pairDelta([
    { scenario: 'read', repetition: 0, variant: 'baseline', inputTokens: 100, quality: 'pass' },
    { scenario: 'read', repetition: 0, variant: 'optimized', inputTokens: 60, quality: 'pass' },
  ]);
  assert.deepEqual(delta, {
    scenario: 'read',
    repetition: 0,
    baselineInputTokens: 100,
    optimizedInputTokens: 60,
    savedInputTokens: 40,
    savedPercent: 40,
    qualityPass: true,
  });
});

test('summarizes paired medians and refuses missing pairs', () => {
  const summary = summarizeRuns([
    { scenario: 'read', repetition: 0, variant: 'baseline', inputTokens: 100, quality: 'pass' },
    { scenario: 'read', repetition: 0, variant: 'optimized', inputTokens: 50, quality: 'pass' },
    { scenario: 'read', repetition: 1, variant: 'baseline', inputTokens: 80, quality: 'pass' },
    { scenario: 'read', repetition: 1, variant: 'optimized', inputTokens: 60, quality: 'pass' },
  ]);
  assert.deepEqual(summary.scenarios[0], {
    scenario: 'read',
    repetitions: 2,
    baselineMedianInputTokens: 90,
    optimizedMedianInputTokens: 55,
    medianSavedInputTokens: 35,
    medianSavedPercent: 38.88888888888889,
    qualityPassRate: 1,
  });
  assert.equal(summary.pairedRuns, 2);
  assert.throws(() => summarizeRuns([
    { scenario: 'read', repetition: 0, variant: 'baseline', inputTokens: 10, quality: 'pass' },
  ]), /unpaired benchmark run/);
});

test('quality gate rejects artifact loss, leaks, and correctness failures', () => {
  assert.doesNotThrow(() => assertQualityGate({
    baseline: { quality: 'pass' },
    optimized: { quality: 'pass', artifactResolvable: true, secretLeak: false },
  }));
  assert.throws(() => assertQualityGate({
    baseline: { quality: 'pass' },
    optimized: { quality: 'fail', artifactResolvable: true, secretLeak: false },
  }), /correctness/);
  assert.throws(() => assertQualityGate({
    baseline: { quality: 'pass' },
    optimized: { quality: 'pass', artifactResolvable: false, secretLeak: false },
  }), /artifact/);
  assert.throws(() => assertQualityGate({
    baseline: { quality: 'pass' },
    optimized: { quality: 'pass', artifactResolvable: true, secretLeak: true },
  }), /secret/);
});

test('quality gate distinguishes model-visible facts from artifact-recoverable facts', async () => {
  const { evaluateFacts } = await import('../lib/metrics.mjs');
  const facts = evaluateFacts({ requiredFacts: [
    { value: 'HEAD-FACT', location: 'head' },
    { value: 'MIDDLE-FACT', location: 'middle' },
    { value: 'TAIL-ERROR', location: 'tail' },
  ] }, 'HEAD-FACT\n[sando: middle elided]', 'MIDDLE-FACT\nTAIL-ERROR');
  assert.deepEqual(facts, {
    quality: 'pass',
    modelVisibleQuality: 'fail',
    facts: {
      'HEAD-FACT': { inline: true, artifact: false, modelVisible: true, recoverable: true },
      'MIDDLE-FACT': { inline: false, artifact: true, modelVisible: false, recoverable: true },
      'TAIL-ERROR': { inline: false, artifact: true, modelVisible: false, recoverable: true },
    },
  });
});
