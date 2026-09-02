import { createHash } from 'node:crypto';

export const GATE_EVIDENCE_SCHEMA = 'sando-progressive-gateway-evidence/v1';
export const GATE_SCHEMA = 'sando-progressive-context-gate/v1';
export const GATE_VERSION = 1;
export const GATE_THRESHOLDS = Object.freeze({
  hosts: Object.freeze(['claude', 'codex']),
  minimumPairedSamples: 10,
  minimumDiscoveryIntents: 50,
  minimumResidualMcpTokens: 10_000,
  minimumResidualMcpRatio: 0.10,
  minimumDiscoverySuccessRate: 0.95,
  minimumSafetyCriticalDiscoveryRate: 1,
  maximumWrongMutativeCalls: 0,
  minimumProviderInputReductionRate: 0.10,
  maximumExtraToolCallsMedian: 1,
  maximumP50LatencyOverhead: 0.15,
  maximumStartupOverhead: 0.10,
  minimumSchemaValidationRate: 1,
  minimumCancellationPropagationRate: 1,
  minimumTimeoutPropagationRate: 1,
  minimumErrorPropagationRate: 1,
  minimumProgressPropagationRate: 1,
  minimumListChangedInvalidationRate: 1,
  maximumWeightedCostRatio: 1,
});

const HOSTS = new Set(GATE_THRESHOLDS.hosts);
const STATES = new Set(['enabled', 'disabled', 'unavailable', 'indeterminate']);
const METRIC_FIELDS = Object.freeze([
  'discoverySuccessRate',
  'safetyCriticalDiscoveryRate',
  'wrongMutativeCalls',
  'providerInputReductionRate',
  'extraToolCallsMedian',
  'p50LatencyOverhead',
  'startupOverhead',
  'schemaValidationRate',
  'cancellationPropagationRate',
  'timeoutPropagationRate',
  'errorPropagationRate',
  'progressPropagationRate',
  'listChangedInvalidationRate',
  'authPropagationRate',
  'approvalPropagationRate',
  'elicitationPropagationRate',
  'weightedCostRatio',
  'acceptanceControlRate',
  'acceptanceTreatmentRate',
]);
const BOUNDED_RATE_FIELDS = new Set([
  'discoverySuccessRate',
  'safetyCriticalDiscoveryRate',
  'schemaValidationRate',
  'cancellationPropagationRate',
  'timeoutPropagationRate',
  'errorPropagationRate',
  'progressPropagationRate',
  'listChangedInvalidationRate',
  'authPropagationRate',
  'approvalPropagationRate',
  'elicitationPropagationRate',
  'acceptanceControlRate',
  'acceptanceTreatmentRate',
]);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digest(value, name) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`);
  return value;
}

function rate(value, name, { minimum = 0, maximum = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function optionalInteger(value, name) {
  if (value === undefined || value === null) return null;
  return integer(value, name);
}

function optionalRate(value, name, options) {
  if (value === undefined || value === null) return null;
  return rate(value, name, options);
}

function stableJson(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined) throw new TypeError('gateway gate value is not serializable');
    return result;
  }
  if (seen.has(value)) throw new TypeError('gateway gate value must not be cyclic');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableJson(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

function provenanceDigest(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function identity(value, name) {
  if (value === undefined || value === null) return null;
  if (!object(value)) throw new TypeError(`${name} is invalid`);
  const result = {};
  for (const field of ['scenarioDigest', 'workloadDigest']) {
    result[field] = value[field] === undefined || value[field] === null
      ? null : digest(value[field], `${name}.${field}`);
  }
  for (const field of ['promptDigest', 'modelDigest', 'clientVersionDigest']) {
    if (value[field] !== undefined && value[field] !== null) result[field] = digest(value[field], `${name}.${field}`);
  }
  return result;
}

function sameIdentity(control, treatment) {
  if (!control || !treatment || control.scenarioDigest === null || control.workloadDigest === null
    || treatment.scenarioDigest === null || treatment.workloadDigest === null) return false;
  const fields = new Set([...Object.keys(control), ...Object.keys(treatment)]);
  return [...fields].every((field) => control[field] === treatment[field]);
}

function normalizeMetrics(value, host) {
  if (value === undefined || value === null) {
    return { source: null, ...Object.fromEntries(METRIC_FIELDS.map((field) => [field, null])) };
  }
  if (!object(value) || value.source === 'mechanical-estimate'
    || (value.source !== undefined && value.source !== null && value.source !== 'provider-reported')) {
    throw new TypeError(`${host}.metrics must use provider-reported evidence`);
  }
  const result = { source: value.source ?? null };
  for (const field of METRIC_FIELDS) {
    const candidate = value[field];
    if (candidate === undefined || candidate === null) result[field] = null;
    else if (field === 'wrongMutativeCalls') result[field] = integer(candidate, `${host}.metrics.${field}`);
    else if (field === 'extraToolCallsMedian') result[field] = rate(candidate, `${host}.metrics.${field}`);
    else if (field === 'weightedCostRatio') result[field] = rate(candidate, `${host}.metrics.${field}`);
    else result[field] = rate(candidate, `${host}.metrics.${field}`, {
      minimum: field === 'providerInputReductionRate' ? -Infinity : 0,
      maximum: BOUNDED_RATE_FIELDS.has(field) || field === 'providerInputReductionRate' ? 1 : Infinity,
    });
  }
  return result;
}

function normalizeHost(value) {
  if (!object(value) || !HOSTS.has(value.host)) throw new TypeError('gateway evidence host is invalid');
  const controlArm = value.controlArm ?? null;
  const treatmentArm = value.treatmentArm ?? null;
  if ((controlArm !== null && controlArm !== 'native-tool-search')
    || (treatmentArm !== null && treatmentArm !== 'sando-gateway')) {
    throw new TypeError(`${value.host} arm provenance is invalid`);
  }
  if ((value.realWorkload !== undefined && typeof value.realWorkload !== 'boolean')
    || (value.originalMcpDisabled !== undefined && typeof value.originalMcpDisabled !== 'boolean')) {
    throw new TypeError(`${value.host} workload isolation evidence is invalid`);
  }
  if ((value.catalogReadOnly !== undefined && typeof value.catalogReadOnly !== 'boolean')
    || (value.allowlistEnforced !== undefined && typeof value.allowlistEnforced !== 'boolean')
    || (value.killSwitchRollbackTested !== undefined && typeof value.killSwitchRollbackTested !== 'boolean')) {
    throw new TypeError(`${value.host} gateway safety evidence is invalid`);
  }
  const nativeToolSearchState = value.nativeToolSearchState ?? null;
  if (nativeToolSearchState !== null && !STATES.has(nativeToolSearchState)) throw new TypeError(`${value.host} Tool Search state is invalid`);
  const identityEvidence = object(value.identity)
    ? value.identity
    : value.identity === undefined || value.identity === null ? {} : null;
  if (!identityEvidence) throw new TypeError(`${value.host} identity evidence is invalid`);
  const control = identity(identityEvidence.control, `${value.host}.identity.control`);
  const treatment = identity(identityEvidence.treatment, `${value.host}.identity.treatment`);
  const prerequisite = object(value.prerequisite) ? value.prerequisite : {};
  const metrics = normalizeMetrics(value.metrics, value.host);
  return {
    host: value.host,
    controlArm,
    treatmentArm,
    realWorkload: value.realWorkload ?? null,
    originalMcpDisabled: value.originalMcpDisabled ?? null,
    catalogReadOnly: value.catalogReadOnly ?? null,
    allowlistEnforced: value.allowlistEnforced ?? null,
    killSwitchRollbackTested: value.killSwitchRollbackTested ?? null,
    nativeToolSearchState,
    samplePairs: value.samplePairs === undefined || value.samplePairs === null
      ? null : integer(value.samplePairs, `${value.host}.samplePairs`),
    discoveryIntents: value.discoveryIntents === undefined || value.discoveryIntents === null
      ? null : integer(value.discoveryIntents, `${value.host}.discoveryIntents`),
    identity: { control, treatment, paired: sameIdentity(control, treatment) },
    prerequisite: {
      residualMcpTokens: optionalInteger(prerequisite.residualMcpTokens, `${value.host}.prerequisite.residualMcpTokens`),
      initialContextTokens: optionalInteger(prerequisite.initialContextTokens, `${value.host}.prerequisite.initialContextTokens`),
      selectionStartupDefectRate: optionalRate(
        prerequisite.selectionStartupDefectRate,
        `${value.host}.prerequisite.selectionStartupDefectRate`,
        { maximum: 1 },
      ),
    },
    metrics,
  };
}

function check(host, id, observed, required, pass, { missing = observed === null } = {}) {
  return {
    host,
    id,
    status: missing ? 'missing' : pass ? 'pass' : 'fail',
    observed,
    required,
  };
}

function prerequisiteValue(value) {
  const { residualMcpTokens, initialContextTokens, selectionStartupDefectRate } = value.prerequisite;
  const residualTokens = residualMcpTokens !== null && residualMcpTokens >= GATE_THRESHOLDS.minimumResidualMcpTokens;
  const residualRatio = initialContextTokens !== null && initialContextTokens > 0 && residualMcpTokens !== null
    && residualMcpTokens / initialContextTokens >= GATE_THRESHOLDS.minimumResidualMcpRatio;
  const defect = selectionStartupDefectRate !== null && selectionStartupDefectRate > 0;
  const available = residualMcpTokens !== null || initialContextTokens !== null || selectionStartupDefectRate !== null;
  return { residualTokens, residualRatio, defect, available, qualified: residualTokens || residualRatio || defect };
}

function hostChecks(value) {
  const prerequisite = prerequisiteValue(value);
  const metrics = value.metrics;
  const checks = [
    check(value.host, 'native-tool-search-control-arm', value.controlArm, 'native-tool-search', value.controlArm === 'native-tool-search', {
      missing: value.controlArm === null,
    }),
    check(value.host, 'sando-gateway-treatment-arm', value.treatmentArm, 'sando-gateway', value.treatmentArm === 'sando-gateway', {
      missing: value.treatmentArm === null,
    }),
    check(value.host, 'paired-identity', value.identity.paired, true, value.identity.paired, { missing: !value.identity.paired }),
    check(value.host, 'real-workload', value.realWorkload, true, value.realWorkload === true, { missing: value.realWorkload === null }),
    check(value.host, 'native-tool-search-control', value.nativeToolSearchState, 'enabled', value.nativeToolSearchState === 'enabled', {
      missing: !['enabled', 'disabled'].includes(value.nativeToolSearchState),
    }),
    check(value.host, 'isolated-original-mcp', value.originalMcpDisabled, true, value.originalMcpDisabled === true, { missing: value.originalMcpDisabled === null }),
    check(value.host, 'paired-sample-count', value.samplePairs, GATE_THRESHOLDS.minimumPairedSamples,
      value.samplePairs !== null && value.samplePairs >= GATE_THRESHOLDS.minimumPairedSamples),
    check(value.host, 'discovery-intent-count', value.discoveryIntents, GATE_THRESHOLDS.minimumDiscoveryIntents,
      value.discoveryIntents !== null && value.discoveryIntents >= GATE_THRESHOLDS.minimumDiscoveryIntents),
    check(value.host, 'catalog-read-only', value.catalogReadOnly, true, value.catalogReadOnly === true, { missing: value.catalogReadOnly === null }),
    check(value.host, 'allowlist', value.allowlistEnforced, true, value.allowlistEnforced === true, { missing: value.allowlistEnforced === null }),
    check(value.host, 'kill-switch-rollback', value.killSwitchRollbackTested, true, value.killSwitchRollbackTested === true, { missing: value.killSwitchRollbackTested === null }),
    check(value.host, 'gateway-prerequisite', {
      residualMcpTokens: value.prerequisite.residualMcpTokens,
      initialContextTokens: value.prerequisite.initialContextTokens,
      selectionStartupDefectRate: value.prerequisite.selectionStartupDefectRate,
      qualified: prerequisite.qualified,
    }, 'residual threshold or measured selection/startup defect', prerequisite.qualified, {
      missing: !prerequisite.available,
    }),
    check(value.host, 'provider-reported-metrics', metrics.source, 'provider-reported', metrics.source === 'provider-reported', {
      missing: metrics.source === null,
    }),
    check(value.host, 'discovery-success', metrics.discoverySuccessRate, GATE_THRESHOLDS.minimumDiscoverySuccessRate,
      metrics.discoverySuccessRate !== null && metrics.discoverySuccessRate >= GATE_THRESHOLDS.minimumDiscoverySuccessRate),
    check(value.host, 'safety-critical-discovery', metrics.safetyCriticalDiscoveryRate, GATE_THRESHOLDS.minimumSafetyCriticalDiscoveryRate,
      metrics.safetyCriticalDiscoveryRate !== null && metrics.safetyCriticalDiscoveryRate >= GATE_THRESHOLDS.minimumSafetyCriticalDiscoveryRate),
    check(value.host, 'wrong-mutative-calls', metrics.wrongMutativeCalls, GATE_THRESHOLDS.maximumWrongMutativeCalls,
      metrics.wrongMutativeCalls !== null && metrics.wrongMutativeCalls <= GATE_THRESHOLDS.maximumWrongMutativeCalls),
    check(value.host, 'provider-input-reduction', metrics.providerInputReductionRate, GATE_THRESHOLDS.minimumProviderInputReductionRate,
      metrics.providerInputReductionRate !== null && metrics.providerInputReductionRate >= GATE_THRESHOLDS.minimumProviderInputReductionRate),
    check(value.host, 'extra-tool-calls', metrics.extraToolCallsMedian, GATE_THRESHOLDS.maximumExtraToolCallsMedian,
      metrics.extraToolCallsMedian !== null && metrics.extraToolCallsMedian <= GATE_THRESHOLDS.maximumExtraToolCallsMedian),
    check(value.host, 'p50-latency-overhead', metrics.p50LatencyOverhead, GATE_THRESHOLDS.maximumP50LatencyOverhead,
      metrics.p50LatencyOverhead !== null && metrics.p50LatencyOverhead <= GATE_THRESHOLDS.maximumP50LatencyOverhead),
    check(value.host, 'startup-overhead', metrics.startupOverhead, GATE_THRESHOLDS.maximumStartupOverhead,
      metrics.startupOverhead !== null && metrics.startupOverhead <= GATE_THRESHOLDS.maximumStartupOverhead),
    check(value.host, 'schema-validation', metrics.schemaValidationRate, GATE_THRESHOLDS.minimumSchemaValidationRate,
      metrics.schemaValidationRate !== null && metrics.schemaValidationRate >= GATE_THRESHOLDS.minimumSchemaValidationRate),
    check(value.host, 'cancellation-propagation', metrics.cancellationPropagationRate, GATE_THRESHOLDS.minimumCancellationPropagationRate,
      metrics.cancellationPropagationRate !== null && metrics.cancellationPropagationRate >= GATE_THRESHOLDS.minimumCancellationPropagationRate),
    check(value.host, 'timeout-propagation', metrics.timeoutPropagationRate, GATE_THRESHOLDS.minimumTimeoutPropagationRate,
      metrics.timeoutPropagationRate !== null && metrics.timeoutPropagationRate >= GATE_THRESHOLDS.minimumTimeoutPropagationRate),
    check(value.host, 'error-propagation', metrics.errorPropagationRate, GATE_THRESHOLDS.minimumErrorPropagationRate,
      metrics.errorPropagationRate !== null && metrics.errorPropagationRate >= GATE_THRESHOLDS.minimumErrorPropagationRate),
    check(value.host, 'progress-propagation', metrics.progressPropagationRate, GATE_THRESHOLDS.minimumProgressPropagationRate,
      metrics.progressPropagationRate !== null && metrics.progressPropagationRate >= GATE_THRESHOLDS.minimumProgressPropagationRate),
    check(value.host, 'list-changed-invalidation', metrics.listChangedInvalidationRate, GATE_THRESHOLDS.minimumListChangedInvalidationRate,
      metrics.listChangedInvalidationRate !== null && metrics.listChangedInvalidationRate >= GATE_THRESHOLDS.minimumListChangedInvalidationRate),
    check(value.host, 'auth-propagation', metrics.authPropagationRate, 1,
      metrics.authPropagationRate !== null && metrics.authPropagationRate >= 1),
    check(value.host, 'approval-propagation', metrics.approvalPropagationRate, 1,
      metrics.approvalPropagationRate !== null && metrics.approvalPropagationRate >= 1),
    check(value.host, 'elicitation-propagation', metrics.elicitationPropagationRate, 1,
      metrics.elicitationPropagationRate !== null && metrics.elicitationPropagationRate >= 1),
    check(value.host, 'weighted-cost', metrics.weightedCostRatio, GATE_THRESHOLDS.maximumWeightedCostRatio,
      metrics.weightedCostRatio !== null && metrics.weightedCostRatio <= GATE_THRESHOLDS.maximumWeightedCostRatio),
    check(value.host, 'acceptance-no-regression', {
      control: metrics.acceptanceControlRate,
      treatment: metrics.acceptanceTreatmentRate,
    }, 'treatment >= control',
    metrics.acceptanceControlRate !== null && metrics.acceptanceTreatmentRate !== null
      && metrics.acceptanceTreatmentRate >= metrics.acceptanceControlRate,
    { missing: metrics.acceptanceControlRate === null || metrics.acceptanceTreatmentRate === null }),
  ];
  return checks;
}

function reasonFor(checkValue) {
  const names = {
    'paired-identity': 'paired-identity-required',
    'native-tool-search-control-arm': 'native-tool-search-control-arm-required',
    'sando-gateway-treatment-arm': 'sando-gateway-treatment-arm-required',
    'provider-reported-metrics': 'provider-reported-metrics-required',
    'both-hosts': 'both-hosts-required',
    'real-workload': 'real-workload-required',
    'native-tool-search-control': 'native-tool-search-control-required',
    'isolated-original-mcp': 'isolated-original-mcp-required',
    'paired-sample-count': 'minimum-paired-samples-required',
    'discovery-intent-count': 'minimum-discovery-intents-required',
    'catalog-read-only': 'catalog-read-only-required',
    allowlist: 'allowlist-required',
    'kill-switch-rollback': 'kill-switch-rollback-required',
    'gateway-prerequisite': 'gateway-prerequisite-not-established',
    'discovery-success': 'discovery-success-threshold',
    'safety-critical-discovery': 'safety-critical-discovery-threshold',
    'wrong-mutative-calls': 'wrong-mutative-call',
    'provider-input-reduction': 'provider-input-reduction-threshold',
    'extra-tool-calls': 'extra-tool-call-threshold',
    'p50-latency-overhead': 'latency-overhead-threshold',
    'startup-overhead': 'startup-overhead-threshold',
    'schema-validation': 'schema-validation-threshold',
    'cancellation-propagation': 'cancellation-propagation-threshold',
    'timeout-propagation': 'timeout-propagation-threshold',
    'error-propagation': 'error-propagation-threshold',
    'progress-propagation': 'progress-propagation-threshold',
    'list-changed-invalidation': 'list-changed-invalidation-threshold',
    'auth-propagation': 'auth-propagation-threshold',
    'approval-propagation': 'approval-propagation-threshold',
    'elicitation-propagation': 'elicitation-propagation-threshold',
    'weighted-cost': 'weighted-cost-regression',
    'acceptance-no-regression': 'acceptance-regression',
  };
  return names[checkValue.id] ?? `${checkValue.id}-check`;
}

function normalizeEvidence(value) {
  if (!object(value) || value.schema !== GATE_EVIDENCE_SCHEMA || value.version !== GATE_VERSION) {
    throw new TypeError('gateway evidence schema is invalid');
  }
  if (!Array.isArray(value.hosts)) throw new TypeError('gateway evidence hosts are invalid');
  const hosts = value.hosts.map(normalizeHost).sort((left, right) => left.host.localeCompare(right.host));
  if (new Set(hosts.map((item) => item.host)).size !== hosts.length) throw new TypeError('gateway evidence contains duplicate hosts');
  return hosts;
}

function safeHost(value) {
  return {
    host: value.host,
    controlArm: value.controlArm,
    treatmentArm: value.treatmentArm,
    samplePairs: value.samplePairs,
    discoveryIntents: value.discoveryIntents,
    realWorkload: value.realWorkload,
    originalMcpDisabled: value.originalMcpDisabled,
    catalogReadOnly: value.catalogReadOnly,
    allowlistEnforced: value.allowlistEnforced,
    killSwitchRollbackTested: value.killSwitchRollbackTested,
    nativeToolSearchState: value.nativeToolSearchState,
    identity: value.identity,
    prerequisite: value.prerequisite,
    metrics: value.metrics,
  };
}

export function evaluateGatewayGate({ evidence } = {}) {
  const hosts = normalizeEvidence(evidence ?? { schema: GATE_EVIDENCE_SCHEMA, version: GATE_VERSION, hosts: [] });
  const checks = hosts.flatMap(hostChecks);
  if (hosts.length !== GATE_THRESHOLDS.hosts.length || hosts.some((item) => !HOSTS.has(item.host))) {
    checks.unshift({
      host: 'all', id: 'both-hosts', status: 'missing', observed: hosts.map((item) => item.host), required: GATE_THRESHOLDS.hosts,
    });
  } else {
    checks.unshift({ host: 'all', id: 'both-hosts', status: 'pass', observed: hosts.map((item) => item.host), required: GATE_THRESHOLDS.hosts });
  }
  const missing = checks.filter((item) => item.status === 'missing');
  const failed = checks.filter((item) => item.status === 'fail');
  const status = missing.length > 0 ? 'insufficient-evidence' : failed.length > 0 ? 'no-go' : 'go';
  const reasons = [...new Set(checks.filter((item) => item.status !== 'pass').map(reasonFor))].sort();
  const report = {
    schema: GATE_SCHEMA,
    version: GATE_VERSION,
    feature: 'lazy-mcp-gateway',
    status,
    thresholds: GATE_THRESHOLDS,
    hosts: hosts.map(safeHost),
    checks,
    reasons,
  };
  return { ...report, provenanceDigest: provenanceDigest(report) };
}

export function serializeGatewayGate(report) {
  if (!object(report) || report.schema !== GATE_SCHEMA || report.version !== GATE_VERSION) {
    throw new TypeError('gateway gate report is invalid');
  }
  return stableJson(report);
}
