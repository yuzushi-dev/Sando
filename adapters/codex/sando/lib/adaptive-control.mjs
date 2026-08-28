const ARMS = new Set(['apply', 'control']);

export const ADAPTIVE_ARMS = Object.freeze(['apply', 'control']);
export const DEFAULT_ADAPTIVE_WEIGHTS = Object.freeze({
  freshInput: 1,
  cacheRead: 0.1,
  cacheWrite: 1.25,
  output: 1,
  reasoningOutput: 1,
});

export function adaptiveArmFromEnv(env = process.env) {
  const value = env.SANDO_ADAPTIVE_ARM ?? 'apply';
  return ARMS.has(value) ? value : null;
}

export function adaptiveExperimentFromEnv(env = process.env) {
  const value = env.SANDO_ADAPTIVE_EXPERIMENT ?? 'default';
  return text(value) ? value : 'default';
}

export function adaptiveWorkloadFromEnv(env = process.env) {
  const value = env.SANDO_ADAPTIVE_WORKLOAD;
  return text(value) ? value : undefined;
}

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function text(value) {
  return typeof value === 'string' && value.length > 0;
}

function weights(value) {
  const result = { ...DEFAULT_ADAPTIVE_WEIGHTS, ...(value ?? {}) };
  if (Object.keys(result).some((key) => !Object.hasOwn(DEFAULT_ADAPTIVE_WEIGHTS, key))
    || Object.values(result).some((item) => typeof item !== 'number' || !Number.isFinite(item) || item < 0)) {
    throw new TypeError('adaptive weights are invalid');
  }
  return result;
}

function costUnits(parts, pricing) {
  const value = parts.freshInputTokens * pricing.freshInput
    + parts.cachedInputTokens * pricing.cacheRead
    + parts.cacheWriteInputTokens * pricing.cacheWrite
    + parts.outputTokens * pricing.output
    + parts.reasoningOutputTokens * pricing.reasoningOutput;
  if (!Number.isFinite(value)) throw new RangeError('adaptive cost overflow');
  return value;
}

export function computeUsageCost(record, pricing) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('usage record is invalid');
  const inputTokens = record.inputTokens;
  const cachedInputTokens = record.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = record.cacheWriteInputTokens ?? 0;
  const outputTokens = record.outputTokens;
  const reasoningOutputTokens = record.reasoningOutputTokens ?? 0;
  if (![inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens].every(counter)
    || cachedInputTokens + cacheWriteInputTokens > inputTokens) throw new TypeError('usage counters are invalid');
  const parts = {
    freshInputTokens: inputTokens - cachedInputTokens - cacheWriteInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
  return { ...parts, costUnits: costUnits(parts, weights(pricing)) };
}

function sessionKey(record) {
  return `${record.arm}\0${record.sessionId}`;
}

export function summarizeAdaptiveSessions(records, { host, experimentId, workloadId, pricing } = {}) {
  if (!Array.isArray(records)) throw new TypeError('usage records must be an array');
  const groups = new Map();
  records.forEach((record, index) => {
    if (!record || typeof record !== 'object' || record.host !== host || !ARMS.has(record.arm)
      || !text(record.sessionId) || (experimentId !== undefined && record.experimentId !== experimentId)
      || (workloadId !== undefined && record.workloadId !== workloadId)) return;
    let group = groups.get(sessionKey(record));
    if (!group) {
      group = { sessionId: record.sessionId, arm: record.arm, costUnits: 0, turnIds: new Set() };
      groups.set(sessionKey(record), group);
    }
    const usage = computeUsageCost(record, pricing);
    group.costUnits += usage.costUnits;
    group.turnIds.add(text(record.turnId) ? record.turnId : `record:${index}`);
  });
  return [...groups.values()]
    .map(({ turnIds, ...group }) => ({ ...group, turns: turnIds.size }))
    .sort((left, right) => left.arm.localeCompare(right.arm) || left.sessionId.localeCompare(right.sessionId));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function cohort(sessions, arm) {
  const values = sessions.filter((session) => session.arm === arm);
  return {
    sessions: values.length,
    medianCostUnits: median(values.map((session) => session.costUnits)),
    medianTurns: median(values.map((session) => session.turns)),
  };
}

function ratio(left, right) {
  if (left === null || right === null) return null;
  if (right === 0) return left === 0 ? 1 : Infinity;
  return left / right;
}

export function decideAdaptiveRouting({ records, host, experimentId, workloadId, minSessions = 3, tolerance = 0.05, pricing } = {}) {
  if (!text(host)) throw new TypeError('adaptive host is required');
  if (experimentId !== undefined && !text(experimentId)) throw new TypeError('adaptive experiment is invalid');
  if (workloadId !== undefined && !text(workloadId)) throw new TypeError('adaptive workload is invalid');
  if (!Number.isSafeInteger(minSessions) || minSessions < 1 || minSessions > 1000) throw new TypeError('adaptive minSessions is invalid');
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) throw new TypeError('adaptive tolerance is invalid');
  const sessions = summarizeAdaptiveSessions(records, { host, experimentId, workloadId, pricing });
  const control = cohort(sessions, 'control');
  const apply = cohort(sessions, 'apply');
  const base = { enabled: true, control, apply, costRatio: ratio(apply.medianCostUnits, control.medianCostUnits), turnRatio: ratio(apply.medianTurns, control.medianTurns) };
  if (control.sessions < minSessions || apply.sessions < minSessions) return { ...base, reason: 'insufficient-evidence' };
  if (apply.medianCostUnits > control.medianCostUnits * (1 + tolerance)) return { ...base, enabled: false, reason: 'cost-backoff' };
  if (apply.medianTurns > control.medianTurns * (1 + tolerance)) return { ...base, enabled: false, reason: 'turn-backoff' };
  return { ...base, reason: 'evidence-favorable' };
}
