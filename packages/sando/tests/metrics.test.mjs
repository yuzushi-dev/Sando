import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  buildMetricsReport,
  formatMetricsReport,
  readMetrics,
  recordMetrics,
} from '../index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempMetricsPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-metrics-'));
  return { directory, storagePath: path.join(directory, 'metrics.json') };
}

function input({ id, sessionId, timestamp, estimatedInputTokens = 100, estimatedInlineTokens = 60, providerUsage }) {
  return {
    host: 'claude',
    event: {
      eventName: 'PostToolUse',
      toolName: 'Read',
      output: 'secret=secret-value',
      cwd: '/tmp',
      eventId: id,
      sessionId,
      timestamp,
      client: 'Claude Code',
      clientVersion: '2.1.233',
      model: 'claude-opus-5',
      ...(providerUsage ? { providerUsage } : {}),
    },
    receipt: { digest: `sha256:${id}` },
    optimization: { inline: 'bounded', stats: { estimatedInputTokens, estimatedInlineTokens } },
  };
}

function record(storagePath, values) {
  return recordMetrics({ storagePath, timezone: 'UTC', ...input(values) });
}

test('empty reports expose zero estimates, unavailable provider savings, and current period boundaries', () => {
  const { storagePath } = tempMetricsPath();
  const report = buildMetricsReport(readMetrics(storagePath, { timezone: 'UTC' }), {
    now: '2026-02-02T12:00:00.000Z',
  });

  assert.equal(report.currentSession, null);
  assert.deepEqual(report.cumulative, {
    eventCount: 0,
    sessionCount: 0,
    estimatedTransformSavingsTokens: 0,
    providerReportedSavingsTokens: null,
  });
  assert.equal(report.periods.daily.current.period, '2026-02-02');
  assert.equal(report.periods.weekly.current.period, '2026-W06');
  assert.equal(report.periods.monthly.current.period, '2026-02');
  assert.match(formatMetricsReport(report), /No Sando events recorded/);
});

test('repeated receipts are counted once and savings aggregate by session', () => {
  const { storagePath } = tempMetricsPath();
  record(storagePath, {
    id: 'a', sessionId: 's1', timestamp: '2026-01-31T23:59:59.000Z',
    estimatedInputTokens: 100, estimatedInlineTokens: 70,
    providerUsage: { baselineInputTokens: 100, optimizedInputTokens: 80 },
  });
  record(storagePath, {
    id: 'a', sessionId: 's1', timestamp: '2026-01-31T23:59:59.000Z',
    estimatedInputTokens: 100, estimatedInlineTokens: 70,
    providerUsage: { baselineInputTokens: 100, optimizedInputTokens: 80 },
  });
  record(storagePath, {
    id: 'b', sessionId: 's1', timestamp: '2026-02-01T00:00:00.000Z',
    estimatedInputTokens: 100, estimatedInlineTokens: 80,
    providerUsage: { baselineInputTokens: 70, optimizedInputTokens: 50 },
  });
  record(storagePath, {
    id: 'c', sessionId: 's2', timestamp: '2026-02-02T00:00:00.000Z',
    estimatedInputTokens: 100, estimatedInlineTokens: 70,
  });

  const report = buildMetricsReport(readMetrics(storagePath), { now: '2026-02-02T12:00:00.000Z' });
  assert.equal(report.currentSession.id, 's2');
  assert.equal(report.currentSession.estimatedTransformSavingsTokens, 30);
  assert.deepEqual(report.cumulative, {
    eventCount: 3,
    sessionCount: 2,
    estimatedTransformSavingsTokens: 80,
    providerReportedSavingsTokens: 40,
  });
  assert.deepEqual(report.averagePerSession, {
    sessionCount: 2,
    providerSessionCount: 1,
    estimatedTransformSavingsTokens: 40,
    providerReportedSavingsTokens: 40,
  });
  assert.equal(report.periods.daily.history.length, 3);
  assert.equal(report.periods.weekly.history.length, 2);
  assert.equal(report.periods.monthly.history.length, 2);
  assert.match(formatMetricsReport(report), /estimated transform savings/);
  assert.match(formatMetricsReport(report), /provider-reported savings/);
});

test('daily, ISO-week, and monthly rollups use the configured timezone', () => {
  const { storagePath } = tempMetricsPath();
  recordMetrics({
    storagePath,
    timezone: 'America/Los_Angeles',
    host: 'codex',
    event: { eventName: 'PostToolUse', toolName: 'Read', output: 'x', cwd: '/tmp', eventId: 'la', sessionId: 's', timestamp: '2026-01-01T00:30:00.000Z' },
    receipt: { digest: 'sha256:la' },
    optimization: { inline: 'x', stats: { estimatedInputTokens: 10, estimatedInlineTokens: 0 } },
  });
  recordMetrics({
    storagePath,
    host: 'codex',
    event: { eventName: 'PostToolUse', toolName: 'Read', output: 'x', cwd: '/tmp', eventId: 'week-1', sessionId: 's', timestamp: '2026-01-05T08:00:00.000Z' },
    receipt: { digest: 'sha256:week-1' },
    optimization: { inline: 'x', stats: { estimatedInputTokens: 10, estimatedInlineTokens: 5 } },
  });

  const report = buildMetricsReport(readMetrics(storagePath), { now: '2026-01-05T08:00:00.000Z' });
  assert.equal(report.timezone, 'America/Los_Angeles');
  assert.deepEqual(report.periods.daily.history.map((bucket) => bucket.period), ['2025-12-31', '2026-01-05']);
  assert.deepEqual(report.periods.weekly.history.map((bucket) => bucket.period), ['2026-W01', '2026-W02']);
  assert.deepEqual(report.periods.monthly.history.map((bucket) => bucket.period), ['2025-12', '2026-01']);
});

test('malformed metrics input is rejected without persisting secrets', () => {
  const { directory, storagePath } = tempMetricsPath();
  assert.throws(() => recordMetrics({
    storagePath,
    timezone: 'UTC',
    host: 'claude',
    event: { eventName: 'PostToolUse', toolName: 'Read', output: 'secret-value', cwd: '/tmp', eventId: 'bad', timestamp: 'not-a-date' },
    receipt: { digest: 'sha256:bad' },
    optimization: { inline: 'bounded', stats: { estimatedInputTokens: 10, estimatedInlineTokens: 5 } },
  }), /timestamp/);
  assert.throws(() => recordMetrics({
    storagePath,
    timezone: 'UTC',
    host: 'claude',
    event: { eventName: 'PostToolUse', toolName: 'Read', output: 'secret-value', cwd: '/tmp', eventId: 'bad-2' },
    receipt: { digest: 'sha256:bad-2' },
    optimization: { inline: 'bounded', stats: { estimatedInputTokens: -1, estimatedInlineTokens: 5 } },
  }), /metrics input/);
  fs.writeFileSync(storagePath, '{');
  assert.throws(() => readMetrics(storagePath), /metrics state/);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
});

test('atomic locked writers preserve all distinct events and safe file modes', async () => {
  const { directory, storagePath } = tempMetricsPath();
  const metricsUrl = pathToFileURL(path.join(ROOT, 'src/metrics.mjs')).href;
  const children = Array.from({ length: 8 }, (_, index) => {
    const script = `import { recordMetrics } from ${JSON.stringify(metricsUrl)};
recordMetrics({ storagePath: ${JSON.stringify(storagePath)}, timezone: 'UTC', host: 'codex', event: { eventName: 'PostToolUse', toolName: 'Read', output: 'secret=child-secret', cwd: '/tmp', eventId: 'child-${index}', sessionId: 's', timestamp: '2026-02-02T12:00:00.000Z' }, receipt: { digest: 'sha256:child-${index}' }, optimization: { inline: 'bounded', stats: { estimatedInputTokens: 10, estimatedInlineTokens: 5 } } });`;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
    });
  });
  await Promise.all(children);

  const state = readMetrics(storagePath);
  assert.equal(state.records.length, 8);
  assert.equal(buildMetricsReport(state).cumulative.eventCount, 8);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${storagePath}.lock`), false);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
  assert.doesNotMatch(fs.readFileSync(storagePath, 'utf8'), /child-secret/);
});
