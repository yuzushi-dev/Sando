import crypto from 'node:crypto';
import path from 'node:path';

import { PLUGIN_VERSION } from './version.mjs';
import {
  SCHEMA_VERSION, defaultTelemetryConfigPath, isDoNotTrack, readTelemetryConfig, serializeEvent, toOtlpLogs,
} from './telemetry.mjs';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4319/v1/logs';
const SUMMARY_FIELDS = Object.freeze([
  'files', 'blocks', 'instructionBytes', 'alwaysOnBlocks', 'alwaysOnBytes',
  'onDemandBlocks', 'onDemandBytes', 'duplicateBlocks', 'duplicateBytes',
  'unknownBlocks', 'unknownBytes', 'proposalCount', 'proposedBytes',
]);

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function day(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('F2 telemetry timestamp is invalid');
  return date.toISOString().slice(0, 10);
}

function project(root) {
  const name = path.basename(root);
  return /^[A-Za-z0-9_.-]{1,32}$/.test(name)
    ? name
    : `project-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 10)}`;
}

function snapshotId(fingerprint) {
  return typeof fingerprint === 'string' && /^sha256:[0-9a-f]{64}$/.test(fingerprint)
    ? fingerprint.slice(7, 19)
    : '000000000000';
}

function summaryOf(value = {}) {
  return Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, counter(value[field])]));
}

function eventBase({ event, scannedAt, pluginVersion }) {
  return { schema_version: SCHEMA_VERSION, event, day_utc: day(scannedAt), plugin_version: pluginVersion || PLUGIN_VERSION };
}

export function buildF2TelemetryEvents({ result } = {}) {
  if (!result || !Array.isArray(result.results)) throw new Error('F2 telemetry result is invalid');
  return result.results.map((item) => {
    const summary = summaryOf(item.summary);
    const event = {
      ...eventBase({ event: 'f2_snapshot', scannedAt: result.scannedAt, pluginVersion: item.sandoVersion }),
      f2_project: project(item.root),
      f2_snapshot_id: snapshotId(item.fingerprint),
      f2_status: item.status,
      f2_duration_ms: counter(item.durationMs),
      f2_error_kind: item.errorKind || 'none',
      f2_delta_instruction_bytes: Number.isSafeInteger(item.delta?.instructionBytes) ? item.delta.instructionBytes : 0,
      f2_delta_proposed_bytes: Number.isSafeInteger(item.delta?.proposedBytes) ? item.delta.proposedBytes : 0,
    };
    for (const [field, value] of Object.entries(summary)) event[`f2_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`] = value;
    serializeEvent(event);
    return event;
  });
}

export function buildF2ReviewEvent({ root, fingerprint, label, reviewedAt = new Date(), pluginVersion = PLUGIN_VERSION } = {}) {
  const event = {
    ...eventBase({ event: 'f2_review', scannedAt: reviewedAt, pluginVersion }),
    f2_project: project(root),
    f2_snapshot_id: snapshotId(fingerprint),
    f2_label: label,
  };
  serializeEvent(event);
  return event;
}

async function publishEvents(events, {
  endpoint,
  fetchImpl = fetch,
  timeoutMs = 2500,
  env = process.env,
  configPath,
} = {}) {
  if (!events.length) return { events: 0, status: 'empty' };
  const config = readTelemetryConfig(configPath ?? defaultTelemetryConfigPath(env));
  if (!config.enabled || isDoNotTrack(env)) return { events: 0, status: 'disabled' };
  // F2 is a local Grafana aggregate. The general consent endpoint is for the
  // daily queue and does not admit feature-local event shapes.
  const destination = endpoint ?? env.SANDO_F2_TELEMETRY_ENDPOINT ?? DEFAULT_ENDPOINT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const firstTimestamp = BigInt(Date.now()) * 1000000n;
  const timedEvents = events.map((event, index) => ({
    ...event,
    _timeUnixNano: (firstTimestamp + BigInt(index)).toString(),
  }));
  try {
    const response = await fetchImpl(destination, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toOtlpLogs(timedEvents)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`F2 telemetry endpoint returned ${response.status}`);
    return { events: events.length, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

export function publishF2Telemetry(options) {
  return publishEvents(buildF2TelemetryEvents(options), options);
}

export function publishF2Review(options) {
  return publishEvents([buildF2ReviewEvent(options)], options);
}
