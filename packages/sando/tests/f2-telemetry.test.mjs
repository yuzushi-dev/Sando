import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildF2ReviewEvent,
  buildF2TelemetryEvents,
  publishF2Review,
  publishF2Telemetry,
} from '../src/f2-telemetry.mjs';
import { PLUGIN_VERSION } from '../src/version.mjs';

const DIGEST = `sha256:${'d'.repeat(64)}`;

function resultFixture() {
  return {
    schema: 'sando-f2-automation/v1',
    version: 1,
    scannedAt: '2026-08-31T08:00:00.000Z',
    results: [
      {
        root: '/home/cristina/loop-engineering',
        status: 'recorded',
        fingerprint: DIGEST,
        sandoVersion: '0.4.1',
        durationMs: 42,
        summary: {
          files: 3,
          blocks: 8,
          instructionBytes: 1200,
          alwaysOnBlocks: 3,
          alwaysOnBytes: 500,
          onDemandBlocks: 2,
          onDemandBytes: 300,
          duplicateBlocks: 1,
          duplicateBytes: 100,
          unknownBlocks: 2,
          unknownBytes: 300,
          proposalCount: 2,
          proposedBytes: 300,
        },
        delta: { instructionBytes: 100, proposedBytes: 20 },
      },
      {
        root: '/home/cristina/selfhosted/orca',
        status: 'error',
        errorKind: 'missing-root',
        durationMs: 3,
      },
    ],
  };
}

function configFile(t, config) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-f2-telemetry-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'telemetry.json');
  if (config !== undefined) fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

function enabledConfig() {
  return {
    schema_version: 1,
    enabled: true,
    prompted_consent_version: 1,
    consent_state: 'enabled',
    consent_version: 1,
    consented_at: '2026-08-31T09:00:00.000Z',
    endpoint: 'http://127.0.0.1:4318/v1/logs',
  };
}

test('F2 telemetry emits bounded aggregate events without repository paths or content', () => {
  const events = buildF2TelemetryEvents({ result: resultFixture() });
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'f2_snapshot');
  assert.equal(events[0].f2_project, 'loop-engineering');
  assert.equal(events[0].f2_snapshot_id, 'dddddddddddd');
  assert.equal(events[0].f2_proposed_bytes, 300);
  assert.equal(events[1].f2_status, 'error');
  assert.equal(events[1].f2_error_kind, 'missing-root');
  assert.doesNotMatch(JSON.stringify(events), /home\/cristina|secret|prompt|For test workflows/i);
});

test('F2 review event contains only a fixed label and a snapshot id', () => {
  const event = buildF2ReviewEvent({
    root: '/home/cristina/loop-engineering',
    fingerprint: DIGEST,
    label: 'useful',
    reviewedAt: new Date('2026-08-31T09:00:00.000Z'),
  });
  assert.deepEqual(event, {
    schema_version: 2,
    event: 'f2_review',
    day_utc: '2026-08-31',
    plugin_version: PLUGIN_VERSION,
    f2_project: 'loop-engineering',
    f2_snapshot_id: 'dddddddddddd',
    f2_label: 'useful',
  });
});

test('publisher keeps local event generation but skips upload without consent', async (t) => {
  let calls = 0;
  const configPath = configFile(t);
  const result = await publishF2Telemetry({
    result: resultFixture(),
    configPath,
    env: {},
    fetchImpl: async () => { calls += 1; return { ok: true, status: 202 }; },
  });
  assert.deepEqual(result, { events: 0, status: 'disabled' });
  assert.equal(calls, 0);
});

test('publisher honors DO_NOT_TRACK for telemetry and review uploads', async (t) => {
  let calls = 0;
  const configPath = configFile(t, enabledConfig());
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 202 }; };
  const telemetry = await publishF2Telemetry({
    result: resultFixture(), configPath, env: { DO_NOT_TRACK: '1' }, fetchImpl,
  });
  const review = await publishF2Review({
    root: '/home/cristina/loop-engineering', fingerprint: DIGEST, label: 'useful',
    configPath, env: { DO_NOT_TRACK: '1' }, fetchImpl,
  });
  assert.deepEqual(telemetry, { events: 0, status: 'disabled' });
  assert.deepEqual(review, { events: 0, status: 'disabled' });
  assert.equal(calls, 0);
});

test('publisher posts one local OTLP batch after explicit consent', async (t) => {
  let request;
  const result = await publishF2Telemetry({
    result: resultFixture(),
    configPath: configFile(t, enabledConfig()),
    env: {},
    endpoint: 'http://127.0.0.1:4318/v1/logs',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 202 };
    },
  });
  assert.equal(result.events, 2);
  assert.equal(request.url, 'http://127.0.0.1:4318/v1/logs');
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.resourceLogs[0].resource.attributes[0].value.stringValue, 'sando');
  const records = payload.resourceLogs[0].scopeLogs[0].logRecords;
  assert.equal(records.length, 2);
  assert.match(records[0].timeUnixNano, /^\d+$/);
  assert.equal(BigInt(records[1].timeUnixNano), BigInt(records[0].timeUnixNano) + 1n);
});

test('publisher defaults to the local F2 collector instead of the general endpoint', async (t) => {
  let request;
  const result = await publishF2Telemetry({
    result: resultFixture(),
    configPath: configFile(t, { ...enabledConfig(), endpoint: 'https://telemetry.example/v1/logs' }),
    env: {},
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 202 };
    },
  });
  assert.equal(result.events, 2);
  assert.equal(request.url, 'http://127.0.0.1:4319/v1/logs');
});
