import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCHEMA = 'sando-metrics/v1';
const JOURNAL_SCHEMA = 'sando-metrics-journal/v1';
const REPORT_SCHEMA = 'sando-report/v1';
const VERSION = 1;
const JOURNAL_HEADER_MAX_BYTES = 4096;
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

function readSnapshotTimezone(filePath, { allowFullRead = false } = {}) {
  assertRegularFile(filePath);
  const handle = fs.openSync(filePath, 'r');
  let prefix;
  try {
    const buffer = Buffer.alloc(JOURNAL_HEADER_MAX_BYTES);
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
    prefix = buffer.toString('utf8', 0, bytesRead);
  } finally {
    fs.closeSync(handle);
  }
  const header = /^\s*\{\s*"schema"\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*"version"\s*:\s*(\d+)\s*,\s*"timezone"\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*"records"\s*:\s*\[/.exec(prefix);
  if (header) {
    try {
      if (JSON.parse(header[1]) === SCHEMA && Number(header[2]) === VERSION) {
        return validateTimezone(JSON.parse(header[3]));
      }
    } catch { /* fall through to the full-state validation below */ }
  }
  if (!allowFullRead) return undefined;
  try {
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (state?.schema !== SCHEMA || state.version !== VERSION || !Array.isArray(state.records)) {
      throw new Error('metrics state is invalid');
    }
    return validateTimezone(state.timezone);
  } catch {
    throw new Error('metrics state is invalid');
  }
}

function journalPathFor(filePath) {
  return `${filePath}.journal`;
}

function parseJournalHeader(line) {
  try {
    const header = JSON.parse(line);
    if (!header || header.schema !== JOURNAL_SCHEMA || header.version !== VERSION) throw new Error();
    validateTimezone(header.timezone);
    return header;
  } catch {
    throw new Error('metrics journal is invalid');
  }
}

function readJournalHeader(filePath) {
  assertRegularFile(filePath);
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(JOURNAL_HEADER_MAX_BYTES);
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) {
      const error = new Error(bytesRead < JOURNAL_HEADER_MAX_BYTES ? 'metrics journal header is incomplete' : 'metrics journal is invalid');
      error.code = bytesRead < JOURNAL_HEADER_MAX_BYTES ? 'SANDO_METRICS_JOURNAL_HEADER_INCOMPLETE' : 'SANDO_METRICS_JOURNAL_INVALID';
      throw error;
    }
    const header = parseJournalHeader(buffer.toString('utf8', 0, newline));
    return { header, headerBytes: newline + 1 };
  } finally {
    fs.closeSync(handle);
  }
}

function readJournal(filePath) {
  assertRegularFile(filePath);
  const contents = fs.readFileSync(filePath, 'utf8');
  const headerEnd = contents.indexOf('\n');
  if (headerEnd < 0) throw new Error('metrics journal is invalid');
  const header = parseJournalHeader(contents.slice(0, headerEnd));
  const payload = contents.slice(headerEnd + 1);
  if (payload.startsWith('\n')) throw new Error('metrics journal is invalid');
  const lastNewline = payload.lastIndexOf('\n');
  const complete = lastNewline < 0 ? '' : payload.slice(0, lastNewline);
  const records = [];
  if (complete) {
    for (const line of complete.split('\n')) {
      if (!line) throw new Error('metrics journal is invalid');
      try {
        const record = JSON.parse(line);
        validateRecord(record);
        records.push(record);
      } catch {
        throw new Error('metrics journal is invalid');
      }
    }
  }
  return { header, records };
}

function sameRecord(left, right) {
  const canonical = (record) => JSON.stringify(Object.keys(record).filter((key) => key !== 'at').sort().map((key) => [key, record[key]]));
  return canonical(left) === canonical(right);
}

function mergeJournalRecords(state, records) {
  const byEventKey = new Map(state.records.map((record) => [record.eventKey, record]));
  const receiptKeys = new Set(state.records.map((record) => `${record.host}\0${record.receiptDigest}`));
  for (const record of records) {
    const receiptKey = `${record.host}\0${record.receiptDigest}`;
    if (!record.eventKey.startsWith('event:') && receiptKeys.has(receiptKey)) continue;
    const existing = byEventKey.get(record.eventKey);
    if (existing) {
      if (!sameRecord(existing, record)) throw new Error('metrics journal contains a conflicting event');
      continue;
    }
    state.records.push(record);
    byEventKey.set(record.eventKey, record);
    receiptKeys.add(receiptKey);
  }
  return state;
}

function repairJournalTail(filePath, headerBytes) {
  const handle = fs.openSync(filePath, 'r+');
  try {
    const size = fs.fstatSync(handle).size;
    if (size <= headerBytes) return;
    const lastByte = Buffer.alloc(1);
    fs.readSync(handle, lastByte, 0, 1, size - 1);
    if (lastByte[0] === 0x0a) return;
    const buffer = Buffer.alloc(4096);
    let end = size;
    let truncateAt = headerBytes;
    while (end > headerBytes) {
      const start = Math.max(headerBytes, end - buffer.length);
      const bytesRead = fs.readSync(handle, buffer, 0, end - start, start);
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline >= 0) {
        truncateAt = start + newline + 1;
        break;
      }
      end = start;
    }
    fs.ftruncateSync(handle, truncateAt);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function writeJournalHeader(filePath, timezone) {
  const handle = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify({ schema: JOURNAL_SCHEMA, version: VERSION, timezone })}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.chmodSync(filePath, 0o600);
  syncDirectory(path.dirname(filePath));
}

function appendJournalRecord(filePath, record) {
  assertRegularFile(filePath);
  const handle = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.chmodSync(filePath, 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('metrics directory is unsafe');
  fs.chmodSync(directory, 0o700);
}

function syncDirectory(directory) {
  try {
    const handle = fs.openSync(directory, 'r');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  } catch {}
}

function assertRegularFile(filePath) {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('metrics file is unsafe');
}

function waitForLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

function ownerPid(filePath) {
  try {
    const contents = fs.readFileSync(filePath, 'utf8').trim();
    let value;
    try { value = JSON.parse(contents); }
    catch {
      if (!/^\d+$/.test(contents)) return undefined;
      value = Number(contents);
    }
    const pid = typeof value === 'number' ? value : value?.pid;
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

function sameFile(leftPath, rightPath) {
  const left = fs.lstatSync(leftPath, { bigint: true, throwIfNoEntry: false });
  const right = fs.lstatSync(rightPath, { bigint: true, throwIfNoEntry: false });
  return Boolean(left?.isFile() && right?.isFile() && left.dev === right.dev && left.ino === right.ino);
}

function writeLockTicket(filePath) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.ticket-tmp.${randomUUID()}`);
  let handle;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid }));
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporary, filePath);
    syncDirectory(path.dirname(filePath));
  } finally {
    try { if (handle !== undefined) fs.closeSync(handle); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
}

function reclaimMetadataPaths(lockPath) {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.reclaim.`;
  return fs.readdirSync(directory).filter((name) => name.startsWith(prefix) && !name.includes('.tmp.'))
    .map((name) => ({ metadataPath: path.join(directory, name), token: name.slice(prefix.length) }));
}

function cleanAbandonedReclaimers(lockPath) {
  let active = false;
  for (const { metadataPath, token } of reclaimMetadataPaths(lockPath)) {
    const pid = ownerPid(metadataPath);
    if (pid === undefined || processIsAlive(pid)) {
      active = true;
      continue;
    }
    fs.rmSync(`${lockPath}.claim.${token}`, { force: true });
    fs.rmSync(metadataPath, { force: true });
  }
  return active;
}

function cleanOrphanedClaims(lockPath) {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.claim.`;
  const reclaimers = new Set(reclaimMetadataPaths(lockPath).map(({ token }) => token));
  for (const name of fs.readdirSync(directory).filter((entry) => entry.startsWith(prefix))) {
    const token = name.slice(prefix.length);
    if (!reclaimers.has(token)) fs.rmSync(path.join(directory, name), { force: true });
  }
}

function cleanAbandonedTickets(lockPath) {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.owner.`;
  for (const name of fs.readdirSync(directory).filter((entry) => entry.startsWith(prefix))) {
    const ticketPath = path.join(directory, name);
    const pid = ownerPid(ticketPath);
    const stat = fs.statSync(ticketPath, { throwIfNoEntry: false });
    if ((pid !== undefined && !processIsAlive(pid))
      || (pid === undefined && stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS)) {
      fs.rmSync(ticketPath, { force: true });
    }
  }
}

function lockOwnerIsDead(filePath) {
  assertRegularFile(filePath);
  const pid = ownerPid(filePath);
  return pid !== undefined && !processIsAlive(pid);
}

function tryReclaimLock(lockPath) {
  if (!lockOwnerIsDead(lockPath)) return false;
  const token = randomUUID();
  const metadataPath = `${lockPath}.reclaim.${token}`;
  const claimPath = `${lockPath}.claim.${token}`;
  writeLockTicket(metadataPath);
  let claimCreated = false;
  try {
    fs.linkSync(lockPath, claimPath);
    claimCreated = true;
    if (lockOwnerIsDead(claimPath) && sameFile(lockPath, claimPath)) {
      try { fs.unlinkSync(lockPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  } finally {
    if (claimCreated) fs.rmSync(claimPath, { force: true });
    fs.rmSync(metadataPath, { force: true });
  }
  return true;
}

function releaseLockIfOwned(lockPath, ticketPath) {
  if (sameFile(lockPath, ticketPath)) fs.unlinkSync(lockPath);
}

function withLock(lockPath, operation) {
  const ticketPath = `${lockPath}.owner.${randomUUID()}`;
  writeLockTicket(ticketPath);
  try {
    cleanAbandonedTickets(lockPath);
    cleanOrphanedClaims(lockPath);
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      if (cleanAbandonedReclaimers(lockPath)) { waitForLock(); continue; }
      try { fs.linkSync(ticketPath, lockPath); }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        assertRegularFile(lockPath);
        if (tryReclaimLock(lockPath)) continue;
        waitForLock();
        continue;
      }
      if (!sameFile(ticketPath, lockPath) || cleanAbandonedReclaimers(lockPath)) {
        releaseLockIfOwned(lockPath, ticketPath);
        waitForLock();
        continue;
      }
      try { return operation(); }
      finally { releaseLockIfOwned(lockPath, ticketPath); }
    }
    throw new Error('metrics lock timeout');
  } finally { fs.rmSync(ticketPath, { force: true }); }
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
  syncDirectory(path.dirname(filePath));
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
  let state;
  if (fs.existsSync(filePath)) {
    assertRegularFile(filePath);
    let value;
    try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { throw new Error('metrics state is invalid'); }
    state = validateState(value, requestedTimezone);
  }
  const journalPath = journalPathFor(filePath);
  if (fs.existsSync(journalPath)) {
    const journal = readJournal(journalPath);
    if (requestedTimezone && requestedTimezone !== journal.header.timezone) throw new Error('metrics timezone mismatch');
    if (state && state.timezone !== journal.header.timezone) throw new Error('metrics timezone mismatch');
    state ??= emptyState(journal.header.timezone);
    mergeJournalRecords(state, journal.records);
  }
  state ??= emptyState(requestedTimezone || defaultTimezone());
  return validateState(state, requestedTimezone);
}

function providerSavings(providerUsage) {
  if (providerUsage === undefined || providerUsage === null) return null;
  if (!providerUsage || typeof providerUsage !== 'object' || Array.isArray(providerUsage)) {
    throw new Error('metrics input has invalid provider usage');
  }
  const value = (names) => names.map((name) => providerUsage[name]).find((candidate) => candidate !== undefined);
  const baseline = value(['baselineInputTokens', 'baseline_input_tokens']);
  const optimized = value(['optimizedInputTokens', 'optimized_input_tokens']);
  const reported = value(['reportedSavingsTokens', 'reported_savings_tokens']);
  if (baseline === undefined && optimized === undefined && reported === undefined) return null;
  if (baseline !== undefined || optimized !== undefined) {
    integer(baseline, 'baselineInputTokens');
    integer(optimized, 'optimizedInputTokens');
    return null;
  }
  integer(reported, 'reportedSavingsTokens', { min: -Number.MAX_SAFE_INTEGER });
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

function appendMetricsRecordLocked(filePath, journalPath, requestedTimezone, record) {
  const snapshotExists = fs.existsSync(filePath);
  let journalExists = fs.existsSync(journalPath);
  let journalInfo;
  if (journalExists) {
    try { journalInfo = readJournalHeader(journalPath); }
    catch (error) {
      if (error?.code !== 'SANDO_METRICS_JOURNAL_HEADER_INCOMPLETE') throw error;
      fs.rmSync(journalPath, { force: true });
      journalExists = false;
    }
  }
  let storedTimezone = snapshotExists
    ? readSnapshotTimezone(filePath, { allowFullRead: !journalExists })
    : undefined;
  if (storedTimezone && journalInfo && storedTimezone !== journalInfo.header.timezone) {
    throw new Error('metrics timezone mismatch');
  }
  storedTimezone ??= journalInfo?.header.timezone;
  const metricsTimezone = storedTimezone ?? requestedTimezone ?? defaultTimezone();
  if (requestedTimezone && requestedTimezone !== metricsTimezone) throw new Error('metrics timezone mismatch');
  if (!snapshotExists) atomicWrite(filePath, emptyState(metricsTimezone));
  if (!journalExists) writeJournalHeader(journalPath, metricsTimezone);
  else repairJournalTail(journalPath, journalInfo.headerBytes);
  appendJournalRecord(journalPath, record);
}

export function appendMetricsRecord({ storagePath = defaultMetricsPath(), timezone, host, event, receipt, optimization, now = new Date() } = {}) {
  const filePath = resolvePath(storagePath);
  const journalPath = journalPathFor(filePath);
  const requestedTimezone = timezone === undefined ? undefined : validateTimezone(timezone);
  const record = makeRecord({ host, event, receipt, optimization, now });
  ensureDirectory(path.dirname(filePath));
  assertRegularFile(journalPath);
  return withLock(`${filePath}.lock`, () => {
    appendMetricsRecordLocked(filePath, journalPath, requestedTimezone, record);
    return record;
  });
}

export function recordMetrics({ storagePath = defaultMetricsPath(), timezone, host, event, receipt, optimization, now = new Date() } = {}) {
  const filePath = resolvePath(storagePath);
  const journalPath = journalPathFor(filePath);
  ensureDirectory(path.dirname(filePath));
  assertRegularFile(journalPath);
  return withLock(`${filePath}.lock`, () => {
    const state = readMetrics(filePath, { timezone });
    const record = makeRecord({ host, event, receipt, optimization, now });
    if (state.records.some((candidate) => candidate.eventKey === record.eventKey
      || (!record.eventKey.startsWith('event:')
        && candidate.host === record.host && candidate.receiptDigest === record.receiptDigest))) return state;
    appendMetricsRecordLocked(filePath, journalPath, state.timezone, record);
    state.records.push(record);
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
    `Sando mechanical measurement (timezone: ${report.timezone})`,
    `Current session: ${report.currentSession ? report.currentSession.id ?? 'unknown' : 'none'}`,
    `Current session mechanical reduction: ${tokenLine(report.currentSession?.estimatedTransformSavingsTokens ?? 0)}`,
    `Average mechanical reduction per session: ${tokenLine(report.averagePerSession.estimatedTransformSavingsTokens)} (${report.averagePerSession.sessionCount} sessions)`,
    `Cumulative mechanical reduction: ${tokenLine(report.cumulative.estimatedTransformSavingsTokens)}`,
    `Provider cost: unavailable here; use paired control/apply ledger evidence`,
    `Daily (${report.periods.daily.current.period}) mechanical reduction: ${tokenLine(report.periods.daily.current.estimatedTransformSavingsTokens)}`,
    `ISO week (${report.periods.weekly.current.period}) mechanical reduction: ${tokenLine(report.periods.weekly.current.estimatedTransformSavingsTokens)}`,
    `Monthly (${report.periods.monthly.current.period}) mechanical reduction: ${tokenLine(report.periods.monthly.current.estimatedTransformSavingsTokens)}`,
  ];
  if (!report.cumulative.eventCount) lines.push('No Sando events recorded.');
  return `${lines.join('\n')}\n`;
}
