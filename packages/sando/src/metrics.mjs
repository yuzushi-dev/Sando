import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCHEMA = 'sando-metrics/v1';
const REPORT_SCHEMA = 'sando-report/v1';
const VERSION = 1;
const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 250;
const STALE_LOCK_MS = 30_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function defaultTimezone() {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function validateTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone) throw new Error('timezone is invalid');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
  catch { throw new Error('timezone is invalid'); }
  return timezone;
}

function resolvePath(storagePath) {
  const value = storagePath ?? defaultMetricsPath();
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('metrics path must be absolute');
  return value;
}

function optionalString(value) {
  return typeof value === 'string' && value ? value : null;
}

function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`metrics input has invalid ${name}`);
  return value;
}

function dateValue(value, fallback) {
  const date = value === undefined ? new Date(fallback) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('timestamp is invalid');
  return date;
}

function localParts(date, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US-u-nu-latn', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function isoWeek({ year, month, day }) {
  const current = new Date(Date.UTC(year, month - 1, day));
  const weekday = current.getUTCDay() || 7;
  current.setUTCDate(current.getUTCDate() + 4 - weekday);
  const weekYear = current.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const week = 1 + Math.round((current - firstThursday) / 604800000);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

function periodKey(date, timezone, period) {
  const parts = localParts(date, timezone);
  if (period === 'daily') return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  if (period === 'monthly') return `${parts.year}-${String(parts.month).padStart(2, '0')}`;
  return isoWeek(parts);
}

function emptyState(timezone) {
  return { schema: SCHEMA, version: VERSION, timezone, records: [] };
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || typeof record.eventKey !== 'string'
    || !record.eventKey || typeof record.receiptDigest !== 'string' || !record.receiptDigest
    || typeof record.at !== 'string' || typeof record.host !== 'string' || !record.host) {
    throw new Error('metrics state contains an invalid record');
  }
  if (Number.isNaN(new Date(record.at).getTime())) throw new Error('metrics state contains an invalid timestamp');
  integer(record.estimatedInputTokens, 'estimatedInputTokens');
  integer(record.estimatedInlineTokens, 'estimatedInlineTokens');
  if (!Number.isSafeInteger(record.estimatedTransformSavingsTokens)) throw new Error('metrics state contains invalid savings');
  if (record.estimatedTransformSavingsTokens !== record.estimatedInputTokens - record.estimatedInlineTokens) {
    throw new Error('metrics state contains invalid savings');
  }
  if (record.providerReportedSavingsTokens !== null
    && !Number.isSafeInteger(record.providerReportedSavingsTokens)) throw new Error('metrics state contains invalid provider savings');
}

function validateState(value, requestedTimezone) {
  if (!value || typeof value !== 'object' || value.schema !== SCHEMA || value.version !== VERSION
    || !Array.isArray(value.records)) throw new Error('metrics state is invalid');
  validateTimezone(value.timezone);
  if (requestedTimezone && requestedTimezone !== value.timezone) throw new Error('metrics timezone mismatch');
  const seen = new Set();
  const seenReceipts = new Set();
  for (const record of value.records) {
    validateRecord(record);
    if (seen.has(record.eventKey)) throw new Error('metrics state contains duplicate events');
    const receiptKey = `${record.host}\0${record.receiptDigest}`;
    if (!record.eventKey.startsWith('event:') && seenReceipts.has(receiptKey)) {
      throw new Error('metrics state contains duplicate receipts');
    }
    seen.add(record.eventKey);
    if (!record.eventKey.startsWith('event:')) seenReceipts.add(receiptKey);
  }
  return value;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('metrics directory is unsafe');
  fs.chmodSync(directory, 0o700);
}

function assertRegularFile(filePath) {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('metrics file is unsafe');
}

function waitForLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
}

function withLock(lockPath, operation) {
  let handle;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      handle = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(handle, `${process.pid}\n`);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) fs.rmSync(lockPath, { force: true });
      else waitForLock();
    }
  }
  if (handle === undefined) throw new Error('metrics lock timeout');
  try { return operation(); }
  finally {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  }
}

function atomicWrite(filePath, value) {
  assertRegularFile(filePath);
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filePath);
    renamed = true;
  } finally {
    try {
      if (handle !== undefined) fs.closeSync(handle);
    } finally {
      if (!renamed) fs.rmSync(temporary, { force: true });
    }
  }
  try {
    const directoryHandle = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
  } catch {}
}

export function defaultMetricsPath(env = process.env) {
  const configured = env.SANDO_METRICS_PATH;
  if (configured !== undefined) return resolvePath(configured);
  const stateHome = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  if (!path.isAbsolute(stateHome)) throw new Error('state directory must be absolute');
  return path.join(stateHome, 'sando', 'metrics.json');
}

export function readMetrics(storagePath = defaultMetricsPath(), { timezone } = {}) {
  const filePath = resolvePath(storagePath);
  const requestedTimezone = timezone === undefined ? undefined : validateTimezone(timezone);
  const exists = fs.existsSync(filePath);
  if (!exists) return emptyState(requestedTimezone || defaultTimezone());
  assertRegularFile(filePath);
  let value;
  try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { throw new Error('metrics state is invalid'); }
  return validateState(value, requestedTimezone);
}

function providerSavings(providerUsage) {
  if (providerUsage === undefined || providerUsage === null) return null;
  if (!providerUsage || typeof providerUsage !== 'object' || Array.isArray(providerUsage)) {
    throw new Error('metrics input has invalid provider usage');
  }
  const value = (names) => names.map((name) => providerUsage[name]).find((candidate) => candidate !== undefined);
  const baseline = value(['baselineInputTokens', 'baseline_input_tokens']);
  const optimized = value(['optimizedInputTokens', 'optimized_input_tokens']);
  if (baseline !== undefined || optimized !== undefined) {
    integer(baseline, 'baselineInputTokens');
    integer(optimized, 'optimizedInputTokens');
    return baseline - optimized;
  }
  const reported = value(['reportedSavingsTokens', 'reported_savings_tokens']);
  if (reported !== undefined) return integer(reported, 'reportedSavingsTokens', { min: -Number.MAX_SAFE_INTEGER });
  return null;
}

function makeRecord({ host, event, receipt, optimization, now }) {
  if (typeof host !== 'string' || !host || !event || typeof event !== 'object'
    || typeof receipt?.digest !== 'string' || !receipt.digest || !optimization?.stats
    || typeof optimization.inline !== 'string') throw new Error('metrics input is invalid');
  const stats = optimization.stats;
  const estimatedInputTokens = integer(stats.estimatedInputTokens, 'estimatedInputTokens');
  const estimatedInlineTokens = integer(stats.estimatedInlineTokens, 'estimatedInlineTokens');
  const eventId = optionalString(event.eventId);
  const eventKey = eventId
    ? `event:${sha256(`${host}\0${eventId}`)}`
    : `receipt:${sha256(`${host}\0${receipt.digest}`)}`;
  const timestamp = dateValue(event.timestamp, now).toISOString();
  return {
    eventKey,
    receiptDigest: receipt.digest,
    at: timestamp,
    host,
    sessionId: optionalString(event.sessionId),
    client: optionalString(event.client),
    clientVersion: optionalString(event.clientVersion),
    model: optionalString(event.model),
    estimatedInputTokens,
    estimatedInlineTokens,
    estimatedTransformSavingsTokens: estimatedInputTokens - estimatedInlineTokens,
    providerReportedSavingsTokens: providerSavings(event.providerUsage),
  };
}

export function recordMetrics({ storagePath = defaultMetricsPath(), timezone, host, event, receipt, optimization, now = new Date() } = {}) {
  const filePath = resolvePath(storagePath);
  const directory = path.dirname(filePath);
  ensureDirectory(directory);
  const lockPath = `${filePath}.lock`;
  return withLock(lockPath, () => {
    const state = readMetrics(filePath, { timezone });
    const record = makeRecord({ host, event, receipt, optimization, now });
    if (state.records.some((candidate) => candidate.eventKey === record.eventKey
      || (!record.eventKey.startsWith('event:')
        && candidate.host === record.host && candidate.receiptDigest === record.receiptDigest))) return state;
    state.records.push(record);
    atomicWrite(filePath, state);
    return state;
  });
}

function sessionKey(record) {
  return `${record.host}\0${record.sessionId ?? '<unknown>'}`;
}

function addSafe(left, right) {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error('metrics aggregate overflow');
  return total;
}

function sum(records, field) {
  return records.reduce((total, record) => addSafe(total, record[field]), 0);
}

function providerSum(records) {
  const values = records.filter((record) => record.providerReportedSavingsTokens !== null);
  return values.length ? sum(values, 'providerReportedSavingsTokens') : null;
}

function bucket(period, records) {
  const groups = new Set(records.map(sessionKey));
  return {
    period,
    eventCount: records.length,
    sessionCount: groups.size,
    estimatedTransformSavingsTokens: sum(records, 'estimatedTransformSavingsTokens'),
    providerReportedSavingsTokens: providerSum(records),
  };
}

function sessionSummary(records) {
  if (!records.length) return null;
  const first = records[0];
  return {
    id: first.sessionId,
    host: first.host,
    client: first.client,
    clientVersion: first.clientVersion,
    model: first.model,
    eventCount: records.length,
    estimatedTransformSavingsTokens: sum(records, 'estimatedTransformSavingsTokens'),
    providerReportedSavingsTokens: providerSum(records),
  };
}

function averageBySession(records) {
  const sessions = new Map();
  for (const record of records) {
    const key = sessionKey(record);
    const group = sessions.get(key) || [];
    group.push(record);
    sessions.set(key, group);
  }
  const providerSessions = [...sessions.values()].filter((group) => providerSum(group) !== null);
  return {
    sessionCount: sessions.size,
    providerSessionCount: providerSessions.length,
    estimatedTransformSavingsTokens: sessions.size ? sum(records, 'estimatedTransformSavingsTokens') / sessions.size : 0,
    providerReportedSavingsTokens: providerSessions.length
      ? providerSessions.reduce((total, group) => addSafe(total, providerSum(group)), 0) / providerSessions.length
      : null,
  };
}

function periodReport(records, timezone, period, now) {
  const currentPeriod = periodKey(now, timezone, period);
  const grouped = new Map();
  for (const record of records) {
    const key = periodKey(new Date(record.at), timezone, period);
    const group = grouped.get(key) || [];
    group.push(record);
    grouped.set(key, group);
  }
  const history = [...grouped.keys()].sort().map((key) => bucket(key, grouped.get(key)));
  return { current: bucket(currentPeriod, grouped.get(currentPeriod) || []), history };
}

export function buildMetricsReport(state, { now = new Date(), sessionId } = {}) {
  const value = validateState(state);
  const date = dateValue(now, now);
  const records = [...value.records].sort((left, right) => left.at.localeCompare(right.at));
  const groups = new Map();
  for (const record of records) {
    const key = sessionKey(record);
    const group = groups.get(key) || [];
    group.push(record);
    groups.set(key, group);
  }
  let currentGroup;
  if (sessionId !== undefined) {
    const matching = records.filter((record) => record.sessionId === sessionId);
    currentGroup = matching.length ? groups.get(sessionKey(matching[matching.length - 1])) : undefined;
  } else if (records.length) {
    currentGroup = groups.get(sessionKey(records[records.length - 1]));
  }
  const { period: _period, ...cumulative } = bucket('all-time', records);
  return {
    schema: REPORT_SCHEMA,
    timezone: value.timezone,
    currentSession: sessionSummary(currentGroup || []),
    averagePerSession: averageBySession(records),
    cumulative,
    periods: {
      daily: periodReport(records, value.timezone, 'daily', date),
      weekly: periodReport(records, value.timezone, 'weekly', date),
      monthly: periodReport(records, value.timezone, 'monthly', date),
    },
  };
}

function tokenLine(value) {
  return value === null ? 'unavailable' : `${value} tokens`;
}

export function formatMetricsReport(report) {
  const lines = [
    `Sando savings (timezone: ${report.timezone})`,
    `Current session: ${report.currentSession ? report.currentSession.id ?? 'unknown' : 'none'}`,
    `Current session estimated transform savings: ${tokenLine(report.currentSession?.estimatedTransformSavingsTokens ?? 0)}`,
    `Average estimated transform savings per session: ${tokenLine(report.averagePerSession.estimatedTransformSavingsTokens)} (${report.averagePerSession.sessionCount} sessions)`,
    `Cumulative estimated transform savings: ${tokenLine(report.cumulative.estimatedTransformSavingsTokens)}`,
    `Cumulative provider-reported savings: ${tokenLine(report.cumulative.providerReportedSavingsTokens)}`,
    `Daily (${report.periods.daily.current.period}) estimated transform savings: ${tokenLine(report.periods.daily.current.estimatedTransformSavingsTokens)}`,
    `ISO week (${report.periods.weekly.current.period}) estimated transform savings: ${tokenLine(report.periods.weekly.current.estimatedTransformSavingsTokens)}`,
    `Monthly (${report.periods.monthly.current.period}) estimated transform savings: ${tokenLine(report.periods.monthly.current.estimatedTransformSavingsTokens)}`,
  ];
  if (!report.cumulative.eventCount) lines.push('No Sando events recorded.');
  return `${lines.join('\n')}\n`;
}
