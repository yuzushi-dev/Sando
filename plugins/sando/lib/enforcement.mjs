import fs from 'node:fs';
import path from 'node:path';

import { recordCoverage } from './coverage.mjs';
import { pairedArmFromEnv } from './paired-accounting.mjs';
import {
  defaultTelemetryConfigPath, defaultTelemetryStatePaths, isDoNotTrack, readTelemetryConfig,
  recordCoverage as recordCoverageTelemetry,
} from './telemetry.mjs';
import { PLUGIN_VERSION } from './version.mjs';

const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell_command']);
const MAX_COMMAND_LENGTH = 8192;
const MAX_PATH_LENGTH = 4096;
const SHELL_META = new Set([';', '|', '&', '<', '>', '$', '`', '(', ')', '{', '}', '*', '?', '[', ']', '!', '~', '#']);
const CLI_PATH = path.resolve(import.meta.dirname, '..', 'bin', 'sando');

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function bypass(reason) { return { status: 'bypassed', reason }; }

function tokens(command) {
  if (typeof command !== 'string' || !command || command.length > MAX_COMMAND_LENGTH || command.includes('\0')) return null;
  const result = [];
  let current = '';
  let hasToken = false;
  let quote = null;
  const push = () => { if (hasToken) result.push(current); current = ''; hasToken = false; };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) { quote = null; continue; }
      if (character === '\\' || SHELL_META.has(character)) return null;
      current += character;
      continue;
    }
    if (character === '\'' || character === '"') { quote = character; hasToken = true; continue; }
    if (character === '\\' || SHELL_META.has(character)) return null;
    if (character === '\n' || character === '\r') return null;
    if (/\s/.test(character)) { push(); continue; }
    hasToken = true;
    current += character;
  }
  if (quote) return null;
  push();
  return result;
}
// Codex does not hand the hook a bare command. Depending on version it passes an argv
// array (["/bin/bash","-lc","cat f.txt"]) or the same wrapper as a single string. Both
// used to be rejected before classification even began — `tokens` returns null for a
// non-string, and a wrapped string classifies as the shell binary — so every command on
// Codex was bypassed and nothing was ever routed. Measured against Codex 0.153.
const SHELL_WRAPPERS = new Set([
  'sh', 'bash', 'zsh', 'dash',
  '/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash',
  '/usr/bin/sh', '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/dash',
]);

// -c, -lc, -lic … the flag bundle always ends in `c` for "read the command from the
// next argument".
function isShellCommandFlag(value) {
  return typeof value === 'string' && /^-[a-z]*c$/.test(value);
}

/** The inner command of a `<shell> -lc "<command>"` triple, or null. */
function unwrapShellArgv(argv) {
  if (!Array.isArray(argv) || argv.length !== 3) return null;
  const [shell, flag, inner] = argv;
  if (!SHELL_WRAPPERS.has(shell) || !isShellCommandFlag(flag)) return null;
  return typeof inner === 'string' ? inner : null;
}

/**
 * Tokens for the command the user actually asked for, unwrapping one level of shell.
 *
 * The inner command is tokenized by the same `tokens`, so the metacharacter rejection
 * that keeps pipes, redirects and globs out of the routed set still applies — unwrapping
 * widens what is recognised, never what is considered safe.
 */
function commandTokens(command) {
  if (Array.isArray(command)) {
    const inner = unwrapShellArgv(command);
    if (inner !== null) return tokens(inner);
    // A plain argv array: accept it only if every element is a token `tokens` would have
    // produced itself, so an array cannot smuggle in what a string could not.
    if (command.length === 0 || !command.every((item) => typeof item === 'string')) return null;
    const rejoined = command.map((item) => shellQuote(item)).join(' ');
    return tokens(rejoined);
  }
  const direct = tokens(command);
  if (direct === null) return null;
  const inner = unwrapShellArgv(direct);
  return inner === null ? direct : tokens(inner);
}

function safeRoot(cwd, workdir) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) return null;
  let root;
  try { root = fs.realpathSync(cwd); } catch { return null; }
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return null;
  if (workdir !== undefined) {
    if (typeof workdir !== 'string' || !workdir || path.isAbsolute(workdir) || workdir.includes('\0')
      || workdir.split(/[\\/]/).includes('..')) return null;
    const candidate = path.resolve(root, workdir);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
    try { root = fs.realpathSync(candidate); } catch { return null; }
    const stat = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return null;
  }
  return root;
}

function safeTarget(root, relativePath, kind, baseRoot = root) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > MAX_PATH_LENGTH
    || path.isAbsolute(relativePath) || relativePath.includes('\0')
    || relativePath.split(/[\\/]/).includes('..') || relativePath.startsWith('-')) return null;
  const candidate = path.resolve(root, relativePath);
  if (candidate !== baseRoot && !candidate.startsWith(`${baseRoot}${path.sep}`)) return null;
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { return null; }
  if (stat.isSymbolicLink()) return null;
  let target;
  try { target = fs.realpathSync(candidate); } catch { return null; }
  if (target !== baseRoot && !target.startsWith(`${baseRoot}${path.sep}`)) return null;
  if (kind === 'file' && !stat.isFile()) return null;
  if (kind === 'search' && !stat.isFile() && !stat.isDirectory()) return null;
  return path.relative(baseRoot, target).split(path.sep).join('/') || '.';
}

function classifyCat(args, root, baseRoot = root) {
  let afterDash = false;
  const operands = [];
  for (const arg of args) {
    if (afterDash) { operands.push(arg); continue; }
    if (arg === '--') { afterDash = true; continue; }
    if (arg.startsWith('-') && arg.length > 1) return bypass('read-shape');
    operands.push(arg);
  }
  if (operands.length !== 1) return bypass('read-shape');
  const relativePath = safeTarget(root, operands[0], 'file', baseRoot);
  return relativePath ? { status: 'eligible', route: 'sando_read', path: relativePath } : bypass('unsafe-read-target');
}

function classifySed(args, root, baseRoot = root) {
  if (args.length !== 3 || args[0] !== '-n') return bypass('sed-shape');
  const range = /^(\d+)(?:,(\d+))?p$/.exec(args[1]);
  if (!range) return bypass('sed-shape');
  const startLine = Number(range[1]);
  const endLine = range[2] === undefined ? startLine : Number(range[2]);
  if (startLine < 1 || endLine < startLine) return bypass('sed-shape');
  const relativePath = safeTarget(root, args[2], 'file', baseRoot);
  return relativePath
    ? { status: 'eligible', route: 'sando_read', path: relativePath, startLine, endLine }
    : bypass('unsafe-read-target');
}

const DEFAULT_HEAD_LINES = 10;

// `head -n N` is a request for the first N lines and is expressed as the range 1..N. `tail` is
// counted from the end, which `sando_read` has no way to express, so it is left alone: routing it
// would answer "the last 5 lines" with the first lines of the file.
function classifyHead(args, root, baseRoot = root) {
  const operands = [];
  let lines = DEFAULT_HEAD_LINES;
  let afterDash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (afterDash) { operands.push(arg); continue; }
    if (arg === '--') { afterDash = true; continue; }
    if (arg === '-n' && i + 1 < args.length && /^\d+$/.test(args[i + 1])) { lines = Number(args[i + 1]); i += 1; continue; }
    if (/^-\d+$/.test(arg)) { lines = Number(arg.slice(1)); continue; }
    if (arg.startsWith('-') && arg.length > 1) return bypass('head-shape');
    operands.push(arg);
  }
  if (operands.length !== 1) return bypass('head-shape');
  if (!Number.isInteger(lines) || lines < 1) return bypass('head-shape');
  const relativePath = safeTarget(root, operands[0], 'file', baseRoot);
  return relativePath
    ? { status: 'eligible', route: 'sando_read', path: relativePath, startLine: 1, endLine: lines }
    : bypass('unsafe-read-target');
}

function classifyTokens(commandTokens, root, baseRoot = root) {
  const [program, ...args] = commandTokens;
  if (program === 'cat') return classifyCat(args, root, baseRoot);
  if (program === 'grep' || program === 'rg') return bypass('grep-shell-wrap-required');
  if (program === 'sed') return classifySed(args, root, baseRoot);
  if (program === 'head') return classifyHead(args, root, baseRoot);
  if (program === 'tail') return bypass('tail-unbounded-from-end');
  return bypass('unsupported-shell');
}

// L3. The selective routes above only ever reach commands whose shape is understood; on real
// traffic that is under 1% of what an agent runs, while the bulk of the context — builds, test
// runs, `git diff`, scripts — is in the shapes they refuse. Wrapping the command instead of
// parsing it covers all of them: the shell still runs the original text, so pipelines,
// redirects and `&&` keep their meaning, and only the captured output is bounded.
//
// On unless SANDO_SHELL_WRAP is switched off. The selective routes reach under 1% of what an
// agent actually runs, so leaving this off means shipping a context optimiser that, on Codex,
// optimises almost nothing.
function wrapWholeCommand(rawCommand, env) {
  if (disabled(env?.SANDO_SHELL_WRAP)) return null;
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) return null;
  // Already ours: wrapping a wrap would nest one capture inside another.
  if (rawCommand.includes(CLI_PATH) || /\bsando\s+(exec|read|grep)\b/.test(rawCommand)) return null;
  return { status: 'eligible', route: 'sando_exec', command: rawCommand };
}

function disabled(value) {
  return value === '0' || value === 'false' || value === 'no' || value === 'off';
}

export function classifyShellCommand({ toolName, toolInput, cwd, env = process.env } = {}) {
  if (!SHELL_TOOLS.has(toolName)) return bypass('unsupported-tool');
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return bypass('invalid-input');
  const root = safeRoot(cwd, toolInput.workdir);
  if (!root) return bypass('unsafe-cwd');
  const rawCommand = typeof toolInput.command === 'string'
    ? toolInput.command
    : (Array.isArray(toolInput.command)
      ? (unwrapShellArgv(toolInput.command)
        ?? (toolInput.command.every((item) => typeof item === 'string')
          ? toolInput.command.map(shellQuote).join(' ')
          : null))
      : null);
  const parsed = commandTokens(toolInput.command);
  if (parsed?.length) {
    if (parsed[0] === 'grep' || parsed[0] === 'rg') {
      return wrapWholeCommand(rawCommand, env) ?? bypass('grep-shell-wrap-disabled');
    }
    const direct = classifyTokens(parsed, root);
    if (direct.status === 'eligible') return direct;
    return wrapWholeCommand(rawCommand, env) ?? direct;
  }
  if (rawCommand) {
    return wrapWholeCommand(rawCommand, env) ?? bypass('ambiguous-shell');
  }
  return bypass('ambiguous-shell');
}

// The local coverage file has carried these counts all along; this is what puts them on the wire
// beside the reduction they qualify. Best-effort, like every other telemetry path here.
function coverageTelemetry(result, env) {
  try {
    const configPath = defaultTelemetryConfigPath(env);
    if (!readTelemetryConfig(configPath).enabled || isDoNotTrack(env)) return;
    const day = new Date().toISOString().slice(0, 10);
    recordCoverageTelemetry({
      statePaths: defaultTelemetryStatePaths(env), day, pluginVersion: PLUGIN_VERSION, host: 'codex',
      routed: result.status === 'eligible', reason: result.reason,
    });
  } catch { /* telemetry must never affect the routing decision */ }
}

function metric(result, toolName, env) {
  coverageTelemetry(result, env);
  try {
    if (result.status === 'eligible') {
      recordCoverage({
        buckets: ['eligible', 'routed', 'transformed'], reason: result.route === 'sando_read' ? 'covered-read' : 'covered-grep',
        route: result.route, toolName: SHELL_TOOLS.has(toolName) ? 'Bash' : 'unknown', env,
      });
    } else {
      recordCoverage({ buckets: ['bypassed'], reason: result.reason, route: 'bypass', toolName: SHELL_TOOLS.has(toolName) ? 'Bash' : 'unknown', env });
    }
  } catch {}
}

export function runPreToolUse(input, env = process.env) {
  const toolName = input?.tool_name ?? input?.toolName;
  // `env` has to reach the classifier: it is what decides whether the wrap applies, and reading
  // process.env here would ignore the environment the caller actually passed.
  const result = classifyShellCommand({ toolName, toolInput: input?.tool_input ?? input?.toolInput, cwd: input?.cwd, env });
  if (result.status !== 'eligible') {
    metric(result, toolName, env);
    return {};
  }
  // On, unless explicitly switched off. On Codex the PostToolUse hook cannot rewrite output at
  // all, so rewriting the command before it runs is the only channel there is: with this off the
  // plugin bounds nothing on its main surface. What the rewrite preserves — exit codes, signal
  // deaths, stdin, stderr and the working tree — is measured in docs/measurements.md against
  // 1,290 recorded commands. `permissionDecision: 'allow'` below is Codex's way of saying this
  // hook rewrote the input; approval is a separate PermissionRequest event and is not touched.
  // Set SANDO_CLI_ROUTING=0 to opt out.
  if (disabled(env.SANDO_CLI_ROUTING)) {
    metric(bypass('routing-disabled'), toolName, env);
    return {};
  }
  const arm = pairedArmFromEnv(env);
  if (arm === null || arm === 'control') {
    metric(bypass(arm === null ? 'invalid-control-arm' : 'control-arm'), toolName, env);
    return {};
  }
  metric(result, toolName, env);
  const readBounds = result.startLine === undefined ? ''
    : ` --start-line ${result.startLine} --end-line ${result.endLine}`;
  // The wrap runs the original text through a shell, so its own quoting stays intact.
  const cliCommand = result.route === 'sando_exec'
    ? `${shellQuote(CLI_PATH)} exec -- bash -lc ${shellQuote(result.command)}`
    : result.route === 'sando_read'
      ? `${shellQuote(CLI_PATH)} read${readBounds} -- ${shellQuote(result.path)}`
      : `${shellQuote(CLI_PATH)} grep -F -- ${shellQuote(result.pattern)} ${shellQuote(result.path)}`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...(input.tool_input ?? input.toolInput), command: cliCommand },
    },
  };
}
