import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createLazyMcpGateway } from '../src/lazy-mcp-gateway.mjs';
import { startLazyMcpGatewayStdio } from '../src/lazy-mcp-gateway-stdio.mjs';

async function runGateway(gateway, messages) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));
  startLazyMcpGatewayStdio({ gateway, input, output });
  input.end(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  return Buffer.concat(chunks).toString().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('stdio entrypoint forwards explicit configured MCPs and remains disabled by default', async () => {
  const gateway = createLazyMcpGateway({ enabled: true, allowlist: ['fixture'], servers: [{
    name: 'fixture',
    connect: async () => ({
      request: async (message) => message.method === 'initialize'
        ? { result: {} }
        : message.method === 'tools/list'
          ? { result: { tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }] } }
          : { result: { content: [{ type: 'text', text: 'ok' }] } },
    }),
  }] });
  const responses = await runGateway(gateway, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fixture/read', arguments: { value: 'ok' } } },
  ]);
  assert.equal(responses[0].result.serverInfo.name, 'sando-lazy-mcp-gateway');
  assert.equal(responses[1].result.tools[0].name, 'sando_catalog');
  assert.equal(responses[2].result.content[0].text, 'ok');

  const disabled = await runGateway(createLazyMcpGateway({ enabled: false, allowlist: [], servers: [] }), [{ jsonrpc: '2.0', id: 4, method: 'ping' }]);
  assert.equal(disabled[0].error.code, -32004);
});

test('stdio layer forwards downstream notifications and keeps stdout JSONL-only', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));
  let listRequests = 0;
  let notify;
  const gateway = createLazyMcpGateway({ enabled: true, allowlist: ['fixture'], servers: [{
    name: 'fixture',
    connect: ({ onMessage }) => { notify = onMessage; return { request: async (message) => {
      if (message.method === 'initialize') return { result: {} };
      if (message.method === 'tools/list') { listRequests += 1; return { result: { tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } } }] } }; }
      notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } });
      notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      return { result: { content: [{ type: 'text', text: message.params.arguments.value }] } };
    }, close: async () => {} }; },
  }], onMessage: (message) => output.write(`${JSON.stringify(message)}\n`) });
  startLazyMcpGatewayStdio({ gateway, input, output });
  const send = (message) => input.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'sando_catalog', arguments: {} } });
  send({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'sando_call', arguments: { name: 'fixture/read', arguments: { value: 'ok' } } } });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const messages = Buffer.concat(chunks).toString().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(messages.some((message) => message.id === 21 && message.result?.content?.[0]?.text === 'ok'), JSON.stringify(messages));
  assert.ok(messages.some((message) => message.method === 'notifications/progress'));
  assert.ok(messages.some((message) => message.method === 'notifications/tools/list_changed'));
  assert.ok(messages.every((message) => message.jsonrpc === '2.0'));
  await gateway.catalog();
  assert.ok(listRequests >= 2);
  await gateway.close();
  input.end();
  output.destroy();
});

test('stdio serializes consecutive input lines and preserves response order', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));
  let active = 0;
  let maximum = 0;
  const gateway = {
    async handle(message) {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, message.id === 1 ? 25 : 0));
      active -= 1;
      return { jsonrpc: '2.0', id: message.id, result: { order: message.id } };
    },
  };
  const lines = startLazyMcpGatewayStdio({ gateway, input, output });
  input.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  await new Promise((resolve) => lines.once('close', resolve));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const responses = Buffer.concat(chunks).toString().trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(responses.map(({ id }) => id), [1, 2]);
  assert.equal(maximum, 1);
});
