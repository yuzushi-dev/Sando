import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWrite, ensureDirectory, withLock } from './provider-usage.mjs';
import { PLUGIN_VERSION } from './version.mjs';

export const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const SUPPORTED_QUEUE_SCHEMA_VERSIONS = new Set([LEGACY_SCHEMA_VERSION, SCHEMA_VERSION]);
const MAX_STRING_LENGTH = 32;
const MAX_EVENT_BYTES = 2048;

const COUNT_BUCKETS = ['zero', 'one', '2_to_5', '6_to_20', '21_to_100', 'gt_100'];
const BYTE_BUCKETS = ['lt_4k', '4_to_16k', '16_to_64k', '64_to_256k', '256k_to_1m', 'gte_1m'];
const LOCAL_ONLY_EVENTS = new Set(['f1_footprint', 'f2_snapshot', 'f2_review', 'f4_gateway']);
const HOSTS = ['claude', 'codex'];
const PROVIDERS = ['anthropic', 'openai', 'unknown'];
const MODES = ['enforce', 'observe', 'dry_run'];
const F2_STATUSES = ['recorded', 'unchanged', 'error'];
const F2_LABELS = ['useful', 'not-useful', 'duplicate', 'risky'];
const F2_ERROR_KINDS = ['none', 'missing-root', 'permission-denied', 'limits-exceeded', 'invalid-state', 'scan-failed'];
const F4_HOSTS = ['claude', 'codex', 'unknown'];
const F4_OPERATIONS = ['catalog', 'call'];
const F4_OUTCOMES = ['success', 'rejected', 'timeout', 'cancelled', 'error'];
const F4_LATENCY_BUCKETS = ['lt_10ms', '10_to_100ms', '100_to_1000ms', 'gte_1000ms'];
const F4_RESULT_BUCKETS = ['zero', 'one', '2_to_5', '6_to_20', 'gt_20', 'unknown'];
const F2_PROJECT = (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(value);
const F2_SNAPSHOT_ID = (value) => typeof value === 'string' && /^[0-9a-f]{12}$/.test(value);
const F2_COUNTER = (value) => Number.isSafeInteger(value) && value >= 0;
const F2_SIGNED_COUNTER = (value) => Number.isSafeInteger(value);
const F1_HOSTS = ['claude', 'codex'];
const F1_STATUSES = ['complete', 'partial', 'unavailable'];
const F1_RATIO_BUCKETS = ['zero', 'lt_1pct', '1_to_10pct', 'gt_10pct', 'unavailable'];
const F1_SIZE_BUCKETS = [...BYTE_BUCKETS, 'unavailable'];
const F1_INPUT_BUCKETS = [...COUNT_BUCKETS, 'unavailable'];
export const FAILURE_STAGES = [
  'policy', 'input', 'redaction', 'optimization', 'artifact', 'output', 'upstream', 'response',
];

const SHARED_FIELDS = {
  schema_version: (value) => value === SCHEMA_VERSION,
  event: (value) => [
    'hook_summary', 'proxy_summary', 'active_day', 'hook_failure_summary', 'proxy_failure_summary',
    'f1_footprint', 'f2_snapshot', 'f2_review', 'f4_gateway',
  ].includes(value),
  day_utc: (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
  plugin_version: (value) => typeof value === 'string' && /^\d+\.\d+(?:\.\d+)?$/.test(value) && value.length <= MAX_STRING_LENGTH,
};

const HOOK_FIELDS = {
  host: (value) => HOSTS.includes(value),
  mode: (value) => MODES.includes(value),
  tool_calls_bucket: (value) => COUNT_BUCKETS.includes(value),
  capped_outputs_bucket: (value) => COUNT_BUCKETS.includes(value),
  bytes_saved_bucket: (value) => BYTE_BUCKETS.includes(value),
  input_tokens_saved_bucket: (value) => BYTE_BUCKETS.includes(value),
};

const PROXY_FIELDS = {
  provider: (value) => PROVIDERS.includes(value),
  mode: (value) => MODES.includes(value),
  rewrites_applied_bucket: (value) => COUNT_BUCKETS.includes(value),
  rewrites_skipped_cache_bucket: (value) => COUNT_BUCKETS.includes(value),
  input_tokens_saved_bucket: (value) => BYTE_BUCKETS.includes(value),
};

const ACTIVE_DAY_FIELDS = { host: (value) => HOSTS.includes(value) };
const HOOK_FAILURE_FIELDS = {
  host: (value) => HOSTS.includes(value),
  failure_stage: (value) => FAILURE_STAGES.includes(value),
};
const PROXY_FAILURE_FIELDS = {
  provider: (value) => PROVIDERS.includes(value),
  failure_stage: (value) => FAILURE_STAGES.includes(value),
};
const F2_SNAPSHOT_FIELDS = {
  f2_project: F2_PROJECT,
  f2_snapshot_id: F2_SNAPSHOT_ID,
  f2_status: (value) => F2_STATUSES.includes(value),
  f2_duration_ms: F2_COUNTER,
  f2_files: F2_COUNTER,
  f2_blocks: F2_COUNTER,
  f2_instruction_bytes: F2_COUNTER,
  f2_always_on_blocks: F2_COUNTER,
  f2_always_on_bytes: F2_COUNTER,
  f2_on_demand_blocks: F2_COUNTER,
  f2_on_demand_bytes: F2_COUNTER,
  f2_duplicate_blocks: F2_COUNTER,
  f2_duplicate_bytes: F2_COUNTER,
  f2_unknown_blocks: F2_COUNTER,
  f2_unknown_bytes: F2_COUNTER,
  f2_proposal_count: F2_COUNTER,
  f2_proposed_bytes: F2_COUNTER,
  f2_delta_instruction_bytes: F2_SIGNED_COUNTER,
  f2_delta_proposed_bytes: F2_SIGNED_COUNTER,
  f2_error_kind: (value) => F2_ERROR_KINDS.includes(value),
};
const F2_REVIEW_FIELDS = {
  f2_project: F2_PROJECT,
  f2_snapshot_id: F2_SNAPSHOT_ID,
  f2_label: (value) => F2_LABELS.includes(value),
};
const F4_FIELDS = {
  f4_host: (value) => F4_HOSTS.includes(value),
  f4_operation: (value) => F4_OPERATIONS.includes(value),
  f4_outcome: (value) => F4_OUTCOMES.includes(value),
  f4_latency_bucket: (value) => F4_LATENCY_BUCKETS.includes(value),
  f4_result_bucket: (value) => F4_RESULT_BUCKETS.includes(value),
};
const F1_FIELDS = {
  f1_host: (value) => F1_HOSTS.includes(value),
  f1_status: (value) => F1_STATUSES.includes(value),
  f1_unknown_ratio_bucket: (value) => F1_RATIO_BUCKETS.includes(value),
  f1_body_size_bucket: (value) => F1_SIZE_BUCKETS.includes(value),
  f1_input_tokens_bucket: (value) => F1_INPUT_BUCKETS.includes(value),
};

function fieldsForEvent(eventType) {
  if (eventType === 'f1_footprint') return F1_FIELDS;
  if (eventType === 'hook_summary') return HOOK_FIELDS;
  if (eventType === 'proxy_summary') return PROXY_FIELDS;
  if (eventType === 'active_day') return ACTIVE_DAY_FIELDS;
  if (eventType === 'hook_failure_summary') return HOOK_FAILURE_FIELDS;
  if (eventType === 'f2_snapshot') return F2_SNAPSHOT_FIELDS;
  if (eventType === 'f2_review') return F2_REVIEW_FIELDS;
  if (eventType === 'f4_gateway') return F4_FIELDS;
  return PROXY_FAILURE_FIELDS;
}

export function countBucket(count) {
  if (!Number.isInteger(count) || count < 0) throw new Error('countBucket: invalid count');
  if (count === 0) return 'zero';
  if (count === 1) return 'one';
  if (count <= 5) return '2_to_5';
  if (count <= 20) return '6_to_20';
  if (count <= 100) return '21_to_100';
  return 'gt_100';
}

export function byteBucket(bytes) {
  if (!Number.isInteger(bytes) || bytes < 0) throw new Error('byteBucket: invalid byte count');
  if (bytes < 4096) return 'lt_4k';
  if (bytes < 16384) return '4_to_16k';
  if (bytes < 65536) return '16_to_64k';
  if (bytes < 262144) return '64_to_256k';
  if (bytes < 1048576) return '256k_to_1m';
  return 'gte_1m';
}

export function validateEvent(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('event must be an object');
  if (!SHARED_FIELDS.event(payload.event)) throw new Error('event: unknown event type');
  const allowed = { ...SHARED_FIELDS, ...fieldsForEvent(payload.event) };
  for (const key of Object.keys(payload)) {
    if (!Object.hasOwn(allowed, key)) throw new Error(`unknown field: ${key}`);
  }
  for (const [key, check] of Object.entries(allowed)) {
    if (!Object.hasOwn(payload, key)) throw new Error(`missing field: ${key}`);
    if (typeof payload[key] === 'string' && payload[key].length > MAX_STRING_LENGTH) throw new Error(`${key}: string too long`);
    if (!check(payload[key])) throw new Error(`${key}: invalid value`);
  }
  return payload;
}

export function serializeEvent(payload) {
  validateEvent(payload);
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_EVENT_BYTES) throw new Error('event exceeds serialized size limit');
  return serialized;
}

export const TELEMETRY_CONFIG_VERSION = 1;
export const CONSENT_VERSION = 1;
export const TELEMETRY_DETAILS_URL = 'https://github.com/yuzushi-dev/Sando/blob/main/TELEMETRY.md';
export const CONSENT_STATES = ['unasked', 'asked', 'enabled', 'declined'];
// Canary phase: shared backend, fronted by a Cloudflare Tunnel so it's
// reachable from any of the owner's machines (see
// session-handoff/deploy/telemetry/). Rate-limited at nginx (30 req/min/IP).
// Release/broader publication is still gated on the open items in
// session-handoff/docs/telemetry-canary-report.md.
export const TELEMETRY_ENDPOINT = 'https://telemetry.yuzushi.party/v1/logs';

export function isDoNotTrack(env = process.env) {
  return env.DO_NOT_TRACK !== undefined && env.DO_NOT_TRACK !== '' && env.DO_NOT_TRACK !== '0';
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function emptyTelemetryConfig() {
  return {
    schema_version: TELEMETRY_CONFIG_VERSION, enabled: false, prompted_consent_version: 0, consent_state: 'unasked',
  };
}

function validateTelemetryConfig(value) {
  if (!record(value) || value.schema_version !== TELEMETRY_CONFIG_VERSION || typeof value.enabled !== 'boolean'
    || !Number.isInteger(value.prompted_consent_version) || value.prompted_consent_version < 0
    || !CONSENT_STATES.includes(value.consent_state)) {
    throw new Error('telemetry config is invalid');
  }
  if (value.enabled) {
    if (!Number.isInteger(value.consent_version) || value.consent_version < 1
      || typeof value.consented_at !== 'string' || Number.isNaN(Date.parse(value.consented_at))
      || typeof value.endpoint !== 'string' || !value.endpoint) throw new Error('telemetry config is invalid');
  }
  return value;
}

export function defaultTelemetryConfigPath(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  if (!path.isAbsolute(configHome)) throw new Error('config directory must be absolute');
  return path.join(configHome, 'sando', 'telemetry.json');
}

export function defaultTelemetryStatePaths(env = process.env) {
  const stateHome = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  if (!path.isAbsolute(stateHome)) throw new Error('state directory must be absolute');
  const directory = path.join(stateHome, 'sando');
  return { counters: path.join(directory, 'telemetry-counters.json'), queue: path.join(directory, 'telemetry-queue.jsonl') };
}

export function readTelemetryConfig(configPath = defaultTelemetryConfigPath()) {
  if (!fs.existsSync(configPath)) return emptyTelemetryConfig();
  const value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  // Legacy files cannot distinguish an explicit no from blank input or the old
  // y-as-no bug. Keep that ambiguous decision as asked, not as a decline.
  const migrated = Object.hasOwn(value, 'consent_state') ? value : {
    ...value,
    consent_state: value.enabled ? 'enabled' : value.prompted_consent_version > 0 ? 'asked' : 'unasked',
  };
  return validateTelemetryConfig(migrated);
}

function writeTelemetryConfig(configPath, config) {
  validateTelemetryConfig(config);
  ensureDirectory(path.dirname(configPath));
  withLock(`${configPath}.lock`, () => atomicWrite(configPath, config));
  return config;
}

export function statusTelemetry(configPath = defaultTelemetryConfigPath()) {
  return readTelemetryConfig(configPath);
}

export function normalizeConsentAnswer(answer) {
  if (typeof answer !== 'string') return undefined;
  const normalized = answer.trim().toLowerCase();
  if (normalized === 'y' || normalized === 'yes') return 'yes';
  if (normalized === 'n' || normalized === 'no') return 'no';
  return undefined;
}

export function markTelemetryAsked(configPath = defaultTelemetryConfigPath()) {
  ensureDirectory(path.dirname(configPath));
  return withLock(`${configPath}.lock`, () => {
    const current = readTelemetryConfig(configPath);
    if (current.consent_state !== 'unasked') return false;
    const next = {
      ...current, enabled: false, prompted_consent_version: CONSENT_VERSION, consent_state: 'asked',
    };
    validateTelemetryConfig(next);
    atomicWrite(configPath, next);
    return true;
  });
}

/** Only an explicit yes enables collection; explicit no declines, other input stays asked/off. */
export function enableTelemetry({ configPath = defaultTelemetryConfigPath(), answer, interactive = true, now = () => new Date() } = {}) {
  if (!interactive) return { ...readTelemetryConfig(configPath), exitCode: 1 };
  const normalized = normalizeConsentAnswer(answer);
  if (normalized === 'yes') {
    return writeTelemetryConfig(configPath, {
      schema_version: TELEMETRY_CONFIG_VERSION,
      enabled: true,
      prompted_consent_version: CONSENT_VERSION,
      consent_state: 'enabled',
      consent_version: CONSENT_VERSION,
      consented_at: now().toISOString(),
      endpoint: TELEMETRY_ENDPOINT,
    });
  }
  return writeTelemetryConfig(configPath, {
    schema_version: TELEMETRY_CONFIG_VERSION,
    enabled: false,
    prompted_consent_version: CONSENT_VERSION,
    consent_state: normalized === 'no' ? 'declined' : 'asked',
  });
}

// 30 days of daily aggregates plus activity markers for both supported hosts,
// with headroom for concurrent event dimensions and temporary outages.
const QUEUE_MAX_ROWS = 4096;
const QUEUE_MAX_BYTES = 4 * 1024 * 1024;
const ACTIVE_DAY_RETENTION_DAYS = 30;
const DEFAULT_BATCH_MAX = 32;
const LEASE_MS = 5 * 60 * 1000;
const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];
const CHILD_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];

function emptyCounters() { return { schema_version: TELEMETRY_CONFIG_VERSION, counters: {}, active_days: {} }; }
function readCounters(countersPath) {
  if (!fs.existsSync(countersPath)) return emptyCounters();
  const state = JSON.parse(fs.readFileSync(countersPath, 'utf8'));
  return { ...state, counters: state.counters ?? {}, active_days: state.active_days ?? {} };
}

function readQueueRows(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs.readFileSync(queuePath, 'utf8').split('\n').filter(Boolean).map((line) => {
    const row = JSON.parse(line);
    assertQueueRow(row);
    return row;
  });
}

function assertQueueRow(row) {
  if (!record(row) || !SUPPORTED_QUEUE_SCHEMA_VERSIONS.has(row.schema_version)) {
    throw new Error('telemetry queue event schema is unsupported');
  }
}

function writeQueueRows(queuePath, rows) {
  ensureDirectory(path.dirname(queuePath));
  const temporary = path.join(path.dirname(queuePath), `.${path.basename(queuePath)}.${process.pid}.tmp`);
  const content = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, queuePath); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  fs.chmodSync(queuePath, 0o600);
}

/** Enforces the bounded queue (4096 rows / 4 MiB), dropping the oldest rows first —
 *  a telemetry backlog must never grow without bound or block product behavior. */
export function appendQueueRows(queuePath, newRows) {
  for (const row of newRows) {
    assertQueueRow(row);
    if (LOCAL_ONLY_EVENTS.has(row.event)) throw new Error(`${row.event}: local-only event must never reach the upload queue`);
  }
  ensureDirectory(path.dirname(queuePath));
  withLock(`${queuePath}.lock`, () => {
    let rows = readQueueRows(queuePath);
    const keys = new Set(rows.map((row) => queueKey(row)));
    for (const row of newRows) {
      if (!keys.has(queueKey(row))) { rows.push(row); keys.add(queueKey(row)); }
    }
    if (rows.length > QUEUE_MAX_ROWS) rows = rows.slice(rows.length - QUEUE_MAX_ROWS);
    while (rows.length > 0 && Buffer.byteLength(rows.map((row) => JSON.stringify(row)).join('\n')) > QUEUE_MAX_BYTES) rows.shift();
    writeQueueRows(queuePath, rows);
  });
}

function queueKey(row) {
  return [row.event, row.day_utc, row.plugin_version, row.host ?? row.provider ?? '', row.mode ?? '', row.failureStage ?? row.failure_stage ?? ''].join('|');
}

function publicRow(row) {
  const allowed = { ...SHARED_FIELDS, ...fieldsForEvent(row.event) };
  return Object.fromEntries(Object.entries(row).filter(([key]) => Object.hasOwn(allowed, key)));
}

function bucketEntry(entry, pluginVersion) {
  if (entry.event === 'hook_summary') {
    return {
      schema_version: SCHEMA_VERSION, event: 'hook_summary', day_utc: entry.day, plugin_version: PLUGIN_VERSION,
      host: entry.host, mode: entry.mode,
      tool_calls_bucket: countBucket(entry.toolCalls ?? 0),
      capped_outputs_bucket: countBucket(entry.cappedOutputs ?? 0),
      bytes_saved_bucket: byteBucket(entry.bytesSaved ?? 0),
      input_tokens_saved_bucket: byteBucket(entry.inputTokensSaved ?? 0),
    };
  }
  if (entry.event === 'proxy_summary') return {
    schema_version: SCHEMA_VERSION, event: 'proxy_summary', day_utc: entry.day, plugin_version: PLUGIN_VERSION,
    provider: entry.provider ?? 'unknown', mode: entry.mode ?? 'enforce',
    rewrites_applied_bucket: countBucket(entry.rewritesApplied ?? 0),
    rewrites_skipped_cache_bucket: countBucket(entry.rewritesSkippedCache ?? 0),
    input_tokens_saved_bucket: byteBucket(entry.inputTokensSaved ?? 0),
  };
  if (entry.event === 'hook_failure_summary') return {
    schema_version: SCHEMA_VERSION, event: 'hook_failure_summary', day_utc: entry.day, plugin_version: PLUGIN_VERSION,
    host: entry.host, failure_stage: entry.failureStage,
  };
  return {
    schema_version: SCHEMA_VERSION, event: 'proxy_failure_summary', day_utc: entry.day, plugin_version: PLUGIN_VERSION,
    provider: entry.provider, failure_stage: entry.failureStage,
  };
}

/** Accumulates raw per-day counts in memory/on disk; values are only bucketed (and thus
 *  only ever leave the machine) once `closeDay` closes a finished UTC day. */
export function incrementCounter({ statePaths, day, event, host, provider, mode, failureStage, deltas = {} }) {
  if (!['hook_summary', 'proxy_summary', 'hook_failure_summary', 'proxy_failure_summary'].includes(event)) {
    throw new Error('incrementCounter: invalid event');
  }
  const isProxy = event.startsWith('proxy_');
  const dimension = isProxy ? provider : host;
  const key = event.includes('failure')
    ? [day, event, dimension, failureStage ?? ''].join('|')
    : [day, event, dimension, mode ?? ''].join('|');
  ensureDirectory(path.dirname(statePaths.counters));
  withLock(`${statePaths.counters}.lock`, () => {
    const state = readCounters(statePaths.counters);
    const existing = state.counters[key] ?? {
      day, event, ...(isProxy ? { provider: dimension } : { host: dimension }),
      ...(event.endsWith('_summary') && !event.includes('failure') ? { mode: mode ?? null } : {}),
      ...(event.includes('failure') ? { failureStage } : {}),
    };
    for (const [field, value] of Object.entries(deltas)) {
      if (!Number.isInteger(value) || value < 0) throw new Error(`incrementCounter: invalid delta ${field}`);
      existing[field] = (existing[field] ?? 0) + value;
    }
    state.counters[key] = existing;
    atomicWrite(statePaths.counters, state);
  });
}

export function recordFailure({ statePaths, day, event, host, provider, failureStage }) {
  incrementCounter({
    statePaths, day, event, host, provider, failureStage, deltas: { count: 1 },
  });
}

/** Queues a single non-aggregate activity marker for this UTC day and host. */
export function recordActiveDay({ statePaths, day, pluginVersion, host }) {
  const marker = {
    schema_version: SCHEMA_VERSION, event: 'active_day', day_utc: day, plugin_version: PLUGIN_VERSION, host,
  };
  const validatedMarker = validateEvent(marker);
  const activeDayKey = `${day}|${host}`;
  ensureDirectory(path.dirname(statePaths.counters));
  withLock(`${statePaths.counters}.lock`, () => {
    const state = readCounters(statePaths.counters);
    const activeDays = state.active_days;
    const cutoff = Date.parse(`${day}T00:00:00Z`) - (ACTIVE_DAY_RETENTION_DAYS - 1) * 86_400_000;
    for (const [key, recordedDay] of Object.entries(activeDays)) {
      if (Date.parse(`${recordedDay}T00:00:00Z`) < cutoff) delete activeDays[key];
    }
    if (Object.hasOwn(activeDays, activeDayKey)) {
      atomicWrite(statePaths.counters, state);
      return;
    }
    appendQueueRows(statePaths.queue, [validatedMarker]);
    activeDays[activeDayKey] = day;
    atomicWrite(statePaths.counters, state);
  });
}

/** Closes a finished UTC day: buckets its raw counters into daily_aggregate rows,
 *  appends them to the upload queue, and clears them from the raw counter file so a
 *  day is never counted twice. */
export function closeDay({ statePaths, day, pluginVersion }) {
  const closedRows = [];
  withLock(`${statePaths.counters}.lock`, () => {
    const state = readCounters(statePaths.counters);
    const remaining = {};
    for (const [key, entry] of Object.entries(state.counters)) {
      if (entry.day !== day) { remaining[key] = entry; continue; }
      closedRows.push(validateEvent(bucketEntry(entry, pluginVersion)));
    }
    if (closedRows.length) appendQueueRows(statePaths.queue, closedRows);
    state.counters = remaining;
    ensureDirectory(path.dirname(statePaths.counters));
    atomicWrite(statePaths.counters, state);
  });
  return closedRows;
}

function launchDetachedFlush({ statePaths, configPath, spawnImpl }) {
  try {
    const entryPath = fileURLToPath(new URL('./telemetry-flush-entry.mjs', import.meta.url));
    const child = spawnImpl(process.execPath, [entryPath, '--queue', statePaths.queue, '--config', configPath], {
      detached: true,
      env: Object.fromEntries(CHILD_ENV_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
      stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch { /* telemetry must never affect the caller */ }
}

/** Closes every raw counter day before `day` and starts one detached uploader
 * whenever any queue row remains, including a queue from a previous session. */
export function closeFinishedDays({
  statePaths, configPath = defaultTelemetryConfigPath(), day, pluginVersion,
  spawnImpl = spawn,
} = {}) {
  const days = new Set();
  if (fs.existsSync(statePaths.counters)) {
    const state = readCounters(statePaths.counters);
    for (const entry of Object.values(state.counters)) {
      if (typeof entry.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.day) && entry.day < day) days.add(entry.day);
    }
  }
  const closedRows = [];
  for (const closedDay of [...days].sort()) {
    closedRows.push(...closeDay({ statePaths, day: closedDay, pluginVersion }));
  }
  if (fs.existsSync(statePaths.queue) && readQueueRows(statePaths.queue).length) {
    launchDetachedFlush({ statePaths, configPath, spawnImpl });
  }
  return closedRows;
}

function claimBatch({ statePaths, max, now = Date.now, leaseMs = LEASE_MS }) {
  let claimed = [];
  withLock(`${statePaths.queue}.lock`, () => {
    const rows = readQueueRows(statePaths.queue);
    const timestamp = now();
    const available = rows.filter((row) => !row._permanent && (!row._nextAttemptAt || row._nextAttemptAt <= timestamp));
    if (!available.length) return;
    if (available.some((row) => row._leaseUntil > timestamp)) return;
    const leaseId = `${process.pid}-${timestamp}-${Math.random().toString(36).slice(2)}`;
    const selected = available.slice(0, max);
    const selectedKeys = new Set(selected.map(queueKey));
    for (const row of rows) {
      if (selectedKeys.has(queueKey(row))) { row._leaseId = leaseId; row._leaseUntil = timestamp + leaseMs; }
    }
    writeQueueRows(statePaths.queue, rows);
    claimed = selected.map((row) => ({ ...row, _leaseId: leaseId, _leaseUntil: timestamp + leaseMs }));
  });
  return claimed;
}

export function loadBatch({ statePaths, max = DEFAULT_BATCH_MAX, lease = true, now = Date.now } = {}) {
  if (lease) return claimBatch({ statePaths, max, now });
  return readQueueRows(statePaths.queue).filter((row) => !row._permanent && (!row._nextAttemptAt || row._nextAttemptAt <= now())).slice(0, max).map(publicRow);
}

export function ackBatch({ statePaths, count, leaseId } = {}) {
  withLock(`${statePaths.queue}.lock`, () => {
    const rows = readQueueRows(statePaths.queue);
    if (!leaseId) { writeQueueRows(statePaths.queue, rows.slice(count)); return; }
    const leased = rows.filter((row) => row._leaseId === leaseId).slice(0, count);
    const keys = new Set(leased.map(queueKey));
    writeQueueRows(statePaths.queue, rows.filter((row) => !keys.has(queueKey(row))));
  });
}

export function toOtlpLogs(rows) {
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sando' } }] },
      scopeLogs: [{
        logRecords: rows.map((row) => ({
          ...(typeof row._timeUnixNano === 'string' ? { timeUnixNano: row._timeUnixNano } : {}),
          body: { stringValue: 'sando.daily_aggregate' },
          attributes: Object.entries(publicRow(row)).map(([key, value]) => ({ key, value: { stringValue: String(value) } })),
        })),
      }],
    }],
  };
}

export function previewNextUpload({ statePaths, endpoint = TELEMETRY_ENDPOINT, max = DEFAULT_BATCH_MAX } = {}) {
  const rows = loadBatch({ statePaths, max, lease: false });
  return { url: endpoint, headers: { 'content-type': 'application/json' }, body: toOtlpLogs(rows) };
}

/** Drains eligible batches. Every failure mode is swallowed and reported without
 * changing the outcome of the hook or proxy call that triggered the flush. */
function retryAfterMs(response, now) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : Math.max(0, timestamp - now);
}

function updateClaimedRows({ statePaths, leaseId, update }) {
  withLock(`${statePaths.queue}.lock`, () => {
    const rows = readQueueRows(statePaths.queue);
    for (const row of rows) if (row._leaseId === leaseId) update(row);
    writeQueueRows(statePaths.queue, rows);
  });
}

function isRetryableStatus(status) { return [429, 502, 503, 504].includes(status); }

export async function flushQueue({
  statePaths, endpoint = TELEMETRY_ENDPOINT, max = DEFAULT_BATCH_MAX, timeoutMs = 3000,
  fetchImpl = fetch, now = Date.now, random = Math.random, sleep = async () => {},
} = {}) {
  const result = { sent: 0, rejectedLogRecords: 0 };
  while (true) {
    const rows = claimBatch({ statePaths, max, now });
    if (rows.length === 0) return result;
    const leaseId = rows[0]._leaseId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toOtlpLogs(rows)), signal: controller.signal,
      });
      if (response.ok) {
        let body = {};
        try { body = await response.json(); } catch { /* empty 2xx body */ }
        result.rejectedLogRecords += Number(body?.partialSuccess?.rejectedLogRecords || 0);
        ackBatch({ statePaths, count: rows.length, leaseId });
        result.sent += rows.length;
      } else if (isRetryableStatus(response.status)) {
        updateClaimedRows({ statePaths, leaseId, update: (row) => {
          const attempt = (row._attemptCount ?? 0) + 1;
          const base = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
          row._attemptCount = attempt;
          row._nextAttemptAt = now() + Math.max(base * random(), retryAfterMs(response, now()));
          delete row._leaseId; delete row._leaseUntil;
        }});
        return result;
      } else {
        ackBatch({ statePaths, count: rows.length, leaseId });
      }
    } catch {
      updateClaimedRows({ statePaths, leaseId, update: (row) => {
        const attempt = (row._attemptCount ?? 0) + 1;
        const base = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
        row._attemptCount = attempt;
        row._nextAttemptAt = now() + base * random();
        delete row._leaseId; delete row._leaseUntil;
      }});
      return result;
    } finally {
      clearTimeout(timer);
    }
    await sleep(0);
  }
}

export function disableTelemetry({ configPath = defaultTelemetryConfigPath(), purge = false, statePaths = defaultTelemetryStatePaths() } = {}) {
  const previous = readTelemetryConfig(configPath);
  const result = writeTelemetryConfig(configPath, {
    schema_version: TELEMETRY_CONFIG_VERSION,
    enabled: false,
    prompted_consent_version: previous.prompted_consent_version || CONSENT_VERSION,
    consent_state: 'declined',
  });
  if (purge) {
    for (const target of [statePaths.counters, statePaths.queue]) fs.rmSync(target, { force: true });
  }
  return result;
}
