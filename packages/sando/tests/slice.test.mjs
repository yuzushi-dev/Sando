import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createSliceBridge,
  SLICE_TOOLS,
  SliceRpcError,
} from '../src/slice.mjs';

const READ_NAMES = [
  'sando_slice_for',
  'sando_slice_find_symbol',
  'sando_slice_find_referencing_symbols',
  'sando_slice_fetch_body',
];
const WRITE_NAMES = [
  'sando_slice_replace_symbol_body',
  'sando_slice_insert_after_symbol',
];
const HANDLE = 'sym#0123456789abcdef@0123456789abcdef';
const REFUSED_HANDLE = 'sym#1111111111111111@2222222222222222';

function fixtureBackend(t, { invalidInitialize = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-slice-fixture-'));
  const root = path.join(directory, 'workspace');
  const binary = path.join(directory, 'slice-fixture');
  fs.mkdirSync(root);
  fs.writeFileSync(binary, `#!/usr/bin/env node
const readline = require('node:readline');
let sequence = 0;
let clientVersion;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'notifications/initialized') return;
  if (request.method === 'initialize') {
    clientVersion = request.params.clientInfo.version;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: ${invalidInitialize ? "{ capabilities: {} }" : "{ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'slice-fixture', version: '1.0' } }"} }) + '\\n');
    return;
  }
  sequence += 1;
  if (request.params.arguments.task === 'hang') return;
  if (request.params.arguments.task === 'null') {
    process.stdout.write('null\\n');
    return;
  }
  if (request.params.arguments.task === 'exit') {
    process.stderr.write('session_code=stderr-private');
    process.exit(7);
  }
  if (request.params.arguments.symbol === '${REFUSED_HANDLE}') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'stale edit handle; password=private' } }) + '\\n');
    return;
  }
  if (request.params.arguments.symbol === 'oversize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] } }) + '\\n');
    return;
  }
  const payload = { sequence, name: request.params.name, arguments: request.params.arguments, clientVersion, handle: '${HANDLE}' };
  if (request.params.name === 'fetch_body') payload.source = 'const session_code = "private";';
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], _index: '[index: files=1 symbols=2 hash=12345678]', _fresh: sequence === 1 ? 'ok' : 'reindexed', _reingest: sequence - 1 } }) + '\\n');
});
`);
  fs.chmodSync(binary, 0o755);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { binary, root };
}

function envFor(fixture, write = false) {
  return {
    SANDO_SLICE_BINARY: fixture.binary,
    SANDO_SLICE_ROOT: fixture.root,
    ...(write ? { SANDO_SLICE_WRITE: '1' } : {}),
  };
}

test('Slice tools expose the selected bounded surface and correct annotations', () => {
  const fixture = { binary: process.execPath, root: path.resolve(import.meta.dirname, '..') };
  const tools = SLICE_TOOLS(envFor(fixture, true));
  assert.deepEqual(tools.map((tool) => tool.name), [...READ_NAMES, ...WRITE_NAMES]);
  for (const tool of tools) {
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'path'), false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'paths'), false);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'cwd'), false);
  }
  for (const name of READ_NAMES) {
    assert.deepEqual(tools.find((tool) => tool.name === name).annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
  }
  assert.equal(tools.find((tool) => tool.name === WRITE_NAMES[0]).annotations.destructiveHint, true);
  assert.equal(tools.find((tool) => tool.name === WRITE_NAMES[1]).annotations.destructiveHint, false);
  assert.deepEqual(SLICE_TOOLS({}), []);
  assert.deepEqual(SLICE_TOOLS(envFor(fixture)).map((tool) => tool.name), READ_NAMES);
});

test('Slice bridge keeps one upstream MCP process and preserves result metadata', async (t) => {
  const fixture = fixtureBackend(t);
  const bridge = createSliceBridge({ env: envFor(fixture, true) });
  t.after(() => bridge.close());

  const first = await bridge.call('sando_slice_for', { task: 'find the parser', budget_tokens: 500 });
  const second = await bridge.call('sando_slice_insert_after_symbol', { handle: HANDLE, text: '// note\n' });
  const firstPayload = JSON.parse(first.content[0].text);
  const secondPayload = JSON.parse(second.content[0].text);

  assert.equal(firstPayload.sequence, 1);
  assert.equal(secondPayload.sequence, 2);
  assert.equal(firstPayload.name, 'for');
  assert.equal(secondPayload.name, 'insert_after_symbol');
  assert.equal(secondPayload.arguments.symbol, HANDLE);
  assert.equal(Object.hasOwn(secondPayload.arguments, 'handle'), false);
  assert.deepEqual(firstPayload.arguments, { task: 'find the parser', budget_tokens: 500 });
  assert.equal(Object.hasOwn(firstPayload.arguments, 'path'), false);
  assert.equal(first._index, '[index: files=1 symbols=2 hash=12345678]');
  assert.equal(second._fresh, 'reindexed');
  assert.equal(second._reingest, 1);
  assert.equal(firstPayload.clientVersion, '0.6.1');
});

test('Slice fetch_body defaults to a bounded upstream line window', async (t) => {
  const fixture = fixtureBackend(t);
  const bridge = createSliceBridge({ env: envFor(fixture) });
  t.after(() => bridge.close());

  const result = await bridge.call('sando_slice_fetch_body', { handle: HANDLE });
  assert.deepEqual(JSON.parse(result.content[0].text).arguments, {
    handle: HANDLE, start_line: 1, end_line: 400,
  });
});

test('Slice bridge preserves upstream stale-handle errors', async (t) => {
  const fixture = fixtureBackend(t);
  const bridge = createSliceBridge({ env: envFor(fixture, true) });
  t.after(() => bridge.close());

  await assert.rejects(
    bridge.call('sando_slice_replace_symbol_body', { handle: REFUSED_HANDLE, new_body: 'function changed() {}' }),
    (error) => error instanceof SliceRpcError
      && error.code === -32602
      && error.message === 'stale edit handle; password=[REDACTED]',
  );
});

test('Slice writes require explicit opt-in and callers cannot override the configured root', async (t) => {
  const fixture = fixtureBackend(t);
  const bridge = createSliceBridge({ env: envFor(fixture) });
  t.after(() => bridge.close());

  await assert.rejects(
    bridge.call('sando_slice_insert_after_symbol', { handle: HANDLE, text: '// note', path: '/tmp' }),
    /unknown argument: path/,
  );
  await assert.rejects(
    bridge.call('sando_slice_insert_after_symbol', { handle: HANDLE, text: '// note' }),
    /SANDO_SLICE_WRITE=1/,
  );
});

test('Slice requires explicit absolute binary and canonical workspace config', async (t) => {
  const fixture = fixtureBackend(t);
  const relativeBinary = createSliceBridge({ env: { SANDO_SLICE_BINARY: './backend', SANDO_SLICE_ROOT: fixture.root } });
  const relativeRoot = createSliceBridge({ env: { SANDO_SLICE_BINARY: fixture.binary, SANDO_SLICE_ROOT: '.' } });
  t.after(() => { relativeBinary.close(); relativeRoot.close(); });

  await assert.rejects(relativeBinary.call('sando_slice_for', { task: 'x' }), /SANDO_SLICE_BINARY must be an absolute executable file/);
  await assert.rejects(relativeRoot.call('sando_slice_for', { task: 'x' }), /SANDO_SLICE_ROOT must be an absolute canonical directory/);
});

test('Slice refuses invalid initialization and oversized backend frames', async (t) => {
  const invalidFixture = fixtureBackend(t, { invalidInitialize: true });
  const invalidBridge = createSliceBridge({ env: envFor(invalidFixture) });
  t.after(() => invalidBridge.close());
  await assert.rejects(invalidBridge.call('sando_slice_for', { task: 'x' }), /invalid initialize result/);

  const fixture = fixtureBackend(t);
  const bridge = createSliceBridge({ env: envFor(fixture) });
  t.after(() => bridge.close());
  await assert.rejects(bridge.call('sando_slice_find_symbol', { symbol: 'oversize' }), /response exceeded/);
});

test('Slice safely rejects a non-object JSON-RPC envelope', async (t) => {
  const fixture = fixtureBackend(t);
  const bridge = createSliceBridge({ env: envFor(fixture) });
  t.after(() => bridge.close());

  await assert.rejects(
    bridge.call('sando_slice_for', { task: 'null' }),
    /invalid JSON-RPC envelope/,
  );
});

test('Slice applies project redaction, preserves handles, and blocks redacted-source writes', async (t) => {
  const fixture = fixtureBackend(t);
  fs.mkdirSync(path.join(fixture.root, '.sando'));
  fs.writeFileSync(path.join(fixture.root, '.sando', 'redaction.json'), JSON.stringify({
    schema: 'sando-redaction/v1', rules: [{ type: 'assignment-key', key: 'session_code' }],
  }));
  const bridge = createSliceBridge({ env: envFor(fixture, true) });
  t.after(() => bridge.close());

  const result = await bridge.call('sando_slice_fetch_body', { handle: HANDLE });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.source, 'const session_code = "[REDACTED]";');
  assert.equal(payload.handle, HANDLE);
  assert.equal(result._sando_redaction.source_round_trip, false);
  await assert.rejects(
    bridge.call('sando_slice_replace_symbol_body', { handle: HANDLE, new_body: 'function changed() {}' }),
    /redacted source.*not round-trippable/i,
  );
  const inserted = await bridge.call('sando_slice_insert_after_symbol', {
    handle: HANDLE, text: 'function added() {}',
  });
  assert.equal(JSON.parse(inserted.content[0].text).name, 'insert_after_symbol');
});

test('Slice redacts native errors and never exposes stderr', async (t) => {
  const fixture = fixtureBackend(t);
  fs.mkdirSync(path.join(fixture.root, '.sando'));
  fs.writeFileSync(path.join(fixture.root, '.sando', 'redaction.json'), JSON.stringify({
    schema: 'sando-redaction/v1', rules: [{ type: 'assignment-key', key: 'session_code' }],
  }));
  const bridge = createSliceBridge({ env: envFor(fixture, true) });
  t.after(() => bridge.close());

  await assert.rejects(
    bridge.call('sando_slice_replace_symbol_body', { handle: REFUSED_HANDLE, new_body: 'function changed() {}' }),
    (error) => error.message.includes('[REDACTED]') && !error.message.includes('private'),
  );
  await assert.rejects(
    bridge.call('sando_slice_for', { task: 'exit' }),
    (error) => !error.message.includes('stderr-private'),
  );
});

test('Slice close is terminal and prevents queued backend restart', async (t) => {
  const fixture = fixtureBackend(t);
  const bridge = createSliceBridge({ env: envFor(fixture) });
  bridge.close();
  await assert.rejects(bridge.call('sando_slice_for', { task: 'x' }), /closed/i);
});

test('Slice validates required arguments and property types at runtime', async (t) => {
  const fixture = fixtureBackend(t);
  const bridge = createSliceBridge({ env: envFor(fixture, true) });
  t.after(() => bridge.close());

  await assert.rejects(bridge.call('sando_slice_for', { task: 1 }), /invalid argument: task/);
  await assert.rejects(bridge.call('sando_slice_find_symbol', {}), /missing required argument: symbol/);
  await assert.rejects(bridge.call('sando_slice_find_symbol', { symbol: 'name', limit: 1.5 }), /invalid argument: limit/);
  await assert.rejects(bridge.call('sando_slice_fetch_body', { handle: 'name' }), /invalid argument: handle/);
  await assert.rejects(
    bridge.call('sando_slice_insert_after_symbol', { handle: HANDLE, text: '' }),
    /invalid argument: text/,
  );
});

test('Slice cancellation and timeout apply while requests wait in the queue', async (t) => {
  const fixture = fixtureBackend(t);
  const bridge = createSliceBridge({ env: envFor(fixture), requestTimeoutMs: 50 });
  t.after(() => bridge.close());
  const first = bridge.call('sando_slice_for', { task: 'hang' });
  const controller = new AbortController();
  const cancelled = bridge.call('sando_slice_for', { task: 'never-runs' }, { signal: controller.signal });
  const timedOutInQueue = bridge.call('sando_slice_for', { task: 'also-never-runs' });
  controller.abort();

  await assert.rejects(cancelled, /cancelled/i);
  await assert.rejects(first, /timed out/i);
  await assert.rejects(timedOutInQueue, /timed out/i);
});
