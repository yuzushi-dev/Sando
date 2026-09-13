import fs from 'node:fs';
import path from 'node:path';

import { recordCoverage } from './coverage.mjs';
import { pairedArmFromEnv } from './paired-accounting.mjs';

const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell_command']);
const MAX_COMMAND_LENGTH = 8192;
const MAX_PATH_LENGTH = 4096;
const MAX_PATTERN_LENGTH = 512;
const SHELL_META = new Set([';', '|', '&', '<', '>', '$', '`', '(', ')', '{', '}', '*', '?', '[', ']', '!', '~', '#']);
const CLI_PATH = path.resolve(import.meta.dirname, '..', 'bin', 'sando');

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function bypass(reason) { return { status: 'bypassed', reason }; }

function tokens(command) {
  if (typeof command !== 'string' || !command || command.length > MAX_COMMAND_LENGTH || command.includes('\0')) return null;
  const result = [];
  let current = '';
  let quote = null;
  const push = () => { if (current) result.push(current); current = ''; };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) { quote = null; continue; }
      if (character === '\\' || SHELL_META.has(character)) return null;
      current += character;
      continue;
    }
    if (character === '\'' || character === '"') { quote = character; continue; }
    if (character === '\\' || SHELL_META.has(character)) return null;
    if (/\s/.test(character)) { push(); continue; }
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

// ─── L1 flag sets ───────────────────────────────────────────────────────

/** Single-char cat flags that affect display but preserve content identity. */
const CAT_SAFE_FLAGS = new Set('nbsvetAET'.split(''));

/** Single-char grep/rg boolean flags compatible with sando_grep routing. */
const GREP_SAFE_SHORT = new Set('inrREFwHhs'.split(''));

/** Long grep/rg flags (without leading --) compatible with sando_grep routing. */
const GREP_SAFE_LONG = new Set([
  'fixed-strings', 'ignore-case', 'line-number', 'recursive',
  'word-regexp', 'with-filename', 'no-filename', 'no-messages',
  'extended-regexp',
]);

function classifyCat(args, root, baseRoot = root) {
  let afterDash = false;
  const operands = [];
  for (const arg of args) {
    if (afterDash) { operands.push(arg); continue; }
    if (arg === '--') { afterDash = true; continue; }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const c of arg.slice(1)) {
        if (!CAT_SAFE_FLAGS.has(c)) return bypass('read-shape');
      }
      continue;
    }
    operands.push(arg);
  }
  if (operands.length !== 1) return bypass('read-shape');
  const relativePath = safeTarget(root, operands[0], 'file', baseRoot);
  return relativePath ? { status: 'eligible', route: 'sando_read', path: relativePath } : bypass('unsafe-read-target');
}

function classifyGrep(args, root, baseRoot = root) {
  let afterDash = false;
  let isRecursive = false;
  const operands = [];
  for (const arg of args) {
    if (afterDash) { operands.push(arg); continue; }
    if (arg === '--') { afterDash = true; continue; }
    if (arg.startsWith('--') && arg.length > 2) {
      const name = arg.slice(2);
      if (!GREP_SAFE_LONG.has(name)) return bypass('grep-shape');
      if (name === 'recursive') isRecursive = true;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const c of arg.slice(1)) {
        if (!GREP_SAFE_SHORT.has(c)) return bypass('grep-shape');
        if (c === 'r' || c === 'R') isRecursive = true;
      }
      continue;
    }
    operands.push(arg);
  }
  if (operands.length !== 2) return bypass('grep-shape');
  const [pattern, target] = operands;
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH || pattern.includes('\0')) return bypass('unsafe-grep-pattern');
  const kind = isRecursive ? 'search' : 'file';
  const relativePath = safeTarget(root, target, kind, baseRoot);
  return relativePath ? { status: 'eligible', route: 'sando_grep', pattern, path: relativePath } : bypass('unsafe-grep-target');
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
  if (program === 'grep' || program === 'rg') return classifyGrep(args, root, baseRoot);
  if (program === 'sed') return classifySed(args, root, baseRoot);
  if (program === 'head') return classifyHead(args, root, baseRoot);
  if (program === 'tail') return bypass('tail-unbounded-from-end');
  return bypass('unsupported-shell');
}

// ─── L2: Compound command segmentation ──────────────────────────────────

/** Environment prefixes that set context but don't produce routable output. */
const ENV_PREFIXES = new Set(['cd', 'export', 'source', 'set']);

/**
 * Split a raw command string on unquoted |, ||, &&, ;.
 * Returns null for constructs too complex to segment safely (subshells, backticks,
 * background &). The redirect flag is set when the segment contains an unquoted > or <.
 */
function segmentCommand(command) {
  if (typeof command !== 'string' || !command || command.length > MAX_COMMAND_LENGTH) return null;
  const segments = [];
  const operators = [];
  const redirectFlags = [];
  let current = '';
  let quote = null;
  let escaped = false;
  let hasRedirect = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (escaped) { current += c; escaped = false; continue; }
    if (c === '\\' && quote !== "'") { escaped = true; current += c; continue; }
    if (quote) { if (c === quote) quote = null; current += c; continue; }
    if (c === "'" || c === '"') { quote = c; current += c; continue; }
    // Bail on subshells and backticks — too complex to segment safely
    if (c === '(' || c === ')' || c === '{' || c === '}' || c === '`') return null;
    if (c === '|') {
      if (i + 1 < command.length && command[i + 1] === '|') {
        segments.push(current); operators.push('||'); redirectFlags.push(hasRedirect);
        current = ''; hasRedirect = false; i += 1; continue;
      }
      segments.push(current); operators.push('|'); redirectFlags.push(hasRedirect);
      current = ''; hasRedirect = false; continue;
    }
    if (c === '&') {
      if (i + 1 < command.length && command[i + 1] === '&') {
        segments.push(current); operators.push('&&'); redirectFlags.push(hasRedirect);
        current = ''; hasRedirect = false; i += 1; continue;
      }
      return null; // background & — bail
    }
    if (c === ';') {
      segments.push(current); operators.push(';'); redirectFlags.push(hasRedirect);
      current = ''; hasRedirect = false; continue;
    }
    if (c === '>' || c === '<') hasRedirect = true;
    current += c;
  }
  if (quote) return null;
  segments.push(current); operators.push(null); redirectFlags.push(hasRedirect);
  return { segments, operators, redirectFlags };
}

/**
 * L2: classify a compound command by segmenting it, tracking cd environment prefixes,
 * and routing the first real segment — but only if it's the last and has no redirect (§3).
 * Returns a classification result or null if segmentation doesn't apply.
 */
function classifyCompound(command, baseRoot) {
  const parsed = segmentCommand(command);
  if (!parsed) return null;
  const { segments, operators, redirectFlags } = parsed;
  if (segments.length < 2) {
    if (redirectFlags[0]) return bypass('compound-has-redirect');
    return null;
  }
  let currentRoot = baseRoot;
  let targetIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    const trimmed = segments[i].trim();
    if (!trimmed) continue;
    const firstWord = trimmed.split(/\s+/)[0];
    if (ENV_PREFIXES.has(firstWord) && (operators[i] === '&&' || operators[i] === ';')) {
      const segTokens = tokens(trimmed);
      if (!segTokens?.length) return bypass('compound-segment-ambiguous');
      const [, ...args] = segTokens;
      if (firstWord === 'cd') {
        if (args.length === 1 && !args[0].startsWith('-')) {
          const nextRoot = safeRoot(currentRoot, args[0]);
          if (!nextRoot || (nextRoot !== baseRoot && !nextRoot.startsWith(`${baseRoot}${path.sep}`))) {
            return bypass('unsafe-cwd');
          }
          currentRoot = nextRoot;
        } else {
          return bypass('compound-segment-ambiguous');
        }
      }
      continue;
    }
    targetIndex = i;
    break;
  }
  if (targetIndex === -1) return null;
  // §3: route only if the target is the last non-empty segment and has no redirect
  for (let i = targetIndex + 1; i < segments.length; i++) {
    if (segments[i].trim()) return bypass('compound-feeds-pipeline');
  }
  if (redirectFlags[targetIndex]) return bypass('compound-has-redirect');
  const segmentTokens = tokens(segments[targetIndex].trim());
  if (!segmentTokens?.length) return bypass('compound-segment-ambiguous');
  return classifyTokens(segmentTokens, currentRoot, baseRoot);
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
    : (Array.isArray(toolInput.command) ? unwrapShellArgv(toolInput.command) : null);
  const parsed = commandTokens(toolInput.command);
  if (parsed?.length) {
    const direct = classifyTokens(parsed, root);
    if (direct.status === 'eligible') return direct;
    return wrapWholeCommand(rawCommand, env) ?? direct;
  }
  // L2: try compound command segmentation on the raw command string
  if (rawCommand) {
    const compound = classifyCompound(rawCommand, root);
    if (compound?.status === 'eligible') return compound;
    return wrapWholeCommand(rawCommand, env) ?? compound ?? bypass('ambiguous-shell');
  }
  return bypass('ambiguous-shell');
}

function metric(result, toolName, env) {
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
  const result = classifyShellCommand({ toolName, toolInput: input?.tool_input ?? input?.toolInput, cwd: input?.cwd });
  if (result.status !== 'eligible') {
    metric(result, toolName, env);
    return {};
  }
  if (env.SANDO_CLI_ROUTING !== '1') {
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
