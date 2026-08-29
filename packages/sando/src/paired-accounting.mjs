const ARMS = new Set(['apply', 'control']);

export const PAIRED_ARMS = Object.freeze(['apply', 'control']);
export const DEFAULT_ACCOUNTING_WEIGHTS = Object.freeze({
  freshInput: 1,
  cacheRead: 0.1,
  cacheWrite: 1.25,
  output: 1,
  reasoningOutput: 1,
});

function text(value) {
  return typeof value === 'string' && value.length > 0;
}

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function weights(value) {
  const result = { ...DEFAULT_ACCOUNTING_WEIGHTS, ...(value ?? {}) };
  if (Object.keys(result).some((key) => !Object.hasOwn(DEFAULT_ACCOUNTING_WEIGHTS, key))
    || Object.values(result).some((item) => typeof item !== 'number' || !Number.isFinite(item) || item < 0)) {
    throw new TypeError('accounting weights are invalid');
  }
  return result;
}

function add(left, right, message = 'accounting aggregate overflow') {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new RangeError(message);
  return total;
}

function armValue(env) {
  return env.SANDO_EXPERIMENT_ARM ?? env.SANDO_ADAPTIVE_ARM ?? 'apply';
}

export function pairedArmFromEnv(env = process.env) {
  const value = armValue(env);
  return ARMS.has(value) ? value : null;
}

export function pairedExperimentFromEnv(env = process.env) {
  const value = env.SANDO_EXPERIMENT ?? env.SANDO_ADAPTIVE_EXPERIMENT ?? 'default';
  return text(value) ? value : 'default';
}

export function pairedWorkloadFromEnv(env = process.env) {
  const value = env.SANDO_EXPERIMENT_WORKLOAD ?? env.SANDO_ADAPTIVE_WORKLOAD;
  return text(value) ? value : undefined;
}

export function computeWeightedUsage(record, pricing) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('usage record is invalid');
  const inputTokens = record.inputTokens;
  const cachedInputTokens = record.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = record.cacheWriteInputTokens ?? 0;
  const outputTokens = record.outputTokens;
  const reasoningOutputTokens = record.reasoningOutputTokens ?? 0;
  if (![inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens].every(counter)
    || cachedInputTokens + cacheWriteInputTokens > inputTokens) throw new TypeError('usage counters are invalid');
  const parts = {
    inputTokens,
    freshInputTokens: inputTokens - cachedInputTokens - cacheWriteInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
  const prices = weights(pricing);
  const costUnits = parts.freshInputTokens * prices.freshInput
    + parts.cachedInputTokens * prices.cacheRead
    + parts.cacheWriteInputTokens * prices.cacheWrite
    + parts.outputTokens * prices.output
    + parts.reasoningOutputTokens * prices.reasoningOutput;
  if (!Number.isFinite(costUnits)) throw new RangeError('accounting cost overflow');
  return { ...parts, costUnits };
}

function sessionKey(item) {
  return `${item.arm}\0${item.sessionId}`;
}

function optionalCounter(item, field) {
  return item[field] === undefined ? undefined : counter(item[field]) ? item[field] : null;
}

export function summarizePairedSessions(records, { host, experimentId, workloadId, pricing } = {}) {
  if (!Array.isArray(records)) throw new TypeError('usage records must be an array');
  const groups = new Map();
  records.forEach((item, index) => {
    if (!item || typeof item !== 'object' || item.host !== host || !ARMS.has(item.arm)
      || !text(item.sessionId) || (experimentId !== undefined && item.experimentId !== experimentId)
      || (workloadId !== undefined && item.workloadId !== workloadId)) return;
    const usage = computeWeightedUsage(item, pricing);
    const fields = {
      inputTokens: usage.inputTokens,
      freshInputTokens: usage.freshInputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      totalTokens: add(item.inputTokens, item.outputTokens),
      costUnits: usage.costUnits,
    };
    const current = groups.get(sessionKey(item));
    if (!current) {
      groups.set(sessionKey(item), {
        sessionId: item.sessionId, arm: item.arm, ...fields,
        turnIds: new Set([text(item.turnId) ? item.turnId : `record:${index}`]),
        totalToolCalls: optionalCounter(item, 'totalToolCalls') ?? null,
        nativeToolCalls: optionalCounter(item, 'nativeToolCalls') ?? null,
        sandoMcpCalls: optionalCounter(item, 'sandoMcpCalls') ?? null,
        mechanicalContextTrimmedBytes: optionalCounter(item, 'mechanicalContextTrimmedBytes') ?? null,
      });
      return;
    }
    for (const field of Object.keys(fields)) current[field] = add(current[field], fields[field]);
    current.turnIds.add(text(item.turnId) ? item.turnId : `record:${index}`);
    for (const field of ['totalToolCalls', 'nativeToolCalls', 'sandoMcpCalls', 'mechanicalContextTrimmedBytes']) {
      if (current[field] !== null) {
        const value = optionalCounter(item, field);
        current[field] = value === undefined || value === null || current[field] === null
          ? null : add(current[field], value);
      }
    }
  });
  return [...groups.values()]
    .map(({ turnIds, ...group }) => ({ ...group, turns: turnIds.size }))
    .sort((left, right) => left.arm.localeCompare(right.arm) || left.sessionId.localeCompare(right.sessionId));
}
