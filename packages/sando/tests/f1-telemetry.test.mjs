import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildF1TelemetryEvent,
  publishF1Telemetry,
} from '../src/f1-telemetry.mjs';
import { PLUGIN_VERSION } from '../src/version.mjs';

const DIGEST = `sha256:${'d'.repeat(64)}`;

function record(overrides = {}) {
  return {
    schema: 'sando-context-capture-record/v1',
    version: 1,
    at: '2026-08-31T14:00:00.000Z',
    host: 'codex',
    provider: 'openai-responses',
    requestFormat: 'openai-responses',
    model: 'gpt-secret-model',
    sessionKeyDigest: DIGEST,
    report: {
      schema: 'sando-context-footprint/v1',
      attribution: { status: 'partial', bodyBytes: 42_722, unknownRatio: 0.0056 },
      tokenAccounting: {
        estimated: { totalTokens: 10_681 },
        providerReported: { inputTokens: 20_321 },
      },
    },
    ...overrides,
  };
}

test('F1 telemetry emits only bounded coverage buckets', () => {
  assert.deepEqual(buildF1TelemetryEvent(record()), {
    schema_version: 2,
    event: 'f1_footprint',
    day_utc: '2026-08-31',
    plugin_version: PLUGIN_VERSION,
    f1_host: 'codex',
    f1_status: 'partial',
    f1_unknown_ratio_bucket: 'lt_1pct',
    f1_body_size_bucket: '16_to_64k',
    f1_input_tokens_bucket: 'gt_100',
  });
  assert.doesNotMatch(JSON.stringify(buildF1TelemetryEvent(record())), /secret|sha256|model|prompt|home\//i);
});

test('F1 telemetry marks unavailable evidence without inventing measurements', () => {
  const event = buildF1TelemetryEvent(record({
    host: 'claude',
    provider: 'anthropic',
    requestFormat: 'anthropic',
    report: {
      schema: 'sando-context-footprint/v1',
      attribution: { status: 'unavailable', bodyBytes: null, unknownRatio: null },
      tokenAccounting: { estimated: { totalTokens: null }, providerReported: null },
    },
  }));
  assert.equal(event.f1_host, 'claude');
  assert.equal(event.f1_status, 'unavailable');
  assert.equal(event.f1_unknown_ratio_bucket, 'unavailable');
  assert.equal(event.f1_body_size_bucket, 'unavailable');
  assert.equal(event.f1_input_tokens_bucket, 'unavailable');
});

test('F1 publisher posts one bounded OTLP record', async () => {
  let request;
  const result = await publishF1Telemetry({
    record: record(),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 202 };
    },
  });
  assert.deepEqual(result, { events: 1, status: 202 });
  const payload = JSON.parse(request.options.body);
  const log = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
  const attributes = Object.fromEntries(log.attributes.map(({ key, value }) => [key, value.stringValue]));
  assert.equal(request.url, 'http://127.0.0.1:4319/v1/logs');
  assert.match(log.timeUnixNano, /^\d+$/);
  assert.equal(attributes.event, 'f1_footprint');
  assert.equal(attributes.f1_unknown_ratio_bucket, 'lt_1pct');
  assert.doesNotMatch(JSON.stringify(payload), /secret|sha256|prompt|home\//i);
});
