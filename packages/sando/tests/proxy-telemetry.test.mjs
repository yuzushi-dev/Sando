import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProviderProxy } from '../src/proxy.mjs';
import { defaultTelemetryStatePaths, readTelemetryConfig } from '../src/telemetry.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function tempTelemetryEnv({ enabled }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-proxy-telemetry-'));
  const env = { XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_STATE_HOME: path.join(dir, 'state') };
  const configPath = path.join(env.XDG_CONFIG_HOME, 'sando', 'telemetry.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(enabled
    ? { schema_version: 1, enabled: true, prompted_consent_version: 1, consent_version: 1, consented_at: '2026-08-25T00:00:00.000Z', endpoint: 'http://127.0.0.1:1/v1/logs' }
    : { schema_version: 1, enabled: false, prompted_consent_version: 0 }));
  return { env, statePaths: defaultTelemetryStatePaths(env) };
}

function rewriteFixtureBody() {
  return {
    model: 'fixture',
    max_tokens: 32,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-old', name: 'Read', input: { file_path: 'src/app.ts:1-20' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-old', content: 'old file body\n'.repeat(200) }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-new', name: 'Read', input: { file_path: 'src/app.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-new', content: 'current file body' }] },
    ],
  };
}

function noChangeFixtureBody() {
  return { model: 'fixture', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] };
}

function firstCounter(countersPath) {
  const counters = JSON.parse(fs.readFileSync(countersPath, 'utf8')).counters;
  const values = Object.values(counters);
  assert.equal(values.length, 1, 'expected exactly one counter bucket');
  return values[0];
}

test('telemetry disabled: proxy rewrite never touches the counters file', async (t) => {
  const { env, statePaths } = tempTelemetryEnv({ enabled: false });
  const upstream = http.createServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamAddress = await listen(upstream);
  const proxy = await createProviderProxy({
    upstream: `http://127.0.0.1:${upstreamAddress.port}`, policy: { maxHistoryTokens: 10_000 }, env,
  });
  t.after(async () => { await proxy.close(); await close(upstream); });

  await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rewriteFixtureBody()),
  });

  assert.equal(fs.existsSync(statePaths.counters), false);
});

test('telemetry enabled: a rewrite increments rewritesApplied and inputTokensSaved', async (t) => {
  const { env, statePaths } = tempTelemetryEnv({ enabled: true });
  const upstream = http.createServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamAddress = await listen(upstream);
  const proxy = await createProviderProxy({
    upstream: `http://127.0.0.1:${upstreamAddress.port}`, policy: { maxHistoryTokens: 10_000 }, env,
  });
  t.after(async () => { await proxy.close(); await close(upstream); });

  await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rewriteFixtureBody()),
  });

  const counter = firstCounter(statePaths.counters);
  assert.equal(counter.event, 'proxy_summary');
  assert.equal(counter.host, 'claude');
  assert.equal(counter.rewritesApplied, 1);
  assert.ok(counter.inputTokensSaved > 0);
});

test('a recognized request with nothing to rewrite still records a proxy_summary row with zero rewrites', async (t) => {
  const { env, statePaths } = tempTelemetryEnv({ enabled: true });
  const upstream = http.createServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamAddress = await listen(upstream);
  const proxy = await createProviderProxy({ upstream: `http://127.0.0.1:${upstreamAddress.port}`, env });
  t.after(async () => { await proxy.close(); await close(upstream); });

  await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(noChangeFixtureBody()),
  });

  const counter = firstCounter(statePaths.counters);
  assert.equal(counter.rewritesApplied, 0);
});

test('an unrecognized (ambiguous) request body records no telemetry at all', async (t) => {
  const { env, statePaths } = tempTelemetryEnv({ enabled: true });
  const upstream = http.createServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamAddress = await listen(upstream);
  const proxy = await createProviderProxy({ upstream: `http://127.0.0.1:${upstreamAddress.port}`, env });
  t.after(async () => { await proxy.close(); await close(upstream); });

  await fetch(`${proxy.url}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture', input: [{ type: 'message', role: 'user', content: 'hello' }] }),
  });

  assert.equal(fs.existsSync(statePaths.counters), false);
});

test('telemetry failure never affects the proxied response', async (t) => {
  const { env, statePaths } = tempTelemetryEnv({ enabled: true });
  fs.mkdirSync(statePaths.counters, { recursive: true }); // a directory where a file is expected: forces a write failure
  const upstream = http.createServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamAddress = await listen(upstream);
  const proxy = await createProviderProxy({
    upstream: `http://127.0.0.1:${upstreamAddress.port}`, policy: { maxHistoryTokens: 10_000 }, env,
  });
  t.after(async () => { await proxy.close(); await close(upstream); });

  const response = await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rewriteFixtureBody()),
  });
  assert.equal(response.status, 200);
});

test('readTelemetryConfig sanity: disabled state has enabled === false', () => {
  const { env } = tempTelemetryEnv({ enabled: false });
  assert.equal(readTelemetryConfig(path.join(env.XDG_CONFIG_HOME, 'sando', 'telemetry.json')).enabled, false);
});
