import { digestCapability } from './f4-telemetry.mjs';

export const LAZY_MCP_GATEWAY_SCHEMA = 'sando-lazy-mcp-gateway/v1';
export const GATEWAY_CATALOG_TOOL = 'sando_catalog';
export const GATEWAY_CALL_TOOL = 'sando_call';
const MAX_CATALOG_RESULTS = 50;
const GATEWAY_CATALOG_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    query: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_CATALOG_RESULTS },
  },
};
const GATEWAY_CALL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name', 'arguments'],
  properties: {
    name: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
    arguments: { type: 'object', additionalProperties: true },
  },
};
function unsupportedDownstreamMethod(method) {
  return method === 'sampling/createMessage' || /(?:^|\/)(?:auth|approval|elicitation)(?:\/|$)/.test(method);
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message, data) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }; }
function tokens(value) { return String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []; }
function safeCapabilityDigest(value) {
  try { return typeof value === 'string' && value.length <= 256 ? digestCapability(value) : null; }
  catch { return null; }
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$schema', 'title', 'description', 'default', 'examples', 'deprecated',
  'type', 'const', 'enum', 'oneOf', 'anyOf', 'properties', 'required',
  'additionalProperties', 'items', 'minItems', 'minLength', 'maxLength',
  'pattern', 'minimum', 'maximum',
]);

function unsupportedSchemaKeyword(schema) {
  for (const keyword of Object.keys(schema)) if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) return keyword;
  if (schema.type !== undefined && !['object', 'array', 'string', 'integer', 'number', 'boolean'].includes(schema.type)) return `type:${String(schema.type)}`;
  if (Array.isArray(schema.type)) return 'type:array';
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') return 'additionalProperties';
  if (schema.items !== undefined && !object(schema.items)) return 'items';
  if (schema.required !== undefined && !Array.isArray(schema.required)) return 'required';
  if (schema.properties !== undefined && !object(schema.properties)) return 'properties';
  if (schema.oneOf !== undefined && !Array.isArray(schema.oneOf)) return 'oneOf';
  if (schema.anyOf !== undefined && !Array.isArray(schema.anyOf)) return 'anyOf';
  for (const child of Object.values(schema.properties ?? {})) {
    const keyword = object(child) ? unsupportedSchemaKeyword(child) : 'property-schema';
    if (keyword) return keyword;
  }
  for (const child of [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
    const keyword = object(child) ? unsupportedSchemaKeyword(child) : 'combinator-schema';
    if (keyword) return keyword;
  }
  if (object(schema.items)) return unsupportedSchemaKeyword(schema.items);
  return null;
}

function schemaError(schema, value, path = '$') {
  if (!object(schema)) return `${path} uses unsupported schema shape`;
  const unsupported = unsupportedSchemaKeyword(schema);
  if (unsupported) return `${path} uses unsupported schema keyword ${unsupported}`;
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) return `${path} must equal const`;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) return `${path} must be one of enum values`;
  if (schema.oneOf && !schema.oneOf.some((candidate) => !schemaError(candidate, value, path))) return `${path} does not match oneOf`;
  if (schema.anyOf && !schema.anyOf.some((candidate) => !schemaError(candidate, value, path))) return `${path} does not match anyOf`;
  if (schema.type === 'object') {
    if (!object(value)) return `${path} must be an object`;
    for (const name of schema.required ?? []) if (!(name in value)) return `${path}.${name} is required`;
    if (schema.additionalProperties === false) for (const name of Object.keys(value)) if (!schema.properties?.[name]) return `${path}.${name} is not allowed`;
    for (const [name, child] of Object.entries(schema.properties ?? {})) if (name in value) { const error = schemaError(child, value[name], `${path}.${name}`); if (error) return error; }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} has too few items`;
    for (let i = 0; i < value.length; i += 1) { const error = schemaError(schema.items, value[i], `${path}[${i}]`); if (error) return error; }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} must be a string`;
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is too long`;
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) return `${path} has an invalid format`;
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) return `${path} must be an integer`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} is below minimum`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} is above maximum`;
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a number`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} is below minimum`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} is above maximum`;
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') return `${path} must be a boolean`;
  return null;
}

export function validateJsonSchema(schema, value) {
  const message = schemaError(schema, value);
  return message ? { valid: false, message } : { valid: true };
}

function validateConfig(config) {
  if (!object(config) || typeof config.enabled !== 'boolean' || !Array.isArray(config.allowlist) || !Array.isArray(config.servers)) throw new TypeError('gateway requires enabled, allowlist, and servers');
  if (new Set(config.allowlist).size !== config.allowlist.length) throw new TypeError('gateway allowlist contains duplicate names');
  const allowlist = new Set(config.allowlist);
  if ([...allowlist].some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name))) throw new TypeError('gateway allowlist contains an invalid server');
  const servers = new Map();
  for (const server of config.servers) {
    if (!object(server) || typeof server.name !== 'string' || typeof server.connect !== 'function') throw new TypeError('gateway server requires name and connect');
    if (servers.has(server.name)) throw new TypeError('gateway servers contain duplicate names');
    if (allowlist.has(server.name)) servers.set(server.name, server);
  }
  if ([...allowlist].some((name) => !servers.has(name))) throw new TypeError('gateway allowlist references an unconfigured server');
  const timeoutMs = config.timeoutMs ?? 30_000;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('gateway timeoutMs must be a positive finite number');
  return { ...config, allowlist, servers, timeoutMs };
}

export function createLazyMcpGateway(config) {
  const options = validateConfig(config);
  const connections = new Map();
  const tools = new Map();
  const invalidated = new Set();
  const pending = new Map();
  const connectionLocks = new Map();
  const onMessage = options.onMessage ?? (() => {});
  const onF4Event = options.onF4Event ?? (() => {});

  function emitF4Event({ operation, outcome, startedAt, resultCount = null, capabilityDigest = null }) {
    try {
      onF4Event({
        operation,
        outcome,
        latencyMs: Math.max(0, Date.now() - startedAt),
        resultCount,
        capabilityDigest,
      });
    } catch { /* tracing must never affect MCP behavior */ }
  }

  function forward(message) {
    if (message?.method && unsupportedDownstreamMethod(message.method)) {
      if (message.id !== undefined) return rpcError(message.id, -32003, 'Unsupported downstream request; gateway fails closed', { method: message.method });
      return null;
    }
    if (message?.method && message.id === undefined) { onMessage(message); return null; }
    if (message?.method && message.id !== undefined) return rpcError(message.id, -32003, 'Unsupported downstream request; gateway fails closed', { method: message.method });
    onMessage(message);
    return null;
  }
  async function connection(name) {
    if (connections.has(name)) return connections.get(name);
    if (connectionLocks.has(name)) return connectionLocks.get(name);
    const lock = connect(name);
    connectionLocks.set(name, lock);
    try { return await lock; } finally { if (connectionLocks.get(name) === lock) connectionLocks.delete(name); }
  }
  async function connect(name) {
    const server = options.servers.get(name);
    const transport = await server.connect({ onMessage: (message) => {
      if (message?.method === 'notifications/tools/list_changed') { for (const key of tools.keys()) if (key.startsWith(`${name}/`)) tools.delete(key); invalidated.add(name); }
      return forward(message);
    } });
    if (!transport || typeof transport.request !== 'function') throw new TypeError(`gateway server ${name} returned an invalid transport`);
    const init = await transport.request({ jsonrpc: '2.0', id: `init:${name}`, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, clientInfo: { name: 'sando-lazy-mcp-gateway', version: '1' } } }, { notify: forward });
    if (init?.error) throw Object.assign(new Error(init.error.message || 'downstream initialize failed'), init.error);
    const item = { server, transport };
    try {
      await loadTools(name, item);
      connections.set(name, item);
      return item;
    } catch (error) {
      await transport.close?.();
      throw error;
    }
  }
  async function loadTools(name, item) {
    const result = await item.transport.request({ jsonrpc: '2.0', id: `list:${name}:${Date.now()}`, method: 'tools/list', params: {} }, { notify: forward });
    if (result?.error) throw Object.assign(new Error(result.error.message || 'downstream tools/list failed'), result.error);
    for (const descriptor of result?.result?.tools ?? []) {
      if (!object(descriptor) || typeof descriptor.name !== 'string' || !object(descriptor.inputSchema)) continue;
      tools.set(`${name}/${descriptor.name}`, { ...descriptor, server: name, capability: descriptor.name });
    }
  }
  async function catalog(query = '', limit = MAX_CATALOG_RESULTS) {
    const startedAt = Date.now();
    if (!options.enabled) {
      emitF4Event({ operation: 'catalog', outcome: 'rejected', startedAt });
      return [];
    }
    try {
      const queryTokens = tokens(query);
      const records = [];
      for (const name of options.allowlist) {
        const item = await connection(name);
        if (invalidated.delete(name)) await loadTools(name, item);
        for (const [qualified, descriptor] of tools) if (descriptor.server === name) {
          const text = tokens(`${qualified} ${descriptor.description ?? ''} ${name} ${(options.servers.get(name).capabilities ?? []).join(' ')}`);
          const score = queryTokens.reduce((total, token) => total + (text.includes(token) ? 1 : 0), 0);
          if (!queryTokens.length || score) records.push({ namespace: name, description: String(descriptor.description ?? '').slice(0, 160), server: name, capability: descriptor.capability, name: qualified, score });
        }
      }
      const result = records.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, Math.min(limit, MAX_CATALOG_RESULTS)).map(({ score, ...record }) => record);
      emitF4Event({ operation: 'catalog', outcome: 'success', startedAt, resultCount: result.length });
      return result;
    } catch (error) {
      emitF4Event({ operation: 'catalog', outcome: 'error', startedAt });
      throw error;
    }
  }
  async function call(message) {
    const startedAt = Date.now();
    const qualified = message.params?.name;
    const capabilityDigest = safeCapabilityDigest(qualified);
    const serverName = typeof qualified === 'string' ? qualified.split('/')[0] : '';
    const controller = new AbortController();
    let timer;
    const finish = (result, outcome) => {
      emitF4Event({ operation: 'call', outcome, startedAt, capabilityDigest });
      return result;
    };
    try {
      if (!options.allowlist.has(serverName)) return finish(rpcError(message.id, -32602, 'Unknown or undiscovered tool'), 'rejected');
      await connection(serverName);
      const descriptor = tools.get(qualified);
      if (!descriptor) return finish(rpcError(message.id, -32602, 'Unknown or undiscovered tool'), 'rejected');
      const validation = validateJsonSchema(descriptor.inputSchema, message.params?.arguments ?? {});
      if (!validation.valid) return finish(rpcError(message.id, -32602, `Invalid tool arguments: ${validation.message}`), 'rejected');
      const item = await connection(descriptor.server);
      pending.set(message.id, { controller, item });
      timer = setTimeout(() => {
        controller.abort(Object.assign(new Error('gateway request timeout'), { code: -32001 }));
        item.transport.notify?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: message.id, reason: 'timeout' } });
      }, options.timeoutMs);
      const result = await item.transport.request({ ...message, params: { ...message.params, name: descriptor.capability } }, { signal: controller.signal, notify: forward });
      if (result?.error) return finish(rpcError(message.id, result.error.code ?? -32000, result.error.message ?? 'Downstream MCP error', result.error.data), 'error');
      return finish(response(message.id, result?.result ?? result), 'success');
    } catch (error) {
      const code = controller.signal.aborted ? -32001 : (error.code === 'CANCELLED' ? -32800 : (Number.isInteger(error.code) ? error.code : -32000));
      const outcome = controller.signal.aborted
        ? (controller.signal.reason?.code === -32001 ? 'timeout' : 'cancelled')
        : error.code === 'CANCELLED' ? 'cancelled' : 'error';
      return finish(rpcError(message.id, code, controller.signal.aborted ? 'Gateway request timed out or was cancelled' : error.message || 'Downstream MCP request failed', error.data), outcome);
    } finally { clearTimeout(timer); pending.delete(message.id); }
  }
  async function handle(message) {
    if (!options.enabled) return rpcError(message?.id, -32004, 'Lazy MCP gateway is disabled');
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id, -32600, 'Invalid Request');
    if (message.method === 'notifications/cancelled') {
      const request = pending.get(message.params?.requestId);
      if (request) { request.controller.abort(new Error('gateway request cancelled')); await request.item.transport.notify?.(message); }
      return null;
    }
    if (message.id === undefined) { if (message.method === 'notifications/initialized') return null; return rpcError(null, -32601, 'Method not found'); }
    if (message.method === 'initialize') return response(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'sando-lazy-mcp-gateway', version: '1' } });
    if (message.method === 'ping') return response(message.id, {});
    if (message.method === 'sando/catalog') {
      const arguments_ = message.params ?? {};
      const validation = validateJsonSchema(GATEWAY_CATALOG_SCHEMA, arguments_);
      if (!validation.valid) {
        emitF4Event({ operation: 'catalog', outcome: 'rejected', startedAt: Date.now() });
        return rpcError(message.id, -32602, `Invalid catalog arguments: ${validation.message}`);
      }
      return response(message.id, { schema: LAZY_MCP_GATEWAY_SCHEMA, entries: await catalog(arguments_.query, arguments_.limit) });
    }
    if (message.method === 'tools/list') return response(message.id, { tools: [
      { name: GATEWAY_CATALOG_TOOL, description: 'Search the explicit allowlisted MCP catalog.', inputSchema: GATEWAY_CATALOG_SCHEMA },
      { name: GATEWAY_CALL_TOOL, description: 'Call one exact qualified name returned by sando_catalog.', inputSchema: GATEWAY_CALL_SCHEMA },
    ] });
    if (message.method === 'tools/call' && message.params?.name === GATEWAY_CATALOG_TOOL) {
      const arguments_ = message.params.arguments === undefined ? {} : message.params.arguments;
      const validation = validateJsonSchema(GATEWAY_CATALOG_SCHEMA, arguments_);
      if (!validation.valid) {
        emitF4Event({ operation: 'catalog', outcome: 'rejected', startedAt: Date.now() });
        return rpcError(message.id, -32602, `Invalid catalog arguments: ${validation.message}`);
      }
      return response(message.id, { content: [{ type: 'text', text: JSON.stringify(await catalog(arguments_.query, arguments_.limit)) }] });
    }
    if (message.method === 'tools/call' && message.params?.name === GATEWAY_CALL_TOOL) {
      const validation = validateJsonSchema(GATEWAY_CALL_SCHEMA, message.params?.arguments);
      if (!validation.valid) {
        emitF4Event({ operation: 'call', outcome: 'rejected', startedAt: Date.now(), capabilityDigest: safeCapabilityDigest(message.params?.arguments?.name) });
        return rpcError(message.id, -32602, `Invalid tool arguments: ${validation.message}`);
      }
      return call({ ...message, params: { ...message.params, name: message.params.arguments.name, arguments: message.params.arguments.arguments } });
    }
    if (message.method === 'tools/call') return call(message);
    return rpcError(message.id, -32601, 'Method not found');
  }
  return Object.freeze({ handle, catalog, validateJsonSchema, close: async () => { for (const { transport } of connections.values()) await transport.close?.(); connections.clear(); tools.clear(); } });
}
