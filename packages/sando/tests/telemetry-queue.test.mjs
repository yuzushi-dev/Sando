import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ackBatch, appendQueueRows, closeDay, closeFinishedDays, flushQueue, incrementCounter, loadBatch, previewNextUpload, recordActiveDay, recordFailure, toOtlpLogs,
} from '../src/telemetry.mjs';
import { runTelemetryFlushEntry } from '../src/telemetry-flush-entry.mjs';
import { runSessionStart } from '../src/session-start.mjs';
import { PLUGIN_VERSION } from '../src/version.mjs';

function tempStatePaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-telemetry-queue-'));
  return { counters: path.join(dir, 'telemetry-counters.json'), queue: path.join(dir, 'telemetry-queue.jsonl') };
}

test('incrementCounter accumulates raw counts per day/host/mode and closeDay buckets them', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1, redactions: 1 } });
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1, cappedOutputs: 1, bytesSaved: 5000 } });
  const closed = closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0], {
    schema_version: 2, event: 'hook_summary', day_utc: '2026-08-25', plugin_version: PLUGIN_VERSION,
    host: 'claude', mode: 'enforce',
    tool_calls_bucket: '2_to_5', capped_outputs_bucket: 'one', bytes_saved_bucket: '4_to_16k', input_tokens_saved_bucket: 'lt_4k',
  });
});

test('closeDay removes the closed day from raw counters so it is not double-counted', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  const again = closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  assert.deepEqual(again, []);
});

test('closeDay keeps counters when queue persistence fails', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  fs.mkdirSync(statePaths.queue, { recursive: true });
  assert.throws(() => closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' }));
  assert.equal(JSON.parse(fs.readFileSync(statePaths.counters, 'utf8')).counters['2026-08-25|hook_summary|claude|enforce'].toolCalls, 1);
});

test('closeFinishedDays closes old counters and launches a detached flush with only network env', () => {
  const statePaths = tempStatePaths();
  const configPath = path.join(path.dirname(statePaths.counters), 'telemetry.json');
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  let invocation;
  const child = { unref() { invocation.unref = true; } };

  const closed = closeFinishedDays({
    statePaths, configPath, day: '2026-08-26', pluginVersion: '0.1',
    spawnImpl(...args) { invocation = { args }; return child; },
  });

  assert.equal(closed.length, 1);
  assert.equal(invocation.args[0], process.execPath);
  assert.match(invocation.args[1][0], /telemetry-flush-entry\.mjs$/);
  assert.deepEqual(invocation.args[1].slice(1), ['--queue', statePaths.queue, '--config', configPath]);
  assert.deepEqual(invocation.args[2].env, Object.fromEntries(
    ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']
      .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  ));
  assert.equal(invocation.args[2].detached, true);
  assert.deepEqual(invocation.args[2].stdio, 'ignore');
  assert.equal(invocation.unref, true);
  assert.equal(loadBatch({ statePaths, lease: false }).length, 1);
});

test('closeDay buckets proxy_summary with provider and mode', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'proxy_summary', provider: 'openai', mode: 'enforce', deltas: { rewritesApplied: 3, rewritesSkippedCache: 1, inputTokensSaved: 20000 } });
  const closed = closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  assert.deepEqual(closed[0], {
    schema_version: 2, event: 'proxy_summary', day_utc: '2026-08-25', plugin_version: PLUGIN_VERSION, provider: 'openai', mode: 'enforce',
    rewrites_applied_bucket: '2_to_5', rewrites_skipped_cache_bucket: 'one',
    input_tokens_saved_bucket: '16_to_64k',
  });
});

test('closeDay emits one failure row per host and failure stage without a raw count', () => {
  const statePaths = tempStatePaths();
  recordFailure({ statePaths, day: '2026-08-25', event: 'hook_failure_summary', host: 'claude', failureStage: 'optimization' });
  recordFailure({ statePaths, day: '2026-08-25', event: 'hook_failure_summary', host: 'claude', failureStage: 'optimization' });
  recordFailure({ statePaths, day: '2026-08-25', event: 'hook_failure_summary', host: 'claude', failureStage: 'input' });
  const closed = closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  assert.deepEqual(closed, [
    { schema_version: 2, event: 'hook_failure_summary', day_utc: '2026-08-25', plugin_version: PLUGIN_VERSION, host: 'claude', failure_stage: 'optimization' },
    { schema_version: 2, event: 'hook_failure_summary', day_utc: '2026-08-25', plugin_version: PLUGIN_VERSION, host: 'claude', failure_stage: 'input' },
  ]);
});

test('the queue file is created with mode 0600', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  const mode = fs.statSync(statePaths.queue).mode & 0o777;
  assert.equal(mode, 0o600);
});

function dayUtc(offset) {
  return new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
}

test('the queue keeps 4096 rows, evicting the oldest first', () => {
  const statePaths = tempStatePaths();
  const seedRows = [];
  for (let day = 0; day < 4099; day += 1) seedRows.push({
    schema_version: 2, event: 'active_day', day_utc: dayUtc(day), plugin_version: PLUGIN_VERSION, host: 'claude',
  });
  fs.mkdirSync(path.dirname(statePaths.queue), { recursive: true });
  fs.writeFileSync(statePaths.queue, `${seedRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  incrementCounter({ statePaths, day: dayUtc(4099), event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: dayUtc(4099), pluginVersion: '0.5' });
  const rows = loadBatch({ statePaths, max: 10000, lease: false });
  assert.equal(rows.length, 4096);
  assert.equal(rows[0].day_utc, dayUtc(4));
  assert.equal(rows[rows.length - 1].day_utc, dayUtc(4099));
});

test('closeFinishedDays flushes an existing queue even without closing a new day', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  let launches = 0;
  closeFinishedDays({ statePaths, configPath: '/tmp/config', day: '2026-08-25', pluginVersion: '0.5', spawnImpl: () => { launches += 1; return { unref() {} }; } });
  assert.equal(launches, 1);
});

test('session start launches a detached flush for a residual queue', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  const configPath = path.join(path.dirname(statePaths.counters), 'telemetry.json');
  fs.writeFileSync(configPath, JSON.stringify({ schema_version: 1, enabled: true, prompted_consent_version: 1, consent_version: 1, consented_at: '2026-08-25T00:00:00.000Z', endpoint: 'http://127.0.0.1:1' }));
  let launches = 0;
  runSessionStart({ configPath, statePaths, stdout: { write() {} }, spawnImpl: () => { launches += 1; return { unref() {} }; } });
  assert.equal(launches, 1);
});

test('recordActiveDay queues one marker per UTC day and host', () => {
  const statePaths = tempStatePaths();
  recordActiveDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5', host: 'claude' });
  recordActiveDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5', host: 'claude' });
  const rows = loadBatch({ statePaths, max: 100, lease: false });
  assert.equal(rows.length, 1);
  assert.deepEqual(toOtlpLogs(rows).resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map((a) => a.key).sort(), ['day_utc', 'event', 'host', 'plugin_version', 'schema_version']);
  assert.equal(rows[0].event, 'active_day');
});

test('recordActiveDay stays idempotent after the queue is flushed', () => {
  const statePaths = tempStatePaths();
  const marker = { statePaths, day: '2026-08-28', pluginVersion: '0.1', host: 'claude' };
  recordActiveDay(marker);
  recordActiveDay(marker);
  recordActiveDay(marker);
  assert.equal(loadBatch({ statePaths, lease: false }).length, 1);

  fs.writeFileSync(statePaths.queue, '');
  recordActiveDay(marker);
  assert.equal(loadBatch({ statePaths, lease: false }).length, 0);
});

test('recordActiveDay queues a marker for a different day after a flush', () => {
  const statePaths = tempStatePaths();
  const marker = { statePaths, day: '2026-08-28', pluginVersion: '0.1', host: 'claude' };
  recordActiveDay(marker);
  fs.writeFileSync(statePaths.queue, '');

  recordActiveDay({ ...marker, day: '2026-08-29' });
  const rows = loadBatch({ statePaths, lease: false });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day_utc, '2026-08-29');
});

test('loadBatch leases a batch so a second flush cannot claim it', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  const first = loadBatch({ statePaths, lease: true });
  const second = loadBatch({ statePaths, lease: true });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  ackBatch({ statePaths, count: 1, leaseId: first[0]._leaseId });
  assert.equal(loadBatch({ statePaths, lease: false }).length, 0);
});

test('flushQueue persists retry backoff for retryable HTTP failures and honors Retry-After', async () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  const result = await flushQueue({
    statePaths, fetchImpl: async () => new Response('', { status: 503, headers: { 'retry-after': '120' } }),
    now: () => 1_000_000, random: () => 0, sleep: async () => {},
  });
  assert.equal(result.sent, 0);
  const queued = JSON.parse(fs.readFileSync(statePaths.queue, 'utf8').trim().split('\n')[0]);
  assert.equal(queued._attemptCount, 1);
  assert.equal(queued._nextAttemptAt, 1_120_000);
});

test('flushQueue removes permanent failures without retrying and reports rejected records on 2xx', async () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  const permanent = await flushQueue({ statePaths, fetchImpl: async () => new Response('', { status: 400 }), sleep: async () => {} });
  assert.equal(permanent.sent, 0);
  assert.equal(loadBatch({ statePaths, lease: false }).length, 0);

  incrementCounter({ statePaths, day: '2026-08-26', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-26', pluginVersion: '0.5' });
  const accepted = await flushQueue({ statePaths, fetchImpl: async () => new Response(JSON.stringify({ partialSuccess: { rejectedLogRecords: 1 } }), { status: 200 }), sleep: async () => {} });
  assert.equal(accepted.sent, 1);
  assert.equal(accepted.rejectedLogRecords, 1);
});

test('loadBatch reads at most 32 rows by default', () => {
  const statePaths = tempStatePaths();
  for (let day = 0; day < 40; day += 1) {
    incrementCounter({ statePaths, day: dayUtc(day), event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
    closeDay({ statePaths, day: dayUtc(day), pluginVersion: '0.5' });
  }
  const rows = loadBatch({ statePaths, lease: false });
  assert.equal(rows.length, 32);
});

test('toOtlpLogs maps rows to an OTLP/HTTP JSON body with service.name=sando', () => {
  const rows = [{ schema_version: 2, event: 'hook_summary', day_utc: '2026-08-25', plugin_version: PLUGIN_VERSION, host: 'claude', mode: 'enforce', tool_calls_bucket: 'one', redactions_bucket: 'zero', capped_outputs_bucket: 'zero', bytes_saved_bucket: 'lt_4k' }];
  const body = toOtlpLogs(rows);
  const resourceAttrs = body.resourceLogs[0].resource.attributes;
  assert.deepEqual(resourceAttrs, [{ key: 'service.name', value: { stringValue: 'sando' } }]);
  const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(record.body.stringValue, 'sando.daily_aggregate');
  assert.ok(record.attributes.some((a) => a.key === 'day_utc' && a.value.stringValue === '2026-08-25'));
  assert.equal(record.attributes.some((a) => ['redactions_bucket', 'prompt_cache_hit'].includes(a.key)), false);
});

test('ackBatch removes only the acknowledged rows and keeps the rest', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  incrementCounter({ statePaths, day: '2026-08-26', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-26', pluginVersion: '0.5' });
  const rows = loadBatch({ statePaths, lease: false });
  ackBatch({ statePaths, count: 1 });
  const remaining = loadBatch({ statePaths, lease: false });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].day_utc, rows[1].day_utc);
});

test('previewNextUpload renders the exact next OTLP body and header names without sending it', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  const preview = previewNextUpload({ statePaths, endpoint: 'https://telemetry.example/v1/logs' });
  assert.deepEqual(Object.keys(preview.headers).sort(), ['content-type']);
  assert.equal(preview.headers['content-type'], 'application/json');
  assert.deepEqual(preview.body, toOtlpLogs(loadBatch({ statePaths, lease: false })));
  assert.equal(preview.url, 'https://telemetry.example/v1/logs');
});

test('flushQueue posts the batch over HTTPS-shaped fetch and acks on success, leaving the queue intact on failure', async () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });

  let received = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await flushQueue({ statePaths, endpoint: `http://127.0.0.1:${port}/v1/logs`, timeoutMs: 3000 });
    assert.equal(result.sent, 1);
    assert.ok(received);
    assert.equal(loadBatch({ statePaths, lease: false }).length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('flushQueue preserves and drains legacy v1 queue rows during the v2 rollout', async () => {
  const statePaths = tempStatePaths();
  const legacy = {
    schema_version: 1, event: 'hook_summary', day_utc: '2026-08-25', plugin_version: PLUGIN_VERSION,
    host: 'claude', mode: 'enforce', tool_calls_bucket: 'gt_20', capped_outputs_bucket: 'zero',
    bytes_saved_bucket: 'gte_64k', input_tokens_saved_bucket: 'gte_64k',
  };
  fs.mkdirSync(path.dirname(statePaths.queue), { recursive: true });
  fs.writeFileSync(statePaths.queue, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  assert.deepEqual(loadBatch({ statePaths, lease: false }), [legacy]);

  let sent;
  const result = await flushQueue({
    statePaths,
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response('', { status: 200 });
    },
  });
  const attributes = sent.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
  assert.equal(attributes.find(({ key }) => key === 'schema_version').value.stringValue, '1');
  assert.equal(result.sent, 1);
  assert.equal(loadBatch({ statePaths, lease: false }).length, 0);
});

test('flushQueue leaves the queue intact when the upload fails', async () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  const result = await flushQueue({ statePaths, endpoint: 'http://127.0.0.1:1/v1/logs', timeoutMs: 500 });
  assert.equal(result.sent, 0);
  assert.equal(fs.readFileSync(statePaths.queue, 'utf8').trim().length > 0, true);
});

test('flushQueue does nothing and never throws on an empty queue', async () => {
  const statePaths = tempStatePaths();
  const result = await flushQueue({ statePaths, endpoint: 'http://127.0.0.1:1/v1/logs' });
  assert.equal(result.sent, 0);
});

test('the detached flush entrypoint requires --queue and --config and never reads process.env for them', () => {
  const entryPath = fileURLToPath(new URL('../src/telemetry-flush-entry.mjs', import.meta.url));
  assert.throws(
    () => execFileSync(process.execPath, [entryPath], { env: { PATH: process.env.PATH } }),
    /requires --queue and --config/,
  );
});

test('the detached flush entrypoint is a no-op when telemetry is disabled, with an empty inherited environment', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  const configPath = path.join(path.dirname(statePaths.counters), 'telemetry.json');
  fs.writeFileSync(configPath, JSON.stringify({ schema_version: 1, enabled: false, prompted_consent_version: 1 }));

  const entryPath = fileURLToPath(new URL('../src/telemetry-flush-entry.mjs', import.meta.url));
  // Fully empty environment — no PATH, no HOME, no provider credentials. Only argv is read.
  execFileSync(process.execPath, [entryPath, '--queue', statePaths.queue, '--config', configPath], { env: {} });
  assert.equal(loadBatch({ statePaths, lease: false }).length, 1, 'disabled telemetry must not touch the queue');
});

test('the detached flush entrypoint flushes the queue in-process when telemetry is enabled', async () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  const configPath = path.join(path.dirname(statePaths.counters), 'telemetry.json');

  const server = http.createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => response.writeHead(200).end());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  fs.writeFileSync(configPath, JSON.stringify({
    schema_version: 1, enabled: true, prompted_consent_version: 1, consent_version: 1,
    consented_at: '2026-08-25T00:00:00.000Z', endpoint: `http://127.0.0.1:${port}/v1/logs`,
  }));
  try {
    const result = await runTelemetryFlushEntry({ argv: ['--queue', statePaths.queue, '--config', configPath] });
    assert.equal(result.sent, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(loadBatch({ statePaths, lease: false }).length, 0);
});

test('local-only F1/F2/F4 events can never enter the public upload queue', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-local-only-'));
  const queuePath = path.join(directory, 'telemetry-queue.jsonl');
  for (const event of ['f1_footprint', 'f2_snapshot', 'f2_review', 'f4_gateway']) {
    assert.throws(
      () => appendQueueRows(queuePath, [{ schema_version: 2, event, day_utc: '2026-08-25', plugin_version: PLUGIN_VERSION }]),
      /local-only event must never reach the upload queue/,
    );
  }
  assert.equal(fs.existsSync(queuePath), false);
});

test('the queue rejects unsupported event schema versions before persistence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-unsupported-schema-'));
  const queuePath = path.join(directory, 'telemetry-queue.jsonl');
  assert.throws(
    () => appendQueueRows(queuePath, [{ schema_version: 99, event: 'active_day' }]),
    /telemetry queue event schema is unsupported/,
  );
  assert.equal(fs.existsSync(queuePath), false);
});
