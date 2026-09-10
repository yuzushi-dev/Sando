import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { loadProjectRedactionProfile } from './redaction-config.mjs';
import { PLUGIN_VERSION } from './version.mjs';

const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const REPLACE_ANNOTATIONS = { ...WRITE_ANNOTATIONS, destructiveHint: true };
const INTEGER = { type: 'integer', minimum: 1 };
const MAX_FETCH_LINES = 400;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const HANDLE_PATTERN = '^sym#[a-f0-9]{16}@[a-f0-9]{16}$';
const HANDLE_RE = new RegExp(HANDLE_PATTERN);

const definitions = [
  {
    name: 'sando_slice_for', upstream: 'for', write: false,
    description: 'Discover task-relevant symbols from the configured workspace. Returns native content and index freshness metadata unchanged.',
    required: ['task'], properties: { task: { type: 'string', minLength: 1 }, budget_tokens: INTEGER }, annotations: READ_ANNOTATIONS,
  },
  {
    name: 'sando_slice_find_symbol', upstream: 'find_symbol', write: false,
    description: 'Find one symbol and its direct callers and callees. Preserves handles, ambiguity, floors, and index freshness metadata.',
    required: ['symbol'], properties: { symbol: { type: 'string', minLength: 1 }, limit: INTEGER, offset: { type: 'integer', minimum: 0 } }, annotations: READ_ANNOTATIONS,
  },
  {
    name: 'sando_slice_find_referencing_symbols', upstream: 'find_referencing_symbols', write: false,
    description: 'Find direct referencing symbols. Preserves handles, ambiguity, floors, and index freshness metadata.',
    required: ['symbol'], properties: { symbol: { type: 'string', minLength: 1 }, limit: INTEGER, offset: { type: 'integer', minimum: 0 } }, annotations: READ_ANNOTATIONS,
  },
  {
    name: 'sando_slice_fetch_body', upstream: 'fetch_body', write: false,
    description: `Fetch source for a symbol handle, bounded to at most ${MAX_FETCH_LINES} body-relative lines. Stale and ambiguous handles are refused.`,
    required: ['handle'], properties: { handle: { type: 'string', pattern: HANDLE_PATTERN }, start_line: INTEGER, end_line: INTEGER }, annotations: READ_ANNOTATIONS,
  },
  {
    name: 'sando_slice_replace_symbol_body', upstream: 'replace_symbol_body', write: true,
    description: 'Replace exactly the definition span returned by sando_slice_fetch_body. Modifiers outside that span are preserved; do not repeat them in new_body. Requires a fresh handle and SANDO_SLICE_WRITE=1.',
    required: ['handle', 'new_body'], properties: { handle: { type: 'string', pattern: HANDLE_PATTERN }, new_body: { type: 'string', minLength: 1 }, post_check: { type: 'boolean' } }, annotations: REPLACE_ANNOTATIONS,
  },
  {
    name: 'sando_slice_insert_after_symbol', upstream: 'insert_after_symbol', write: true,
    description: 'Insert text after the definition identified by a fresh handle. Requires SANDO_SLICE_WRITE=1; the native engine owns stale-handle refusal, newline handling, and atomic writes.',
    required: ['handle', 'text'], properties: { handle: { type: 'string', pattern: HANDLE_PATTERN }, text: { type: 'string', minLength: 1 }, post_check: { type: 'boolean' } }, annotations: WRITE_ANNOTATIONS,
  },
];

const byName = new Map(definitions.map((definition) => [definition.name, definition]));

export class SliceRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'SliceRpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function configurationError(message) { return new SliceRpcError(-32603, message); }

function configuration(env) {
  const binarySetting = env?.SANDO_SLICE_BINARY;
  if (typeof binarySetting !== 'string' || !path.isAbsolute(binarySetting) || binarySetting.includes('\0')) {
    throw configurationError('SANDO_SLICE_BINARY must be an absolute executable file');
  }
  let executable;
  try {
    executable = fs.realpathSync(binarySetting);
    const stat = fs.statSync(executable);
    if (!stat.isFile()) throw new Error('not a file');
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    throw configurationError('SANDO_SLICE_BINARY must be an absolute executable file');
  }

  const rootSetting = env?.SANDO_SLICE_ROOT;
  if (typeof rootSetting !== 'string' || !path.isAbsolute(rootSetting) || rootSetting.includes('\0')) {
    throw configurationError('SANDO_SLICE_ROOT must be an absolute canonical directory');
  }
  let root;
  try {
    root = fs.realpathSync(rootSetting);
    const stat = fs.lstatSync(rootSetting);
    if (!stat.isDirectory() || stat.isSymbolicLink() || root !== path.resolve(rootSetting)) throw new Error('not canonical');
  } catch {
    throw configurationError('SANDO_SLICE_ROOT must be an absolute canonical directory');
  }
  return { executable, root };
}

function publicTool({ name, description, required, properties, annotations }) {
  return { name, description, inputSchema: { type: 'object', additionalProperties: false, required, properties }, annotations };
}

export function SLICE_TOOLS(env = process.env) {
  try { configuration(env); } catch { return []; }
  return definitions.filter((definition) => !definition.write || env?.SANDO_SLICE_WRITE === '1').map(publicTool);
}

export function spawnSliceProcess({ executable, root }) {
  return spawn(executable, [root, '--mcp'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

class SliceSession {
  constructor(child) {
    if (!child?.stdin || !child?.stdout || !child?.stderr) throw configurationError('Slice backend did not provide stdio pipes');
    this.child = child;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.stdout = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => this.consume(Buffer.from(chunk)));
    child.stderr.resume();
    child.stdin.on('error', (error) => this.close(configurationError(`Slice backend stdin failed: ${error.message}`)));
    child.on('error', (error) => this.close(configurationError(`Slice backend unavailable: ${error.message}`)));
    child.on('exit', (code, signal) => this.fail(configurationError(
      `Slice backend exited before replying (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
    )));
  }

  async initialize(context) {
    const result = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'sando', version: PLUGIN_VERSION },
    }, context);
    if (!result || typeof result !== 'object' || typeof result.protocolVersion !== 'string'
      || !result.capabilities || typeof result.capabilities !== 'object'
      || !result.serverInfo || typeof result.serverInfo.name !== 'string') {
      const error = configurationError('Slice backend returned an invalid initialize result');
      this.close(error);
      throw error;
    }
    this.notify('notifications/initialized', {});
  }

  request(method, params, { signal, deadline } = {}) {
    if (this.closed) return Promise.reject(configurationError('Slice backend is closed'));
    if (signal?.aborted) return Promise.reject(new SliceRpcError(-32800, 'Slice request cancelled'));
    const remaining = (deadline ?? Date.now() + REQUEST_TIMEOUT_MS) - Date.now();
    if (remaining <= 0) return Promise.reject(configurationError('Slice request timed out before execution'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const error = new SliceRpcError(-32800, 'Slice request cancelled');
        this.close(error);
      };
      if (signal) signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => this.close(configurationError('Slice request timed out')), remaining);
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); },
      });
      this.write({ jsonrpc: '2.0', id, method, params }, id);
    });
  }

  consume(chunk) {
    this.stdout = Buffer.concat([this.stdout, chunk]);
    while (true) {
      const newline = this.stdout.indexOf(0x0a);
      if (newline < 0) {
        if (this.stdout.length > MAX_RESPONSE_BYTES) this.close(configurationError(`Slice response exceeded ${MAX_RESPONSE_BYTES} bytes`));
        return;
      }
      if (newline > MAX_RESPONSE_BYTES) {
        this.close(configurationError(`Slice response exceeded ${MAX_RESPONSE_BYTES} bytes`));
        return;
      }
      const line = this.stdout.subarray(0, newline).toString('utf8');
      this.stdout = this.stdout.subarray(newline + 1);
      this.receive(line);
      if (this.closed) return;
    }
  }

  notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }

  write(message, id) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (!error || id === undefined) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.close(configurationError(`Slice request write failed: ${error.message}`));
    });
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { this.close(configurationError('Slice backend returned invalid JSON')); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.close(configurationError('Slice backend returned an invalid JSON-RPC envelope'));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.cleanup();
    if (message.error) pending.reject(new SliceRpcError(message.error.code, message.error.message, message.error.data));
    else pending.resolve(message.result);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  close(error = configurationError('Slice backend closed')) {
    if (this.closed) return;
    this.fail(error);
    this.child.kill();
  }
}

function argumentsFor(definition, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
    throw new SliceRpcError(-32602, 'Slice arguments must be an object');
  }
  const allowed = new Set(Object.keys(definition.properties));
  for (const key of Reflect.ownKeys(args)) {
    if (typeof key !== 'string') throw new SliceRpcError(-32602, 'unknown Slice argument');
    if (!allowed.has(key)) throw new SliceRpcError(-32602, `unknown argument: ${key}`);
  }
  for (const key of definition.required) {
    if (!Object.hasOwn(args, key)) throw new SliceRpcError(-32602, `missing required argument: ${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const schema = definition.properties[key];
    const validType = schema.type === 'string' ? typeof value === 'string'
      : schema.type === 'integer' ? Number.isSafeInteger(value)
        : schema.type === 'boolean' ? typeof value === 'boolean'
          : false;
    if (!validType
      || (schema.minLength !== undefined && value.length < schema.minLength)
      || (schema.minimum !== undefined && value < schema.minimum)
      || (schema.pattern !== undefined && !(new RegExp(schema.pattern)).test(value))) {
      throw new SliceRpcError(-32602, `invalid argument: ${key}`);
    }
  }
  const forwarded = { ...args };
  if (definition.upstream === 'fetch_body') {
    const start = forwarded.start_line ?? 1;
    const end = forwarded.end_line ?? (start + MAX_FETCH_LINES - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start + 1 > MAX_FETCH_LINES) {
      throw new SliceRpcError(-32602, `fetch_body range must span 1..${MAX_FETCH_LINES} positive body-relative lines`);
    }
    forwarded.start_line = start;
    forwarded.end_line = end;
  }
  if (definition.write) {
    if (typeof forwarded.handle !== 'string' || !HANDLE_RE.test(forwarded.handle)) {
      throw new SliceRpcError(-32602, 'Slice writes require a fresh handle from sando_slice_find_symbol');
    }
    forwarded.symbol = forwarded.handle;
    delete forwarded.handle;
  }
  return forwarded;
}

export function isSliceTool(name) { return byName.has(name); }

function resolveRedactionProfile(root) {
  try {
    return loadProjectRedactionProfile(root).profile;
  } catch (error) {
    throw configurationError(`Slice redaction config is invalid: ${error.message}`);
  }
}

function redactError(error, profile) {
  const message = profile.redact(error instanceof Error ? error.message : String(error)).text;
  let data;
  if (error?.data !== undefined) data = profile.redactStructured(error.data).value;
  return new SliceRpcError(Number.isInteger(error?.code) ? error.code : -32603, message, data);
}

function redactContentText(text, profile) {
  try {
    const redacted = profile.redactStructured(JSON.parse(text));
    return { value: JSON.stringify(redacted.value), count: redacted.count };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const redacted = profile.redact(text);
    return { value: redacted.text, count: redacted.count };
  }
}

function redactResult(result, profile) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(result))) {
    throw configurationError('Slice backend returned an invalid tool result');
  }
  const outer = profile.redactStructured(Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== 'content'),
  ));
  let count = outer.count;
  let content;
  if (Object.hasOwn(result, 'content')) {
    if (!Array.isArray(result.content)) throw configurationError('Slice backend returned invalid tool content');
    content = result.content.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
          || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
        throw configurationError('Slice backend returned invalid tool content');
      }
      const metadata = profile.redactStructured(Object.fromEntries(
        Object.entries(item).filter(([key]) => key !== 'text'),
      ));
      count += metadata.count;
      if (!Object.hasOwn(item, 'text')) return metadata.value;
      if (typeof item.text !== 'string') throw configurationError('Slice backend returned invalid tool content');
      const text = redactContentText(item.text, profile);
      count += text.count;
      return { ...metadata.value, text: text.value };
    });
  }
  const value = { ...outer.value, ...(content === undefined ? {} : { content }) };
  if (count === 0) return { value, count };
  return {
    count,
    value: {
      ...value,
      _sando_redaction: {
        count,
        source_round_trip: false,
        message: 'Redacted source is not round-trippable and cannot be used for symbol replacement.',
      },
    },
  };
}

export function createSliceBridge({
  env = process.env,
  spawnBackend = spawnSliceProcess,
  contextKey = () => '',
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw configurationError('Slice requestTimeoutMs must be a positive integer');
  }
  let session;
  let sessionKey;
  let queue = Promise.resolve();
  let closed = false;
  const redactedHandles = new Set();

  async function invoke(name, args, context) {
    if (closed) throw configurationError('Slice bridge is closed');
    if (context.signal?.aborted) throw new SliceRpcError(-32800, 'Slice request cancelled');
    if (Date.now() >= context.deadline) throw configurationError('Slice request timed out before execution');
    const definition = byName.get(name);
    if (!definition) throw new SliceRpcError(-32602, 'Unknown Slice tool');
    const forwarded = argumentsFor(definition, args);
    if (definition.write && env?.SANDO_SLICE_WRITE !== '1') {
      throw new SliceRpcError(-32602, 'Slice writes are disabled; set SANDO_SLICE_WRITE=1 to enable them');
    }
    const config = configuration(env);
    const profile = resolveRedactionProfile(config.root);
    if (definition.upstream === 'replace_symbol_body' && redactedHandles.has(args.handle)) {
      throw new SliceRpcError(-32602, 'Slice fetched redacted source is not round-trippable; fetch an unredacted handle before writing');
    }
    const key = `${config.executable}\0${config.root}\0${contextKey(context)}`;
    try {
      if (!session || session.closed || key !== sessionKey) {
        session?.close();
        session = new SliceSession(spawnBackend(config, context));
        sessionKey = key;
        await session.initialize(context);
      }
      const result = await session.request('tools/call', { name: definition.upstream, arguments: forwarded }, context);
      const redacted = redactResult(result, profile);
      if (definition.upstream === 'fetch_body' && redacted.count > 0) redactedHandles.add(args.handle);
      return redacted.value;
    } catch (error) {
      throw redactError(error, profile);
    }
  }

  return {
    call(name, args = {}, context = {}) {
      if (closed) return Promise.reject(configurationError('Slice bridge is closed'));
      if (context.signal?.aborted) return Promise.reject(new SliceRpcError(-32800, 'Slice request cancelled'));
      const deadline = Date.now() + requestTimeoutMs;
      const admitted = { ...context, deadline };
      let timer;
      let abort;
      const waiting = new Promise((_, reject) => {
        timer = setTimeout(() => reject(configurationError('Slice request timed out')), requestTimeoutMs);
        if (context.signal) {
          abort = () => reject(new SliceRpcError(-32800, 'Slice request cancelled'));
          context.signal.addEventListener('abort', abort, { once: true });
        }
      });
      const result = queue.then(() => invoke(name, args, admitted));
      queue = result.catch(() => {});
      return Promise.race([result, waiting]).finally(() => {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', abort);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      session?.close();
      session = undefined;
      sessionKey = undefined;
    },
  };
}
