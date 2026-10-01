#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CODEX = process.env.SANDO_CODEX_BIN || 'codex';
const repoRoot = path.resolve(import.meta.dirname, '..');
const adapterRoot = path.join(repoRoot, 'adapters/codex/sando');

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

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

function toolEvents(sequence, name, argumentsValue) {
  const responseId = `resp_tool_${sequence}`;
  const callId = `call_${sequence}`;
  const item = { id: `item_${sequence}`, type: 'function_call', status: 'completed', name, call_id: callId, arguments: JSON.stringify(argumentsValue) };
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

async function startProvider(workspace) {
  const requests = [];
  let sequence = 0;
  const issued = { run: 0, denial: 0, sandbox: 0 };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'GET' && request.url?.includes('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
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
  return { server, requests, port: server.address().port };
}

export function hookWrapperSource(logPath) {
  const enforcement = pathToFileURL(path.join(adapterRoot, 'lib/enforcement.mjs')).href;
  const sessionStart = pathToFileURL(path.join(adapterRoot, 'lib/session-start.mjs')).href;
  return `#!/usr/bin/env node
import fs from 'node:fs';
import { runPreToolUse } from ${JSON.stringify(enforcement)};
import { runSessionStart } from ${JSON.stringify(sessionStart)};
const mode = process.argv[2];
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const record = (value) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(value) + '\\n');
record({ mode, input });
if (mode === 'pre') {
  const output = runPreToolUse(input, process.env);
  record({ mode: 'pre-output', output });
  process.stdout.write(JSON.stringify(output) + '\\n');
} else if (mode === 'session') {
  runSessionStart({ env: process.env, stdout: process.stdout });
} else if (mode === 'permission') {
  const output = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'synthetic loopback denial' } } };
  record({ mode: 'permission-output', output });
  process.stdout.write(JSON.stringify(output) + '\\n');
} else {
  process.stdout.write('{}\\n');
}
`;
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

export function resolveExecutable(value) {
  if (path.isAbsolute(value)) return value;
  const candidates = (process.env.PATH ?? '').split(path.delimiter).flatMap((directory) => {
    const candidate = path.resolve(directory, value);
    try { fs.accessSync(candidate, fs.constants.X_OK); return [candidate]; } catch { return []; }
  });
  return candidates.find((candidate) => fs.lstatSync(candidate).isSymbolicLink()) ?? candidates[0] ?? value;
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
    const child = spawn(codexPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

export function startAppServer(codexPath, { cwd, env, onServerRequest, detached = false } = {}) {
  const child = spawn(codexPath, ['app-server', '--stdio'], {
    cwd, env, detached, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const notifications = [];
  const serverRequests = [];
  const stderr = [];
  let nextId = 1;
  let buffered = '';
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdout.on('data', (chunk) => {
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
          if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
          else waiter.resolve(message.result);
        }
      } else if (message.id !== undefined && message.method) {
        serverRequests.push(message);
        Promise.resolve(onServerRequest?.(message)).then((result) => {
          child.stdin.write(`${JSON.stringify({ id: message.id, result: result ?? {} })}\n`);
        });
      } else if (message.method) notifications.push(message);
    }
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
    child.stdin.end();
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 2_000);
      child.once('close', () => { clearTimeout(timer); resolve(true); });
    });
    for (const waiter of pending.values()) waiter.reject(new Error('app-server closed'));
    return { exited, stderr: Buffer.concat(stderr).toString('utf8') };
  };
  return { child, request, notify, initialize, close, notifications, serverRequests, waitForNotification };
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

async function runAppServerDenial({ codexPath, cwd, env, configPath, hookLog }) {
  const discovery = startAppServer(codexPath, { cwd, env });
  await discovery.initialize();
  const listed = await discovery.request('hooks/list', { cwds: [cwd] });
  await discovery.close();
  const trusted = trustHooks(configPath, listed);

  const approvalRequests = [];
  const app = startAppServer(codexPath, {
    cwd,
    env,
    onServerRequest(message) {
      if (message.method === 'item/commandExecution/requestApproval') {
        approvalRequests.push(message);
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
      status: permission.length > 0 && permissionOutputs.length > 0 && approvalRequests.length === 0 ? 'passed' : 'failed',
      exactHashTrustApplied: hashesReloaded && permission.length > 0,
      exactHashesPersisted: trusted.length,
      permissionRequestHookCount: permission.length,
      permissionDenyOutputCount: permissionOutputs.length,
      serverApprovalRequestCount: approvalRequests.length,
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
  const errors = result.stdout.split('\n').flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event?.item?.type === 'error' ? [event.item.message] : [];
    } catch { return []; }
  });
  const stderr = result.stderr.split('\n').filter((line) => line.includes('ERROR')).slice(-3);
  return { status: result.status, signal: result.signal, errors, stderr };
}

export async function runLoopbackCodexContract({ codexPath = DEFAULT_CODEX, keep = false } = {}) {
  codexPath = resolveExecutable(codexPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-loopback-'));
  const workspace = path.join(root, 'workspace');
  privateDirectory(workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# synthetic loopback workspace\n');
  const env = isolatedEnvironment(root, codexPath);
  const hookLog = path.join(root, 'hooks.jsonl');
  const wrapper = path.join(root, 'hook-wrapper.mjs');
  fs.writeFileSync(wrapper, hookWrapperSource(hookLog), { mode: 0o700 });
  const provider = await startProvider(workspace);
  const hooksPath = path.join(env.CODEX_HOME, 'hooks.json');
  const configPath = path.join(env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(configPath, configToml(provider.port), { mode: 0o600 });
  fs.writeFileSync(hooksPath, `${JSON.stringify(hooksConfig(wrapper), null, 2)}\n`, { mode: 0o600 });
  const common = ['--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--json'];
  const denialProbe = ['--skip-git-repo-check', '--json'];
  try {
    const versionProbe = await runCodex(codexPath, ['--version'], { cwd: workspace, env });
    const codexVersion = /(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+)/i.exec(versionProbe.stdout)?.[1] ?? 'unknown';
    const run = await runCodex(codexPath, ['exec', ...common, 'RUN_CASE execute the requested synthetic shell command exactly once'], { cwd: workspace, env });
    const resume = await runCodex(codexPath, ['exec', 'resume', ...common, '--last', 'RESUME_CASE reply without tools'], { cwd: workspace, env });
    const denial = await runCodex(codexPath, ['exec', ...denialProbe, 'DENIAL_CASE request the provided elevated shell command'], { cwd: workspace, env });
    const appServerDenial = await runAppServerDenial({ codexPath, cwd: workspace, env, configPath, hookLog });
    const hooks = lines(hookLog);
    const requestText = provider.requests.map((request) => JSON.stringify(request.body)).join('\n');
    const executions = fs.existsSync(path.join(workspace, 'executions.log'))
      ? fs.readFileSync(path.join(workspace, 'executions.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const deniedExecutions = fs.existsSync(path.join(root, 'denied-outside.log')) ? 1 : 0;
    const outsideWriteBlocked = !fs.existsSync(path.join(root, 'sandbox-outside.log'));
    const sessionTriggers = hooks.filter((entry) => entry.mode === 'session').map((entry) => entry.input.source);
    const preOutputs = hooks.filter((entry) => entry.mode === 'pre-output');
    const permissionRequests = hooks.filter((entry) => entry.mode === 'permission');
    const denialBlockedByExecPolicy = denial.stderr.includes('approval policy is Never');
    const assertions = {
      codexRunsExitedZero: [run, resume, denial].every((result) => result.status === 0),
      startupObserved: sessionTriggers.includes('startup'),
      resumeObserved: sessionTriggers.includes('resume'),
      rewriteReturned: preOutputs.some((entry) => entry.output?.hookSpecificOutput?.updatedInput?.command?.includes('sando')),
      rewrittenCommandConsumed: requestText.includes('[sando exec exit_code=0') && requestText.includes('MODEL_VISIBLE_TOKEN'),
      executionCount: executions,
      streamingSseCompleted: run.status === 0 && provider.requests.length >= 2,
      permissionRequestObserved: permissionRequests.length > 0,
      deniedExecutionCount: deniedExecutions,
      execDenialPathBlockedByNever: denialBlockedByExecPolicy,
      outsideWorkspaceWriteBlocked: outsideWriteBlocked,
      sandboxMode: 'workspace-write',
    };
    const clientContractPassed = assertions.codexRunsExitedZero && assertions.startupObserved && assertions.resumeObserved
      && assertions.rewriteReturned && assertions.rewrittenCommandConsumed && executions === 1
      && assertions.streamingSseCompleted && assertions.outsideWorkspaceWriteBlocked;
    const approvalDenialPassed = appServerDenial.status === 'passed' && deniedExecutions === 0;
    return {
      status: clientContractPassed && approvalDenialPassed ? 'passed' : clientContractPassed ? 'partial' : 'failed',
      provider: 'synthetic-loopback',
      codexVersion,
      outboundModelCalls: 0,
      authenticatedProvider: false,
      lifecycleHookTrustBypass: true,
      scenarios: {
        startupResumeRewriteStreaming: { status: clientContractPassed ? 'passed' : 'failed' },
        approvalDenial: approvalDenialPassed ? { status: 'passed' } : {
          status: 'blocked',
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
      capture: hooks.find((entry) => entry.mode === 'pre')?.input ?? null,
      ...(keep ? { root } : {}),
    };
  } finally {
    await new Promise((resolve) => provider.server.close(resolve));
    if (!keep) fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await runLoopbackCodexContract({ keep: process.argv.includes('--keep') });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
  else if (result.status === 'partial') process.exitCode = 2;
}
