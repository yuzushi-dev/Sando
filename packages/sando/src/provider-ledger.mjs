const SCHEMA = 'sando-provider-ledger/v1';
const VERSION = 1;
const PERIODS = new Set(['session', 'day', 'week', 'month']);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const PROVIDER_LEDGER_SCHEMA = SCHEMA;
export const PROVIDER_LEDGER_VERSION = VERSION;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.length > 0;
}

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeSum(...values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function dateValue(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function usageValue(usage) {
  if (!record(usage) || !Object.hasOwn(usage, 'promptTokens') || !Object.hasOwn(usage, 'outputTokens')
    || !counter(usage.promptTokens) || !counter(usage.outputTokens)) return null;
  const cacheReadTokens = usage.cacheReadTokens === undefined ? 0 : usage.cacheReadTokens;
  const cacheWriteTokens = usage.cacheWriteTokens === undefined ? 0 : usage.cacheWriteTokens;
  if (!counter(cacheReadTokens) || !counter(cacheWriteTokens)) return null;
  const inputTokens = safeSum(usage.promptTokens, usage.outputTokens);
  const cachedTokens = safeSum(cacheReadTokens, cacheWriteTokens);
  if (inputTokens === null || cachedTokens === null || cachedTokens > usage.promptTokens) return null;
  return {
    promptTokens: usage.promptTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    effectiveInputTokens: usage.promptTokens - cacheReadTokens,
    totalTokens: inputTokens,
  };
}

export function createProviderLedgerEntry(input) {
  if (!record(input) || !text(input.provider) || !text(input.sessionId)
    || (input.model !== undefined && input.model !== null && !text(input.model))) return null;
  const at = dateValue(input.at);
  const usage = usageValue(input.usage);
  const rawUsage = input.rawUsage === undefined ? input.usage : input.rawUsage;
  if (!at || !usage || !record(rawUsage)) return null;
  try {
    return {
      schema: SCHEMA,
      version: VERSION,
      provider: input.provider,
      model: input.model ?? null,
      sessionId: input.sessionId,
      at: at.toISOString(),
      usage,
      rawUsage: structuredClone(rawUsage),
    };
  } catch {
    return null;
  }
}

function validEntry(entry) {
  if (!record(entry) || entry.schema !== SCHEMA || entry.version !== VERSION
    || !text(entry.provider) || !text(entry.sessionId)
    || (entry.model !== null && !text(entry.model))) return false;
  const at = dateValue(entry.at);
  const usage = usageValue(entry.usage);
  return Boolean(at && usage && entry.at === at.toISOString() && record(entry.rawUsage)
    && Object.keys(entry.usage).length === 6
    && Object.entries(usage).every(([field, value]) => entry.usage[field] === value));
}

function isoWeek(date) {
  const current = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = current.getUTCDay() || 7;
  current.setUTCDate(current.getUTCDate() + 4 - weekday);
  const year = current.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((current - firstThursday) / WEEK_MS);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function periodKey(entry, period) {
  if (period === 'session') return entry.sessionId;
  const date = new Date(entry.at);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  if (period === 'month') return `${year}-${month}`;
  if (period === 'week') return isoWeek(date);
  return `${year}-${month}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addUsage(left, right) {
  const usage = {};
  for (const field of ['promptTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'effectiveInputTokens', 'totalTokens']) {
    usage[field] = safeSum(left[field], right[field]);
    if (usage[field] === null) throw new Error('provider ledger aggregate overflow');
  }
  return usage;
}

export function aggregateProviderLedger(entries, period = 'session') {
  if (!Array.isArray(entries)) throw new TypeError('provider ledger entries must be an array');
  if (!PERIODS.has(period)) throw new TypeError('provider ledger period is invalid');
  const groups = new Map();
  for (const entry of entries) {
    if (!validEntry(entry)) throw new TypeError('invalid provider ledger entry');
    const key = periodKey(entry, period);
    const current = groups.get(key);
    groups.set(key, current ? {
      period: key,
      entryCount: current.entryCount + 1,
      usage: addUsage(current.usage, entry.usage),
    } : {
      period: key,
      entryCount: 1,
      usage: entry.usage,
    });
  }
  return {
    schema: SCHEMA,
    version: VERSION,
    period,
    buckets: [...groups.values()].sort((left, right) => left.period.localeCompare(right.period)),
  };
}
