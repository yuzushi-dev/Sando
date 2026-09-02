import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GATE_EVIDENCE_SCHEMA,
  GATE_SCHEMA,
  evaluateGatewayGate,
  serializeGatewayGate,
} from '../index.mjs';

const digest = (digit) => `sha256:${digit.repeat(64)}`;

function hostEvidence(host, overrides = {}) {
  const identity = {
    scenarioDigest: digest('1'),
    workloadDigest: digest('2'),
    promptDigest: digest('3'),
    modelDigest: digest('4'),
  };
  return {
    host,
    controlArm: 'native-tool-search',
    treatmentArm: 'sando-gateway',
    realWorkload: true,
    originalMcpDisabled: true,
    catalogReadOnly: true,
    allowlistEnforced: true,
    killSwitchRollbackTested: true,
    nativeToolSearchState: 'enabled',
    samplePairs: 10,
    discoveryIntents: 50,
    identity: { control: identity, treatment: { ...identity } },
    prerequisite: {
      residualMcpTokens: 12_000,
      initialContextTokens: 100_000,
      selectionStartupDefectRate: 0,
    },
    metrics: {
      source: 'provider-reported',
      discoverySuccessRate: 0.96,
      safetyCriticalDiscoveryRate: 1,
      wrongMutativeCalls: 0,
      providerInputReductionRate: 0.12,
      extraToolCallsMedian: 1,
      p50LatencyOverhead: 0.14,
      startupOverhead: 0.1,
      schemaValidationRate: 1,
      cancellationPropagationRate: 1,
      timeoutPropagationRate: 1,
      errorPropagationRate: 1,
      progressPropagationRate: 1,
      listChangedInvalidationRate: 1,
      authPropagationRate: 1,
      approvalPropagationRate: 1,
      elicitationPropagationRate: 1,
      weightedCostRatio: 0.99,
      acceptanceControlRate: 1,
      acceptanceTreatmentRate: 1,
    },
    ...overrides,
  };
}

function evidence(hosts = [hostEvidence('claude'), hostEvidence('codex')]) {
  return { schema: GATE_EVIDENCE_SCHEMA, version: 1, hosts };
}

test('gateway gate returns a deterministic go only for complete paired evidence', () => {
  const first = evaluateGatewayGate({ evidence: evidence() });
  const second = evaluateGatewayGate({ evidence: evidence() });

  assert.equal(first.schema, GATE_SCHEMA);
  assert.equal(first.status, 'go');
  assert.equal(first.hosts.length, 2);
  assert.ok(first.checks.every((check) => check.status === 'pass'));
  for (const id of [
    'discovery-intent-count', 'catalog-read-only', 'allowlist', 'kill-switch-rollback',
    'auth-propagation', 'approval-propagation', 'elicitation-propagation',
  ]) assert.ok(first.checks.some((check) => check.id === id), id);
  assert.deepEqual(first, second);
  assert.equal(serializeGatewayGate(first), serializeGatewayGate(second));
});

test('gateway gate is insufficient when native baseline, pairs, or prerequisite evidence is missing', () => {
  const result = evaluateGatewayGate({ evidence: evidence([
    hostEvidence('claude', {
      nativeToolSearchState: 'indeterminate',
      samplePairs: 9,
      prerequisite: {
        residualMcpTokens: 0,
        initialContextTokens: 100_000,
        selectionStartupDefectRate: 0,
      },
    }),
  ]) });

  assert.equal(result.status, 'insufficient-evidence');
  assert.ok(result.reasons.includes('both-hosts-required'));
  assert.ok(result.reasons.includes('native-tool-search-control-required'));
  assert.ok(result.reasons.includes('minimum-paired-samples-required'));
  assert.ok(result.reasons.includes('gateway-prerequisite-not-established'));
});

test('gateway gate treats a structurally incomplete host record as insufficient evidence', () => {
  const result = evaluateGatewayGate({ evidence: evidence([{ host: 'claude' }]) });

  assert.equal(result.status, 'insufficient-evidence');
  assert.ok(result.reasons.includes('native-tool-search-control-required'));
  assert.ok(result.reasons.includes('paired-identity-required'));
  assert.ok(result.checks.some((check) => check.status === 'missing'));
});

test('gateway gate returns no-go for a complete safety or quality regression', () => {
  const result = evaluateGatewayGate({ evidence: evidence([
    hostEvidence('claude', {
      metrics: {
        ...hostEvidence('claude').metrics,
        wrongMutativeCalls: 1,
      },
    }),
    hostEvidence('codex', {
      metrics: {
        ...hostEvidence('codex').metrics,
        providerInputReductionRate: 0.04,
      },
    }),
  ]) });

  assert.equal(result.status, 'no-go');
  assert.ok(result.reasons.includes('wrong-mutative-call'));
  assert.ok(result.reasons.includes('provider-input-reduction-threshold'));
  assert.ok(result.checks.some((check) => check.status === 'fail'));
});

test('gateway gate rejects estimated provider evidence and blocks mismatched pair identity', () => {
  assert.throws(() => evaluateGatewayGate({ evidence: evidence([
    hostEvidence('claude', {
      metrics: { ...hostEvidence('claude').metrics, source: 'mechanical-estimate' },
    }),
    hostEvidence('codex'),
  ]) }), /provider-reported/i);

  const treatment = { ...hostEvidence('codex').identity.treatment, workloadDigest: digest('9') };
  const result = evaluateGatewayGate({ evidence: evidence([
    hostEvidence('claude'),
    hostEvidence('codex', { identity: { ...hostEvidence('codex').identity, treatment } }),
  ]) });
  assert.equal(result.status, 'insufficient-evidence');
  assert.ok(result.reasons.includes('paired-identity-required'));
});

test('gateway gate requires both explicit arms and provider-reported metric provenance', () => {
  const result = evaluateGatewayGate({ evidence: evidence([
    hostEvidence('claude', { controlArm: null, treatmentArm: null, metrics: { ...hostEvidence('claude').metrics, source: null } }),
    hostEvidence('codex'),
  ]) });

  assert.equal(result.status, 'insufficient-evidence');
  assert.ok(result.reasons.includes('native-tool-search-control-arm-required'));
  assert.ok(result.reasons.includes('sando-gateway-treatment-arm-required'));
  assert.ok(result.reasons.includes('provider-reported-metrics-required'));
});

test('gateway prerequisite accepts a measured residual threshold or selection defect independently', () => {
  const residualOnly = evaluateGatewayGate({ evidence: evidence([
    hostEvidence('claude', {
      prerequisite: { residualMcpTokens: 12_000 },
    }),
    hostEvidence('codex'),
  ]) });
  assert.equal(residualOnly.status, 'go');

  const defectOnly = evaluateGatewayGate({ evidence: evidence([
    hostEvidence('claude', {
      prerequisite: { selectionStartupDefectRate: 0.1 },
    }),
    hostEvidence('codex'),
  ]) });
  assert.equal(defectOnly.status, 'go');
});

test('gateway gate keeps missing sample evidence insufficient instead of calling it a regression', () => {
  const result = evaluateGatewayGate({ evidence: evidence([
    hostEvidence('claude', { samplePairs: null }),
    hostEvidence('codex'),
  ]) });

  assert.equal(result.status, 'insufficient-evidence');
  assert.ok(result.checks.some((check) => check.id === 'paired-sample-count' && check.status === 'missing'));
});

test('gateway gate rejects a disabled native Tool Search control arm', () => {
  const result = evaluateGatewayGate({ evidence: evidence([
    hostEvidence('claude', { nativeToolSearchState: 'disabled' }),
    hostEvidence('codex'),
  ]) });

  assert.equal(result.status, 'no-go');
  assert.ok(result.checks.some((check) => check.id === 'native-tool-search-control' && check.status === 'fail'));
});
