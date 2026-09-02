#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildMetricsReport, defaultMetricsPath, readMetrics } from './metrics.mjs';
import { buildProviderUsageReport, defaultProviderUsagePath, readProviderUsage } from './provider-usage.mjs';

export const CANARY_REPORT_SCHEMA = 'sando-canary-report/v1';

const HOSTS = new Set(['claude', 'codex']);
const ARMS = new Set(['apply', 'control']);

function text(value) { return typeof value === 'string' && value.length > 0; }

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function flag(argv, name) { return argv.includes(`--${name}`); }

function boundary(value, name) {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid timestamp`);
  return date;
}

function normalizeScope({ host, experimentId, arm, workloadId, from, to } = {}) {
  if (host !== undefined && host !== 'both' && !HOSTS.has(host)) throw new Error('host must be claude, codex, or both');
  if (experimentId !== undefined && experimentId !== null && !text(experimentId)) throw new Error('experiment must be a non-empty string');
  if (arm !== undefined && arm !== 'both' && !ARMS.has(arm)) throw new Error('arm must be apply, control, or both');
  if (workloadId !== undefined && workloadId !== null && !text(workloadId)) throw new Error('workload must be a non-empty string');
  const fromDate = boundary(from, '--from');
  const toDate = boundary(to, '--to');
  if (fromDate && toDate && fromDate > toDate) throw new Error('--from must not be after --to');
  return {
    host: host === 'both' ? undefined : host,
    experimentId: experimentId === null ? undefined : experimentId,
    arm: arm === 'both' ? undefined : arm,
    workloadId: workloadId === null ? undefined : workloadId,
    from: fromDate,
    to: toDate,
  };
}

function inScope(item, scope) {
  if (scope.host !== undefined && item.host !== scope.host) return false;
  if (scope.experimentId !== undefined && item.experimentId !== scope.experimentId) return false;
  if (scope.arm !== undefined && item.arm !== scope.arm) return false;
  if (scope.workloadId !== undefined && item.workloadId !== scope.workloadId) return false;
  const at = new Date(item.at);
  if (scope.from && (Number.isNaN(at.getTime()) || at < scope.from)) return false;
  if (scope.to && (Number.isNaN(at.getTime()) || at > scope.to)) return false;
  return true;
}

function inMetricScope(item, scope) {
  if (scope.host !== undefined && item.host !== scope.host) return false;
  const at = new Date(item.at);
  if (scope.from && (Number.isNaN(at.getTime()) || at < scope.from)) return false;
  if (scope.to && (Number.isNaN(at.getTime()) || at > scope.to)) return false;
  return true;
}

function sessionKey(item) {
  return `${item.host}\0${item.sessionId ?? '<unknown>'}`;
}

function metricAggregate(records, providerRecords) {
  const providerSessions = new Set(providerRecords.filter((item) => text(item.sessionId)).map(sessionKey));
  const matched = records.filter((item) => providerSessions.has(sessionKey(item)));
  const sessions = new Set(matched.map(sessionKey));
  const savings = matched.map((item) => item.estimatedTransformSavingsTokens);
  const providerSavings = matched
    .map((item) => item.providerReportedSavingsTokens)
    .filter((value) => value !== null);
  const modelCount = matched.filter((item) => text(item.model)).length;
  const models = [...new Set(matched.map((item) => item.model).filter(text))].sort();
  return {
    eventCount: matched.length,
    matchedSessionCount: sessions.size,
    estimatedTransformSavingsTokens: savings.reduce((total, value) => total + value, 0),
    providerReportedSavingsTokens: providerSavings.length
      ? providerSavings.reduce((total, value) => total + value, 0)
      : null,
    modelCoverage: matched.length === 0 ? 'unavailable' : modelCount === matched.length ? 'complete' : modelCount ? 'partial' : 'unavailable',
    models,
  };
}

function providerQuality(records) {
  const count = (predicate) => records.filter(predicate).length;
  return {
    totalProviderRecords: records.length,
    recordsWithSessionId: count((item) => text(item.sessionId)),
    recordsWithArm: count((item) => ARMS.has(item.arm)),
    recordsWithExperimentId: count((item) => text(item.experimentId)),
    recordsWithWorkloadId: count((item) => text(item.workloadId)),
    recordsWithTurnId: count((item) => text(item.turnId)),
    recordsWithProviderCost: count((item) => typeof item.totalCostUsd === 'number'),
    providerModelCoverage: count((item) => text(item.model)) === records.length && records.length ? 'complete' : 'unavailable',
    untaggedProviderRecords: count((item) => !text(item.sessionId) || !ARMS.has(item.arm) || !text(item.experimentId)),
  };
}

function scopeValue(value) { return value instanceof Date ? value.toISOString() : value ?? null; }

function fileDigest(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

export function buildCanaryReport({ providerState, metricsState, host, experimentId = 'default', arm,
  workloadId, from, to, now = new Date(), providerSnapshotDigest = null, metricsSnapshotDigest = null } = {}) {
  if (!providerState || typeof providerState !== 'object') throw new TypeError('provider state is required');
  const scope = normalizeScope({ host, experimentId, arm, workloadId, from, to });
  const allProvider = buildProviderUsageReport(providerState);
  const selectedProvider = providerState.records.filter((item) => inScope(item, scope));
  const metricsReport = metricsState ? buildMetricsReport(metricsState, { now }) : null;
  const allMetrics = metricsState?.records ?? [];
  const selectedMetrics = allMetrics.filter((item) => inMetricScope(item, scope));
  const arms = scope.arm ? [scope.arm] : ['apply', 'control'];
  const byArm = Object.fromEntries(arms.map((armName) => {
    const records = selectedProvider.filter((item) => item.arm === armName);
    return [armName, {
      provider: buildProviderUsageReport({ ...providerState, records }),
      metrics: metricAggregate(selectedMetrics, records),
    }];
  }));
  const selectedMetricSessions = new Set(selectedMetrics.map(sessionKey));
  const selectedProviderSessions = new Set(selectedProvider.map(sessionKey));
  const quality = providerQuality(providerState.records);
  quality.selectedProviderRecords = selectedProvider.length;
  quality.selectedProviderSessions = selectedProviderSessions.size;
  quality.metricsRecords = allMetrics.length;
  quality.selectedMetricsRecords = selectedMetrics.length;
  quality.matchedMetricSessions = [...selectedProviderSessions].filter((key) => selectedMetricSessions.has(key)).length;
  quality.selectedUntaggedProviderRecords = selectedProvider.filter((item) => !text(item.sessionId) || !ARMS.has(item.arm) || !text(item.experimentId)).length;
  quality.metricsArmPartitioning = 'unavailable';
  quality.status = selectedProvider.length && quality.selectedUntaggedProviderRecords === 0 ? 'ready' : 'incomplete';
  return {
    schema: CANARY_REPORT_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    scope: {
      host: scope.host ?? 'both',
      experimentId: scope.experimentId ?? 'all',
      arm: scope.arm ?? 'both',
      workloadId: scopeValue(scope.workloadId),
      from: scopeValue(scope.from),
      to: scopeValue(scope.to),
    },
    snapshot: {
      providerUsageDigest: providerSnapshotDigest,
      metricsDigest: metricsSnapshotDigest,
    },
    totals: {
      provider: allProvider,
      selectedProvider: buildProviderUsageReport({ ...providerState, records: selectedProvider }),
      selectedMetrics: metricsReport ? buildMetricsReport({ ...metricsState, records: selectedMetrics }, { now }).cumulative : null,
    },
    byArm,
    dataQuality: quality,
    comparison: {
      status: 'descriptive-only',
      reason: 'The current provider ledger has no shared paired-run key; apply/control values are not causal evidence.',
    },
  };
}

export function formatCanaryReport(report) {
  const lines = [
    'Sando personal canary',
    `scope: ${report.scope.host}/${report.scope.experimentId}/${report.scope.arm}`,
  ];
  for (const arm of ['apply', 'control']) {
    const entry = report.byArm[arm];
    if (!entry) continue;
    lines.push(`${arm}: ${entry.provider.eventCount} provider events, ${entry.provider.sessionCount} sessions, ${entry.provider.totalTokens} tokens, ${entry.metrics.estimatedTransformSavingsTokens} estimated mechanical savings`);
  }
  lines.push(`data quality: ${report.dataQuality.status}; provider model: ${report.dataQuality.providerModelCoverage}; metric sessions joined: ${report.dataQuality.matchedMetricSessions}`);
  lines.push(`comparison: ${report.comparison.status}`);
  return `${lines.join('\n')}\n`;
}

export function runCanaryCli({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout,
  stderr = process.stderr, now = new Date() } = {}) {
  if (argv.includes('--help')) {
    stdout.write('Usage: node canary.mjs [--json] [--path ABSOLUTE_PATH] [--metrics-path ABSOLUTE_PATH] [--host claude|codex|both] [--experiment ID|--all-experiments] [--arm apply|control|both] [--workload ID] [--from ISO] [--to ISO]\n');
    return null;
  }
  try {
    const providerPath = option(argv, 'path') || defaultProviderUsagePath(env);
    const metricsPath = option(argv, 'metrics-path') || defaultMetricsPath(env);
    const providerState = readProviderUsage(providerPath);
    const metricsState = readMetrics(metricsPath);
    const report = buildCanaryReport({
      providerState,
      metricsState,
      host: option(argv, 'host'),
      experimentId: flag(argv, 'all-experiments') ? undefined : (option(argv, 'experiment') ?? 'default'),
      arm: option(argv, 'arm'),
      workloadId: option(argv, 'workload'),
      from: option(argv, 'from'),
      to: option(argv, 'to'),
      now,
      providerSnapshotDigest: fileDigest(providerPath),
      metricsSnapshotDigest: fileDigest(metricsPath),
    });
    stdout.write(argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatCanaryReport(report));
    return report;
  } catch (error) {
    stderr.write(`sando canary: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runCanaryCli();
