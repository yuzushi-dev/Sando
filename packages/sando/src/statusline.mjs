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

function compactTokens(value) {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return `${Number((value / 1_000_000).toFixed(2))}M`;
}

// The rate is the session's own blended $/token (totalCostUsd / totalTokens),
// so cache reads (0.1x) and cache writes (1.25x/2x) are already folded in:
// it's the harness's real billed rate, not a reconstructed list price.
function compactCost(tokens, effectiveRate) {
  return `$${(tokens * effectiveRate).toFixed(2)}`;
}

export function renderStatusLine({ metrics, providerUsage, totalCostUsd } = {}, _now = Date.now()) {
  if (!metrics || !['estimate', 'provider-reported'].includes(metrics.source)
    || !Number.isSafeInteger(metrics.savedTokens) || metrics.savedTokens <= 0) return '🥪 —';
  const estimated = metrics.source === 'estimate';
  const savings = `${estimated ? '~' : ''}${compactTokens(metrics.savedTokens)} token saved`;
  const effectiveRate = Number.isFinite(totalCostUsd) && totalCostUsd > 0
    && Number.isSafeInteger(providerUsage?.totalTokens) && providerUsage.totalTokens > 0
    ? totalCostUsd / providerUsage.totalTokens : undefined;
  const cost = effectiveRate === undefined ? undefined : compactCost(metrics.savedTokens, effectiveRate);
  return `🥪 ${[savings, cost && `(-${cost})`].filter(Boolean).join(' ')}`;
}
