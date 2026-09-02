import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureDirectory, withLock } from './provider-usage.mjs';
import { PLUGIN_VERSION } from './version.mjs';
import { SCHEMA_VERSION, serializeEvent, toOtlpLogs } from './telemetry.mjs';

export const F4_EVENT_SCHEMA = 'sando-f4-event/v1';
export const F4_EVENT_VERSION = 1;
export const F4_HOSTS = Object.freeze(['claude', 'codex', 'unknown']);
export const F4_OPERATIONS = Object.freeze(['catalog', 'call']);
export const F4_OUTCOMES = Object.freeze(['success', 'rejected', 'timeout', 'cancelled', 'error']);
export const F4_LATENCY_BUCKETS = Object.freeze(['lt_10ms', '10_to_100ms', '100_to_1000ms', 'gte_1000ms']);
export const F4_RESULT_BUCKETS = Object.freeze(['zero', 'one', '2_to_5', '6_to_20', 'gt_20', 'unknown']);
export const DEFAULT_F4_TELEMETRY_ENDPOINT = 'http://127.0.0.1:4319/v1/logs';

const CAPABILITY_DIGEST = /^sha256:[0-9a-f]{64}$/;

function text(value) { return typeof value === 'string' && value.length > 0; }

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError('F4 event timestamp is invalid');
  return date.toISOString();
}

export function digestCapability(value) {
  if (!text(value) || value.length > 256) throw new TypeError('F4 capability is invalid');
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function latencyBucket(latencyMs) {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) throw new TypeError('F4 latency is invalid');
  if (latencyMs < 10) return 'lt_10ms';
  if (latencyMs < 100) return '10_to_100ms';
  if (latencyMs < 1000) return '100_to_1000ms';
  return 'gte_1000ms';
}

export function resultBucket(resultCount) {
  if (resultCount === null || resultCount === undefined) return 'unknown';
  if (!Number.isSafeInteger(resultCount) || resultCount < 0) throw new TypeError('F4 result count is invalid');
  if (resultCount === 0) return 'zero';
  if (resultCount === 1) return 'one';
  if (resultCount <= 5) return '2_to_5';
  if (resultCount <= 20) return '6_to_20';
  return 'gt_20';
}

export function defaultF4EventsPath(env = process.env) {
  const configured = env.SANDO_F4_EVENTS_PATH;
  if (configured !== undefined) {
    if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw new Error('F4 events path must be absolute');
    return configured;
  }
  const stateHome = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  if (!path.isAbsolute(stateHome)) throw new Error('state directory must be absolute');
  return path.join(stateHome, 'sando', 'f4-events.jsonl');
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || event.schema !== F4_EVENT_SCHEMA || event.version !== F4_EVENT_VERSION
    || typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at))
    || !F4_HOSTS.includes(event.host) || !F4_OPERATIONS.includes(event.operation)
    || !F4_OUTCOMES.includes(event.outcome) || !F4_LATENCY_BUCKETS.includes(event.latency_bucket)
    || !F4_RESULT_BUCKETS.includes(event.result_bucket)
    || (event.capability_digest !== null && !CAPABILITY_DIGEST.test(event.capability_digest))) {
    throw new TypeError('F4 event is invalid');
  }
  const keys = Object.keys(event).sort().join(',');
  if (keys !== 'at,capability_digest,host,latency_bucket,operation,outcome,result_bucket,schema,version') {
    throw new TypeError('F4 event contains unsupported fields');
  }
  return event;
}

export function buildF4Event({
  host = process.env.SANDO_F4_HOST || 'unknown',
  operation,
  outcome,
  latencyMs,
  resultCount = null,
  capability,
  capabilityDigest = null,
  at,
} = {}) {
  const normalizedCapability = capabilityDigest === null || capabilityDigest === undefined
    ? (capability === undefined || capability === null ? null : digestCapability(capability))
    : capabilityDigest;
  if (normalizedCapability !== null && !CAPABILITY_DIGEST.test(normalizedCapability)) throw new TypeError('F4 capability digest is invalid');
  const event = {
    schema: F4_EVENT_SCHEMA,
    version: F4_EVENT_VERSION,
    at: timestamp(at),
    host,
    operation,
    outcome,
    latency_bucket: latencyBucket(latencyMs),
    result_bucket: resultBucket(resultCount),
    capability_digest: normalizedCapability,
  };
  return validateEvent(event);
}

export function serializeF4Event(event) {
  const value = validateEvent(event);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 1024) throw new Error('F4 event exceeds serialized size limit');
  return serialized;
}

export function buildF4TelemetryEvent(event, pluginVersion = PLUGIN_VERSION) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || event.schema !== F4_EVENT_SCHEMA || event.version !== F4_EVENT_VERSION
    || typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at))
    || !F4_HOSTS.includes(event.host) || !F4_OPERATIONS.includes(event.operation)
    || !F4_OUTCOMES.includes(event.outcome) || !F4_LATENCY_BUCKETS.includes(event.latency_bucket)
    || !F4_RESULT_BUCKETS.includes(event.result_bucket)) {
    throw new TypeError('F4 event is invalid');
  }
  const telemetryEvent = {
    schema_version: SCHEMA_VERSION,
    event: 'f4_gateway',
    day_utc: new Date(event.at).toISOString().slice(0, 10),
    plugin_version: pluginVersion,
    f4_host: event.host,
    f4_operation: event.operation,
    f4_outcome: event.outcome,
    f4_latency_bucket: event.latency_bucket,
    f4_result_bucket: event.result_bucket,
  };
  serializeEvent(telemetryEvent);
  return telemetryEvent;
}

export async function publishF4Telemetry(event, {
  endpoint = DEFAULT_F4_TELEMETRY_ENDPOINT,
  fetchImpl = fetch,
  timeoutMs = 2_500,
} = {}) {
  const telemetryEvent = buildF4TelemetryEvent(event);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toOtlpLogs([telemetryEvent])),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`F4 telemetry endpoint returned ${response.status}`);
    return { events: 1, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

function resolvePath(storagePath) {
  if (typeof storagePath !== 'string' || !path.isAbsolute(storagePath)) throw new Error('F4 events path must be absolute');
  return storagePath;
}

function assertRegularFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('F4 events file is unsafe');
}

export function recordF4Event({ storagePath, env = process.env, ...options } = {}) {
  const event = buildF4Event(options);
  const filePath = resolvePath(storagePath ?? defaultF4EventsPath(env));
  ensureDirectory(path.dirname(filePath));
  assertRegularFile(filePath);
  withLock(`${filePath}.lock`, () => {
    assertRegularFile(filePath);
    fs.appendFileSync(filePath, `${serializeF4Event(event)}\n`, { flag: 'a', mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  });
  return event;
}
