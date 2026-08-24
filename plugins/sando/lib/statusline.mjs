import {
  buildMetricsReport,
  defaultMetricsPath,
  readMetrics,
} from './metrics.mjs';
import {
  buildProviderUsageReport,
  defaultProviderUsagePath,
  readProviderUsage,
} from './provider-usage.mjs';

export const STATUSLINE_MAX_AGE_MS = 5 * 60 * 1000;

const INPUT_PRICE_PER_MILLION = [
  [/^(?:claude-)?sonnet(?:-?5)?$/, 2],
  [/claude-sonnet-5/, 2],
  [/claude-sonnet-(?:4(?:[.-][0-9]+)?|3(?:[.-][0-9]+)?)/, 3],
  [/claude-opus-4[.-]1$/, 15],
  [/claude-opus-4$/, 15],
  [/^(?:claude-)?opus(?:-?4(?:[.-][0-9]+)?)?$/, 5],
  [/claude-opus-4\.[5678]|claude-opus-4-(?:[5678]|[.]\d+)/, 5],
  [/^(?:claude-)?haiku$/, 1],
  [/claude-haiku-4[.-]5/, 1],
  [/claude-haiku-3[.-]5/, 0.8],
  [/claude-haiku-3$/, 0.25],
];

function latestAt(records) {
  const timestamp = records.reduce((latest, item) => {
    const value = Date.parse(item.at);
    return Number.isFinite(value) && value > latest ? value : latest;
  }, Number.NEGATIVE_INFINITY);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function scopedRecords(records, { host, sessionId } = {}) {
  return records.filter((item) => {
    if (host !== undefined && item.host !== host) return false;
    if (sessionId !== undefined && item.sessionId !== sessionId) return false;
    return true;
  });
}

function readMetricsSnapshot(metricsPath, { host, sessionId, model } = {}) {
  try {
    const state = readMetrics(metricsPath);
    const records = scopedRecords(state.records, { host, sessionId });
    if (!records.length) return undefined;
    const report = buildMetricsReport({ ...state, records }, { sessionId });
    const hasProvider = records.some((item) => item.providerReportedSavingsTokens !== null);
    const hasEstimate = records.some((item) => item.providerReportedSavingsTokens === null);
    const providerSavings = report.cumulative.providerReportedSavingsTokens;
    const source = hasProvider && !hasEstimate && providerSavings !== null
      ? 'provider-reported' : 'estimate';
    const latest = [...records].sort((left, right) => left.at.localeCompare(right.at)).at(-1);
    return {
      updatedAt: latestAt(records), source,
      model: model ?? latest?.model,
      savedTokens: source === 'provider-reported'
        ? providerSavings : report.cumulative.estimatedTransformSavingsTokens,
    };
  } catch {
    return undefined;
  }
}

function readProviderSnapshot(providerUsagePath, { host, sessionId } = {}) {
  try {
    const state = readProviderUsage(providerUsagePath);
    const records = scopedRecords(state.records, { host, sessionId });
    if (!records.length) return undefined;
    return { ...buildProviderUsageReport({ ...state, records }), updatedAt: latestAt(records) };
  } catch {
    return undefined;
  }
}

export function readStatusSnapshot({
  metricsPath = defaultMetricsPath(),
  providerUsagePath = defaultProviderUsagePath(),
  host,
  sessionId,
  model,
} = {}) {
  return {
    metrics: readMetricsSnapshot(metricsPath, { host, sessionId, model }),
    providerUsage: readProviderSnapshot(providerUsagePath, { host, sessionId }),
  };
}

function inputPrice(model) {
  const normalized = typeof model === 'string' ? model.toLowerCase().replaceAll('_', '-') : '';
  return INPUT_PRICE_PER_MILLION.find(([pattern]) => pattern.test(normalized))?.[1];
}

function compactTokens(value) {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return `${Number((value / 1_000_000).toFixed(2))}M`;
}

function compactCost(tokens, model) {
  const price = inputPrice(model);
  if (price === undefined) return undefined;
  const dollars = tokens * price / 1_000_000;
  return dollars < 0.01 ? '<$0.01' : `$${dollars.toFixed(2)}`;
}

export function renderStatusLine({ metrics } = {}, _now = Date.now()) {
  if (!metrics || !['estimate', 'provider-reported'].includes(metrics.source)
    || !Number.isSafeInteger(metrics.savedTokens) || metrics.savedTokens <= 0) return '🥪 —';
  const savings = `${compactTokens(metrics.savedTokens)} token risparmiati`;
  const cost = compactCost(metrics.savedTokens, metrics.model);
  return `🥪 ${[savings, cost].filter(Boolean).join(' · ')}`;
}
