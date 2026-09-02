import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  F4_EVENT_SCHEMA,
  F4_EVENT_VERSION,
  buildF4Event,
  buildF4TelemetryEvent,
  defaultF4EventsPath,
  digestCapability,
  publishF4Telemetry,
  recordF4Event,
  resultBucket,
} from '../src/f4-telemetry.mjs';
import { SCHEMA_VERSION } from '../src/telemetry.mjs';
import { PLUGIN_VERSION } from '../src/version.mjs';

test('builds a bounded content-free event with a capability digest', () => {
  const event = buildF4Event({
    host: 'claude',
    operation: 'call',
    outcome: 'success',
    latencyMs: 42,
    capability: 'sando-local-readonly/secret_tool',
    at: '2026-08-31T14:00:00.000Z',
  });

  assert.equal(event.schema, F4_EVENT_SCHEMA);
  assert.equal(event.host, 'claude');
  assert.equal(event.operation, 'call');
  assert.equal(event.outcome, 'success');
  assert.equal(event.latency_bucket, '10_to_100ms');
  assert.equal(event.result_bucket, 'unknown');
  assert.equal(event.capability_digest, digestCapability('sando-local-readonly/secret_tool'));
  assert.doesNotMatch(JSON.stringify(event), /secret_tool/);
});

test('appends one private JSONL event and preserves fixed result buckets', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-f4-'));
  const storagePath = path.join(directory, 'nested', 'f4-events.jsonl');
  try {
    const event = recordF4Event({
      storagePath,
      host: 'codex',
      operation: 'catalog',
      outcome: 'success',
      latencyMs: 101,
      resultCount: 3,
    });
    const lines = fs.readFileSync(storagePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), event);
    assert.equal(fs.statSync(path.dirname(storagePath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600);
    assert.equal(resultBucket(0), 'zero');
    assert.equal(resultBucket(1), 'one');
    assert.equal(resultBucket(5), '2_to_5');
    assert.equal(resultBucket(20), '6_to_20');
    assert.equal(resultBucket(21), 'gt_20');
    assert.equal(resultBucket(null), 'unknown');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects invalid event dimensions and resolves a private default path', () => {
  assert.throws(() => buildF4Event({ host: 'other', operation: 'catalog', outcome: 'success', latencyMs: 1 }), /invalid/i);
  assert.throws(() => buildF4Event({ host: 'claude', operation: 'other', outcome: 'success', latencyMs: 1 }), /invalid/i);
  assert.throws(() => buildF4Event({ host: 'claude', operation: 'catalog', outcome: 'success', latencyMs: -1 }), /invalid/i);
  assert.equal(defaultF4EventsPath({ XDG_STATE_HOME: '/tmp/sando-state' }), '/tmp/sando-state/sando/f4-events.jsonl');
});

test('publishes only bounded F4 aggregates to OTLP', async () => {
  const source = buildF4Event({
    host: 'claude',
    operation: 'call',
    outcome: 'success',
    latencyMs: 42,
    resultCount: null,
    capability: 'sando-local-readonly/secret_tool',
    at: '2026-08-31T14:00:00.000Z',
  });
  const telemetry = buildF4TelemetryEvent(source);
  assert.equal(telemetry.schema_version, SCHEMA_VERSION);
  assert.notEqual(telemetry.schema_version, F4_EVENT_VERSION);
  assert.deepEqual(telemetry, {
    schema_version: SCHEMA_VERSION,
    event: 'f4_gateway',
    day_utc: '2026-08-31',
    plugin_version: PLUGIN_VERSION,
    f4_host: 'claude',
    f4_operation: 'call',
    f4_outcome: 'success',
    f4_latency_bucket: '10_to_100ms',
    f4_result_bucket: 'unknown',
  });
  let request;
  const result = await publishF4Telemetry(source, {
    endpoint: 'http://127.0.0.1:4319/v1/logs',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 202 };
    },
  });
  assert.deepEqual(result, { events: 1, status: 202 });
  const payload = JSON.parse(request.options.body);
  const attributes = Object.fromEntries(payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(({ key, value }) => [key, value.stringValue]));
  assert.equal(request.url, 'http://127.0.0.1:4319/v1/logs');
  assert.equal(payload.resourceLogs[0].resource.attributes[0].value.stringValue, 'sando');
  assert.equal(attributes.event, 'f4_gateway');
  assert.equal(attributes.f4_host, 'claude');
  assert.equal(attributes.f4_operation, 'call');
  assert.equal(attributes.f4_latency_bucket, '10_to_100ms');
  assert.equal(Object.hasOwn(attributes, 'f4_capability_digest'), false);
  assert.doesNotMatch(JSON.stringify(payload), /secret_tool/);
});
