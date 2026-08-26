import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizePolicy, optimizeToolOutput } from './core.mjs';
import { recordCoverage } from './coverage.mjs';

const MAX_PATH_LENGTH = 4096;
const MAX_PATTERN_LENGTH = 512;
const MAX_GREP_FILES = 20;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_BYTES = 4 * 1024 * 1024;
const MAX_GREP_LINE_BYTES = 512;
const MAX_GREP_OUTPUT_BYTES = 65_536;
const CODEX_SANDBOX_META = 'codex/sandbox-state-meta';
const MAX_EXEC_COMMAND_LENGTH = 8192;
const MAX_EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_CAPTURE_BYTES = 16_777_216;

/** Resolves the real `codex` binary on PATH, preferring a `.session-handoff-original`
 *  sibling when one exists. session-handoff (a companion plugin, same marketplace)
 *  permanently replaces `codex` on PATH with its own launcher wrapper after `setup`,
 *  backing up the original there; codex's own sandbox self-dispatch (via argv0) does
 *  not survive going through that wrapper. Falls back to the literal 'codex' command
 *  (unresolved, letting spawn's own ENOENT surface) when nothing is found on PATH. */
export function resolveCodexCommand(env = process.env, fsImpl = fs) {
  const fallback = 'codex';
  if (process.platform === 'win32') return fallback; // session-handoff supports linux/darwin only
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'codex');
    try {
      fsImpl.accessSync(candidate, fsImpl.constants.X_OK);
    } catch {
      continue;
    }
    const original = `${candidate}.session-handoff-original`;
    try {
      fsImpl.accessSync(original, fsImpl.constants.X_OK);
      return original;
    } catch {
      return candidate;
    }
  }
  return fallback;
}

const TOOLS = [
  {
    name: 'prepare_tool_output',
    description: 'Prepare deterministic bounded inline output and an optional redacted artifact payload. Performs no writes or network access.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['toolName', 'output', 'cwd'],
      properties: { toolName: { type: 'string', minLength: 1, maxLength: 128 }, output: {}, cwd: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH }, policy: { type: 'object' } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'sando_read',
    description: 'Read one workspace-relative text file and return redacted, bounded output with an optional artifact payload.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path', 'cwd'],
      properties: { path: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH }, cwd: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH }, policy: { type: 'object' } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'sando_grep',
    description: 'Search a workspace-relative file or directory for a literal string and return bounded redacted matches.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['pattern', 'path', 'cwd'],
      properties: {
        pattern: { type: 'string', minLength: 1, maxLength: MAX_PATTERN_LENGTH },
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH },
        cwd: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH },
        caseSensitive: { type: 'boolean' }, maxMatches: { type: 'integer', minimum: 1, maximum: MAX_GREP_MATCHES },
        policy: { type: 'object' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'sando_exec',
    description: 'Execute one non-interactive shell command inside the Codex-provided sandbox and return bounded redacted output.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['command'],
      properties: { command: { type: 'string', minLength: 1, maxLength: 8192 }, workdir: { type: 'string', maxLength: MAX_PATH_LENGTH }, timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 }, interactive: { type: 'boolean' }, policy: { type: 'object' } },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

function invalid(message) { throw new Error(message); }

function workspaceRoot(cwd) {
  if (typeof cwd !== 'string' || !cwd || cwd.length > MAX_PATH_LENGTH || !path.isAbsolute(cwd) || cwd.includes('\0')) invalid('cwd must be an absolute directory');
  const root = fs.realpathSync(cwd);
  if (!fs.statSync(root).isDirectory()) invalid('cwd must be a directory');
  return root;
}

function workspacePath(cwd, relativePath) {
  const root = workspaceRoot(cwd);
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > MAX_PATH_LENGTH || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    invalid('path must be workspace-relative');
  }
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) invalid('path escapes cwd');
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) invalid('symlinks are not allowed');
  const target = fs.realpathSync(candidate);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) invalid('path escapes cwd');
  return { root, target, stat };
}

function readPrefix(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  const marker = `\n[sando input truncated at ${stat.size} bytes]\n`;
  const truncated = stat.size > maxBytes;
  const readBytes = truncated ? Math.max(1, maxBytes - Buffer.byteLength(marker)) : stat.size;
  const buffer = Buffer.alloc(readBytes);
  let handle;
  let bytes = 0;
  try {
    handle = fs.openSync(filePath, 'r');
    while (bytes < readBytes) {
      const count = fs.readSync(handle, buffer, bytes, readBytes - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  return { text: `${buffer.subarray(0, bytes).toString('utf8')}${truncated ? marker : ''}`, truncated };
}

function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let output = '';
  for (const character of text) {
    if (Buffer.byteLength(output + character) > maxBytes) break;
    output += character;
  }
  return output;
}

function prepare(toolName, output, cwd, policy, hints = {}) {
  const normalized = normalizePolicy(policy);
  return optimizeToolOutput({ toolName, output, cwd: workspaceRoot(cwd), policy: normalized, ...hints });
}

function readTool(args = {}) {
  const { root, target, stat } = workspacePath(args.cwd, args.path);
  if (!stat.isFile()) invalid('path must be a regular file');
  const policy = normalizePolicy(args.policy);
  const source = readPrefix(target, policy.maxArtifactBytes);
  const result = prepare('Read', source.text, root, policy, {
    lineCount: source.text.split(/\r?\n/).length,
    fileBytes: stat.size,
  });
  return { ...result, source: { path: path.relative(root, target).split(path.sep).join('/'), truncated: source.truncated } };
}

function walkFiles(root, target) {
  const files = [];
  const pending = [target];
  while (pending.length && files.length < MAX_GREP_FILES) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) { files.push(current); continue; }
    if (!stat.isDirectory()) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries.reverse()) {
      const child = path.join(current, entry.name);
      if (child !== root && !child.startsWith(`${root}${path.sep}`)) invalid('path escapes cwd');
      pending.push(child);
    }
  }
  return { files, truncated: pending.length > 0 };
}

function capLine(line) {
  if (Buffer.byteLength(line) <= MAX_GREP_LINE_BYTES) return line;
  let output = '';
  for (const character of line) {
    if (Buffer.byteLength(output + character) > MAX_GREP_LINE_BYTES - 1) break;
    output += character;
  }
  return `${output}~`;
}

function grepTool(args = {}) {
  if (typeof args.pattern !== 'string' || !args.pattern || args.pattern.length > MAX_PATTERN_LENGTH || args.pattern.includes('\0')) invalid('pattern is invalid');
  const { root, target, stat: targetStat } = workspacePath(args.cwd, args.path);
  const policy = normalizePolicy(args.policy);
  const caseSensitive = args.caseSensitive !== false;
  const needle = caseSensitive ? args.pattern : args.pattern.toLocaleLowerCase();
  const maxMatches = args.maxMatches === undefined ? MAX_GREP_MATCHES : args.maxMatches;
  if (!Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > MAX_GREP_MATCHES) invalid('maxMatches is invalid');
  const singleFile = targetStat.isFile();
  const matchesPerFile = singleFile ? maxMatches : Math.min(maxMatches, 20);
  const walked = walkFiles(root, target);
  const matches = [];
  let skippedBinary = 0;
  let truncated = walked.truncated;
  for (const file of walked.files) {
    const stat = fs.statSync(file);
    if (stat.size > MAX_GREP_FILE_BYTES) truncated = true;
    const source = readPrefix(file, MAX_GREP_FILE_BYTES);
    const text = source.text;
    if (text.includes('\0')) { skippedBinary += 1; continue; }
    const lines = text.split(/\r?\n/);
    let fileMatches = 0;
    for (let index = 0; index < lines.length && fileMatches < matchesPerFile; index += 1) {
      const haystack = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
      if (!haystack.includes(needle)) continue;
      matches.push(`${path.relative(root, file).split(path.sep).join('/')}:${index + 1}:${capLine(lines[index])}`);
      fileMatches += 1;
    }
    if (fileMatches >= matchesPerFile && lines.length > fileMatches) truncated = true;
  }
  let output = matches.join('\n');
  if (!output) output = '(no matches)';
  const summary = `\n[sando grep: ${matches.length} matches, ${walked.files.length} files${skippedBinary ? `, ${skippedBinary} binary skipped` : ''}${truncated ? ', bounded' : ''}]`;
  if (Buffer.byteLength(output + summary) > MAX_GREP_OUTPUT_BYTES) {
    output = truncateUtf8(output, Math.max(1, MAX_GREP_OUTPUT_BYTES - Buffer.byteLength(summary) - 1));
    truncated = true;
  }
  output += summary;
  const result = prepare('Grep', output, root, policy, { grepScope: singleFile ? 'single-file' : 'multi' });
  return { ...result, source: { path: path.relative(root, target).split(path.sep).join('/'), matches: matches.length, truncated } };
}

export const MCP_TOOLS = TOOLS;

function recordMcpCoverage(name, env) {
  try {
    recordCoverage({ buckets: ['transformed'], reason: 'mcp-prepared', route: name, toolName: 'MCP', env });
  } catch {}
}

function execError(message, reason) {
  const error = new Error(message);
  error.coverageReason = reason;
  return error;
}

function sandboxState(meta) {
  const state = meta?.[CODEX_SANDBOX_META];
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw execError('sando_exec requires Codex sandbox metadata', 'missing-sandbox-metadata');
  if (state.permissionProfile?.type !== 'managed' || state.permissionProfile.file_system?.type !== 'restricted') {
    throw execError('sando_exec requires a managed restricted Codex sandbox', 'unsupported-sandbox');
  }
  if (typeof state.sandboxCwd !== 'string' || !state.sandboxCwd) throw execError('Codex sandbox cwd is invalid', 'invalid-sandbox-cwd');
  let cwd;
  try { cwd = state.sandboxCwd.startsWith('file:') ? fileURLToPath(state.sandboxCwd) : state.sandboxCwd; } catch { throw execError('Codex sandbox cwd is invalid', 'invalid-sandbox-cwd'); }
  if (!path.isAbsolute(cwd) || cwd.includes('\0')) throw execError('Codex sandbox cwd is invalid', 'invalid-sandbox-cwd');
  let root;
  try { root = fs.realpathSync(cwd); } catch { throw execError('Codex sandbox cwd is unavailable', 'invalid-sandbox-cwd'); }
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw execError('Codex sandbox cwd is unavailable', 'invalid-sandbox-cwd');
  if (state.codexLinuxSandboxExe !== null && state.codexLinuxSandboxExe !== undefined
    && (typeof state.codexLinuxSandboxExe !== 'string' || !path.isAbsolute(state.codexLinuxSandboxExe))) {
    throw execError('Codex sandbox helper path is invalid', 'invalid-sandbox-helper');
  }
  return { state, root };
}

function safeExecWorkdir(root, workdir) {
  if (workdir === undefined) return root;
  if (typeof workdir !== 'string' || !workdir || workdir.length > MAX_PATH_LENGTH || path.isAbsolute(workdir)
    || workdir.includes('\0') || workdir.split(/[\\/]/).includes('..')) {
    throw execError('workdir must be workspace-relative', 'invalid-workdir');
  }
  const candidate = path.resolve(root, workdir);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw execError('workdir escapes sandbox cwd', 'invalid-workdir');
  let current = root;
  for (const part of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw execError('workdir must contain only regular directories', 'invalid-workdir');
  }
  return candidate;
}

function shellArgs(root, workdir, command) {
  if (process.platform === 'win32') {
    if (/["&|<>^]/.test(workdir)) throw execError('workdir contains shell syntax', 'invalid-workdir');
    return ['/d', '/s', '/c', `cd /d "${workdir}" && ${command}`];
  }
  return ['-lc', 'cd -- "$1" && eval "$2"', 'sando-exec', path.relative(root, workdir) || '.', command];
}

function terminate(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
  try { child.kill(signal); } catch {}
}

function textOrBinary(buffer) {
  if (buffer.includes(0)) return { binary: true, text: '' };
  try { return { binary: false, text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }; }
  catch { return { binary: true, text: '' }; }
}

async function runSandboxedCommand({ state, root, workdir, command, timeoutMs, maxBytes, signal }) {
  if (signal?.aborted) throw execError('sando_exec cancelled', 'cancelled');
  const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const args = ['sandbox', '--sandbox-state-json', JSON.stringify(state), '--', shell, ...shellArgs(root, workdir, command)];
  const child = spawn(resolveCodexCommand(), args, { cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let captured = 0;
  let truncated = false;
  let forceTimer;
  const stop = (signalName) => {
    terminate(child, signalName);
    if (signalName === 'SIGTERM' && forceTimer === undefined) forceTimer = setTimeout(() => terminate(child, 'SIGKILL'), 250);
  };
  const stdout = [];
  const stderr = [];
  const collect = (bucket, chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, maxBytes - captured);
    if (remaining) {
      const part = buffer.subarray(0, remaining);
      bucket.push(part);
      captured += part.length;
    }
    if (buffer.length > remaining) truncated = true;
    if (truncated) stop('SIGTERM');
  };
  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); }, timeoutMs);
  const onAbort = () => { cancelled = true; stop('SIGTERM'); };
  signal?.addEventListener('abort', onAbort, { once: true });
  child.stdout.on('data', (chunk) => collect(stdout, chunk));
  child.stderr.on('data', (chunk) => collect(stderr, chunk));
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, exitSignal) => resolve({ exitCode, exitSignal }));
  }).catch((error) => { throw execError(`sando_exec runner unavailable: ${error.code || error.message}`, 'sandbox-runner-unavailable'); })
    .finally(() => { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', onAbort); });
  if (signal?.aborted) cancelled = true;
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), truncated, timedOut, cancelled, ...outcome };
}

async function execTool(args = {}, meta, signal) {
  if (!meta || typeof meta !== 'object' || !meta[CODEX_SANDBOX_META]) {
    throw execError('sando_exec requires Codex sandbox metadata', 'missing-sandbox-metadata');
  }
  if (args.interactive === true) throw execError('sando_exec does not support TTY or interactive commands', 'interactive-unsupported');
  if (typeof args.command !== 'string' || !args.command || args.command.length > MAX_EXEC_COMMAND_LENGTH || args.command.includes('\0')) {
    throw execError('command is invalid', 'invalid-command');
  }
  const { state, root } = sandboxState(meta);
  const workdir = safeExecWorkdir(root, args.workdir);
  const timeoutMs = args.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EXEC_TIMEOUT_MS) throw execError('timeoutMs is invalid', 'invalid-timeout');
  const policy = normalizePolicy(args.policy);
  const run = await runSandboxedCommand({ state, root, workdir, command: args.command, timeoutMs, maxBytes: Math.min(policy.maxArtifactBytes, MAX_EXEC_CAPTURE_BYTES), signal });
  const stdout = textOrBinary(run.stdout);
  const stderr = textOrBinary(run.stderr);
  const binaryOutput = stdout.binary || stderr.binary;
  const status = `[sando_exec exit_code=${run.exitCode ?? 'null'} signal=${run.exitSignal || 'none'} timed_out=${run.timedOut} cancelled=${run.cancelled} tty=false]`;
  const output = binaryOutput
    ? `${status}\n[binary output withheld]`
    : `${status}\nstdout:\n${stdout.text}\nstderr:\n${stderr.text}${run.truncated ? `\n[sando_exec output bounded at ${Math.min(policy.maxArtifactBytes, MAX_EXEC_CAPTURE_BYTES)} bytes]` : ''}`;
  const result = optimizeToolOutput({ toolName: 'Bash', output, cwd: root, policy });
  return { ...result, execution: { exitCode: run.exitCode, signal: run.exitSignal, timedOut: run.timedOut, cancelled: run.cancelled, outputTruncated: run.truncated, binaryOutput, tty: false, workdir: path.relative(root, workdir).split(path.sep).join('/') || '.' } };
}

export function callMcpTool(name, args, env = process.env) {
  let result;
  try {
    if (name === 'prepare_tool_output') result = prepare(args?.toolName, args?.output, args?.cwd, args?.policy);
    else if (name === 'sando_read') result = readTool(args);
    else if (name === 'sando_grep') result = grepTool(args);
    else if (name === 'sando_exec') {
      sandboxState(undefined);
      throw execError('sando_exec requires asynchronous MCP dispatch', 'async-dispatch-required');
    }
    else invalid('Unknown tool');
  } catch (error) {
    if (name === 'sando_exec') {
      try { recordCoverage({ buckets: ['bypassed'], reason: error?.coverageReason || 'runner-error', route: 'sando_exec', toolName: 'Bash', env }); } catch {}
    }
    throw error;
  }
  recordMcpCoverage(name, env);
  return result;
}

export async function callMcpToolAsync(name, args, env = process.env, meta, signal) {
  if (name !== 'sando_exec') return callMcpTool(name, args, env);
  let result;
  try { result = await execTool(args, meta, signal); }
  catch (error) {
    try { recordCoverage({ buckets: ['bypassed'], reason: error?.coverageReason || 'runner-error', route: 'sando_exec', toolName: 'Bash', env }); } catch {}
    throw error;
  }
  recordMcpCoverage(name, env);
  return result;
}
