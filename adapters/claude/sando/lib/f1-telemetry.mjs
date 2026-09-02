import { PLUGIN_VERSION } from './version.mjs';
import { SCHEMA_VERSION, byteBucket, countBucket, serializeEvent, toOtlpLogs } from './telemetry.mjs';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4319/v1/logs';
const HOSTS = ['claude', 'codex'];
const STATUSES = ['complete', 'partial', 'unavailable'];
const RATIO_BUCKETS = ['zero', 'lt_1pct', '1_to_10pct', 'gt_10pct', 'unavailable'];

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function optionalCounter(value, name) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`);
  return value;
}

function optionalBytes(value) { return optionalCounter(value, 'F1 body bytes'); }

function ratioBucket(value) {
  if (value === null || value === undefined) return 'unavailable';
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('F1 unknown ratio is invalid');
  }
  if (value === 0) return 'zero';
  if (value <= 0.01) return 'lt_1pct';
  if (value <= 0.1) return '1_to_10pct';
  return 'gt_10pct';
}

function bucket(value, build, name) {
  if (value === null || value === undefined) return 'unavailable';
  try { return build(value); } catch { throw new TypeError(`${name} is invalid`); }
}

export function buildF1TelemetryEvent(record) {
  if (!object(record) || !HOSTS.includes(record.host) || typeof record.at !== 'string') {
    throw new TypeError('F1 capture record is invalid');
  }
  const at = new Date(record.at);
  if (Number.isNaN(at.getTime()) || !object(record.report) || !object(record.report.attribution)) {
    throw new TypeError('F1 capture report is invalid');
  }
  const status = record.report.attribution.status;
  if (!STATUSES.includes(status)) throw new TypeError('F1 attribution status is invalid');
  const bodyBytes = optionalBytes(record.report.attribution.bodyBytes);
  const providerReported = record.report.tokenAccounting?.providerReported;
  const inputTokens = optionalCounter(providerReported?.inputTokens, 'F1 provider input tokens');
  const event = {
    schema_version: SCHEMA_VERSION,
    event: 'f1_footprint',
    day_utc: at.toISOString().slice(0, 10),
    plugin_version: PLUGIN_VERSION,
    f1_host: record.host,
    f1_status: status,
    f1_unknown_ratio_bucket: ratioBucket(record.report.attribution.unknownRatio),
    f1_body_size_bucket: bucket(bodyBytes, byteBucket, 'F1 body bytes'),
    f1_input_tokens_bucket: bucket(inputTokens, countBucket, 'F1 provider input tokens'),
  };
  serializeEvent(event);
  return event;
}

export async function publishF1Telemetry({ record, endpoint = process.env.SANDO_F1_TELEMETRY_ENDPOINT || DEFAULT_ENDPOINT,
  fetchImpl = fetch, timeoutMs = 2500 } = {}) {
  const event = buildF1TelemetryEvent(record);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toOtlpLogs([{ ...event, _timeUnixNano: (BigInt(Date.now()) * 1000000n).toString() }])),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`F1 telemetry endpoint returned ${response.status}`);
    return { events: 1, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}
