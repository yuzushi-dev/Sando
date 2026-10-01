const ARMS = new Set(['apply', 'control']);
const OUTCOMES = new Set(['passed', 'failed']);
const CACHE_STATUSES = new Set(['observed', 'unavailable']);
const COST_STATUSES = new Set(['complete', 'incomplete']);
const ORDER_POSITIONS = new Set([1, 2]);

function object(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function text(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be non-empty text`);
  return value;
}

function member(value, allowed, field) {
  if (!allowed.has(value)) throw new TypeError(`${field} is unsupported`);
  return value;
}

function integer(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${field} must be an integer >= ${minimum}`);
  return value;
}

function amount(value, field) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be a finite number >= 0`);
  return value;
}

function addInteger(left, right, field) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${field} overflow`);
  return result;
}

function addCost(left, right) {
  const result = left + right;
  if (!Number.isFinite(result)) throw new RangeError('cost overflow');
  return result;
}

function validateCache(value, prefix) {
  const cache = object(value, `${prefix}.cache`);
  const status = member(cache.status, CACHE_STATUSES, `${prefix}.cache.status`);
  if (status === 'unavailable') {
    if (cache.readInputTokens !== null || cache.writeInputTokens !== null) {
      throw new TypeError(`${prefix}.cache unavailable counters must be null`);
    }
    return { status, readInputTokens: null, writeInputTokens: null };
  }
  return {
    status,
    readInputTokens: integer(cache.readInputTokens, `${prefix}.cache.readInputTokens`),
    writeInputTokens: integer(cache.writeInputTokens, `${prefix}.cache.writeInputTokens`),
  };
}

function validateCost(value, prefix) {
  const cost = object(value, `${prefix}.cost`);
  const status = member(cost.status, COST_STATUSES, `${prefix}.cost.status`);
  if (status === 'complete') {
    const supportedSubtotalUsd = amount(cost.supportedSubtotalUsd, `${prefix}.cost.supportedSubtotalUsd`);
    const estimatedApiCostUsd = amount(cost.estimatedApiCostUsd, `${prefix}.cost.estimatedApiCostUsd`);
    if (supportedSubtotalUsd !== estimatedApiCostUsd) {
      throw new TypeError(`${prefix}.cost supported subtotal must equal complete estimate`);
    }
    return { status, estimatedApiCostUsd, supportedSubtotalUsd };
  }
  if (cost.estimatedApiCostUsd !== null) {
    throw new TypeError(`${prefix}.cost incomplete estimate must be null`);
  }
  const supportedSubtotalUsd = cost.supportedSubtotalUsd === null ? null
    : amount(cost.supportedSubtotalUsd, `${prefix}.cost.supportedSubtotalUsd`);
  return { status, estimatedApiCostUsd: null, supportedSubtotalUsd };
}

function validateAttempt(value, index) {
  const prefix = `attempts[${index}]`;
  const attempt = object(value, prefix);
  if (attempt.schemaVersion !== 'sando.benchmark-attempt.v1') {
    throw new TypeError(`${prefix}.schemaVersion is unsupported`);
  }
  const outcome = member(attempt.outcome, OUTCOMES, `${prefix}.outcome`);
  if (typeof attempt.successVerified !== 'boolean'
    || (outcome === 'passed' && attempt.successVerified !== true)) {
    throw new TypeError(`${prefix}.successVerified is inconsistent with outcome`);
  }
  const failure = attempt.successVerified ? null : text(attempt.failure, `${prefix}.failure`);
  const observedInteger = (value, field) => {
    if (!attempt.successVerified && value === null) return null;
    return integer(value, `${prefix}.${field}`);
  };
  return {
    benchmarkId: text(attempt.benchmarkId, `${prefix}.benchmarkId`),
    taskId: text(attempt.taskId, `${prefix}.taskId`),
    arm: member(attempt.arm, ARMS, `${prefix}.arm`),
    repetition: integer(attempt.repetition, `${prefix}.repetition`, 1),
    orderPosition: member(attempt.orderPosition, ORDER_POSITIONS, `${prefix}.orderPosition`),
    outcome,
    successVerified: attempt.successVerified,
    failure,
    attempts: integer(attempt.attempts, `${prefix}.attempts`, 1),
    durationMs: observedInteger(attempt.durationMs, 'durationMs'),
    toolCalls: observedInteger(attempt.toolCalls, 'toolCalls'),
    artifactRetrievals: observedInteger(attempt.artifactRetrievals, 'artifactRetrievals'),
    cache: validateCache(attempt.cache, prefix),
    cost: validateCost(attempt.cost, prefix),
  };
}

function newGroup({ benchmarkId, taskId, arm }) {
  return {
    benchmarkId,
    taskId,
    arm,
    runs: 0,
    successfulCompletions: 0,
    failedCompletions: 0,
    unverifiedFailures: 0,
    totalAttempts: 0,
    durationMs: 0,
    supportedDurationMs: 0,
    observedDurationRuns: 0,
    toolCalls: 0,
    supportedToolCalls: 0,
    observedToolCallRuns: 0,
    artifactRetrievals: 0,
    supportedArtifactRetrievals: 0,
    observedArtifactRuns: 0,
    cache: { observedRuns: 0, unavailableRuns: 0, readInputTokens: 0, writeInputTokens: 0 },
    allAttemptsCost: { status: 'determined', totalUsd: 0, supportedSubtotalUsd: null },
    costPerSuccessfulCompletion: { status: 'indeterminate', usd: null },
  };
}

export function summarizeBenchmarkAttempts(values) {
  if (!Array.isArray(values)) throw new TypeError('attempts must be an array');
  const groups = new Map();
  const seen = new Set();

  values.map(validateAttempt).forEach((attempt) => {
    const runKey = JSON.stringify([attempt.benchmarkId, attempt.taskId, attempt.arm, attempt.repetition]);
    if (seen.has(runKey)) throw new TypeError('duplicate benchmark task, arm, and repetition');
    seen.add(runKey);
    const groupKey = JSON.stringify([attempt.benchmarkId, attempt.taskId, attempt.arm]);
    const group = groups.get(groupKey) ?? newGroup(attempt);
    groups.set(groupKey, group);

    group.runs = addInteger(group.runs, 1, 'runs');
    group.successfulCompletions = addInteger(group.successfulCompletions,
      attempt.outcome === 'passed' ? 1 : 0, 'successfulCompletions');
    group.failedCompletions = addInteger(group.failedCompletions,
      attempt.outcome === 'failed' ? 1 : 0, 'failedCompletions');
    group.unverifiedFailures = addInteger(group.unverifiedFailures,
      attempt.successVerified ? 0 : 1, 'unverifiedFailures');
    group.totalAttempts = addInteger(group.totalAttempts, attempt.attempts, 'attempts');
    if (attempt.successVerified) {
      group.supportedDurationMs = addInteger(group.supportedDurationMs, attempt.durationMs, 'supportedDurationMs');
      group.supportedToolCalls = addInteger(group.supportedToolCalls, attempt.toolCalls, 'supportedToolCalls');
      group.supportedArtifactRetrievals = addInteger(group.supportedArtifactRetrievals,
        attempt.artifactRetrievals, 'supportedArtifactRetrievals');
      group.observedDurationRuns = addInteger(group.observedDurationRuns, 1, 'observedDurationRuns');
      group.observedToolCallRuns = addInteger(group.observedToolCallRuns, 1, 'observedToolCallRuns');
      group.observedArtifactRuns = addInteger(group.observedArtifactRuns, 1, 'observedArtifactRuns');
      if (group.durationMs !== null) group.durationMs = addInteger(group.durationMs, attempt.durationMs, 'durationMs');
      if (group.toolCalls !== null) group.toolCalls = addInteger(group.toolCalls, attempt.toolCalls, 'toolCalls');
      if (group.artifactRetrievals !== null) group.artifactRetrievals = addInteger(group.artifactRetrievals,
        attempt.artifactRetrievals, 'artifactRetrievals');
    } else {
      group.durationMs = null;
      group.toolCalls = null;
      group.artifactRetrievals = null;
    }
    const cacheRunField = attempt.cache.status === 'observed' ? 'observedRuns' : 'unavailableRuns';
    group.cache[cacheRunField] = addInteger(group.cache[cacheRunField], 1, `cache.${cacheRunField}`);
    if (attempt.cache.status === 'observed') {
      group.cache.readInputTokens = addInteger(group.cache.readInputTokens,
        attempt.cache.readInputTokens, 'cache.readInputTokens');
      group.cache.writeInputTokens = addInteger(group.cache.writeInputTokens,
        attempt.cache.writeInputTokens, 'cache.writeInputTokens');
    }
    if (attempt.cost.supportedSubtotalUsd !== null) {
      group.allAttemptsCost.supportedSubtotalUsd = addCost(
        group.allAttemptsCost.supportedSubtotalUsd ?? 0, attempt.cost.supportedSubtotalUsd);
    }
    if (attempt.cost.status === 'complete' && group.allAttemptsCost.status === 'determined') {
      group.allAttemptsCost.totalUsd = addCost(
        group.allAttemptsCost.totalUsd, attempt.cost.estimatedApiCostUsd);
    } else {
      group.allAttemptsCost.status = 'indeterminate';
      group.allAttemptsCost.totalUsd = null;
    }
  });

  const result = [...groups.values()]
    .sort((left, right) => left.taskId.localeCompare(right.taskId)
      || left.arm.localeCompare(right.arm)
      || left.benchmarkId.localeCompare(right.benchmarkId));
  for (const group of result) {
    if (group.allAttemptsCost.status === 'determined' && group.successfulCompletions > 0) {
      group.costPerSuccessfulCompletion = {
        status: 'determined',
        usd: group.allAttemptsCost.totalUsd / group.successfulCompletions,
      };
    }
  }
  return { schemaVersion: 'sando.benchmark-summary.v1', groups: result };
}
