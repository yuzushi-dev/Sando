import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProviderProxy } from '../src/proxy.mjs';
import { recoverArtifactFromWorkspace } from '../src/artifact-recovery.mjs';

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

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition did not settle');
}

const recoverableArchivePolicy = {
  strategies: {
    supersededRead: false,
    producerUseless: false,
    exactDuplicate: false,
    repeatedLines: false,
    historyShake: false,
    recoverableArchive: true,
  },
  historyArchiveRetainResults: 1,
  cacheRewriteRatio: 0,
};

test('proxy persists recoverable history before forwarding the marker', async (t) => {
  let received;
  const upstream = http.createServer(async (request, response) => {
    received = JSON.parse(await readBody(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamAddress = await listen(upstream);
  const historyArchiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-proxy-history-'));
  const proxy = await createProviderProxy({
    upstream: `http://127.0.0.1:${upstreamAddress.port}`,
    policy: recoverableArchivePolicy,
    transformProviderRequests: true,
    historyArchiveRoot,
  });
  t.after(async () => {
    await proxy.close();
    await close(upstream);
  });
  const original = Array.from({ length: 500 }, (_, index) =>
    `${index + 1}: ${index === 417 ? 'SANDO_NEEDLE_418' : `evidence-${index + 1}`} ${'π detail '.repeat(20)}`).join('\n');
  const body = { input: [
    { type: 'function_call', call_id: 'old', name: 'Bash', arguments: '{}' },
    { type: 'function_call_output', call_id: 'old', output: original, status: 'completed', ok: true },
    { type: 'function_call', call_id: 'current', name: 'Bash', arguments: '{}' },
    { type: 'function_call_output', call_id: 'current', output: 'current', status: 'completed', ok: true },
  ] };
  const response = await fetch(`${proxy.url}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await response.text();

  const marker = received.input[1].output;
  assert.match(marker, /full exact text: use native Read on the archive file/);
  const ref = marker.match(/sando:sha256:[a-f0-9]{64}/)?.[0];
  assert.ok(ref);
  const artifactPath = path.join(historyArchiveRoot, '.sando', 'sando', 'artifacts', `${ref.slice('sando:sha256:'.length)}.txt`);
  assert.match(marker, new RegExp(`use rtk grep -n on archive '${artifactPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  assert.match(marker, /; \d+B, 500 lines;/);
  assert.match(marker, /--start-line 1 --end-line 80 --max-bytes 8192; bounded, continue with valid line ranges up to 500\]$/);
  assert.equal(fs.readFileSync(artifactPath, 'utf8').split('\n')[417].includes('SANDO_NEEDLE_418'), true);
  assert.equal(recoverArtifactFromWorkspace({ cwd: historyArchiveRoot, ref, maxBytes: 1_048_576 }).content, original);
  const artifactCli = path.join(import.meta.dirname, '..', 'src', 'artifact-cli.mjs');
  const firstPage = JSON.parse(execFileSync(process.execPath, [
    artifactCli, 'artifact', 'get', '--root', historyArchiveRoot, '--ref', ref,
    '--start-line', '1', '--end-line', '80', '--max-bytes', '8192', '--json',
  ], { encoding: 'utf8' }));
  assert.deepEqual(firstPage.range, { type: 'lines', start: 1, end: 80 });
  assert.ok(firstPage.bytes <= 8192);
  const ranged = JSON.parse(execFileSync(process.execPath, [
    artifactCli, 'artifact', 'get',
    '--root', historyArchiveRoot, '--ref', ref, '--start-line', '418', '--end-line', '418',
    '--max-bytes', '8192', '--json',
  ], { encoding: 'utf8' }));
  assert.match(ranged.content, /SANDO_NEEDLE_418/);
  assert.equal(ranged.range.type, 'lines');
  assert.equal(ranged.range.start, 418);
  assert.equal(received.input[3].output, 'current');
});

test('proxy forwards the original request when history persistence fails', async (t) => {
  let received;
  const upstream = http.createServer(async (request, response) => {
    received = JSON.parse(await readBody(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamAddress = await listen(upstream);
  const historyArchiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-proxy-history-fail-'));
  fs.writeFileSync(path.join(historyArchiveRoot, '.sando'), 'unsafe');
  const proxy = await createProviderProxy({
    upstream: `http://127.0.0.1:${upstreamAddress.port}`,
    policy: recoverableArchivePolicy,
    transformProviderRequests: true,
    historyArchiveRoot,
  });
  t.after(async () => {
    await proxy.close();
    await close(upstream);
  });
  const body = { messages: [
    { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old', content: 'old '.repeat(1200), status: 'completed', ok: true },
    { role: 'assistant', tool_calls: [{ id: 'current', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'current', content: 'current', status: 'completed', ok: true },
  ] };
  const response = await fetch(`${proxy.url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await response.text();
  assert.deepEqual(received, body);
});

test('proxy requires an explicit absolute archive root when recoverable history is enabled', async () => {
  await assert.rejects(
    createProviderProxy({
      upstream: 'http://127.0.0.1:1', transformProviderRequests: true,
      policy: recoverableArchivePolicy,
    }),
    /historyArchiveRoot must be an absolute path/,
  );
  await assert.rejects(
    createProviderProxy({
      upstream: 'http://127.0.0.1:1', transformProviderRequests: true,
      policy: recoverableArchivePolicy, historyArchiveRoot: 'relative',
    }),
    /historyArchiveRoot must be an absolute path/,
  );
});

test('proxy transforms repeated Anthropic tool results and preserves streaming response', async (t) => {
  let received;
  const upstream = http.createServer(async (request, response) => {
    received = { headers: request.headers, body: JSON.parse(await readBody(request)) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    response.end('data: [DONE]\n\n');
  });
  const upstreamAddress = await listen(upstream);
  const proxy = await createProviderProxy({
    upstream: `http://127.0.0.1:${upstreamAddress.port}`,
    policy: { maxHistoryTokens: 10_000 },
    transformProviderRequests: true,
  });
  t.after(async () => {
    await proxy.close();
    await close(upstream);
  });

  const body = {
    model: 'fixture',
    max_tokens: 32,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-old', name: 'Read', input: { file_path: 'src/app.ts:1-20' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-old', content: 'old file body' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-new', name: 'Read', input: { file_path: 'src/app.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-new', content: 'current file body' }] },
    ],
  };
  const response = await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data: first\n\ndata: [DONE]\n\n');
  assert.equal(received.headers.authorization, 'Bearer test-secret');
  assert.equal(received.headers.host, `127.0.0.1:${upstreamAddress.port}`);
  assert.equal(received.body.messages[1].content[0].content, '[sando superseded by newer read]');
  assert.equal(received.body.messages[1].content[0].tool_use_id, 'read-old');
  assert.equal(received.body.messages[3].content[0].content, 'current file body');
});

test('proxy is pass-through unless request transformation is explicitly enabled', async (t) => {
  let received;
  const upstream = http.createServer(async (request, response) => {
    received = JSON.parse(await readBody(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamAddress = await listen(upstream);
  const proxy = await createProviderProxy({ upstream: `http://127.0.0.1:${upstreamAddress.port}` });
  t.after(async () => {
    await proxy.close();
    await close(upstream);
  });
  const body = { messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Read', input: { file_path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'old' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'new', name: 'Read', input: { file_path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new', content: 'new' }] },
  ] };

  const response = await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  await response.text();
  assert.deepEqual(received, body);
});

test('proxy fails open for an ambiguous request body', async (t) => {
  let received;
  const upstream = http.createServer(async (request, response) => {
    received = JSON.parse(await readBody(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamAddress = await listen(upstream);
  const proxy = await createProviderProxy({ upstream: `http://127.0.0.1:${upstreamAddress.port}` });
  t.after(async () => {
    await proxy.close();
    await close(upstream);
  });

  const body = { model: 'fixture', input: [{ type: 'message', role: 'user', content: 'hello' }] };
  const response = await fetch(`${proxy.url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(received, body);
});

test('proxy does not forward compressed-response negotiation', async (t) => {
  let receivedHeaders;
  const upstream = http.createServer(async (request, response) => {
    receivedHeaders = request.headers;
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamAddress = await listen(upstream);
  const proxy = await createProviderProxy({ upstream: `http://127.0.0.1:${upstreamAddress.port}` });
  t.after(async () => {
    await proxy.close();
    await close(upstream);
  });

  const response = await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'accept-encoding': 'gzip, deflate, br', 'content-type': 'application/json' },
    body: '{}',
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"ok":true}');
  assert.notEqual(receivedHeaders['accept-encoding'], 'gzip, deflate, br');
});

test('proxy can observe semantic candidates without changing the forwarded body', async (t) => {
  let received;
  const candidates = [];
  const upstream = http.createServer(async (request, response) => {
    received = JSON.parse(await readBody(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamAddress = await listen(upstream);
  const proxy = await createProviderProxy({
    upstream: `http://127.0.0.1:${upstreamAddress.port}`,
    transformProviderRequests: true,
    semanticCompactor: async (candidate) => {
      candidates.push(candidate);
      return { status: 'candidate', cacheHit: false, netSavedTokens: 3, latencyMs: 4 };
    },
  });
  t.after(async () => {
    await proxy.close();
    await close(upstream);
  });

  const body = {
    model: 'fixture',
    input: [
      { type: 'custom_tool_call', call_id: 'old', name: 'Bash', input: { command: 'npm test' } },
      { type: 'custom_tool_call_output', call_id: 'old', output: 'old output', status: 'completed', ok: true },
      { type: 'custom_tool_call', call_id: 'current', name: 'Bash', input: { command: 'git status' } },
      { type: 'custom_tool_call_output', call_id: 'current', output: 'current output', status: 'completed', ok: true },
    ],
  };
  const response = await fetch(`${proxy.url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(received, body);
  await waitFor(() => proxy.lastStats.semantic.pending === 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].text, 'old output');
  assert.equal(candidates[0].model, 'fixture');
  assert.equal(proxy.lastStats.semantic.candidates, 1);
  assert.equal(proxy.lastStats.semantic.accepted, 1);
  assert.equal(proxy.lastStats.semantic.netSavedTokens, 3);
});

test('semantic observer failure does not undo deterministic proxy reduction', async (t) => {
  let received;
  const upstream = http.createServer(async (request, response) => {
    received = JSON.parse(await readBody(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamAddress = await listen(upstream);
  const proxy = await createProviderProxy({
    upstream: `http://127.0.0.1:${upstreamAddress.port}`,
    transformProviderRequests: true,
    semanticCompactor: async () => { throw new Error('adapter unavailable'); },
  });
  t.after(async () => {
    await proxy.close();
    await close(upstream);
  });

  const body = {
    model: 'fixture',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Read', input: { file_path: 'src/app.ts:1-20' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'old body' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'new', name: 'Read', input: { file_path: 'src/app.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new', content: 'new body' }] },
    ],
  };
  const response = await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });

  assert.equal(response.status, 200);
  assert.equal(received.messages[1].content[0].content, '[sando superseded by newer read]');
  await waitFor(() => proxy.lastStats.semantic.pending === 0);
  assert.equal(proxy.lastStats.semantic.fallbacks, 1);
});

test('shadow observer runs after forwarding and cannot delay the provider response', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const upstream = http.createServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamAddress = await listen(upstream);
  const proxy = await createProviderProxy({
    upstream: `http://127.0.0.1:${upstreamAddress.port}`,
    transformProviderRequests: true,
    semanticCompactor: async () => {
      await gate;
      return { status: 'candidate', cacheHit: false, netSavedTokens: 1 };
    },
  });
  t.after(async () => {
    release();
    await proxy.close();
    await close(upstream);
  });

  const body = {
    model: 'fixture',
    input: [
      { type: 'custom_tool_call', call_id: 'old', name: 'Bash', input: { command: 'npm test' } },
      { type: 'custom_tool_call_output', call_id: 'old', output: 'old output', status: 'completed', ok: true },
      { type: 'custom_tool_call', call_id: 'current', name: 'Bash', input: { command: 'git status' } },
      { type: 'custom_tool_call_output', call_id: 'current', output: 'current output', status: 'completed', ok: true },
    ],
  };
  const response = await Promise.race([
    fetch(`${proxy.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 1000)),
  ]);

  assert.notEqual(response, 'timed-out');
  release();
  await response.text();
  await waitFor(() => proxy.lastStats.semantic.pending === 0);
});

test('proxy persists provider-reported usage and transform stats when metricsPath is set', async (t) => {
  const upstream = http.createServer(async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_creation_input_tokens":80,"cache_read_input_tokens":0}}}\n\n');
    response.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":16}}\n\n');
  });
  const upstreamAddress = await listen(upstream);
  const metricsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sando-proxy-metrics-')), 'proxy-requests.jsonl');
  const proxy = await createProviderProxy({
    upstream: `http://127.0.0.1:${upstreamAddress.port}`,
    policy: { maxHistoryTokens: 10_000 },
    transformProviderRequests: true,
    metricsPath,
  });
  t.after(async () => {
    await proxy.close();
    await close(upstream);
  });

  const body = {
    model: 'fixture-model',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Read', input: { file_path: 'src/app.ts:1-20' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'old body' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'new', name: 'Read', input: { file_path: 'src/app.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new', content: 'new body' }] },
    ],
  };
  const response = await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await response.text();

  await waitFor(() => fs.existsSync(metricsPath));
  const record = JSON.parse(fs.readFileSync(metricsPath, 'utf8').trim().split('\n')[0]);
  assert.equal(record.schema, 'sando-proxy-metrics/v1');
  assert.equal(record.provider, 'anthropic');
  assert.equal(record.model, 'fixture-model');
  assert.equal(record.stats.supersededReads, 1);
  assert.deepEqual(record.usage, { input_tokens: 5, cache_creation_input_tokens: 80, cache_read_input_tokens: 0, output_tokens: 16 });
});
