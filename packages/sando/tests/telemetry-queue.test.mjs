import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ackBatch, closeDay, closeFinishedDays, flushQueue, incrementCounter, loadBatch, previewNextUpload, toOtlpLogs,
} from '../src/telemetry.mjs';
import { runTelemetryFlushEntry } from '../src/telemetry-flush-entry.mjs';

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
    schema_version: 1, event: 'hook_summary', day_utc: '2026-08-25', plugin_version: '0.5',
    host: 'claude', mode: 'enforce',
    tool_calls_bucket: '2_to_5', redactions_bucket: 'one', capped_outputs_bucket: 'one', bytes_saved_bucket: '4_to_16k',
  });
});

test('closeDay removes the closed day from raw counters so it is not double-counted', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  const again = closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  assert.deepEqual(again, []);
});

test('closeFinishedDays closes old counters and launches a detached flush without provider env', () => {
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
  assert.deepEqual(invocation.args[2].env, {});
  assert.equal(invocation.args[2].detached, true);
  assert.deepEqual(invocation.args[2].stdio, 'ignore');
  assert.equal(invocation.unref, true);
  assert.equal(loadBatch({ statePaths }).length, 1);
});

test('closeDay buckets proxy_summary with majority prompt_cache_hit', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'proxy_summary', host: 'codex', deltas: { rewritesApplied: 3, rewritesSkippedCache: 1, inputTokensSaved: 20000, cacheHitYes: 2, cacheHitNo: 1 } });
  const closed = closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  assert.deepEqual(closed[0], {
    schema_version: 1, event: 'proxy_summary', day_utc: '2026-08-25', plugin_version: '0.5', host: 'codex',
    rewrites_applied_bucket: '2_to_5', rewrites_skipped_cache_bucket: 'one',
    input_tokens_saved_bucket: '16_to_64k', prompt_cache_hit: 'yes',
  });
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

test('the queue keeps at most 256 rows, evicting the oldest first', () => {
  const statePaths = tempStatePaths();
  for (let day = 0; day < 260; day += 1) {
    incrementCounter({ statePaths, day: dayUtc(day), event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
    closeDay({ statePaths, day: dayUtc(day), pluginVersion: '0.5' });
  }
  const rows = loadBatch({ statePaths, max: 1000 });
  assert.equal(rows.length, 256);
  assert.equal(rows[0].day_utc, dayUtc(4));
  assert.equal(rows[rows.length - 1].day_utc, dayUtc(259));
});

test('loadBatch reads at most 32 rows by default', () => {
  const statePaths = tempStatePaths();
  for (let day = 0; day < 40; day += 1) {
    incrementCounter({ statePaths, day: dayUtc(day), event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
    closeDay({ statePaths, day: dayUtc(day), pluginVersion: '0.5' });
  }
  const rows = loadBatch({ statePaths });
  assert.equal(rows.length, 32);
});

test('toOtlpLogs maps rows to an OTLP/HTTP JSON body with service.name=sando', () => {
  const rows = [{ schema_version: 1, event: 'hook_summary', day_utc: '2026-08-25', plugin_version: '0.5', host: 'claude', mode: 'enforce', tool_calls_bucket: 'one', redactions_bucket: 'zero', capped_outputs_bucket: 'zero', bytes_saved_bucket: 'lt_4k' }];
  const body = toOtlpLogs(rows);
  const resourceAttrs = body.resourceLogs[0].resource.attributes;
  assert.deepEqual(resourceAttrs, [{ key: 'service.name', value: { stringValue: 'sando' } }]);
  const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(record.body.stringValue, 'sando.daily_aggregate');
  assert.ok(record.attributes.some((a) => a.key === 'day_utc' && a.value.stringValue === '2026-08-25'));
});

test('ackBatch removes only the acknowledged rows and keeps the rest', () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  incrementCounter({ statePaths, day: '2026-08-26', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-26', pluginVersion: '0.5' });
  const rows = loadBatch({ statePaths });
  ackBatch({ statePaths, count: 1 });
  const remaining = loadBatch({ statePaths });
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
  assert.deepEqual(preview.body, toOtlpLogs(loadBatch({ statePaths })));
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
    assert.equal(loadBatch({ statePaths }).length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('flushQueue leaves the queue intact when the upload fails', async () => {
  const statePaths = tempStatePaths();
  incrementCounter({ statePaths, day: '2026-08-25', event: 'hook_summary', host: 'claude', mode: 'enforce', deltas: { toolCalls: 1 } });
  closeDay({ statePaths, day: '2026-08-25', pluginVersion: '0.5' });
  const result = await flushQueue({ statePaths, endpoint: 'http://127.0.0.1:1/v1/logs', timeoutMs: 500 });
  assert.equal(result.sent, 0);
  assert.equal(loadBatch({ statePaths }).length, 1);
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
  assert.equal(loadBatch({ statePaths }).length, 1, 'disabled telemetry must not touch the queue');
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
  assert.equal(loadBatch({ statePaths }).length, 0);
});
