import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createProviderProxy } from '../src/proxy.mjs';

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
      { type: 'custom_tool_call_output', call_id: 'old', output: 'old output' },
      { type: 'custom_tool_call', call_id: 'current', name: 'Bash', input: { command: 'git status' } },
      { type: 'custom_tool_call_output', call_id: 'current', output: 'current output' },
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
      { type: 'custom_tool_call_output', call_id: 'old', output: 'old output' },
      { type: 'custom_tool_call', call_id: 'current', name: 'Bash', input: { command: 'git status' } },
      { type: 'custom_tool_call_output', call_id: 'current', output: 'current output' },
    ],
  };
  const response = await Promise.race([
    fetch(`${proxy.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100)),
  ]);

  assert.notEqual(response, 'timed-out');
  release();
  await response.text();
  await waitFor(() => proxy.lastStats.semantic.pending === 0);
});
