import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { atomicWrite, ensureDirectory, withLock } from './provider-usage.mjs';

const SCHEMA_VERSION = 1;
const MAX_STRING_LENGTH = 32;
const MAX_EVENT_BYTES = 2048;

const COUNT_BUCKETS = ['zero', 'one', '2_to_5', '6_to_20', 'gt_20'];
const BYTE_BUCKETS = ['lt_4k', '4_to_16k', '16_to_64k', 'gte_64k'];
const HOSTS = ['claude', 'codex'];
const MODES = ['enforce', 'observe'];
const YES_NO_UNKNOWN = ['yes', 'no', 'unknown'];

const SHARED_FIELDS = {
  schema_version: (value) => value === SCHEMA_VERSION,
  event: (value) => value === 'hook_summary' || value === 'proxy_summary',
  day_utc: (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
  plugin_version: (value) => typeof value === 'string' && /^\d+\.\d+$/.test(value) && value.length <= MAX_STRING_LENGTH,
  host: (value) => HOSTS.includes(value),
};

const HOOK_FIELDS = {
  mode: (value) => MODES.includes(value),
  tool_calls_bucket: (value) => COUNT_BUCKETS.includes(value),
  redactions_bucket: (value) => COUNT_BUCKETS.includes(value),
  capped_outputs_bucket: (value) => COUNT_BUCKETS.includes(value),
  bytes_saved_bucket: (value) => BYTE_BUCKETS.includes(value),
};

const PROXY_FIELDS = {
  rewrites_applied_bucket: (value) => COUNT_BUCKETS.includes(value),
  rewrites_skipped_cache_bucket: (value) => COUNT_BUCKETS.includes(value),
  input_tokens_saved_bucket: (value) => BYTE_BUCKETS.includes(value),
  prompt_cache_hit: (value) => YES_NO_UNKNOWN.includes(value),
};

function fieldsForEvent(eventType) {
  return eventType === 'hook_summary' ? HOOK_FIELDS : PROXY_FIELDS;
}

export function countBucket(count) {
  if (!Number.isInteger(count) || count < 0) throw new Error('countBucket: invalid count');
  if (count === 0) return 'zero';
  if (count === 1) return 'one';
  if (count <= 5) return '2_to_5';
  if (count <= 20) return '6_to_20';
  return 'gt_20';
}

export function byteBucket(bytes) {
  if (!Number.isInteger(bytes) || bytes < 0) throw new Error('byteBucket: invalid byte count');
  if (bytes < 4096) return 'lt_4k';
  if (bytes < 16384) return '4_to_16k';
  if (bytes < 65536) return '16_to_64k';
  return 'gte_64k';
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
const CONSENT_VERSION = 1;
export const TELEMETRY_ENDPOINT = 'https://telemetry.yuzushi.example/v1/logs';

export const TELEMETRY_DISCLOSURE = [
  'Sando can send anonymous daily aggregate counts to a shared telemetry backend:',
  '  - hook: tool-call, redaction, capped-output counts, and bytes saved, per host/mode',
  '  - proxy: rewrite-applied/skipped counts, estimated input tokens saved, prompt-cache hit',
  'All values are bucketed (e.g. "2_to_5", "16_to_64k") — never a raw count, byte value, path,',
  'transcript, tool output, session ID, or any other identifier.',
  `Endpoint: ${TELEMETRY_ENDPOINT}`,
  'Retention: 13 months, aggregate rows only.',
  'This is an opt-in sample, not a population measurement — enabled users may not be representative.',
].join('\n');

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function emptyTelemetryConfig() {
  return { schema_version: TELEMETRY_CONFIG_VERSION, enabled: false, prompted_consent_version: 0 };
}

function validateTelemetryConfig(value) {
  if (!record(value) || value.schema_version !== TELEMETRY_CONFIG_VERSION || typeof value.enabled !== 'boolean'
    || !Number.isInteger(value.prompted_consent_version) || value.prompted_consent_version < 0) {
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
  return validateTelemetryConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
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

/** Only an explicit `yes` in an interactive session enables collection; anything else
 *  (blank, `no`, EOF, or a non-interactive caller) writes the disabled prompt marker so
 *  upgrades and reinstalls never re-prompt or silently opt a user in. */
export function enableTelemetry({ configPath = defaultTelemetryConfigPath(), answer, interactive = true, now = () => new Date() } = {}) {
  if (!interactive || typeof answer !== 'string' || answer.trim().toLowerCase() !== 'yes') {
    return writeTelemetryConfig(configPath, { schema_version: TELEMETRY_CONFIG_VERSION, enabled: false, prompted_consent_version: CONSENT_VERSION });
  }
  return writeTelemetryConfig(configPath, {
    schema_version: TELEMETRY_CONFIG_VERSION,
    enabled: true,
    prompted_consent_version: CONSENT_VERSION,
    consent_version: CONSENT_VERSION,
    consented_at: now().toISOString(),
    endpoint: TELEMETRY_ENDPOINT,
  });
}

export function disableTelemetry({ configPath = defaultTelemetryConfigPath(), purge = false, statePaths = defaultTelemetryStatePaths() } = {}) {
  const previous = readTelemetryConfig(configPath);
  const result = writeTelemetryConfig(configPath, {
    schema_version: TELEMETRY_CONFIG_VERSION,
    enabled: false,
    prompted_consent_version: previous.prompted_consent_version || CONSENT_VERSION,
  });
  if (purge) {
    for (const target of [statePaths.counters, statePaths.queue]) fs.rmSync(target, { force: true });
  }
  return result;
}
