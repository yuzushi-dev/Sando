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
    const estimatedInputTokens = records.reduce((total, item) => total + item.estimatedInputTokens, 0);
    const latest = [...records].sort((left, right) => left.at.localeCompare(right.at)).at(-1);
    return {
      updatedAt: latestAt(records), source,
      model: model ?? latest?.model,
      estimatedInputTokens,
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

export function renderStatusLine({ metrics } = {}) {
  if (!Number.isSafeInteger(metrics?.savedTokens) || metrics.savedTokens < 0
    || !Number.isSafeInteger(metrics?.estimatedInputTokens) || metrics.estimatedInputTokens <= 0) return '🥪 —';
  const percentage = Math.round(metrics.savedTokens / metrics.estimatedInputTokens * 100);
  const estimate = metrics.source === 'estimate' ? '~' : '';
  return `🥪 saved ${estimate}${compactTokens(metrics.savedTokens)} ctx tok (${percentage}%)`;
}
