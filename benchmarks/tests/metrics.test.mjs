import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateTokens,
  pairDelta,
  summarizeRuns,
  assertQualityGate,
} from '../lib/metrics.mjs';

const localAuditEvidence = {
  host: 'local',
  resolvedModel: null,
  clientVersion: null,
  promptDigest: `sha256:${'1'.repeat(64)}`,
  scenarioDigest: `sha256:${'2'.repeat(64)}`,
  commit: 'abc123',
  workingTreeDirty: false,
  diffDigest: null,
  workingTreeProvenance: 'clean',
  measurement: { mode: 'local-replay', hookEndToEnd: false },
  tokenAccounting: { source: 'estimate', formula: 'ceil(UTF-8 bytes / 4)', providerObserved: false },
};

test('estimates tokens deterministically and never returns less than one for text', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('€'), 1);
});

test('pairs baseline and optimized runs by scenario and repetition', () => {
  const delta = pairDelta([
    { scenario: 'read', repetition: 0, variant: 'baseline', inputTokens: 100, quality: 'pass', measurement: 'local-replay', tokenAccounting: 'estimate', audit: localAuditEvidence },
    { scenario: 'read', repetition: 0, variant: 'optimized', inputTokens: 60, quality: 'pass', measurement: 'local-replay', tokenAccounting: 'estimate', audit: localAuditEvidence },
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
    { scenario: 'read', repetition: 0, variant: 'baseline', inputTokens: 100, quality: 'pass', measurement: 'local-replay', tokenAccounting: 'estimate', audit: localAuditEvidence },
    { scenario: 'read', repetition: 0, variant: 'optimized', inputTokens: 50, quality: 'pass', measurement: 'local-replay', tokenAccounting: 'estimate', audit: localAuditEvidence },
    { scenario: 'read', repetition: 1, variant: 'baseline', inputTokens: 80, quality: 'pass', measurement: 'local-replay', tokenAccounting: 'estimate', audit: localAuditEvidence },
    { scenario: 'read', repetition: 1, variant: 'optimized', inputTokens: 60, quality: 'pass', measurement: 'local-replay', tokenAccounting: 'estimate', audit: localAuditEvidence },
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
    { scenario: 'read', repetition: 0, variant: 'baseline', inputTokens: 10, quality: 'pass', measurement: 'local-replay', tokenAccounting: 'estimate', audit: localAuditEvidence },
  ]), /unpaired benchmark run/);
});

test('v2 pairs require matching measurement and accounting provenance', () => {
  assert.throws(() => pairDelta([
    { scenario: 'read', repetition: 0, variant: 'baseline', inputTokens: 100, quality: 'pass' },
    { scenario: 'read', repetition: 0, variant: 'optimized', inputTokens: 60, quality: 'pass' },
  ]), /provenance|measurement|accounting/);
  assert.throws(() => pairDelta([
    { scenario: 'read', repetition: 0, variant: 'baseline', inputTokens: 100, quality: 'pass', measurement: 'local-replay', tokenAccounting: 'estimate', audit: localAuditEvidence },
    { scenario: 'read', repetition: 0, variant: 'optimized', inputTokens: 60, quality: 'pass', measurement: 'local-replay', tokenAccounting: 'provider-reported', audit: {
      measurement: { mode: 'local-replay', hookEndToEnd: false },
      tokenAccounting: { source: 'provider-reported', providerObserved: true },
    }, providerUsage: { inputTokens: 60 } },
  ]), /accounting|provenance/);
});

test('quality gate rejects artifact loss, leaks, and correctness failures', () => {
  assert.doesNotThrow(() => assertQualityGate({
    baseline: { quality: 'pass', modelVisibleQuality: 'pass', artifactResolvable: true, secretLeak: false },
    optimized: { quality: 'pass', modelVisibleQuality: 'pass', artifactResolvable: true, secretLeak: false },
  }));
  assert.throws(() => assertQualityGate({
    baseline: { quality: 'pass', modelVisibleQuality: 'pass', artifactResolvable: true, secretLeak: false },
    optimized: { quality: 'fail', modelVisibleQuality: 'pass', artifactResolvable: true, secretLeak: false },
  }), /correctness/);
  assert.throws(() => assertQualityGate({
    baseline: { quality: 'pass', modelVisibleQuality: 'pass', artifactResolvable: true, secretLeak: false },
    optimized: { quality: 'pass', modelVisibleQuality: 'pass', artifactResolvable: false, secretLeak: false },
  }), /artifact/);
  assert.throws(() => assertQualityGate({
    baseline: { quality: 'pass', modelVisibleQuality: 'pass', artifactResolvable: true, secretLeak: false },
    optimized: { quality: 'pass', modelVisibleQuality: 'pass', artifactResolvable: true, secretLeak: true },
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

test('quality gate rejects optimized output when required facts are not model-visible', () => {
  assert.throws(() => assertQualityGate({
    baseline: { quality: 'pass', modelVisibleQuality: 'pass', artifactResolvable: true, secretLeak: false },
    optimized: {
      quality: 'pass', modelVisibleQuality: 'fail', artifactResolvable: true, secretLeak: false,
    },
  }), /model-visible/);
});

test('quality gate rejects missing model-visible, artifact, or leak evidence', () => {
  const base = { quality: 'pass', modelVisibleQuality: 'pass', artifactResolvable: true, secretLeak: false };
  assert.throws(() => assertQualityGate({ baseline: base, optimized: { quality: 'pass', artifactResolvable: true, secretLeak: false } }), /model-visible/);
  assert.throws(() => assertQualityGate({ baseline: base, optimized: { quality: 'pass', modelVisibleQuality: 'pass', secretLeak: false } }), /artifact/);
  assert.throws(() => assertQualityGate({ baseline: base, optimized: { quality: 'pass', modelVisibleQuality: 'pass', artifactResolvable: true } }), /leak/);
});

test('paired summaries reject mixed measurement labels', () => {
  assert.throws(() => summarizeRuns([
    { scenario: 'read', repetition: 0, variant: 'baseline', inputTokens: 100, quality: 'pass', measurement: 'local-replay', tokenAccounting: 'estimate', audit: localAuditEvidence },
    { scenario: 'read', repetition: 0, variant: 'optimized', inputTokens: 50, quality: 'pass', measurement: 'prompt-level', tokenAccounting: 'estimate', audit: {
      measurement: { mode: 'prompt-level', hookEndToEnd: false },
      tokenAccounting: { source: 'estimate', providerObserved: false },
    } },
  ]), /measurement|provenance/);
});

test('accepts provider-proxy measurements with provider-reported usage', () => {
  assert.doesNotThrow(() => summarizeRuns([
    auditedRun({
      variant: 'baseline', measurement: 'end-to-end-proxy', tokenAccounting: 'provider-reported', inputTokens: 100,
      providerUsage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    }),
    auditedRun({
      variant: 'optimized', measurement: 'end-to-end-proxy', tokenAccounting: 'provider-reported', inputTokens: 60,
      providerUsage: { inputTokens: 60, outputTokens: 10, totalTokens: 70 },
    }),
  ]));
});

function auditedRun({ variant, measurement = 'local-replay', tokenAccounting = 'estimate', inputTokens = 100, audit, providerUsage, ...rest }) {
  const promptDigest = `sha256:${'3'.repeat(64)}`;
  const scenarioDigest = `sha256:${'4'.repeat(64)}`;
  const baseAudit = {
    host: 'local', resolvedModel: null, clientVersion: null, promptDigest, scenarioDigest,
    commit: 'abc123', workingTreeDirty: false, diffDigest: null, workingTreeProvenance: 'clean',
    measurement: { mode: measurement, hookEndToEnd: measurement === 'end-to-end' },
    tokenAccounting: {
      source: tokenAccounting,
      ...(tokenAccounting === 'estimate' ? { formula: 'ceil(UTF-8 bytes / 4)' } : {}),
      providerObserved: tokenAccounting === 'provider-reported',
    },
  };
  return {
    scenario: 'read', repetition: 0, variant, inputTokens, quality: 'pass',
    measurement, tokenAccounting,
    audit: { ...baseAudit, ...audit, measurement: audit?.measurement ?? baseAudit.measurement, tokenAccounting: audit?.tokenAccounting ?? baseAudit.tokenAccounting },
    ...(providerUsage === undefined ? {} : { providerUsage }),
    ...rest,
  };
}

test('paired runs reject measurement labels that contradict audit evidence', () => {
  assert.throws(() => pairDelta([
    auditedRun({ variant: 'baseline' }),
    auditedRun({
      variant: 'optimized',
      audit: {
        measurement: { mode: 'prompt-level', hookEndToEnd: false },
        tokenAccounting: { source: 'estimate', formula: 'ceil(UTF-8 bytes / 4)', providerObserved: false },
      },
    }),
  ]), /audit|measurement/);
});

test('paired runs require provider usage for provider-reported accounting', () => {
  assert.throws(() => pairDelta([
    auditedRun({ variant: 'baseline', tokenAccounting: 'provider-reported' }),
    auditedRun({ variant: 'optimized', tokenAccounting: 'provider-reported', inputTokens: 60 }),
  ]), /provider/);
});

test('paired runs reject contradictory estimate and provider evidence', () => {
  assert.throws(() => pairDelta([
    auditedRun({ variant: 'baseline' }),
    auditedRun({
      variant: 'optimized',
      providerUsage: { inputTokens: 60 },
      audit: {
        measurement: { mode: 'local-replay', hookEndToEnd: false },
        tokenAccounting: { source: 'estimate', providerObserved: true },
      },
    }),
  ]), /provider|accounting/);
});

test('paired runs reconcile reported input tokens with provider evidence', () => {
  const providerUsage = { inputTokens: 60, outputTokens: 4, totalTokens: 64 };
  assert.throws(() => pairDelta([
    auditedRun({
      variant: 'baseline', tokenAccounting: 'provider-reported', providerUsage: { inputTokens: 100 },
    }),
    auditedRun({
      variant: 'optimized', tokenAccounting: 'provider-reported', inputTokens: 61, providerUsage,
    }),
  ]), /provider|input/);
});

test('paired runs reject contradictory dirty-tree audit evidence', () => {
  assert.throws(() => pairDelta([
    auditedRun({ variant: 'baseline' }),
    auditedRun({
      variant: 'optimized',
      audit: {
        measurement: { mode: 'local-replay', hookEndToEnd: false },
        tokenAccounting: { source: 'estimate', formula: 'ceil(UTF-8 bytes / 4)', providerObserved: false },
        workingTreeDirty: false,
        diffDigest: `sha256:${'0'.repeat(64)}`,
        workingTreeProvenance: 'clean',
      },
    }),
  ]), /tree/);
});

function completePairedRun(variant, overrides = {}) {
  const promptDigest = `sha256:${(variant === 'baseline' ? '2' : '3').repeat(64)}`;
  return {
    scenario: 'read',
    scenarioDigest: `sha256:${'1'.repeat(64)}`,
    repetition: 0,
    variant,
    host: 'claude',
    resolvedModel: 'claude-test',
    clientVersion: 'claude 1.0.0',
    promptDigest,
    inputTokens: variant === 'baseline' ? 100 : 60,
    quality: 'pass',
    measurement: 'prompt-level',
    tokenAccounting: 'provider-reported',
    providerUsage: { inputTokens: variant === 'baseline' ? 100 : 60, outputTokens: 4, totalTokens: variant === 'baseline' ? 104 : 64 },
    audit: {
      host: 'claude',
      resolvedModel: 'claude-test',
      clientVersion: 'claude 1.0.0',
      promptDigest,
      scenarioDigest: `sha256:${'1'.repeat(64)}`,
      commit: 'abc123',
      workingTreeDirty: false,
      diffDigest: null,
      workingTreeProvenance: 'clean',
      measurement: { mode: 'prompt-level', hookEndToEnd: false },
      tokenAccounting: { source: 'provider-reported', providerObserved: true },
    },
    ...overrides,
  };
}

test('paired evidence requires matching identity and scenario provenance', () => {
  const baseline = completePairedRun('baseline');
  const optimized = completePairedRun('optimized');
  assert.doesNotThrow(() => pairDelta([baseline, optimized]));
  for (const field of ['host', 'resolvedModel', 'clientVersion', 'scenarioDigest']) {
    assert.throws(() => pairDelta([
      baseline,
      { ...optimized, [field]: field === 'scenarioDigest' ? `sha256:${'4'.repeat(64)}` : 'different' },
    ]), new RegExp(field));
  }
  for (const field of ['host', 'resolvedModel', 'clientVersion', 'scenarioDigest', 'promptDigest']) {
    const missing = { ...baseline, audit: { ...baseline.audit } };
    delete missing.audit[field];
    assert.throws(() => pairDelta([missing, optimized]), /provenance|evidence/);
  }
});

test('paired evidence stays consistent across repetitions', () => {
  const firstBaseline = completePairedRun('baseline');
  const firstOptimized = completePairedRun('optimized');
  const secondBaseline = { ...completePairedRun('baseline'), repetition: 1 };
  const secondOptimized = { ...completePairedRun('optimized'), repetition: 1, host: 'codex' };
  secondOptimized.audit = { ...secondOptimized.audit, host: 'codex' };
  const secondBaselineCodex = { ...secondBaseline, host: 'codex', audit: { ...secondBaseline.audit, host: 'codex' } };
  assert.throws(() => summarizeRuns([firstBaseline, firstOptimized, secondBaselineCodex, secondOptimized]), /provenance/);
});
