import fs from 'node:fs';
import path from 'node:path';

import { recordCoverage } from './coverage.mjs';

const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell_command']);
const MAX_COMMAND_LENGTH = 8192;
const MAX_PATH_LENGTH = 4096;
const MAX_PATTERN_LENGTH = 512;
const SHELL_META = new Set([';', '|', '&', '<', '>', '$', '`', '(', ')', '{', '}', '*', '?', '[', ']', '!', '~', '#']);

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

function safeTarget(root, relativePath, kind) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > MAX_PATH_LENGTH
    || path.isAbsolute(relativePath) || relativePath.includes('\0')
    || relativePath.split(/[\\/]/).includes('..') || relativePath.startsWith('-')) return null;
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { return null; }
  if (stat.isSymbolicLink()) return null;
  let target;
  try { target = fs.realpathSync(candidate); } catch { return null; }
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  if (kind === 'file' && !stat.isFile()) return null;
  if (kind === 'search' && !stat.isFile() && !stat.isDirectory()) return null;
  return path.relative(root, target).split(path.sep).join('/') || '.';
}

function classifyTokens(commandTokens, root) {
  const [program, ...arguments_] = commandTokens;
  if (program === 'cat') {
    const args = arguments_[0] === '--' ? arguments_.slice(1) : arguments_;
    if (args.length !== 1) return bypass('read-shape');
    const relativePath = safeTarget(root, args[0], 'file');
    return relativePath ? { status: 'eligible', route: 'sando_read', path: relativePath } : bypass('unsafe-read-target');
  }
  if (program !== 'rg' && program !== 'grep') return bypass('unsupported-shell');
  if (!['-F', '--fixed-strings'].includes(arguments_[0]) || arguments_[1] !== '--' || arguments_.length !== 4) {
    return bypass('grep-shape');
  }
  const pattern = arguments_[2];
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH || pattern.includes('\0')) return bypass('unsafe-grep-pattern');
  const relativePath = safeTarget(root, arguments_[3], 'search');
  return relativePath ? { status: 'eligible', route: 'sando_grep', pattern, path: relativePath } : bypass('unsafe-grep-target');
}

export function classifyShellCommand({ toolName, toolInput, cwd } = {}) {
  if (!SHELL_TOOLS.has(toolName)) return bypass('unsupported-tool');
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return bypass('invalid-input');
  const root = safeRoot(cwd, toolInput.workdir);
  if (!root) return bypass('unsafe-cwd');
  const commandTokens = tokens(toolInput.command);
  if (!commandTokens?.length) return bypass('ambiguous-shell');
  return classifyTokens(commandTokens, root);
}

function metric(result, toolName, env) {
  try {
    if (result.status === 'eligible') {
      recordCoverage({
        buckets: ['eligible', 'routed', 'blocked'], reason: result.route === 'sando_read' ? 'covered-read' : 'covered-grep',
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
  metric(result, toolName, env);
  if (result.status !== 'eligible') return {};
  const tool = result.route === 'sando_read' ? 'sando_read' : 'sando_grep';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Sando routed this covered command to ${tool}. Use the ${tool} MCP tool; ambiguous commands remain allowed and are counted as bypasses.`,
    },
  };
}
