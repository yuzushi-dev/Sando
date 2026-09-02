#!/usr/bin/env node

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const root = path.resolve(import.meta.dirname, '..');
const gatewayScript = path.join(root, 'packages', 'sando', 'gateway.mjs');
const gatewayConfig = {
  enabled: true,
  allowlist: ['sando-local-readonly'],
  servers: [{
    name: 'sando-local-readonly',
    command: process.execPath,
    args: [path.join(root, 'adapters', 'claude', 'sando', 'mcp', 'server.mjs')],
    cwd: root,
    capabilities: ['read-only', 'local'],
  }],
};

function validateConfig() {
  const config = gatewayConfig;
  if (config.enabled !== true || config.allowlist?.length !== 1 || config.allowlist[0] !== 'sando-local-readonly'
    || config.servers?.length !== 1 || config.servers[0]?.name !== 'sando-local-readonly') {
    throw new Error('F4 canary configuration is not the active single-server lane');
  }
}

function request(child, responses, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve, reject) => { responses.set(message.id, { resolve, reject }); });
}

async function main() {
  validateConfig();
  const child = spawn(process.execPath, [gatewayScript], {
    cwd: root,
    env: {
      ...process.env,
      SANDO_MCP_GATEWAY_CONFIG: JSON.stringify(gatewayConfig),
      SANDO_F4_HOST: process.env.SANDO_F4_HOST || 'claude',
      SANDO_F4_EVENTS_PATH: process.env.SANDO_F4_EVENTS_PATH
        || path.join(os.homedir(), '.local', 'state', 'sando', 'canary', 'f4-events.jsonl'),
      SANDO_F4_TELEMETRY: process.env.SANDO_F4_TELEMETRY || '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  const errors = [];
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      const pending = responses.get(message.id);
      if (pending) { responses.delete(message.id); pending.resolve(message); }
    } catch {}
  });
  child.stderr.on('data', (chunk) => errors.push(String(chunk)));
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const wait = (promise, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 10_000)),
  ]);
  try {
    const initialize = await wait(request(child, responses, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), 'initialize');
    if (initialize.result?.serverInfo?.name !== 'sando-lazy-mcp-gateway') throw new Error('gateway initialize failed');
    const listed = await wait(request(child, responses, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 'tools/list');
    const names = listed.result?.tools?.map(({ name }) => name).sort();
    if (JSON.stringify(names) !== JSON.stringify(['sando_call', 'sando_catalog'])) throw new Error('gateway tool surface is not strict');
    const catalog = await wait(request(child, responses, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'sando_catalog', arguments: {},
    } }), 'sando_catalog');
    const entries = JSON.parse(catalog.result?.content?.[0]?.text || '[]');
    if (!entries.some(({ name }) => name === 'sando-local-readonly/prepare_tool_output')) throw new Error('read-only downstream was not catalogued');
    const called = await wait(request(child, responses, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'sando_call', arguments: {
        name: 'sando-local-readonly/prepare_tool_output',
        arguments: { toolName: 'Read', output: 'canary smoke', cwd: root },
      },
    } }), 'sando_call');
    if (called.result?.isError) throw new Error('read-only downstream call failed');
    process.stdout.write(`${JSON.stringify({ gateway: 'active', enabled: true, catalogEntries: entries.length, downstreamCall: 'ok' })}\n`);
  } finally {
    child.kill();
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    lines.close();
    for (const { reject } of responses.values()) reject(new Error('gateway stopped'));
    if (errors.length) process.stderr.write(errors.join(''));
  }
}

main().catch((error) => {
  process.stderr.write(`sando canary smoke: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
