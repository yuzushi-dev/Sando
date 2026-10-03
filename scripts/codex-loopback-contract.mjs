#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CODEX = process.env.SANDO_CODEX_BIN || 'codex';
const repoRoot = path.resolve(import.meta.dirname, '..');
const adapterRoot = path.join(repoRoot, 'adapters/codex/sando');
const outputFixturePath = path.join(repoRoot, 'packages/sando/tests/codex-compat/mcp-output.synthetic.json');
const outputServerPath = path.join(repoRoot, 'packages/sando/tests/fixtures/mcp-output-contract-server.mjs');
const hookCliPath = path.join(repoRoot, 'packages/sando/src/hook-cli.mjs');
const outputTransformCliPath = path.join(adapterRoot, 'lib/output-transform-cli.mjs');
const sandoMcpServerPath = path.join(adapterRoot, 'mcp/server.mjs');
const OUTPUT_CONTRACT_SCHEMA = 'sando-openai-output-contract/v1';
const RECOVERY_CONTRACT_SCHEMA = 'sando-codex-recovery-contract/v1';
const RECOVERY_TOOL_IDENTITY = 'mcp__sando__sando_artifact_get';
const VERIFIER_VERSION = '1.0.0';
const PINNED_CODEX_REFERENCE = Object.freeze({
  tag: 'rust-v0.160.0',
  commit: 'a956835d020762cb2b570053af06f643a11c0ecc',
});
const DEFAULT_CAPTURE_LIMITS = Object.freeze({
  processStdoutBytes: 4 * 1024 * 1024,
  processStderrBytes: 1024 * 1024,
  appServerStderrBytes: 1024 * 1024,
  appServerLineBytes: 4 * 1024 * 1024,
  appServerQueueEntries: 256,
  appServerQueueBytes: 512 * 1024,
  providerRequestBytes: 8 * 1024 * 1024,
  providerTotalBytes: 32 * 1024 * 1024,
});

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function captureLimits(overrides = {}) {
  const limits = { ...DEFAULT_CAPTURE_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${key} must be a positive safe integer`);
  }
  return limits;
}

export function createBoundedCapture(maxBytes, onOverflow = () => {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer');
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  return {
    push(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = maxBytes - bytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        chunks.push(retained);
        bytes += retained.byteLength;
      }
      if (chunk.byteLength > remaining && !overflow) {
        overflow = true;
        onOverflow();
      }
    },
    buffer: () => Buffer.concat(chunks, bytes),
    summary: () => ({ bytes, overflow }),
    get bytes() { return bytes; },
    get overflow() { return overflow; },
  };
}

function boundedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writeSse(response, events) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  let index = 0;
  const send = () => {
    if (index === events.length) { response.end(); return; }
    response.write(`event: ${events[index].type}\ndata: ${JSON.stringify(events[index])}\n\n`);
    index += 1;
    setTimeout(send, 12);
  };
  send();
}

function completedResponse(id, output) {
  return {
    id,
    object: 'response',
    created_at: 0,
    status: 'completed',
    model: 'sando-loopback',
    output,
    parallel_tool_calls: false,
    tool_choice: 'auto',
    usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
  };
}

function toolEvents(sequence, name, argumentsValue, namespace) {
  const responseId = `resp_tool_${sequence}`;
  const callId = `call_${sequence}`;
  const item = { id: `item_${sequence}`, type: 'function_call', status: 'completed', name, ...(namespace ? { namespace } : {}), call_id: callId, arguments: JSON.stringify(argumentsValue) };
  return [
    { type: 'response.created', response: { ...completedResponse(responseId, []), status: 'in_progress' }, sequence_number: 0 },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' }, sequence_number: 1 },
    { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments, sequence_number: 2 },
    { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments, sequence_number: 3 },
    { type: 'response.output_item.done', output_index: 0, item, sequence_number: 4 },
    { type: 'response.completed', response: completedResponse(responseId, [item]), sequence_number: 5 },
  ];
}

function messageEvents(sequence, text) {
  const responseId = `resp_message_${sequence}`;
  const item = { id: `message_${sequence}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
  return [
    { type: 'response.created', response: { ...completedResponse(responseId, []), status: 'in_progress' }, sequence_number: 0 },
    { type: 'response.output_item.done', output_index: 0, item, sequence_number: 1 },
    { type: 'response.completed', response: completedResponse(responseId, [item]), sequence_number: 2 },
  ];
}

function customToolEvents(sequence, name, input, namespace) {
  const responseId = `resp_custom_${sequence}`;
  const callId = `custom_call_${sequence}`;
  const item = { id: `custom_item_${sequence}`, type: 'custom_tool_call', status: 'completed', name, ...(namespace ? { namespace } : {}), call_id: callId, input };
  return [
    { type: 'response.created', response: { ...completedResponse(responseId, []), status: 'in_progress' }, sequence_number: 0 },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', input: '' }, sequence_number: 1 },
    { type: 'response.custom_tool_call_input.delta', item_id: item.id, output_index: 0, delta: input, sequence_number: 2 },
    { type: 'response.custom_tool_call_input.done', item_id: item.id, output_index: 0, input, sequence_number: 3 },
    { type: 'response.output_item.done', output_index: 0, item, sequence_number: 4 },
    { type: 'response.completed', response: completedResponse(responseId, [item]), sequence_number: 5 },
  ];
}

function namedTool(body, predicate) {
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (predicate(tool?.name ?? '', tool)) return tool;
    if (tool?.type === 'namespace' && Array.isArray(tool.tools)) {
      const nested = tool.tools.find((entry) => predicate(entry?.name ?? '', entry));
      if (nested) return { ...nested, type: nested.type ?? 'function', namespace: tool.name };
    }
  }
  return undefined;
}

function eventsForTool(sequence, tool, input) {
  if (tool?.type === 'custom') return customToolEvents(sequence, tool.name, String(input), tool.namespace);
  return toolEvents(sequence, tool.name, input, tool.namespace);
}

function toolFromRequest(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const candidate = tools.find((tool) => ['exec_command', 'shell_command', 'Bash'].includes(tool?.name));
  if (!candidate) throw new Error(`no supported shell tool advertised: ${tools.map((tool) => tool?.name ?? tool?.type).join(', ')}`);
  return candidate.name;
}

function toolArguments(name, command, cwd, requireApproval) {
  const base = name === 'exec_command' ? { cmd: command, workdir: cwd } : { command, workdir: cwd };
  if (requireApproval) {
    base.sandbox_permissions = 'require_escalated';
    base.justification = 'exercise the synthetic PermissionRequest denial contract';
  }
  return base;
}

async function startProvider(workspace, { limits: limitOverrides } = {}) {
  const limits = captureLimits(limitOverrides);
  const requests = [];
  let sequence = 0;
  let overflow = false;
  let capturedBytes = 0;
  const issued = { run: 0, denial: 0, sandbox: 0 };
  const server = http.createServer((request, response) => {
    const capture = createBoundedCapture(limits.providerRequestBytes, () => { overflow = true; });
    request.on('data', (chunk) => capture.push(chunk));
    request.on('end', () => {
      if (capture.overflow || capturedBytes + capture.bytes > limits.providerTotalBytes) {
        overflow = true;
        response.writeHead(413);
        response.end('request capture limit exceeded');
        return;
      }
      capturedBytes += capture.bytes;
      if (request.method === 'GET' && request.url?.includes('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      let body;
      try { body = JSON.parse(capture.buffer().toString('utf8') || '{}'); }
      catch {
        response.writeHead(400); response.end('invalid JSON'); return;
      }
      requests.push({ method: request.method, url: request.url, body });
      sequence += 1;
      const serialized = JSON.stringify(body);
      const denied = serialized.includes('DENIAL_CASE');
      const sandbox = serialized.includes('SANDBOX_CASE');
      const hasToolOutput = serialized.includes('function_call_output');
      const shouldIssueTool = sandbox ? issued.sandbox++ === 0
        : denied ? issued.denial++ % 2 === 0
          : !serialized.includes('RESUME_CASE') && issued.run++ === 0;
      if (hasToolOutput && !shouldIssueTool) {
        writeSse(response, messageEvents(sequence, 'contract complete'));
        return;
      }
      if (serialized.includes('RESUME_CASE')) {
        writeSse(response, messageEvents(sequence, 'resume complete'));
        return;
      }
      const name = toolFromRequest(body);
      const outsideMarker = path.join(path.dirname(workspace), sandbox ? 'sandbox-outside.log' : 'denied-outside.log');
      const command = denied
        ? `printf 'forbidden\\n' > ${quote(outsideMarker)}`
        : sandbox ? `printf 'outside\\n' > ${quote(outsideMarker)}`
          : "sleep 0.2; printf 'once\\n' >> executions.log; printf 'MODEL_VISIBLE_TOKEN\\n'";
      writeSse(response, toolEvents(sequence, name, toolArguments(name, command, workspace, denied)));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, requests, get overflow() { return overflow; }, port: server.address().port };
}

export function hookWrapperSource(logPath) {
  const enforcement = pathToFileURL(path.join(adapterRoot, 'lib/enforcement.mjs')).href;
  const sessionStart = pathToFileURL(path.join(adapterRoot, 'lib/session-start.mjs')).href;
  const hookCli = pathToFileURL(hookCliPath).href;
  return `#!/usr/bin/env node
import fs from 'node:fs';
import { runPreToolUse } from ${JSON.stringify(enforcement)};
import { runSessionStart } from ${JSON.stringify(sessionStart)};
import { buildCodexFallback } from ${JSON.stringify(hookCli)};
const mode = process.argv[2];
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const record = (value) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(value) + '\\n');
if (mode === 'pre') {
  record({ mode, tool: ['Bash', 'exec_command', 'shell_command'].includes(input.tool_name) ? input.tool_name : 'other' });
  const output = runPreToolUse(input, process.env);
  record({ mode: 'pre-output', rewriteReturned: typeof output?.hookSpecificOutput?.updatedInput?.command === 'string' && output.hookSpecificOutput.updatedInput.command.includes('sando') });
  process.stdout.write(JSON.stringify(output) + '\\n');
} else if (mode === 'session') {
  record({ mode, source: ['startup', 'resume', 'clear', 'compact'].includes(input.source) ? input.source : 'other' });
  runSessionStart({ env: process.env, stdout: process.stdout });
} else if (mode === 'permission') {
  record({ mode });
  const output = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'synthetic loopback denial' } } };
  record({ mode: 'permission-output', decision: 'deny' });
  process.stdout.write(JSON.stringify(output) + '\\n');
} else if (mode === 'post-continue') {
  const output = { continue: false, stopReason: 'SANDO_BOUNDED_SENTINEL_001', reason: 'SANDO_BOUNDED_SENTINEL_001' };
  record({ mode: 'post-continue', effect: 'replacement' });
  process.stdout.write(JSON.stringify(output) + '\\n');
} else if (mode === 'post-current-fallback') {
  const output = buildCodexFallback({ optimization: { artifact: null, stats: { redactions: 0 } }, cwd: input.cwd || process.cwd() });
  record({ mode: 'post-current-fallback', effect: 'current-fallback' });
  process.stdout.write(JSON.stringify(output) + '\\n');
} else if (mode === 'post-block') {
  record({ mode: 'post-block', effect: 'blocked', exitCode: 2 });
  process.stderr.write('SANDO_BOUNDED_SENTINEL_001\\n');
  process.exitCode = 2;
} else {
  process.stdout.write('{}\\n');
}
`;
}

function outputHooksConfig(wrapper, action) {
  if (action === 'none') return null;
  const mode = action === 'block' ? 'post-block'
    : action === 'current-fallback' ? 'post-current-fallback'
      : 'post-continue';
  const command = `${quote(process.execPath)} ${quote(wrapper)} ${mode}`;
  return {
    hooks: {
      PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, timeout: 5 }] }],
    },
  };
}

export function hooksConfig(wrapper) {
  const command = (mode) => `${quote(process.execPath)} ${quote(wrapper)} ${mode}`;
  return {
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: command('session'), timeout: 5 }] }],
      PreToolUse: [{ matcher: '^(Bash|exec_command|shell_command)$', hooks: [{ type: 'command', command: command('pre'), timeout: 5 }] }],
      PermissionRequest: [{ matcher: '.*', hooks: [{ type: 'command', command: command('permission'), timeout: 5 }] }],
      PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: command('post'), timeout: 5 }] }],
    },
  };
}

function configToml(port) {
  return `model = "sando-loopback"
model_provider = "sando_loopback"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[model_providers.sando_loopback]
name = "Sando loopback synthetic provider"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 10000
`;
}

function outputConfigToml(port, executionLog) {
  return `${configToml(port)}
[features]
code_mode = true

[mcp_servers.fixture]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(outputServerPath)}, ${JSON.stringify(outputFixturePath)}, ${JSON.stringify(executionLog)}]
startup_timeout_sec = 10
tool_timeout_sec = 10
`;
}

function recoveryConfigToml(port, coveragePath) {
  return `${configToml(port)}
[features]
code_mode = true

[mcp_servers.sando]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(sandoMcpServerPath)}]
startup_timeout_sec = 10
tool_timeout_sec = 10

[mcp_servers.sando.env]
DO_NOT_TRACK = "1"
SANDO_COVERAGE_PATH = ${JSON.stringify(coveragePath)}
`;
}

export function resolveExecutable(value) {
  if (path.isAbsolute(value)) return value;
  const candidates = (process.env.PATH ?? '').split(path.delimiter).flatMap((directory) => {
    const candidate = path.resolve(directory, value);
    try { fs.accessSync(candidate, fs.constants.X_OK); return [candidate]; } catch { return []; }
  });
  return candidates[0] ?? value;
}

function isolatedEnvironment(root, codexPath) {
  const env = {
    PATH: `${path.dirname(codexPath)}:/usr/bin:/bin`,
    HOME: path.join(root, 'home'),
    CODEX_HOME: path.join(root, 'codex-home'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    DO_NOT_TRACK: '1',
    SANDO_CLI_ROUTING: '1',
    SANDO_SHELL_WRAP: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
  };
  for (const key of ['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) privateDirectory(env[key]);
  return env;
}

function runCodex(codexPath, args, options) {
  return new Promise((resolve) => {
    const { limits: limitOverrides, ...spawnOptions } = options;
    const limits = captureLimits(limitOverrides);
    const child = spawn(codexPath, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError = null;
    let timedOut = false;
    let settled = false;
    let captureOverflow = false;
    const overflow = () => { captureOverflow = true; child.kill('SIGKILL'); };
    const stdout = createBoundedCapture(limits.processStdoutBytes, overflow);
    const stderr = createBoundedCapture(limits.processStderrBytes, overflow);
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => { spawnError = error?.code === 'ENOENT' ? 'binary-unavailable' : 'spawn-failed'; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        signal,
        spawnError,
        timedOut,
        captureOverflow,
        stdout: stdout.buffer().toString('utf8'),
        stderr: stderr.buffer().toString('utf8'),
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
      });
    });
  });
}

export function startAppServer(codexPath, { cwd, env, onServerRequest, detached = false, limits: limitOverrides } = {}) {
  const limits = captureLimits(limitOverrides);
  const child = spawn(codexPath, ['app-server', '--stdio'], {
    cwd, env, detached, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const notifications = [];
  let notificationBytes = 0;
  let protocolOverflow = false;
  const stderr = createBoundedCapture(limits.appServerStderrBytes, () => { protocolOverflow = true; child.kill('SIGKILL'); });
  let nextId = 1;
  let buffered = '';
  let childClosed = false;
  const failProtocolCapture = () => {
    protocolOverflow = true;
    buffered = '';
    for (const waiter of pending.values()) waiter.reject(boundedError('APP_SERVER_CAPTURE_LIMIT', 'app-server protocol capture limit exceeded'));
    pending.clear();
    child.kill('SIGKILL');
  };
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdout.on('data', (chunk) => {
    const bufferedBytes = Buffer.byteLength(buffered);
    const remaining = limits.appServerLineBytes - bufferedBytes;
    if (chunk.byteLength > remaining) {
      if (remaining > 0) buffered += chunk.subarray(0, remaining).toString('utf8');
      failProtocolCapture();
      return;
    }
    buffered += chunk.toString('utf8');
    while (buffered.includes('\n')) {
      const end = buffered.indexOf('\n');
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const waiter = pending.get(String(message.id));
        if (waiter) {
          pending.delete(String(message.id));
          if (message.error) waiter.reject(boundedError('APP_SERVER_RPC_FAILED', 'app-server RPC request failed'));
          else waiter.resolve(message.result);
        }
      } else if (message.id !== undefined && message.method) {
        Promise.resolve(onServerRequest?.(message)).then((result) => {
          child.stdin.write(`${JSON.stringify({ id: message.id, result: result ?? {} })}\n`);
        }).catch(() => {
          child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: 'client request handler failed' } })}\n`);
        });
      } else if (message.method === 'turn/completed') {
        const retained = {
          method: message.method,
          params: { turn: { id: message.params?.turn?.id ?? null } },
        };
        const retainedBytes = Buffer.byteLength(JSON.stringify(retained));
        if (notifications.length >= limits.appServerQueueEntries
          || notificationBytes + retainedBytes > limits.appServerQueueBytes) {
          failProtocolCapture();
          return;
        }
        notifications.push(retained);
        notificationBytes += retainedBytes;
      }
    }
  });
  child.on('error', () => {
    for (const waiter of pending.values()) waiter.reject(boundedError('APP_SERVER_UNAVAILABLE', 'app-server process unavailable'));
    pending.clear();
  });
  child.on('close', () => {
    childClosed = true;
    for (const waiter of pending.values()) waiter.reject(boundedError(
      protocolOverflow ? 'APP_SERVER_CAPTURE_LIMIT' : 'APP_SERVER_CLOSED',
      protocolOverflow ? 'app-server protocol capture limit exceeded' : 'app-server closed',
    ));
    pending.clear();
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(String(id), { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  const waitForNotification = (method, predicate = () => true, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const found = notifications.find((message) => message.method === method && predicate(message.params));
      if (found) { resolve(found); return; }
      if (Date.now() - started >= timeoutMs) { reject(new Error(`timed out waiting for ${method}`)); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
  const initialize = async ({ experimentalApi = false } = {}) => {
    await request('initialize', {
      clientInfo: { name: 'sando-loopback-contract', title: 'Sando loopback contract', version: '1' },
      ...(experimentalApi ? { capabilities: { experimentalApi: true } } : {}),
    });
    notify('initialized');
  };
  const close = async () => {
    if (childClosed) return { exited: true, stderrObserved: stderr.bytes > 0, stderrOverflow: stderr.overflow, protocolOverflow };
    child.stdin.end();
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 2_000);
      child.once('close', () => { clearTimeout(timer); resolve(true); });
    });
    for (const waiter of pending.values()) waiter.reject(new Error('app-server closed'));
    return { exited, stderrObserved: stderr.bytes > 0, stderrOverflow: stderr.overflow, protocolOverflow };
  };
  return { child, request, notify, initialize, close, notifications, waitForNotification };
}

export function trustHooks(configPath, response) {
  const hooks = response.data.flatMap((entry) => entry.hooks ?? []);
  if (!hooks.length) throw new Error('hooks/list returned no hooks');
  let toml = '';
  for (const hook of hooks) {
    if (!hook.key || !hook.currentHash) throw new Error('hook trust metadata is incomplete');
    toml += `\n[hooks.state.${JSON.stringify(hook.key)}]\nenabled = true\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`;
  }
  fs.appendFileSync(configPath, toml);
  return hooks.map(({ key, currentHash }) => ({ key, currentHash }));
}

async function runAppServerDenial({ codexPath, cwd, env, configPath, hookLog, limits }) {
  const discovery = startAppServer(codexPath, { cwd, env, limits });
  let listed;
  try {
    await discovery.initialize();
    listed = await discovery.request('hooks/list', { cwds: [cwd] });
  } finally {
    await discovery.close();
  }
  const trusted = trustHooks(configPath, listed);

  let approvalRequestCount = 0;
  const app = startAppServer(codexPath, {
    cwd,
    env,
    limits,
    onServerRequest(message) {
      if (message.method === 'item/commandExecution/requestApproval') {
        approvalRequestCount += 1;
        return { decision: 'decline' };
      }
      return {};
    },
  });
  try {
    await app.initialize();
    const verified = await app.request('hooks/list', { cwds: [cwd] });
    const verifiedHooks = verified.data.flatMap((entry) => entry.hooks ?? []);
    const hashesReloaded = trusted.every(({ key, currentHash }) => verifiedHooks.some((hook) => (
      hook.key === key && hook.currentHash === currentHash
    )));
    const thread = await app.request('thread/start', {
      cwd,
      model: 'sando-loopback',
      modelProvider: 'sando_loopback',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      ephemeral: true,
      experimentalRawEvents: false,
    });
    const threadId = thread.thread?.id ?? thread.threadId;
    if (!threadId) throw new Error('thread/start returned no thread id');
    const turn = await app.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'DENIAL_CASE request the provided elevated shell command', text_elements: [] }],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      cwd,
    });
    const turnId = turn.turn?.id ?? turn.turnId;
    await app.waitForNotification('turn/completed', (params) => !turnId || params?.turn?.id === turnId, 30_000);
    const sandboxTurn = await app.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'SANDBOX_CASE execute the provided outside-workspace write without requesting escalation', text_elements: [] }],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      cwd,
    });
    const sandboxTurnId = sandboxTurn.turn?.id ?? sandboxTurn.turnId;
    await app.waitForNotification('turn/completed', (params) => !sandboxTurnId || params?.turn?.id === sandboxTurnId, 30_000);
    const hookRecords = lines(hookLog);
    const permission = hookRecords.filter((entry) => entry.mode === 'permission');
    const permissionOutputs = hookRecords.filter((entry) => entry.mode === 'permission-output');
    return {
      status: permission.length > 0 && permissionOutputs.length > 0 && approvalRequestCount === 0 ? 'passed' : 'failed',
      exactHashTrustApplied: hashesReloaded && permission.length > 0,
      exactHashesPersisted: trusted.length,
      permissionRequestHookCount: permission.length,
      permissionDenyOutputCount: permissionOutputs.length,
      serverApprovalRequestCount: approvalRequestCount,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      hookTrustBypass: false,
    };
  } finally {
    await app.close();
  }
}

function lines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function runSummary(result) {
  return {
    status: result.status,
    signal: result.signal,
    spawn: result.spawnError ?? 'started',
    timedOut: result.timedOut === true,
    errorEventObserved: result.stdout.split('\n').some((line) => {
      try { return JSON.parse(line)?.item?.type === 'error'; } catch { return false; }
    }),
    stderrObserved: result.stderr.length > 0,
  };
}

function jsonStringSpan(buffer, marker) {
  const markerOffset = buffer.indexOf(Buffer.from(marker));
  if (markerOffset < 0) return null;
  const unescapedQuote = (offset) => {
    let slashes = 0;
    for (let index = offset - 1; index >= 0 && buffer[index] === 0x5c; index -= 1) slashes += 1;
    return slashes % 2 === 0;
  };
  let start = markerOffset;
  while (start >= 0 && !(buffer[start] === 0x22 && unescapedQuote(start))) start -= 1;
  let end = markerOffset + Buffer.byteLength(marker);
  while (end < buffer.length && !(buffer[end] === 0x22 && unescapedQuote(end))) end += 1;
  if (start < 0 || end >= buffer.length) return null;
  end += 1;
  const span = buffer.subarray(start, end);
  return {
    startByte: start,
    endByte: end,
    byteLength: span.byteLength,
    sha256: crypto.createHash('sha256').update(span).digest('hex'),
  };
}

export function captureDeliveryEvidence(rawBody, fixture) {
  if (!Buffer.isBuffer(rawBody)) throw new TypeError('rawBody must be a Buffer');
  const text = rawBody.toString('utf8');
  const promiseMatches = Object.entries(fixture.promiseMarkers).filter(([, marker]) => text.includes(marker));
  const candidates = [
    ['raw', fixture.rawMarker],
    ['replacement', fixture.replacementMarker],
    ['current-fallback', fixture.fallbackMarker],
    ...promiseMatches.map(([kind, marker]) => [`promise-${kind}`, marker]),
  ];
  const selected = candidates.find(([, marker]) => text.includes(marker));
  const span = selected ? jsonStringSpan(rawBody, selected[1]) : null;
  return {
    actualBytes: rawBody.byteLength,
    resultUtf8Bytes: Buffer.byteLength(JSON.stringify(fixture.result), 'utf8'),
    sha256: crypto.createHash('sha256').update(rawBody).digest('hex'),
    controlledField: span ? { classification: selected[0], ...span } : null,
    markers: {
      raw: text.includes(fixture.rawMarker),
      replacement: text.includes(fixture.replacementMarker),
      fallback: text.includes(fixture.fallbackMarker),
      typedValue: text.includes('"count":3') || text.includes('\\"count\\":3'),
      isError: text.includes('"isError":false') || text.includes('\\"isError\\":false'),
      privateTopMeta: text.includes(fixture.result?._meta?.test ?? 'SANDO_PRIVATE_TOP_META_001'),
    },
    promiseOutcome: promiseMatches.length === 1 ? promiseMatches[0][0] : 'not-observed',
    promiseSentinelConflict: promiseMatches.length > 1,
  };
}

function collectRecoveryObjects(value, output = [], seen = new Set(), depth = 0) {
  if (depth > 12 || value === null || value === undefined) return output;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length <= DEFAULT_CAPTURE_LIMITS.providerRequestBytes
      && ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
      try { collectRecoveryObjects(JSON.parse(trimmed), output, seen, depth + 1); } catch {}
    }
    return output;
  }
  if (typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (!Array.isArray(value) && value.schema === 'sando-artifact-recovery/v1') output.push(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    collectRecoveryObjects(nested, output, seen, depth + 1);
  }
  return output;
}

export function captureRecoveryDeliveryEvidence(rawBody, expected) {
  if (!Buffer.isBuffer(rawBody)) throw new TypeError('rawBody must be a Buffer');
  if (!expected || typeof expected !== 'object') throw new TypeError('expected recovery evidence is required');
  let body = null;
  try { body = JSON.parse(rawBody.toString('utf8')); } catch {}
  const candidates = collectRecoveryObjects(body);
  const candidate = candidates.find((entry) => entry.digest === expected.digest) ?? candidates[0] ?? null;
  const exactText = candidate?.content === expected.content;
  const exactDigest = candidate?.digest === expected.digest;
  const exactRange = stableJson(candidate?.range) === stableJson(expected.range);
  const exactBytes = candidate?.bytes === expected.bytes && candidate?.sourceBytes === expected.sourceBytes;
  const complete = candidate?.truncated === false;
  const outOfRangeMarkerVisible = rawBody.includes(Buffer.from(expected.outOfRangeMarker));
  return {
    observed: candidate !== null,
    exactText,
    exactDigest,
    exactRange,
    exactBytes,
    complete,
    outOfRangeMarkerVisible,
    deliveredBytes: candidate?.bytes ?? null,
    deliveryBytes: rawBody.byteLength,
    deliverySha256: sha256(rawBody),
    satisfied: candidate !== null && exactText && exactDigest && exactRange && exactBytes && complete
      && !outOfRangeMarkerVisible,
  };
}

function executionCount(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function repositoryIdentity() {
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const filesResult = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: null });
  const files = filesResult.status === 0
    ? filesResult.stdout.toString('utf8').split('\0').filter(Boolean).sort()
    : [];
  const manifest = crypto.createHash('sha256');
  for (const relative of files) {
    const absolute = path.join(repoRoot, relative);
    const stat = fs.statSync(absolute, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    manifest.update(relative);
    manifest.update('\0');
    manifest.update(fs.readFileSync(absolute));
    manifest.update('\0');
  }
  const adapterFiles = [path.join(adapterRoot, 'cli.mjs'), path.join(adapterRoot, 'bin/sando')];
  for (const directory of ['hooks', 'lib']) {
    const absolute = path.join(adapterRoot, directory);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.json'))) adapterFiles.push(path.join(absolute, entry.name));
    }
  }
  const bundle = crypto.createHash('sha256');
  for (const file of adapterFiles.sort()) {
    bundle.update(path.relative(adapterRoot, file));
    bundle.update('\0');
    bundle.update(fs.readFileSync(file));
    bundle.update('\0');
  }
  return {
    head: headResult.status === 0 ? headResult.stdout.trim() : '0'.repeat(40),
    worktreeManifestHash: manifest.digest('hex'),
    bundleHash: bundle.digest('hex'),
  };
}

function hashFile(file) {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

function resolvedIdentityFile(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
  try {
    const resolved = fs.realpathSync(candidate);
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function launcherFromWrapper(wrapperPath) {
  const resolved = resolvedIdentityFile(wrapperPath);
  if (!resolved) return null;
  const source = fs.readFileSync(resolved, 'utf8');
  if (/^#!.*\bnode(?:\s|$)/.test(source.split('\n', 1)[0]) || /\.(?:c|m)?js$/.test(resolved)) return resolved;
  const matches = [...source.matchAll(/^\s*exec\s+(.+?)\s+"\$@"\s*$/gm)];
  if (matches.length !== 1) return null;
  const command = matches[0][1];
  const tokens = [];
  const tokenPattern = /"([^"\n]*)"|'([^'\n]*)'|([^\s"'$`\\]+)/g;
  let cursor = 0;
  for (const match of command.matchAll(tokenPattern)) {
    if (command.slice(cursor, match.index).trim()) return null;
    tokens.push(match[1] ?? match[2] ?? match[3]);
    cursor = match.index + match[0].length;
  }
  if (!tokens.length || command.slice(cursor).trim()) return null;
  const candidate = tokens.length === 1
    ? tokens[0]
    : tokens.length === 2 && /^(?:node|node\.exe)$/.test(path.basename(tokens[0]))
      ? tokens[1]
      : null;
  return resolvedIdentityFile(candidate);
}

function findNativeBinary(launcherPath) {
  let resolved;
  try { resolved = fs.realpathSync(launcherPath); } catch { return null; }
  const target = {
    'linux:x64': ['codex-linux-x64', 'x86_64-unknown-linux-musl'],
    'linux:arm64': ['codex-linux-arm64', 'aarch64-unknown-linux-musl'],
    'darwin:x64': ['codex-darwin-x64', 'x86_64-apple-darwin'],
    'darwin:arm64': ['codex-darwin-arm64', 'aarch64-apple-darwin'],
    'win32:x64': ['codex-win32-x64', 'x86_64-pc-windows-msvc'],
    'win32:arm64': ['codex-win32-arm64', 'aarch64-pc-windows-msvc'],
  }[`${process.platform}:${process.arch}`];
  if (!target) return null;
  const packageRoot = path.resolve(path.dirname(resolved), '..');
  const [packageName, targetTriple] = target;
  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const candidate of [
    path.join(packageRoot, 'node_modules', '@openai', packageName, 'vendor', targetTriple, 'bin', binaryName),
    path.join(packageRoot, 'vendor', targetTriple, 'bin', binaryName),
  ]) {
    const native = resolvedIdentityFile(candidate);
    if (!native) continue;
    try { fs.accessSync(native, fs.constants.X_OK); return native; } catch {}
  }
  return null;
}

export function codexIdentity(codexPath, version, available, { launcherPath, nativeBinaryPath } = {}) {
  const launcher = launcherPath === undefined
    ? launcherFromWrapper(codexPath)
    : resolvedIdentityFile(launcherPath);
  const native = nativeBinaryPath === undefined
    ? (launcher ? findNativeBinary(launcher) : null)
    : resolvedIdentityFile(nativeBinaryPath);
  return {
    name: 'codex',
    version,
    available,
    wrapperSha256: hashFile(codexPath),
    launcherSha256: launcher ? hashFile(launcher) : null,
    nativeBinarySha256: native ? hashFile(native) : null,
  };
}

function outputProvenance() {
  return {
    client: 'real-installed-codex',
    provider: 'synthetic-http-sse-loopback',
    mcpServer: 'synthetic-stdio-fixture',
    externalNetwork: false,
    authenticatedProvider: false,
  };
}

function codexReference() {
  return {
    ...PINNED_CODEX_REFERENCE,
    commitMatch: 'unknown',
    testedFeatures: OUTPUT_SCENARIOS.map(({ id }) => id),
  };
}

const OUTPUT_SCENARIOS = Object.freeze([
  { key: 'directNoHook', id: 'direct-no-hook', surface: 'direct', stage: 'post-tool-use', hook: 'none' },
  { key: 'directCurrentFallback', id: 'direct-current-fallback', surface: 'direct', stage: 'post-tool-use', hook: 'current-fallback' },
  { key: 'directContinueFalse', id: 'direct-continue-false', surface: 'direct', stage: 'post-tool-use', hook: 'continue' },
  { key: 'directBlock', id: 'direct-block', surface: 'direct', stage: 'post-tool-use', hook: 'block' },
  { key: 'codeModeNoHook', id: 'code-mode-no-hook', surface: 'execute', stage: 'code-mode-execute', hook: 'none' },
  { key: 'codeModeExecuteContinueFalse', id: 'code-mode-execute-continue-false', surface: 'execute', stage: 'code-mode-execute', hook: 'continue' },
  { key: 'codeModeWaitNoHook', id: 'code-mode-wait-no-hook', surface: 'wait', stage: 'code-mode-wait', hook: 'none' },
  { key: 'codeModeWaitContinueFalse', id: 'code-mode-wait-continue-false', surface: 'wait', stage: 'code-mode-wait', hook: 'continue' },
  { key: 'codeModeBlock', id: 'code-mode-block', surface: 'execute', stage: 'code-mode-execute', hook: 'block' },
]);

async function startOutputProvider({ surface, limits: limitOverrides }) {
  const limits = captureLimits(limitOverrides);
  const requests = [];
  let sequence = 0;
  let issued = 0;
  let available = null;
  let overflow = false;
  let capturedBytes = 0;
  const server = http.createServer((request, response) => {
    const capture = createBoundedCapture(limits.providerRequestBytes, () => { overflow = true; });
    request.on('data', (chunk) => capture.push(chunk));
    request.on('end', () => {
      if (capture.overflow || capturedBytes + capture.bytes > limits.providerTotalBytes) {
        overflow = true;
        response.writeHead(413);
        response.end('request capture limit exceeded');
        return;
      }
      capturedBytes += capture.bytes;
      if (request.method === 'GET' && request.url?.includes('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      const raw = capture.buffer();
      let body;
      try { body = JSON.parse(raw.toString('utf8') || '{}'); }
      catch { response.writeHead(400); response.end('invalid JSON'); return; }
      requests.push({ body, raw });
      sequence += 1;
      if (issued === 0) {
        const direct = namedTool(body, (name) => name.includes('fixture_report'));
        const execute = namedTool(body, (name) => name === 'execute' || name === 'exec');
        const tool = surface === 'direct' ? direct : execute;
        if (!tool) {
          available = false;
          writeSse(response, messageEvents(sequence, `surface unavailable: ${surface}`));
          return;
        }
        available = true;
        issued += 1;
        const waitCode = surface === 'wait'
          ? 'yield_control(); await new Promise((resolve) => setTimeout(resolve, 100));'
          : '';
        const code = `const markers = { resolved: ['SANDO','PROMISE','RESOLVED','001'].join('_'), rejected: ['SANDO','PROMISE','REJECTED','001'].join('_'), withheld: ['SANDO','PROMISE','WITHHELD','001'].join('_') }; let settled = { kind: 'withheld' }; try { settled = await Promise.race([tools.mcp__fixture__fixture_report({}).then((value) => ({ kind: 'resolved', value }), () => ({ kind: 'rejected' })), new Promise((resolve) => setTimeout(() => resolve({ kind: 'withheld' }), 5000))]); ${waitCode} text(markers[settled.kind]); if (settled.kind === 'resolved') text(JSON.stringify(settled.value)); } catch { text(markers.rejected); }`;
        writeSse(response, eventsForTool(sequence, tool, surface === 'direct' ? {} : code));
        return;
      }
      if (surface === 'wait' && issued === 1) {
        const wait = namedTool(body, (name) => name === 'wait');
        const match = JSON.stringify(body).match(/cell(?:_id| ID)[^a-zA-Z0-9_-]*([a-zA-Z0-9_-]+)/i);
        if (wait && match) {
          issued += 1;
          const input = wait.type === 'custom'
            ? JSON.stringify({ cell_id: match[1], yield_time_ms: 10_000 })
            : { cell_id: match[1], yield_time_ms: 10_000 };
          writeSse(response, eventsForTool(sequence, wait, input));
          return;
        }
      }
      writeSse(response, messageEvents(sequence, 'contract complete'));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    requests,
    get issued() { return issued; },
    get available() { return available; },
    get overflow() { return overflow; },
    port: server.address().port,
  };
}

async function runOutputScenario({ codexPath, surface, hookAction, limits }) {
  const fixture = JSON.parse(fs.readFileSync(outputFixturePath, 'utf8'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-output-'));
  const workspace = path.join(root, 'workspace');
  privateDirectory(workspace);
  const env = isolatedEnvironment(root, codexPath);
  const executionLog = path.join(root, 'mcp-executions.jsonl');
  const hookLog = path.join(root, 'hooks.jsonl');
  const wrapper = path.join(root, 'hook-wrapper.mjs');
  fs.writeFileSync(wrapper, hookWrapperSource(hookLog), { mode: 0o700 });
  const provider = await startOutputProvider({ surface, limits });
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), outputConfigToml(provider.port, executionLog), { mode: 0o600 });
  const hooks = outputHooksConfig(wrapper, hookAction);
  if (hooks) fs.writeFileSync(path.join(env.CODEX_HOME, 'hooks.json'), `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o600 });
  try {
    const prompt = `SYNTHETIC_${surface.toUpperCase()}_${hookAction.toUpperCase()} call the available contract tool exactly once`;
    const args = ['exec', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--ephemeral', '--json', prompt];
    const run = await runCodex(codexPath, args, { cwd: workspace, env, limits });
    const nextRequest = surface === 'wait' ? provider.requests[2] : provider.requests[1];
    const delivery = nextRequest ? captureDeliveryEvidence(nextRequest.raw, fixture) : null;
    const hookRecords = lines(hookLog);
    const count = executionCount(executionLog);
    return {
      surface,
      hookAction,
      spawn: run.spawnError,
      timedOut: run.timedOut,
      captureOverflow: run.captureOverflow || provider.overflow,
      exitStatus: run.status,
      signal: run.signal,
      surfaceAvailable: provider.available,
      delivery,
      providerRequestCount: provider.requests.length,
      providerRequestBytes: provider.requests.reduce((total, entry) => total + entry.raw.byteLength, 0),
      resultUtf8Bytes: Buffer.byteLength(JSON.stringify(fixture.result), 'utf8'),
      executionCount: count,
      waitRoundTripObserved: surface === 'wait' && provider.issued >= 2 && provider.requests.length >= 3,
      postHookObserved: hookRecords.some((entry) => entry.mode === `post-${hookAction}`),
    };
  } finally {
    await new Promise((resolve) => provider.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function expectedScenario(config, observations) {
  const common = observations.process.exitStatus === 0 && observations.process.signal === null
    && observations.process.termination === 'completed'
    && observations.executionCount === 1 && observations.typedValueVisible !== null
    && observations.rawMarkerVisible !== null && observations.replacementMarkerVisible !== null
    && observations.hookObserved === (config.hook !== 'none');
  if (!common) return false;
  if (config.id === 'direct-no-hook') return observations.rawMarkerVisible && observations.typedValueVisible
    && !observations.isErrorVisible && !observations.replacementMarkerVisible && !observations.fallbackMarkerVisible
    && observations.hookEffect === 'absent';
  if (config.id === 'direct-current-fallback') return !observations.rawMarkerVisible
    && !observations.typedValueVisible && !observations.isErrorVisible
    && !observations.replacementMarkerVisible && observations.fallbackMarkerVisible
    && observations.hookEffect === 'current-fallback';
  if (config.id === 'direct-continue-false') return !observations.rawMarkerVisible
    && !observations.typedValueVisible && !observations.isErrorVisible
    && observations.replacementMarkerVisible && !observations.fallbackMarkerVisible
    && observations.hookEffect === 'replacement';
  if (config.id === 'direct-block') return !observations.rawMarkerVisible
    && !observations.typedValueVisible && !observations.isErrorVisible
    && observations.replacementMarkerVisible && !observations.fallbackMarkerVisible
    && observations.hookEffect === 'blocked';
  if (config.id === 'code-mode-block') return !observations.rawMarkerVisible
    && !observations.typedValueVisible && !observations.isErrorVisible
    && !observations.replacementMarkerVisible && !observations.fallbackMarkerVisible
    && observations.promiseOutcome === 'rejected'
    && observations.blockBehavior === 'rejected' && observations.hookEffect === 'blocked';
  const resolvedOriginal = observations.rawMarkerVisible && observations.typedValueVisible
    && observations.isErrorVisible && !observations.replacementMarkerVisible
    && !observations.fallbackMarkerVisible && observations.promiseOutcome === 'resolved'
    && observations.privateTopMetaVisible === false;
  if (config.hook === 'none') return resolvedOriginal && observations.hookEffect === 'absent'
    && (config.surface !== 'wait' || observations.executeWait === 'observed');
  if (config.id === 'code-mode-wait-continue-false') return resolvedOriginal
    && observations.executeWait === 'observed' && observations.hookEffect === 'preserved-original';
  return resolvedOriginal && observations.hookEffect === 'preserved-original';
}

function processObservation(captured) {
  const termination = captured.spawn ? 'not-started'
    : captured.captureOverflow ? 'capture-limit'
      : captured.timedOut ? 'timeout'
        : captured.signal ? 'signal'
          : captured.exitStatus === 0 ? 'completed'
            : 'nonzero-exit';
  return { exitStatus: captured.exitStatus, signal: captured.signal ?? null, termination };
}

function scenarioReceipt({ config, captured, client, sando, provenance, reference, baselineBytes, controlPassed }) {
  const unavailable = captured.spawn === 'binary-unavailable' || captured.spawn === 'spawn-failed'
    || captured.surfaceAvailable === false;
  const delivery = captured.delivery;
  const promiseOutcome = config.surface === 'direct' ? 'not-applicable' : delivery?.promiseOutcome ?? 'not-observed';
  const observations = {
    process: processObservation(captured),
    executionCount: captured.executionCount,
    typedValueVisible: delivery?.markers.typedValue ?? null,
    isErrorVisible: delivery?.markers.isError ?? null,
    rawMarkerVisible: delivery?.markers.raw ?? null,
    replacementMarkerVisible: delivery?.markers.replacement ?? null,
    fallbackMarkerVisible: delivery?.markers.fallback ?? null,
    privateTopMetaVisible: delivery?.markers.privateTopMeta ?? null,
    executeWait: config.surface === 'wait' ? (captured.waitRoundTripObserved ? 'observed' : 'not-observed') : 'not-applicable',
    blockBehavior: config.hook === 'block' ? (promiseOutcome === 'rejected' ? 'rejected' : promiseOutcome === 'withheld' ? 'withheld' : 'not-observed') : 'not-applicable',
    hookObserved: captured.postHookObserved,
    hookEffect: config.hook === 'none' ? 'absent'
      : !captured.postHookObserved ? 'not-observed'
        : config.hook === 'current-fallback' && delivery?.markers.fallback ? 'current-fallback'
          : config.hook === 'block' && !delivery?.markers.raw ? 'blocked'
            : config.surface === 'direct' && delivery?.markers.replacement ? 'replacement'
              : config.surface !== 'direct' && delivery?.markers.raw && promiseOutcome === 'resolved' ? 'preserved-original'
                : 'not-observed',
    promiseOutcome,
    approval: { requested: false, decision: 'not-applicable' },
    cancel: { requested: false, observed: false },
    expectedSatisfied: null,
  };
  const reason = captured.spawn === 'binary-unavailable' ? 'codex-binary-unavailable'
    : captured.spawn === 'spawn-failed' ? 'codex-client-spawn-failed'
      : captured.surfaceAvailable === false ? 'codex-surface-unavailable'
        : captured.captureOverflow ? 'capture-limit-exceeded'
          : captured.timedOut ? 'codex-client-timeout'
            : captured.signal ? 'codex-process-signaled'
              : captured.exitStatus !== 0 ? 'codex-process-nonzero-exit'
                : 'contract-observation-mismatch';
  observations.expectedSatisfied = unavailable ? null : expectedScenario(config, observations) && controlPassed;
  const status = unavailable ? 'not-run' : observations.expectedSatisfied ? 'passed' : 'failed';
  const baseDelivery = delivery ? {
    actualBytes: delivery.actualBytes,
    resultUtf8Bytes: captured.resultUtf8Bytes,
    sha256: delivery.sha256,
    controlledField: delivery.controlledField,
    controlledFieldDeltaBytes: delivery.controlledField && Number.isInteger(baselineBytes)
      ? delivery.controlledField.byteLength - baselineBytes : null,
  } : unavailable ? {
    actualBytes: null,
    resultUtf8Bytes: captured.resultUtf8Bytes,
    sha256: null,
    controlledField: null,
    controlledFieldDeltaBytes: null,
  } : {
    actualBytes: 0,
    resultUtf8Bytes: captured.resultUtf8Bytes,
    sha256: sha256(Buffer.alloc(0)),
    controlledField: null,
    controlledFieldDeltaBytes: null,
  };
  const core = {
    schema: OUTPUT_CONTRACT_SCHEMA,
    verifierVersion: VERIFIER_VERSION,
    status,
    provenance,
    reference,
    client,
    sando,
    scenario: { id: config.id, surface: config.surface, stage: config.stage, hook: config.hook, resultType: 'mcp-tool-result' },
    observations,
    delivery: baseDelivery,
    usage: { provider: null, localEstimates: { requestCount: captured.providerRequestCount, requestBytes: captured.providerRequestBytes } },
    recovery: { status: 'not-needed', attempted: false, method: null, artifactRef: null, recoveredBytes: null, errorClass: null },
    ...(status !== 'passed' ? { reason } : {}),
  };
  return { ...core, delivery: { ...baseDelivery, evidenceDigest: sha256(stableJson(core)) } };
}

function aggregateStatus(receipts) {
  if (receipts.some(({ status }) => status === 'failed')) return 'failed';
  if (receipts.some(({ status }) => status === 'not-run')) return 'not-run';
  return 'passed';
}

function unavailableCaptured(reason) {
  return {
    spawn: reason === 'codex-binary-unavailable' ? 'binary-unavailable' : 'spawn-failed',
    timedOut: false,
    captureOverflow: false,
    exitStatus: null,
    signal: null,
    surfaceAvailable: null,
    delivery: null,
    providerRequestCount: 0,
    providerRequestBytes: 0,
    resultUtf8Bytes: null,
    executionCount: 0,
    waitRoundTripObserved: false,
    postHookObserved: false,
  };
}

function recoveryProvenance() {
  return {
    client: 'real-installed-codex',
    provider: 'synthetic-http-sse-loopback',
    outputTransform: 'real-sando-cli',
    mcpServer: 'real-sando-stdio',
    externalNetwork: false,
    authenticatedProvider: false,
  };
}

function materializeRecoveryFixture(workspace, env) {
  const outOfRangeMarker = 'SANDO_SYNTHETIC_OUT_OF_RANGE_001';
  const secret = `ghp_${'A'.repeat(36)}`;
  const startLine = 319;
  const endLine = 321;
  const sourceLines = Array.from({ length: 700 }, (_, index) => `synthetic recovery line ${index + 1}`);
  sourceLines[319] = `line 320 selected redacted ${secret}`;
  sourceLines[499] = outOfRangeMarker;
  const request = {
    schema: 'sando-model-output-transform/v1',
    requestId: '00000000-0000-4000-8000-000000000001',
    deliveryId: '00000000-0000-4000-8000-000000000002',
    surface: 'direct',
    recoveryDelivery: false,
    cwd: workspace,
    tool: { name: 'Bash', callId: 'synthetic-recovery-materialization' },
    budget: { maxResponseBytes: 1_048_576 },
    segments: [{ index: 0, text: sourceLines.join('\n') }],
  };
  const transformed = spawnSync(process.execPath, [outputTransformCliPath], {
    cwd: workspace,
    env: { ...env, DO_NOT_TRACK: '1', SANDO_POLICY: '' },
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  if (transformed.status !== 0) return { status: transformed.status, reason: 'output-transform-nonzero-exit' };
  let response;
  try { response = JSON.parse(transformed.stdout); } catch { return { status: transformed.status, reason: 'output-transform-invalid-response' }; }
  const edit = response.edits?.[0]?.text;
  const ref = typeof edit === 'string' ? edit.match(/sando:sha256:[a-f0-9]{16,64}/u)?.[0] : null;
  if (!ref) return { status: transformed.status, reason: 'output-transform-artifact-missing' };
  const digestPrefix = ref.slice('sando:sha256:'.length);
  const artifactDirectory = path.join(workspace, '.sando', 'sando', 'artifacts');
  let matches;
  try { matches = fs.readdirSync(artifactDirectory).filter((name) => name.startsWith(digestPrefix)); }
  catch { return { status: transformed.status, reason: 'output-transform-artifact-missing' }; }
  if (matches.length !== 1) return { status: transformed.status, reason: 'output-transform-artifact-ambiguous' };
  const artifact = fs.readFileSync(path.join(artifactDirectory, matches[0]), 'utf8');
  const digest = `sha256:${sha256(artifact)}`;
  const content = artifact.split('\n').slice(startLine - 1, endLine).join('\n');
  const redacted = !artifact.includes(secret) && artifact.includes('[REDACTED TOKEN]');
  return {
    status: transformed.status,
    ref,
    redacted,
    expected: {
      content,
      digest,
      bytes: Buffer.byteLength(content),
      sourceBytes: Buffer.byteLength(artifact),
      range: { type: 'lines', start: startLine, end: endLine },
      outOfRangeMarker,
    },
  };
}

async function startRecoveryProvider({ recovery, limits: limitOverrides }) {
  const limits = captureLimits(limitOverrides);
  const requests = [];
  let sequence = 0;
  let issued = 0;
  let available = null;
  let overflow = false;
  let capturedBytes = 0;
  const server = http.createServer((request, response) => {
    const capture = createBoundedCapture(limits.providerRequestBytes, () => { overflow = true; });
    request.on('data', (chunk) => capture.push(chunk));
    request.on('end', () => {
      if (capture.overflow || capturedBytes + capture.bytes > limits.providerTotalBytes) {
        overflow = true;
        response.writeHead(413);
        response.end('request capture limit exceeded');
        return;
      }
      capturedBytes += capture.bytes;
      if (request.method === 'GET' && request.url?.includes('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      const raw = capture.buffer();
      let body;
      try { body = JSON.parse(raw.toString('utf8') || '{}'); }
      catch { response.writeHead(400); response.end('invalid JSON'); return; }
      requests.push({ body, raw });
      sequence += 1;
      if (issued === 0) {
        const execute = namedTool(body, (name) => name === 'execute' || name === 'exec');
        if (!execute) {
          available = false;
          writeSse(response, messageEvents(sequence, 'code mode unavailable'));
          return;
        }
        available = true;
        issued += 1;
        const args = {
          ref: recovery.ref,
          startLine: recovery.expected.range.start,
          endLine: recovery.expected.range.end,
          maxBytes: 65_536,
        };
        const code = `const recovered = await tools.${RECOVERY_TOOL_IDENTITY}(${JSON.stringify(args)}); text(JSON.stringify(recovered));`;
        writeSse(response, eventsForTool(sequence, execute, code));
        return;
      }
      writeSse(response, messageEvents(sequence, 'recovery contract complete'));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    requests,
    get issued() { return issued; },
    get available() { return available; },
    get overflow() { return overflow; },
    port: server.address().port,
  };
}

function recoveryIdentity() {
  return {
    outputTransformSha256: hashFile(outputTransformCliPath),
    mcpServerSha256: hashFile(sandoMcpServerPath),
  };
}

export async function runCodeModeRecoveryContract({ codexPath = DEFAULT_CODEX, clock = () => new Date(), limits } = {}) {
  codexPath = resolveExecutable(codexPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-recovery-'));
  const workspace = path.join(root, 'workspace');
  privateDirectory(workspace);
  const env = isolatedEnvironment(root, codexPath);
  const provenance = recoveryProvenance();
  const sando = recoveryIdentity();
  let provider;
  try {
    const versionProbe = await runCodex(codexPath, ['--version'], { cwd: workspace, env, limits });
    const unavailable = versionProbe.spawnError === 'binary-unavailable';
    const version = unavailable ? null : /(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+)/iu.exec(versionProbe.stdout)?.[1] ?? null;
    const client = codexIdentity(codexPath, version, !unavailable);
    const base = {
      schema: RECOVERY_CONTRACT_SCHEMA,
      verifierVersion: VERIFIER_VERSION,
      generatedAt: clock().toISOString(),
      provenance,
      client,
      sando,
      authenticatedProvider: false,
      externalNetwork: false,
    };
    if (unavailable) return { ...base, status: 'not-run', reason: versionProbe.spawnError === 'binary-unavailable' ? 'codex-binary-unavailable' : 'codex-client-spawn-failed' };
    if (versionProbe.spawnError) return { ...base, status: 'failed', reason: 'codex-client-spawn-failed' };
    if (versionProbe.captureOverflow || versionProbe.timedOut || versionProbe.signal || versionProbe.status !== 0) {
      const reason = versionProbe.captureOverflow ? 'capture-limit-exceeded'
        : versionProbe.timedOut ? 'codex-client-timeout'
          : versionProbe.signal ? 'codex-process-signaled' : 'codex-process-nonzero-exit';
      return { ...base, status: 'failed', reason };
    }
    if (version !== '0.160.0') return { ...base, status: 'failed', reason: 'codex-version-mismatch' };

    const recovery = materializeRecoveryFixture(workspace, env);
    if (!recovery.expected) return { ...base, status: 'failed', reason: recovery.reason };
    provider = await startRecoveryProvider({ recovery, limits });
    const coveragePath = path.join(root, 'recovery-coverage.json');
    fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), recoveryConfigToml(provider.port, coveragePath), { mode: 0o600 });
    const run = await runCodex(codexPath, [
      'exec', '--skip-git-repo-check', '--ephemeral', '--json',
      'SYNTHETIC_CODE_MODE_RECOVERY call the requested recovery tool exactly once',
    ], { cwd: workspace, env, limits });
    const delivered = provider.requests.slice(1)
      .map(({ raw }) => captureRecoveryDeliveryEvidence(raw, recovery.expected))
      .find(({ observed }) => observed)
      ?? captureRecoveryDeliveryEvidence(Buffer.from('{}'), recovery.expected);
    let coverage = null;
    try { coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8')); } catch {}
    const executionCount = Array.isArray(coverage?.events)
      ? coverage.events.filter((event) => event.route === 'sando_artifact_get').length
      : 0;
    const process = {
      exitStatus: run.status,
      signal: run.signal,
      termination: run.captureOverflow ? 'capture-limit' : run.timedOut ? 'timeout' : run.signal ? 'signal' : 'completed',
    };
    const observations = {
      process,
      surfaceAvailable: provider.available,
      toolIdentitySha256: sha256(RECOVERY_TOOL_IDENTITY),
      providerIssuedCount: provider.issued,
      providerRequestCount: provider.requests.length,
      executionCount,
      artifact: {
        redacted: recovery.redacted,
        digest: recovery.expected.digest,
        sourceBytes: recovery.expected.sourceBytes,
        recoveredBytes: recovery.expected.bytes,
        range: recovery.expected.range,
      },
      delivery: delivered,
    };
    const passed = run.status === 0 && run.signal === null && !run.timedOut && !run.captureOverflow
      && !provider.overflow && provider.available === true && provider.issued === 1
      && executionCount === 1 && recovery.redacted && delivered.satisfied;
    const reason = run.captureOverflow || provider.overflow ? 'capture-limit-exceeded'
      : run.timedOut ? 'codex-client-timeout'
        : run.signal ? 'codex-process-signaled'
          : run.status !== 0 ? 'codex-process-nonzero-exit'
            : provider.available !== true ? 'codex-surface-unavailable'
              : executionCount !== 1 || provider.issued !== 1 ? 'recovery-execution-count-mismatch'
                : !recovery.redacted ? 'output-transform-redaction-mismatch'
                  : 'recovery-evidence-mismatch';
    const core = { ...base, status: passed ? 'passed' : 'failed', observations };
    return { ...core, ...(passed ? {} : { reason }), evidenceDigest: sha256(stableJson(core)) };
  } finally {
    if (provider) await new Promise((resolve) => provider.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export async function runMcpHostContract({ codexPath = DEFAULT_CODEX, clock = () => new Date(), limits } = {}) {
  codexPath = resolveExecutable(codexPath);
  const sando = repositoryIdentity();
  const provenance = outputProvenance();
  const reference = codexReference();
  const versionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-version-'));
  let version;
  try {
    version = await runCodex(codexPath, ['--version'], { cwd: repoRoot, env: isolatedEnvironment(versionRoot, codexPath), limits });
  } finally {
    fs.rmSync(versionRoot, { recursive: true, force: true });
  }
  const unavailable = Boolean(version.spawnError);
  const preflightFailed = !unavailable && (version.captureOverflow || version.timedOut || version.signal || version.status !== 0);
  const parsedVersion = !unavailable && !preflightFailed
    ? /(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+)/i.exec(version.stdout)?.[1] ?? null
    : null;
  const client = codexIdentity(codexPath, parsedVersion, !unavailable);
  const captured = {};
  if (!unavailable && !preflightFailed) {
    for (const config of OUTPUT_SCENARIOS) {
      captured[config.key] = await runOutputScenario({ codexPath, surface: config.surface, hookAction: config.hook, limits });
    }
  } else if (unavailable) {
    const reason = version.spawnError === 'binary-unavailable' ? 'codex-binary-unavailable' : 'codex-client-spawn-failed';
    for (const config of OUTPUT_SCENARIOS) captured[config.key] = unavailableCaptured(reason);
  } else {
    for (const config of OUTPUT_SCENARIOS) captured[config.key] = {
      spawn: null,
      timedOut: version.timedOut,
      captureOverflow: version.captureOverflow,
      exitStatus: version.status,
      signal: version.signal,
      surfaceAvailable: null,
      delivery: null,
      providerRequestCount: 0,
      providerRequestBytes: 0,
      resultUtf8Bytes: null,
      executionCount: 0,
      waitRoundTripObserved: false,
      postHookObserved: false,
    };
  }
  const baseline = {
    direct: captured.directNoHook.delivery?.controlledField?.byteLength,
    code: captured.codeModeNoHook.delivery?.controlledField?.byteLength,
    wait: captured.codeModeWaitNoHook.delivery?.controlledField?.byteLength,
  };
  const scenarios = {};
  for (const config of OUTPUT_SCENARIOS) {
    const controlPassed = ['directNoHook', 'codeModeNoHook', 'codeModeWaitNoHook'].includes(config.key)
      ? true
      : config.surface === 'direct'
        ? scenarios.directNoHook.status === 'passed'
        : config.surface === 'wait'
          ? scenarios.codeModeWaitNoHook.status === 'passed'
          : scenarios.codeModeNoHook.status === 'passed';
    scenarios[config.key] = scenarioReceipt({
      config,
      captured: captured[config.key],
      client,
      sando,
      provenance,
      reference,
      baselineBytes: config.surface === 'direct' ? baseline.direct : config.surface === 'wait' ? baseline.wait : baseline.code,
      controlPassed,
    });
  }
  const receipts = Object.values(scenarios);
  const status = aggregateStatus(receipts);
  const surfaceStatus = (keys) => aggregateStatus(keys.map((key) => scenarios[key]));
  const report = {
    schema: OUTPUT_CONTRACT_SCHEMA,
    verifierVersion: VERIFIER_VERSION,
    generatedAt: clock().toISOString(),
    profile: 'full-a1',
    status,
    ...(status === 'not-run' || status === 'failed' ? { reason: receipts.find((receipt) => receipt.status === status)?.reason } : {}),
    provenance,
    reference,
    client,
    sando,
    authenticatedProvider: false,
    surfaces: {
      directMcp: surfaceStatus(['directNoHook', 'directCurrentFallback', 'directContinueFalse', 'directBlock']),
      codeModeExecute: surfaceStatus(['codeModeNoHook', 'codeModeExecuteContinueFalse', 'codeModeBlock']),
      codeModeWait: surfaceStatus(['codeModeWaitNoHook', 'codeModeWaitContinueFalse']),
      serialization: surfaceStatus(['directNoHook', 'codeModeNoHook']),
    },
    scenarios,
    summary: {
      passed: receipts.filter(({ status: value }) => value === 'passed').length,
      failed: receipts.filter(({ status: value }) => value === 'failed').length,
      notRun: receipts.filter(({ status: value }) => value === 'not-run').length,
    },
  };
  return report;
}

export async function runLoopbackCodexContract({ codexPath = DEFAULT_CODEX, keep = false, limits } = {}) {
  codexPath = resolveExecutable(codexPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-loopback-'));
  const workspace = path.join(root, 'workspace');
  privateDirectory(workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# synthetic loopback workspace\n');
  const env = isolatedEnvironment(root, codexPath);
  const hookLog = path.join(root, 'hooks.jsonl');
  const wrapper = path.join(root, 'hook-wrapper.mjs');
  fs.writeFileSync(wrapper, hookWrapperSource(hookLog), { mode: 0o700 });
  const provider = await startProvider(workspace, { limits });
  const hooksPath = path.join(env.CODEX_HOME, 'hooks.json');
  const configPath = path.join(env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(configPath, configToml(provider.port), { mode: 0o600 });
  fs.writeFileSync(hooksPath, `${JSON.stringify(hooksConfig(wrapper), null, 2)}\n`, { mode: 0o600 });
  const common = ['--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--json'];
  const denialProbe = ['--skip-git-repo-check', '--json'];
  try {
    const versionProbe = await runCodex(codexPath, ['--version'], { cwd: workspace, env, limits });
    if (versionProbe.spawnError || versionProbe.captureOverflow || versionProbe.timedOut || versionProbe.signal || versionProbe.status !== 0) {
      const unavailable = Boolean(versionProbe.spawnError);
      return {
        status: unavailable ? 'not-run' : 'failed',
        reason: versionProbe.spawnError === 'binary-unavailable' ? 'codex-binary-unavailable'
          : versionProbe.spawnError ? 'codex-client-spawn-failed'
            : versionProbe.captureOverflow ? 'capture-limit-exceeded'
              : versionProbe.timedOut ? 'codex-client-timeout'
                : versionProbe.signal ? 'codex-process-signaled' : 'codex-process-nonzero-exit',
        provider: 'synthetic-loopback',
        codexVersion: null,
        outboundModelCalls: 0,
        authenticatedProvider: false,
      };
    }
    const codexVersion = /(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+)/i.exec(versionProbe.stdout)?.[1] ?? 'unknown';
    const run = await runCodex(codexPath, ['exec', ...common, 'RUN_CASE execute the requested synthetic shell command exactly once'], { cwd: workspace, env, limits });
    const resume = await runCodex(codexPath, ['exec', 'resume', ...common, '--last', 'RESUME_CASE reply without tools'], { cwd: workspace, env, limits });
    const denial = await runCodex(codexPath, ['exec', ...denialProbe, 'DENIAL_CASE request the provided elevated shell command'], { cwd: workspace, env, limits });
    let appServerDenial;
    try {
      appServerDenial = await runAppServerDenial({ codexPath, cwd: workspace, env, configPath, hookLog, limits });
    } catch (error) {
      appServerDenial = {
        status: 'failed',
        reason: error?.code === 'APP_SERVER_CAPTURE_LIMIT' ? 'capture-limit-exceeded' : 'app-server-contract-failed',
      };
    }
    const hooks = lines(hookLog);
    const requestText = provider.requests.map((request) => JSON.stringify(request.body)).join('\n');
    const executions = fs.existsSync(path.join(workspace, 'executions.log'))
      ? fs.readFileSync(path.join(workspace, 'executions.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const deniedExecutions = fs.existsSync(path.join(root, 'denied-outside.log')) ? 1 : 0;
    const outsideWriteBlocked = !fs.existsSync(path.join(root, 'sandbox-outside.log'));
    const sessionTriggers = hooks.filter((entry) => entry.mode === 'session').map((entry) => entry.source);
    const preOutputs = hooks.filter((entry) => entry.mode === 'pre-output');
    const permissionRequests = hooks.filter((entry) => entry.mode === 'permission');
    const denialBlockedByExecPolicy = denial.stderr.includes('approval policy is Never');
    const assertions = {
      codexRunsExitedZero: [run, resume, denial].every((result) => result.status === 0),
      startupObserved: sessionTriggers.includes('startup'),
      resumeObserved: sessionTriggers.includes('resume'),
      rewriteReturned: preOutputs.some((entry) => entry.rewriteReturned === true),
      rewrittenCommandConsumed: requestText.includes('[sando exec exit_code=0') && requestText.includes('MODEL_VISIBLE_TOKEN'),
      executionCount: executions,
      streamingSseCompleted: run.status === 0 && provider.requests.length >= 2,
      permissionRequestObserved: permissionRequests.length > 0,
      deniedExecutionCount: deniedExecutions,
      execDenialPathBlockedByNever: denialBlockedByExecPolicy,
      outsideWorkspaceWriteBlocked: outsideWriteBlocked,
      captureWithinLimits: !provider.overflow && [run, resume, denial].every((result) => !result.captureOverflow),
      sandboxMode: 'workspace-write',
    };
    const clientContractPassed = assertions.codexRunsExitedZero && assertions.startupObserved && assertions.resumeObserved
      && assertions.rewriteReturned && assertions.rewrittenCommandConsumed && executions === 1
      && assertions.streamingSseCompleted && assertions.outsideWorkspaceWriteBlocked && assertions.captureWithinLimits;
    const approvalDenialPassed = appServerDenial.status === 'passed' && deniedExecutions === 0;
    return {
      status: clientContractPassed && approvalDenialPassed ? 'passed' : 'failed',
      provider: 'synthetic-loopback',
      codexVersion,
      outboundModelCalls: 0,
      authenticatedProvider: false,
      lifecycleHookTrustBypass: true,
      scenarios: {
        startupResumeRewriteStreaming: { status: clientContractPassed ? 'passed' : 'failed' },
        approvalDenial: approvalDenialPassed ? { status: 'passed' } : {
          status: 'failed',
          reason: denialBlockedByExecPolicy
            ? 'codex exec forces approval policy Never; without pre-approved hook trust the PermissionRequest hook cannot run, while --dangerously-bypass-hook-trust reports bypassPermissions'
            : 'PermissionRequest denial was not observed in the isolated non-interactive client',
        },
      },
      assertions,
      appServerDenial,
      diagnostics: clientContractPassed && approvalDenialPassed ? undefined : {
        runs: { run: runSummary(run), resume: runSummary(resume), denial: runSummary(denial) },
        hookModes: hooks.map((entry) => entry.mode),
        providerRequestCount: provider.requests.length,
      },
      ...(keep ? { root } : {}),
    };
  } finally {
    await new Promise((resolve) => provider.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    if (keep) privateDirectory(root);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = process.argv.includes('--code-mode-recovery-contract')
      ? await runCodeModeRecoveryContract()
      : process.argv.includes('--mcp-host-contract')
        ? await runMcpHostContract()
        : await runLoopbackCodexContract({ keep: process.argv.includes('--keep') });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'failed') process.exitCode = 1;
    else if (result.status === 'not-run') process.exitCode = 2;
  } catch {
    process.stdout.write(`${JSON.stringify({ status: 'failed', reason: 'contract-runner-failed' }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
