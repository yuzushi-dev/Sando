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
  optimizeToolOutput,
  readMetrics,
  recordMetrics,
} from '../index.mjs';
import { appendMetricsRecord } from '../src/metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempMetricsPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-metrics-'));
  return { directory, storagePath: path.join(directory, 'metrics.json') };
}

function input({ id, eventId = id, sessionId, timestamp, host = 'claude', receiptDigest = `sha256:${id}`, estimatedInputTokens = 100, estimatedInlineTokens = 60, providerUsage }) {
  return {
    host,
    event: {
      eventName: 'PostToolUse',
      toolName: 'Read',
      output: 'secret=secret-value',
      cwd: '/tmp',
      eventId,
      sessionId,
      timestamp,
      client: 'Claude Code',
      clientVersion: '2.1.233',
      model: 'claude-opus-5',
      ...(providerUsage ? { providerUsage } : {}),
    },
    receipt: { digest: receiptDigest },
    optimization: { inline: 'bounded', stats: { estimatedInputTokens, estimatedInlineTokens } },
  };
}

function writeLegacyState(storagePath, records = []) {
  const state = { schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records };
  fs.writeFileSync(storagePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return fs.readFileSync(storagePath);
}

function legacyRecord() {
  return {
    eventKey: 'event:legacy',
    receiptDigest: 'sha256:legacy',
    at: '2026-02-01T00:00:00.000Z',
    host: 'codex',
    sessionId: 'legacy-session',
    client: 'Codex',
    clientVersion: '1',
    model: 'gpt-6',
    estimatedInputTokens: 10,
    estimatedInlineTokens: 5,
    estimatedTransformSavingsTokens: 5,
    providerReportedSavingsTokens: null,
  };
}

function reportedSavings(baselineInputTokens, optimizedInputTokens) {
  return {
    source: 'provider-reported', provider: 'anthropic', model: 'claude-sonnet-5', scope: 'event',
    attestation: 'fixture-attestation', baselineInputTokens, optimizedInputTokens,
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
    providerUsage: reportedSavings(100, 80),
  });
  record(storagePath, {
    id: 'a', sessionId: 's1', timestamp: '2026-01-31T23:59:59.000Z',
    estimatedInputTokens: 100, estimatedInlineTokens: 70,
    providerUsage: reportedSavings(100, 80),
  });
  record(storagePath, {
    id: 'b', sessionId: 's1', timestamp: '2026-02-01T00:00:00.000Z',
    estimatedInputTokens: 100, estimatedInlineTokens: 80,
    providerUsage: reportedSavings(70, 50),
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
    providerReportedSavingsTokens: null,
  });
  assert.deepEqual(report.averagePerSession, {
    sessionCount: 2,
    providerSessionCount: 0,
    estimatedTransformSavingsTokens: 40,
    providerReportedSavingsTokens: null,
  });
  assert.equal(report.periods.daily.history.length, 3);
  assert.equal(report.periods.weekly.history.length, 2);
  assert.equal(report.periods.monthly.history.length, 2);
  assert.match(formatMetricsReport(report), /mechanical reduction/);
  assert.doesNotMatch(formatMetricsReport(report), /provider-reported savings/);
});

test('distinct event ids are recorded despite identical receipt digests', () => {
  const { storagePath } = tempMetricsPath();
  record(storagePath, { id: 'first', sessionId: 's', timestamp: '2026-02-01T00:00:00.000Z', receiptDigest: 'sha256:shared' });
  record(storagePath, { id: 'retry', sessionId: 's', timestamp: '2026-02-01T00:00:01.000Z', receiptDigest: 'sha256:shared' });
  record(storagePath, { id: 'other-host', host: 'codex', sessionId: 's', timestamp: '2026-02-01T00:00:02.000Z', receiptDigest: 'sha256:shared' });

  assert.equal(readMetrics(storagePath).records.length, 3);
});

test('does not turn caller-supplied savings fields into provider claims', () => {
  const { storagePath } = tempMetricsPath();
  record(storagePath, {
    id: 'unproven', sessionId: 's', timestamp: '2026-02-01T00:00:00.000Z',
    providerUsage: {
      source: 'provider-reported', provider: 'anthropic', model: 'claude-sonnet-5', scope: 'event',
      attestation: 'caller-supplied', baselineInputTokens: 1_000, optimizedInputTokens: 1,
    },
  });
  assert.equal(readMetrics(storagePath).records[0].providerReportedSavingsTokens, null);
});

test('receipt-backed duplicates remain deduplicated', () => {
  const { storagePath } = tempMetricsPath();
  record(storagePath, { id: 'first', eventId: null, sessionId: 's', timestamp: '2026-02-01T00:00:00.000Z', receiptDigest: 'sha256:shared' });
  record(storagePath, { id: 'retry', eventId: null, sessionId: 's', timestamp: '2026-02-01T00:00:01.000Z', receiptDigest: 'sha256:shared' });

  assert.equal(readMetrics(storagePath).records.length, 1);
});

test('redaction expansion is recorded as signed transform savings', () => {
  const { storagePath } = tempMetricsPath();
  const optimization = optimizeToolOutput({
    toolName: 'Read', output: 'secret=x', cwd: '/tmp', policy: { mode: 'apply', redact: true },
  });

  assert.equal(optimization.inline, 'secret=[REDACTED]\n[sando] display redacted; Sando did not sanitize source files');
  assert.ok(optimization.stats.estimatedInlineTokens > optimization.stats.estimatedInputTokens);
  recordMetrics({
    storagePath,
    timezone: 'UTC',
    host: 'claude',
    event: { eventName: 'PostToolUse', toolName: 'Read', output: 'secret=x', cwd: '/tmp', eventId: 'expanded-redaction', timestamp: '2026-02-01T00:00:00.000Z' },
    receipt: { digest: 'sha256:expanded-redaction' },
    optimization,
  });

  const state = readMetrics(storagePath);
  const savings = optimization.stats.estimatedInputTokens - optimization.stats.estimatedInlineTokens;
  assert.equal(state.records[0].estimatedTransformSavingsTokens, savings);
  assert.equal(buildMetricsReport(state).cumulative.estimatedTransformSavingsTokens, savings);
});

test('v1 validation accepts event-backed duplicate receipts and rejects receipt-backed duplicates', () => {
  const { storagePath } = tempMetricsPath();
  const recordState = (eventKey) => ({
    eventKey, receiptDigest: 'sha256:shared', at: '2026-02-01T00:00:00.000Z', host: 'claude',
    sessionId: 's', client: null, clientVersion: null, model: null,
    estimatedInputTokens: 10, estimatedInlineTokens: 5, estimatedTransformSavingsTokens: 5,
    providerReportedSavingsTokens: null,
  });
  const state = (records) => ({ schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records });

  fs.writeFileSync(storagePath, JSON.stringify(state([recordState('event:one'), recordState('event:two')])));
  assert.equal(readMetrics(storagePath).records.length, 2);

  fs.writeFileSync(storagePath, JSON.stringify(state([recordState('receipt:one'), recordState('receipt:two')])));
  assert.throws(() => readMetrics(storagePath), /duplicate receipts/);
});

test('unsafe token counts and inconsistent savings are rejected while signed savings are accepted', () => {
  const { storagePath } = tempMetricsPath();
  assert.throws(() => record(storagePath, {
    id: 'unsafe', sessionId: 's', timestamp: '2026-02-01T00:00:00.000Z',
    estimatedInputTokens: Number.MAX_SAFE_INTEGER + 1,
  }), /estimatedInputTokens/);
  assert.throws(() => record(storagePath, {
    id: 'unsafe-inline', sessionId: 's', timestamp: '2026-02-01T00:00:00.000Z',
    estimatedInlineTokens: Number.MAX_SAFE_INTEGER + 1,
  }), /estimatedInlineTokens/);

  fs.writeFileSync(storagePath, JSON.stringify({
    schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records: [{
      eventKey: 'event:one', receiptDigest: 'sha256:one', at: '2026-02-01T00:00:00.000Z', host: 'claude',
      sessionId: 's', client: null, clientVersion: null, model: null,
      estimatedInputTokens: 10, estimatedInlineTokens: 5, estimatedTransformSavingsTokens: 4,
      providerReportedSavingsTokens: null,
    }],
  }));
  assert.throws(() => readMetrics(storagePath), /invalid savings/);

  fs.writeFileSync(storagePath, JSON.stringify({
    schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records: [{
      eventKey: 'event:one', receiptDigest: 'sha256:one', at: '2026-02-01T00:00:00.000Z', host: 'claude',
      sessionId: 's', client: null, clientVersion: null, model: null,
      estimatedInputTokens: 5, estimatedInlineTokens: 6, estimatedTransformSavingsTokens: -1,
      providerReportedSavingsTokens: null,
    }],
  }));
  assert.equal(readMetrics(storagePath).records[0].estimatedTransformSavingsTokens, -1);
});

test('rollups reject unsafe cumulative, session, and period sums', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const records = ({ estimatedInputTokens = max, estimatedTransformSavingsTokens = max, providerReportedSavingsTokens = null } = {}) => [1, 2].map((id) => ({
    eventKey: `event:${id}`,
    receiptDigest: `sha256:${id}`,
    at: `2026-02-01T00:00:0${id}.000Z`,
    host: 'claude',
    sessionId: `s${id}`,
    client: null,
    clientVersion: null,
    model: null,
    estimatedInputTokens,
    estimatedInlineTokens: estimatedInputTokens - estimatedTransformSavingsTokens,
    estimatedTransformSavingsTokens,
    providerReportedSavingsTokens,
  }));

  assert.throws(() => buildMetricsReport({
    schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records: records(),
  }), /aggregate overflow/);
  assert.throws(() => buildMetricsReport({
    schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records: records({
      estimatedInputTokens: 0, estimatedTransformSavingsTokens: 0, providerReportedSavingsTokens: max,
    }),
  }), /aggregate overflow/);

  const sessionOverflow = records({
    estimatedInputTokens: 0, estimatedTransformSavingsTokens: 0, providerReportedSavingsTokens: null,
  });
  sessionOverflow[0].providerReportedSavingsTokens = -max;
  sessionOverflow[1].providerReportedSavingsTokens = max;
  sessionOverflow.push({ ...sessionOverflow[1], eventKey: 'event:3', receiptDigest: 'sha256:3', at: '2026-02-01T00:00:03.000Z' });
  assert.throws(() => buildMetricsReport({
    schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records: sessionOverflow,
  }), /aggregate overflow/);

  const periodOverflow = records({
    estimatedInputTokens: 0, estimatedTransformSavingsTokens: 0, providerReportedSavingsTokens: null,
  });
  periodOverflow[0].at = '2026-02-01T00:00:01.000Z';
  periodOverflow[0].providerReportedSavingsTokens = -max;
  periodOverflow[1].at = '2026-02-02T00:00:01.000Z';
  periodOverflow[1].providerReportedSavingsTokens = max;
  periodOverflow.push({ ...periodOverflow[1], eventKey: 'event:3', receiptDigest: 'sha256:3', sessionId: 's3', at: '2026-02-02T00:00:03.000Z' });
  assert.throws(() => buildMetricsReport({
    schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records: periodOverflow,
  }), /aggregate overflow/);
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

test('journal appends records without rewriting the v1 snapshot', () => {
  const { directory, storagePath } = tempMetricsPath();
  const snapshotBytes = writeLegacyState(storagePath, [legacyRecord()]);

  appendMetricsRecord({
    storagePath,
    timezone: 'UTC',
    ...input({ id: 'journal-1', host: 'codex', timestamp: '2026-02-02T12:00:00.000Z' }),
  });

  assert.deepEqual(fs.readFileSync(storagePath), snapshotBytes);
  const lines = fs.readFileSync(`${storagePath}.journal`, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(lines[0], { schema: 'sando-metrics-journal/v1', version: 1, timezone: 'UTC' });
  const state = readMetrics(storagePath, { timezone: 'UTC' });
  assert.equal(state.records.length, 2);
  assert.equal(state.records[0].eventKey, 'event:legacy');
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(`${storagePath}.journal`).mode & 0o777, 0o600);
});

test('journal migration reads timezone after records in a reordered v1 snapshot', () => {
  const { storagePath } = tempMetricsPath();
  const records = Array.from({ length: 24 }, (_, index) => ({
    ...legacyRecord(), eventKey: `event:legacy-${index}`, receiptDigest: `sha256:legacy-${index}`,
    headerLike: { schema: 'sando-metrics/v1', version: 1, timezone: 'Europe/Rome' },
  }));
  const snapshot = JSON.stringify({ records, timezone: 'UTC', version: 1, schema: 'sando-metrics/v1' });
  assert.ok(snapshot.lastIndexOf('"timezone"') > 4096);
  fs.writeFileSync(storagePath, snapshot, { mode: 0o600 });

  appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'after-reordered-header', host: 'codex' }) });

  const readFileSync = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    if (String(file) === storagePath) throw new Error('legacy snapshot read after migration');
    return readFileSync.call(this, file, ...args);
  };
  try {
    appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'after-reordered-header-again', host: 'codex' }) });
  } finally {
    fs.readFileSync = readFileSync;
  }

  assert.equal(readMetrics(storagePath, { timezone: 'UTC' }).records.length, records.length + 2);
});

test('an old lock owned by a live process is not reclaimed', () => {
  const { storagePath } = tempMetricsPath();
  const lockPath = `${storagePath}.lock`;
  const stale = new Date(Date.now() - 60_000);
  fs.writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });
  fs.utimesSync(lockPath, stale, stale);
  const wait = Atomics.wait;
  Atomics.wait = () => 'timed-out';
  try {
    assert.throws(() => appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'blocked' }) }), /metrics lock timeout/);
  } finally {
    Atomics.wait = wait;
  }
  assert.equal(fs.readFileSync(lockPath, 'utf8'), `${process.pid}\n`);
  assert.equal(fs.existsSync(`${storagePath}.journal`), false);
});

test('an old lock without a verifiable owner is not reclaimed', () => {
  const { storagePath } = tempMetricsPath();
  const lockPath = `${storagePath}.lock`;
  const stale = new Date(Date.now() - 60_000);
  fs.writeFileSync(lockPath, 'not-a-pid\n', { mode: 0o600 });
  fs.utimesSync(lockPath, stale, stale);
  const wait = Atomics.wait;
  Atomics.wait = () => 'timed-out';
  try {
    assert.throws(() => appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'unknown-owner' }) }), /metrics lock timeout/);
  } finally {
    Atomics.wait = wait;
  }
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'not-a-pid\n');
  assert.equal(fs.existsSync(`${storagePath}.journal`), false);
});

test('an old lock with a dead owner is reclaimed', () => {
  const { storagePath } = tempMetricsPath();
  const lockPath = `${storagePath}.lock`;
  const stale = new Date(Date.now() - 60_000);
  fs.writeFileSync(lockPath, `${process.pid + 1_000_000}\n`, { mode: 0o600 });
  fs.utimesSync(lockPath, stale, stale);

  appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'reclaimed-lock' }) });

  assert.equal(readMetrics(storagePath, { timezone: 'UTC' }).records.length, 1);
  assert.equal(fs.existsSync(lockPath), false);
});

test('an abandoned reclaimer claim is cleaned before reclaiming the lock', () => {
  const { storagePath } = tempMetricsPath();
  const lockPath = `${storagePath}.lock`;
  const stale = new Date(Date.now() - 60_000);
  const deadPid = process.pid + 1_000_000;
  const token = 'abandoned';
  const claimPath = `${lockPath}.claim.${token}`;
  const reclaimerPath = `${lockPath}.reclaim.${token}`;
  fs.writeFileSync(lockPath, `${deadPid}\n`, { mode: 0o600 });
  fs.linkSync(lockPath, claimPath);
  fs.writeFileSync(reclaimerPath, JSON.stringify({ pid: deadPid }), { mode: 0o600 });
  fs.utimesSync(lockPath, stale, stale);

  appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'recover-abandoned-reclaimer' }) });

  assert.equal(readMetrics(storagePath, { timezone: 'UTC' }).records.length, 1);
  assert.equal(fs.existsSync(claimPath), false);
  assert.equal(fs.existsSync(reclaimerPath), false);
});

test('an old reclaimer claim without an owner keeps its reclamation barrier', () => {
  const { storagePath } = tempMetricsPath();
  const lockPath = `${storagePath}.lock`;
  const stale = new Date(Date.now() - 60_000);
  const deadPid = process.pid + 1_000_000;
  const claimPath = `${lockPath}.claim.unknown-owner`;
  const reclaimerPath = `${lockPath}.reclaim.unknown-owner`;
  fs.writeFileSync(lockPath, `${deadPid}\n`, { mode: 0o600 });
  fs.linkSync(lockPath, claimPath);
  fs.writeFileSync(reclaimerPath, 'partial metadata', { mode: 0o600 });
  fs.utimesSync(reclaimerPath, stale, stale);
  const wait = Atomics.wait;
  Atomics.wait = () => 'timed-out';
  try {
    assert.throws(() => appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'unknown-reclaimer' }) }), /metrics lock timeout/);
  } finally {
    Atomics.wait = wait;
  }
  assert.equal(fs.existsSync(claimPath), true);
  assert.equal(fs.existsSync(reclaimerPath), true);
  assert.equal(fs.existsSync(`${storagePath}.journal`), false);
});

test('an abandoned reclaimer temporary does not become a permanent lock barrier', () => {
  const { storagePath } = tempMetricsPath();
  const lockPath = `${storagePath}.lock`;
  const stale = new Date(Date.now() - 60_000);
  const deadPid = process.pid + 1_000_000;
  const temporaryPath = `${lockPath}.reclaim.abandoned.tmp.crashed`;
  fs.writeFileSync(lockPath, `${deadPid}\n`, { mode: 0o600 });
  fs.writeFileSync(temporaryPath, 'partial metadata', { mode: 0o600 });
  fs.utimesSync(lockPath, stale, stale);
  fs.utimesSync(temporaryPath, stale, stale);

  appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'recover-temp-reclaimer' }) });

  assert.equal(readMetrics(storagePath, { timezone: 'UTC' }).records.length, 1);
  assert.equal(fs.existsSync(lockPath), false);
});

test('journal initializes a v1 snapshot for a fresh metrics path', () => {
  const { storagePath } = tempMetricsPath();
  appendMetricsRecord({
    storagePath,
    timezone: 'UTC',
    ...input({ id: 'first-journal', host: 'codex', timestamp: '2026-02-02T12:00:00.000Z' }),
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(storagePath, 'utf8')).records, []);
  assert.equal(readMetrics(storagePath, { timezone: 'UTC' }).records.length, 1);
});

test('journal deduplicates receipt retries and rejects conflicting event ids', () => {
  const { storagePath } = tempMetricsPath();
  appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'first', eventId: null, host: 'codex', receiptDigest: 'sha256:shared' }) });
  appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'retry', eventId: null, host: 'codex', receiptDigest: 'sha256:shared', timestamp: '2026-02-02T12:00:01.000Z' }) });
  assert.equal(readMetrics(storagePath, { timezone: 'UTC' }).records.length, 1);

  appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'stable-event', host: 'codex', timestamp: '2026-02-02T12:00:00.000Z' }) });
  appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'stable-event', host: 'codex', timestamp: '2026-02-02T12:00:00.000Z' }) });
  const journalPath = `${storagePath}.journal`;
  const state = readMetrics(storagePath, { timezone: 'UTC' });
  assert.equal(state.records.length, 2);
  const written = state.records.at(-1);
  fs.appendFileSync(journalPath, `${JSON.stringify({ ...written, model: 'different-model' })}\n`);
  assert.throws(() => readMetrics(storagePath, { timezone: 'UTC' }), /conflicting event/);
});

test('event retries without timestamps preserve the first observed time', () => {
  const { storagePath } = tempMetricsPath();
  const event = input({ id: 'retry-without-timestamp', timestamp: undefined });
  appendMetricsRecord({ storagePath, timezone: 'UTC', ...event, now: new Date('2026-02-01T00:00:00.000Z') });
  appendMetricsRecord({ storagePath, timezone: 'UTC', ...event, now: new Date('2026-02-01T00:00:01.000Z') });

  const { records } = readMetrics(storagePath, { timezone: 'UTC' });
  assert.equal(records.length, 1);
  assert.equal(records[0].at, '2026-02-01T00:00:00.000Z');
});

test('journal ignores and repairs only a torn final line', () => {
  const { storagePath } = tempMetricsPath();
  appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'before-crash', host: 'codex' }) });
  const journalPath = `${storagePath}.journal`;
  fs.appendFileSync(journalPath, '{"eventKey":"partial');
  assert.equal(readMetrics(storagePath, { timezone: 'UTC' }).records.length, 1);

  appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'after-recovery', host: 'codex' }) });
  const lines = fs.readFileSync(journalPath, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) JSON.parse(line);
  assert.equal(readMetrics(storagePath, { timezone: 'UTC' }).records.length, 2);
});

test('journal rejects malformed complete lines and timezone mismatches', () => {
  const { storagePath } = tempMetricsPath();
  appendMetricsRecord({ storagePath, timezone: 'UTC', ...input({ id: 'valid', host: 'codex' }) });
  const journalPath = `${storagePath}.journal`;
  const contents = fs.readFileSync(journalPath, 'utf8');
  const [header, ...records] = contents.trimEnd().split('\n');
  fs.writeFileSync(journalPath, [header, '{invalid}', ...records, ''].join('\n'));
  assert.throws(() => readMetrics(storagePath, { timezone: 'UTC' }), /metrics journal is invalid/);

  fs.writeFileSync(journalPath, contents);
  assert.throws(() => readMetrics(storagePath, { timezone: 'Europe/Rome' }), /metrics timezone mismatch/);
});

test('atomic locked journal writers preserve all distinct events and safe file modes', async () => {
  const { directory, storagePath } = tempMetricsPath();
  const stale = new Date(Date.now() - 60_000);
  fs.writeFileSync(`${storagePath}.lock`, `${process.pid + 1_000_000}\n`, { mode: 0o600 });
  fs.utimesSync(`${storagePath}.lock`, stale, stale);
  const metricsUrl = pathToFileURL(path.join(ROOT, 'src/metrics.mjs')).href;
  const children = Array.from({ length: 8 }, (_, index) => {
    const script = `import { appendMetricsRecord } from ${JSON.stringify(metricsUrl)};
appendMetricsRecord({ storagePath: ${JSON.stringify(storagePath)}, timezone: 'UTC', host: 'codex', event: { eventName: 'PostToolUse', toolName: 'Read', output: 'secret=child-secret', cwd: '/tmp', eventId: 'child-${index}', sessionId: 's', timestamp: '2026-02-02T12:00:00.000Z' }, receipt: { digest: 'sha256:child-${index}' }, optimization: { inline: 'bounded', stats: { estimatedInputTokens: 10, estimatedInlineTokens: 5 } } });`;
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
  assert.doesNotMatch(fs.readFileSync(`${storagePath}.journal`, 'utf8'), /child-secret/);
});

test('recordMetrics keeps concurrent duplicate retries idempotent', async () => {
  const { storagePath } = tempMetricsPath();
  const metricsUrl = pathToFileURL(path.join(ROOT, 'src/metrics.mjs')).href;
  const children = Array.from({ length: 4 }, (_, index) => {
    const script = `import { recordMetrics } from ${JSON.stringify(metricsUrl)};
recordMetrics({ storagePath: ${JSON.stringify(storagePath)}, timezone: 'UTC', host: 'codex', event: { eventName: 'PostToolUse', toolName: 'Read', output: 'small', cwd: '/tmp', eventId: 'shared-retry', sessionId: 's', timestamp: '2026-02-02T12:00:0${index}.000Z' }, receipt: { digest: 'sha256:shared-retry' }, optimization: { inline: 'bounded', stats: { estimatedInputTokens: 10, estimatedInlineTokens: 5 } } });`;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
    });
  });
  await Promise.all(children);
  assert.equal(readMetrics(storagePath, { timezone: 'UTC' }).records.length, 1);
});
