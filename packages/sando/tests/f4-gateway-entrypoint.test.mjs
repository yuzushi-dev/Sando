import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const GATEWAY = path.join(ROOT, 'packages', 'sando', 'gateway.mjs');

function fixtureSource() {
  return `import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  let result = {};
  if (message.method === 'initialize') result = { capabilities: {}, serverInfo: { name: 'fixture' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'read', description: 'read only', inputSchema: { type: 'object', additionalProperties: false } }] };
  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'ok' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});`;
}

function request(child, responses, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve, reject) => { responses.set(message.id, { resolve, reject }); });
}

test('gateway entrypoint persists normal-host F4 events without raw target data', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-f4-entrypoint-'));
  const fixture = path.join(directory, 'fixture.mjs');
  const config = path.join(directory, 'gateway.json');
  const eventsPath = path.join(directory, 'f4-events.jsonl');
  fs.writeFileSync(fixture, fixtureSource(), { mode: 0o600 });
  fs.writeFileSync(config, JSON.stringify({
    enabled: true,
    allowlist: ['fixture'],
    servers: [{ name: 'fixture', command: process.execPath, args: [fixture], cwd: ROOT }],
  }), { mode: 0o600 });
  const child = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env: { ...process.env, SANDO_MCP_GATEWAY_CONFIG: config, SANDO_F4_HOST: 'codex', SANDO_F4_EVENTS_PATH: eventsPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const pending = responses.get(message.id);
    if (pending) { responses.delete(message.id); pending.resolve(message); }
  });
  const exit = new Promise((resolve) => child.once('exit', resolve));
  try {
    await request(child, responses, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await request(child, responses, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sando_catalog', arguments: {} } });
    await request(child, responses, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'sando_call', arguments: { name: 'fixture/read', arguments: {} },
    } });
  } finally {
    child.kill();
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 1000))]);
    lines.close();
  }
  try {
    const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.map(({ host, operation, outcome }) => ({ host, operation, outcome })), [
      { host: 'codex', operation: 'catalog', outcome: 'success' },
      { host: 'codex', operation: 'call', outcome: 'success' },
    ]);
    assert.doesNotMatch(fs.readFileSync(eventsPath, 'utf8'), /fixture\/read/);
    assert.equal(fs.statSync(eventsPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('gateway entrypoint forwards bounded F4 events to the configured OTLP endpoint', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-f4-publish-'));
  const fixture = path.join(directory, 'fixture.mjs');
  const config = path.join(directory, 'gateway.json');
  const eventsPath = path.join(directory, 'f4-events.jsonl');
  const published = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try { published.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {}
      response.writeHead(202).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/logs`;
  fs.writeFileSync(fixture, fixtureSource(), { mode: 0o600 });
  fs.writeFileSync(config, JSON.stringify({
    enabled: true,
    allowlist: ['fixture'],
    servers: [{ name: 'fixture', command: process.execPath, args: [fixture], cwd: ROOT }],
  }), { mode: 0o600 });
  const child = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env: {
      ...process.env,
      SANDO_MCP_GATEWAY_CONFIG: config,
      SANDO_F4_HOST: 'claude',
      SANDO_F4_EVENTS_PATH: eventsPath,
      SANDO_F4_TELEMETRY_ENDPOINT: endpoint,
      SANDO_F4_DEBUG: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const pending = responses.get(message.id);
    if (pending) { responses.delete(message.id); pending.resolve(message); }
  });
  const request = (message) => new Promise((resolve, reject) => {
    responses.set(message.id, { resolve, reject });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
  try {
    await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sando_catalog', arguments: {} } });
    await request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'sando_call', arguments: { name: 'fixture/read', arguments: {} },
    } });
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 2_000;
      const poll = () => {
        if (published.length >= 2) resolve();
        else if (Date.now() >= deadline) reject(new Error('F4 publish timeout'));
        else setTimeout(poll, 10);
      };
      poll();
    });
    const attributes = published.map((payload) => Object.fromEntries(
      payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(({ key, value }) => [key, value.stringValue]),
    ));
    assert.deepEqual(attributes.map(({ event, f4_host, f4_operation }) => ({ event, f4_host, f4_operation })), [
      { event: 'f4_gateway', f4_host: 'claude', f4_operation: 'catalog' },
      { event: 'f4_gateway', f4_host: 'claude', f4_operation: 'call' },
    ]);
    assert.doesNotMatch(JSON.stringify(published), /fixture\/read/);
  } finally {
    child.kill();
    lines.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
