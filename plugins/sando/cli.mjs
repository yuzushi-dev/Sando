#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { materializeArtifact } from './lib/artifacts.mjs';
import { runArtifactCli } from './lib/artifact-cli.mjs';
import { runAccountingCli } from './lib/accounting-cli.mjs';
import { runContextAuditCli } from './lib/context-audit-cli.mjs';
import { runGatewayGateCli } from './lib/gateway-gate-cli.mjs';
import { normalizePolicy, optimizeToolOutput } from './lib/core.mjs';
import { captureProcess, MAX_EXEC_CAPTURE_BYTES, textOrBinary } from './lib/exec-capture.mjs';
import { callMcpTool } from './lib/mcp-tools.mjs';

// Two minutes bounds a read or a grep, but under SANDO_SHELL_WRAP every build and test run
// passes through here too. Measured over 81,148 real commands the 99th percentile is 31s and
// the longest is 834s, so the ceiling is raised enough that the wrap never kills work that
// would otherwise have finished.
const EXEC_TIMEOUT_MS = 900_000;

function policyFromEnv(env = process.env) {
  const policy = env.SANDO_POLICY ? JSON.parse(env.SANDO_POLICY) : { mode: env.SANDO_MODE || 'apply' };
  if (/^(1|true|yes)$/i.test(env.SANDO_OBSERVE_ONLY || '')) policy.mode = 'observe';
  return normalizePolicy(policy);
}

function cwdRoot() {
  const root = fs.realpathSync(process.cwd());
  if (!fs.statSync(root).isDirectory()) throw new Error('cwd must be a directory');
  return root;
}

// On Codex the CLI replaces the shell command itself, so stdout is read as that command's
// own result: a leading `[sando] artifact ...` makes `cat f` report the header as the first
// line of the file. The handle still has to reach the model — it is the only way to recover
// the elided middle — and stderr visibility in the Codex tool result is not something we can
// rely on, so the disclosure moves to the last line instead of another stream.
// The recovery command has to be runnable as printed. `sando` is not on the model's PATH, so the
// bare name sends it hunting for the binary instead of fetching the elided range; the rewrite
// already resolves an absolute path for `read`/`grep`, and the hint needs the same treatment.
const CLI_PATH = path.resolve(import.meta.dirname, 'bin', 'sando');

function executableRecoveryHint(text) {
  return text.replace('recover: sando artifact get ', `recover: ${CLI_PATH} artifact get `);
}

function writeResult(result, cwd) {
  const out = executableRecoveryHint(materializeArtifact(result, cwd));
  const end = result.artifact ? out.indexOf('\n') : -1;
  if (end === -1) { process.stdout.write(`${out}\n`); return; }
  process.stdout.write(`${out.slice(end + 1)}\n${out.slice(0, end)}\n`);
}

const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

// `bash -lc "cat f"` is a shell carrying one command; the router needs the command, not the
// shell. Anything else is passed through as written.
function routedCommand(argv) {
  const program = argv[0]?.split('/').pop();
  if (SHELL_WRAPPERS.has(program) && argv.length === 3 && /^-[a-z]*c$/.test(argv[1])) return argv[2];
  return argv.join(' ');
}

function commandArgs(args) {
  return args[0] === '--' ? args.slice(1) : args;
}

async function runExec(args, cwd, policy) {
  const command = commandArgs(args);
  if (!command.length) throw new Error('exec requires a command');
  const maxBytes = Math.min(policy.maxArtifactBytes, MAX_EXEC_CAPTURE_BYTES);
  const child = spawn(command[0], command.slice(1), { cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const result = await captureProcess(child, { maxBytes, timeoutMs: EXEC_TIMEOUT_MS });
  const stdout = textOrBinary(result.stdout, { truncated: result.stdoutTruncated });
  const stderr = textOrBinary(result.stderr, { truncated: result.stderrTruncated });
  const binary = stdout.binary || stderr.binary;
  const status = `[sando exec exit_code=${result.exitCode ?? 'null'} signal=${result.exitSignal || 'none'} timed_out=${result.timedOut} tty=false]`;
  const boundary = result.truncated ? `[sando exec output bounded at ${maxBytes} bytes per stream]\n` : '';
  const output = binary
    ? `${boundary}${status}\n[binary output withheld]`
    : `${boundary}${status}\nstdout:\n${stdout.text}\nstderr:\n${stderr.text}`;
  // The router classifies by what the command reads, so the command has to reach it: without
  // this a `sando exec -- bash -lc 'cat app.mjs'` is scored as process-output and capped at
  // 4 KB, where the same read through `sando read` is source and gets 32 KB. A shell wrapper
  // is unwrapped first, or the router would only ever see `bash`.
  const prepared = optimizeToolOutput({ toolName: 'Bash', output, cwd, policy, toolInput: { command: routedCommand(command) } });
  writeResult(prepared, cwd);
  if (result.exitCode !== 0 || result.exitSignal || result.timedOut) process.exitCode = result.exitCode || 1;
}

// `--start-line`/`--end-line` carry the bound of a rewritten `head`/`sed`: without them the
// rewrite would answer a request for 20 lines with the whole file.
function readBounds(values) {
  const positional = [];
  const bounds = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    // `--` separates flags from the path and is not itself an operand.
    if (value === '--') continue;
    const key = value === '--start-line' ? 'startLine' : value === '--end-line' ? 'endLine' : null;
    if (!key) { positional.push(value); continue; }
    const raw = values[index + 1];
    if (!/^\d+$/.test(raw ?? '')) throw new Error(`${value} requires a positive integer`);
    bounds[key] = Number(raw);
    index += 1;
  }
  return { positional, bounds };
}

function runRead(args, cwd, policy) {
  const { positional, bounds } = readBounds(commandArgs(args));
  if (positional.length !== 1) throw new Error('read requires one workspace-relative path');
  writeResult(callMcpTool('sando_read', { path: positional[0], cwd, policy, ...bounds }), cwd);
}

function runGrep(args, cwd, policy) {
  const values = commandArgs(args).filter((value) => value !== '-F' && value !== '--fixed-strings' && value !== '--');
  if (values.length !== 2) throw new Error('grep requires PATTERN and workspace-relative PATH');
  writeResult(callMcpTool('sando_grep', { pattern: values[0], path: values[1], cwd, policy }), cwd);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...args] = argv;
  if (command === 'context' && args[0] === 'audit') {
    runContextAuditCli({ argv: args.slice(1) });
    return;
  }
  if (command === 'context' && args[0] === 'gateway-gate') {
    runGatewayGateCli({ argv: args.slice(1) });
    return;
  }
  if (command === 'artifact' && args[0] === 'get') {
    runArtifactCli({ argv: args });
    return;
  }
  const cwd = cwdRoot();
  const policy = policyFromEnv(env);
  if (command === 'read') runRead(args, cwd, policy);
  else if (command === 'grep') runGrep(args, cwd, policy);
  else if (command === 'exec') await runExec(args, cwd, policy);
  else if (command === 'accounting') runAccountingCli({ argv: args, env });
  else throw new Error('usage: sando {read|grep|exec|accounting|context audit|context gateway-gate|artifact get} ...');
}

main().catch((error) => {
  process.stderr.write(`sando: ${error instanceof Error ? error.message : 'command failed'}\n`);
  process.exitCode = 2;
});
