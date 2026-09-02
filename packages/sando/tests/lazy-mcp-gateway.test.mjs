import assert from 'node:assert/strict';
import test from 'node:test';

import { digestCapability } from '../src/f4-telemetry.mjs';
import { createLazyMcpGateway, validateJsonSchema } from '../src/lazy-mcp-gateway.mjs';

const tool = (name, description, inputSchema = { type: 'object', additionalProperties: false }) => ({
  name, description, inputSchema,
});

function fixtureServer({ name, tools, onCall = () => ({ content: [{ type: 'text', text: 'ok' }] }) }) {
  const state = { connects: 0, requests: [], notifications: [], calls: 0, listChanged: null, onMessage: null };
  return {
    name, description: `${name} fixture`, capabilities: ['tools'], state,
    async connect({ onMessage }) {
      state.onMessage = onMessage;
      state.connects += 1;
      return {
        async request(message, { signal, notify }) {
          state.requests.push(message);
          if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: { capabilities: { tools: { listChanged: true } }, serverInfo: { name } } };
          if (message.method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: { tools } };
          if (message.method === 'tools/call') {
            state.calls += 1;
            return onCall(message.params, { signal, notify, onMessage });
          }
          return { jsonrpc: '2.0', id: message.id, result: {} };
        },
        async notify(message) { state.notifications.push(message); },
        async close() {},
      };
    },
    emit(message) { state.onMessage?.(message); },
  };
}

test('allowlist isolates downstream servers and catalog ranking is deterministic', async () => {
  const hidden = fixtureServer({ name: 'hidden', tools: [tool('delete_everything', 'mutative hidden tool')] });
  const visible = fixtureServer({ name: 'visible', tools: [tool('read_issue', 'read issue details')] });
  const gateway = createLazyMcpGateway({ enabled: true, allowlist: ['visible'], servers: [visible, hidden] });

  const catalog = await gateway.catalog('issue');
  assert.deepEqual(catalog.map(({ server, capability }) => ({ server, capability })), [{ server: 'visible', capability: 'read_issue' }]);
  assert.equal(hidden.state.connects, 0);
  assert.equal(visible.state.connects, 1);
  assert.equal((await gateway.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools[0].name, 'sando_catalog');
});

test('concurrent catalog and call share one initial connection and tools/list', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const server = fixtureServer({ name: 'shared', tools: [tool('read', 'read')] });
  const connect = server.connect;
  server.connect = async (options) => {
    const transport = await connect(options);
    const request = transport.request;
    transport.request = async (message, requestOptions) => {
      if (message.method === 'initialize') await gate;
      return request.call(transport, message, requestOptions);
    };
    return transport;
  };
  const gateway = createLazyMcpGateway({ enabled: true, allowlist: ['shared'], servers: [server] });
  const catalogPromise = gateway.catalog('read');
  const callPromise = gateway.handle({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'shared/read', arguments: {} } });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [catalog, call] = await Promise.all([catalogPromise, callPromise]);
  assert.equal(catalog.length, 1);
  assert.equal(call.result.content[0].text, 'ok');
  assert.equal(server.state.connects, 1);
  assert.equal(server.state.requests.filter(({ method }) => method === 'tools/list').length, 1);
});

test('schemas load lazily, validate arguments before dispatch, and forward valid calls', async () => {
  const server = fixtureServer({ name: 'issues', tools: [tool('read', 'read issue', {
    type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1 } },
  })] });
  const gateway = createLazyMcpGateway({ enabled: true, allowlist: ['issues'], servers: [server] });
  const invalid = await gateway.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'issues/read', arguments: {} } });
  assert.equal(invalid.error.code, -32602);
  assert.equal(server.state.calls, 0);
  const valid = await gateway.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'issues/read', arguments: { id: 'ISSUE-1' } } });
  assert.equal(valid.result.content[0].text, 'ok');
  assert.equal(server.state.calls, 1);
});

test('advertises and dispatches the strict generic catalog call tool', async () => {
  const server = fixtureServer({ name: 'issues', tools: [tool('read', 'read issue', {
    type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1 } },
  })] });
  const gateway = createLazyMcpGateway({ enabled: true, allowlist: ['issues'], servers: [server] });
  await gateway.catalog('read');
  const listed = await gateway.handle({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
  const generic = listed.result.tools.find(({ name }) => name === 'sando_call');
  assert.ok(generic);
  assert.deepEqual(generic.inputSchema.required, ['name', 'arguments']);
  assert.equal(generic.inputSchema.additionalProperties, false);
  assert.equal(generic.inputSchema.properties.name.pattern, '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$');

  const valid = await gateway.handle({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: {
    name: 'sando_call', arguments: { name: 'issues/read', arguments: { id: 'ISSUE-1' } },
  } });
  assert.equal(valid.result.content[0].text, 'ok');
  assert.equal(server.state.calls, 1);

  const invalid = await gateway.handle({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: {
    name: 'sando_call', arguments: { name: 'issues/read', arguments: {} },
  } });
  assert.equal(invalid.error.code, -32602);
  assert.equal(server.state.calls, 1);

  const rejected = await gateway.handle({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: {
    name: 'sando_call', arguments: { name: 'hidden/delete', arguments: {} },
  } });
  assert.equal(rejected.error.code, -32602);
  assert.equal(server.state.calls, 1);
});

test('emits content-free F4 events for catalog and downstream calls', async () => {
  const events = [];
  const server = fixtureServer({ name: 'issues', tools: [tool('read', 'read issue')] });
  const gateway = createLazyMcpGateway({
    enabled: true,
    allowlist: ['issues'],
    servers: [server],
    onF4Event: (event) => events.push(event),
  });

  await gateway.handle({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'sando_catalog', arguments: {} } });
  await gateway.handle({ jsonrpc: '2.0', id: 16, method: 'tools/call', params: {
    name: 'sando_call', arguments: { name: 'issues/read', arguments: {} },
  } });

  assert.deepEqual(events.map(({ operation, outcome, resultCount, capabilityDigest }) => ({
    operation, outcome, resultCount, capabilityDigest,
  })), [
    { operation: 'catalog', outcome: 'success', resultCount: 1, capabilityDigest: null },
    { operation: 'call', outcome: 'success', resultCount: null, capabilityDigest: digestCapability('issues/read') },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /issues\/read/);
});

test('validates sando_catalog arguments and rejects invalid input with -32602', async () => {
  const server = fixtureServer({ name: 'issues', tools: [] });
  const gateway = createLazyMcpGateway({ enabled: true, allowlist: ['issues'], servers: [server] });
  for (const arguments_ of [{ query: 1 }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { extra: true }, []]) {
    const result = await gateway.handle({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'sando_catalog', arguments: arguments_ } });
    assert.equal(result.error.code, -32602, JSON.stringify(arguments_));
  }
  const valid = await gateway.handle({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'sando_catalog', arguments: { query: 'issue', limit: 1 } } });
  assert.equal(valid.result.content[0].text, '[]');
});

test('fails closed for unsupported schema assertions and unknown types', () => {
  assert.equal(validateJsonSchema({ type: 'string', format: 'uuid' }, 'not-a-uuid').valid, false);
  assert.match(validateJsonSchema({ type: 'string', format: 'uuid' }, 'not-a-uuid').message, /unsupported.*format/i);
  assert.equal(validateJsonSchema({ type: 'object', properties: { value: { type: 'mystery' } } }, { value: 'ok' }).valid, false);
  assert.equal(validateJsonSchema({ type: 'object', additionalProperties: { type: 'string' } }, { value: 1 }).valid, false);
});

test('rejects non-positive, non-finite, and duplicate gateway configuration names', () => {
  const server = fixtureServer({ name: 'issues', tools: [] });
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createLazyMcpGateway({ enabled: true, allowlist: ['issues'], servers: [server], timeoutMs }), /timeout/i);
  }
  assert.throws(() => createLazyMcpGateway({ enabled: true, allowlist: ['issues', 'issues'], servers: [server] }), /allowlist.*duplicate/i);
  assert.throws(() => createLazyMcpGateway({ enabled: true, allowlist: ['issues'], servers: [server, { ...server }] }), /servers.*duplicate/i);
});

test('lifecycle, timeout, cancellation, progress, downstream errors, and list changes are preserved', async () => {
  const events = [];
  const f4Events = [];
  const server = fixtureServer({ name: 'stream', tools: [tool('run', 'run stream')], onCall: async (_params, { signal, notify }) => {
    notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } });
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 50); signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); }); });
    return { content: [{ type: 'text', text: 'done' }] };
  } });
  const gateway = createLazyMcpGateway({ enabled: true, allowlist: ['stream'], servers: [server], timeoutMs: 10, onMessage: (message) => events.push(message), onF4Event: (event) => f4Events.push(event) });
  const timed = await gateway.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stream/run', arguments: {} } });
  assert.equal(timed.error.code, -32001);
  assert.equal(f4Events.at(-1).outcome, 'timeout');
  assert.ok(events.some((message) => message.method === 'notifications/progress'));
  assert.ok(server.state.notifications.some((message) => message.method === 'notifications/cancelled'));

  const changed = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };
  server.emit(changed);
  assert.ok(events.includes(changed));
  assert.equal((await gateway.handle({ jsonrpc: '2.0', id: 5, method: 'ping' })).result && typeof (await gateway.handle({ jsonrpc: '2.0', id: 6, method: 'ping' })).result, 'object');
});

test('downstream errors and unsupported server requests fail closed', async () => {
  const server = fixtureServer({ name: 'safe', tools: [tool('fail', 'fail')], onCall: async () => ({ jsonrpc: '2.0', id: 7, error: { code: -32042, message: 'downstream denied', data: { approval: 'required' } } }) });
  const gateway = createLazyMcpGateway({ enabled: true, allowlist: ['safe'], servers: [server] });
  const response = await gateway.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'safe/fail', arguments: {} } });
  assert.equal(response.error.code, -32042);
  assert.match(response.error.message, /downstream denied/);

  const unsafe = fixtureServer({ name: 'unsafe', tools: [tool('ask', 'ask')], onCall: async (_params, { onMessage }) => onMessage({ jsonrpc: '2.0', id: 'server-1', method: 'elicitation/create', params: {} }) });
  const unsafeGateway = createLazyMcpGateway({ enabled: true, allowlist: ['unsafe'], servers: [unsafe] });
  assert.equal((await unsafeGateway.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'unsafe/ask', arguments: {} } })).error.code, -32003);
  assert.equal((await gateway.handle({ jsonrpc: '2.0', id: 8, method: 'unknown' })).error.code, -32601);
});

test('unsupported downstream auth, approval, and elicitation notifications are not forwarded', async () => {
  const events = [];
  const server = fixtureServer({ name: 'blocked', tools: [tool('ask', 'ask')], onCall: async (_params, { onMessage }) => {
    for (const method of ['auth/required', 'approval/required', 'elicitation/create']) {
      onMessage({ jsonrpc: '2.0', method, params: {} });
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  } });
  const gateway = createLazyMcpGateway({ enabled: true, allowlist: ['blocked'], servers: [server], onMessage: (message) => events.push(message) });

  const response = await gateway.handle({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'blocked/ask', arguments: {} } });
  assert.equal(response.result.content[0].text, 'ok');
  assert.deepEqual(events, []);
});

test('disabled gateway is a safe kill switch', async () => {
  const server = fixtureServer({ name: 'off', tools: [tool('read', 'read')] });
  const gateway = createLazyMcpGateway({ enabled: false, allowlist: ['off'], servers: [server] });
  assert.equal((await gateway.handle({ jsonrpc: '2.0', id: 9, method: 'initialize' })).error.code, -32004);
  assert.deepEqual(await gateway.catalog('read'), []);
  assert.equal(server.state.connects, 0);
});
