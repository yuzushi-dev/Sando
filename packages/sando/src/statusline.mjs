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

function readMetricsSnapshot(metricsPath) {
  try {
    const state = readMetrics(metricsPath);
    if (!state.records.length) return undefined;
    const report = buildMetricsReport(state);
    const hasProvider = state.records.some((item) => item.providerReportedSavingsTokens !== null);
    const hasEstimate = state.records.some((item) => item.providerReportedSavingsTokens === null);
    const providerSavings = report.cumulative.providerReportedSavingsTokens;
    const source = hasProvider && !hasEstimate && providerSavings !== null
      ? 'provider-reported' : 'estimate';
    return {
      updatedAt: latestAt(state.records), source,
      savedTokens: source === 'provider-reported'
        ? providerSavings : report.cumulative.estimatedTransformSavingsTokens,
    };
  } catch {
    return undefined;
  }
}

function readProviderSnapshot(providerUsagePath) {
  try {
    const state = readProviderUsage(providerUsagePath);
    if (!state.records.length) return undefined;
    return { ...buildProviderUsageReport(state), updatedAt: latestAt(state.records) };
  } catch {
    return undefined;
  }
}

export function readStatusSnapshot({
  metricsPath = defaultMetricsPath(),
  providerUsagePath = defaultProviderUsagePath(),
} = {}) {
  return {
    metrics: readMetricsSnapshot(metricsPath),
    providerUsage: readProviderSnapshot(providerUsagePath),
  };
}

function validTimestamp(value) {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function providerUsageLine(usage) {
  if (!usage || usage.eventCount < 1) return undefined;
  const line = `${usage.inputTokens}in/${usage.outputTokens}out`;
  const cache = [];
  if (usage.cachedInputTokens) cache.push(`c${usage.cachedInputTokens}`);
  if (usage.cacheWriteInputTokens) cache.push(`w${usage.cacheWriteInputTokens}`);
  return cache.length ? `${line} · ${cache.join('/')}` : line;
}

export function renderStatusLine({ metrics, providerUsage } = {}, now = Date.now()) {
  const metricsTimestamp = validTimestamp(metrics?.updatedAt);
  const providerTimestamp = validTimestamp(providerUsage?.updatedAt);
  const updatedAt = Math.max(metricsTimestamp ?? Number.NEGATIVE_INFINITY, providerTimestamp ?? Number.NEGATIVE_INFINITY);
  const usage = providerUsageLine(providerUsage);
  const savings = metrics && ['estimate', 'provider-reported'].includes(metrics.source)
    && Number.isSafeInteger(metrics.savedTokens)
    ? `${metrics.source === 'estimate' ? '~' : ''}${metrics.savedTokens} saved` : undefined;
  const parts = [savings, savings ? usage : usage ? `provider ${usage}` : undefined].filter(Boolean);
  if (!parts.length || !Number.isFinite(updatedAt)) return '🥪 —';
  if (now - updatedAt > STATUSLINE_MAX_AGE_MS) return '🥪 stale';
  return `🥪 ${parts.join(' · ')}`;
}
