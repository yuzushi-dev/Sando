#!/usr/bin/env node

import fs from 'node:fs';
import { spawn } from 'node:child_process';

import { materializeArtifact } from './lib/artifacts.mjs';
import { runArtifactCli } from './lib/artifact-cli.mjs';
import { runAccountingCli } from './lib/accounting-cli.mjs';
import { runContextAuditCli } from './lib/context-audit-cli.mjs';
import { runGatewayGateCli } from './lib/gateway-gate-cli.mjs';
import { normalizePolicy, optimizeToolOutput } from './lib/core.mjs';
import { captureProcess, MAX_EXEC_CAPTURE_BYTES, textOrBinary } from './lib/exec-capture.mjs';
import { callMcpTool } from './lib/mcp-tools.mjs';

const EXEC_TIMEOUT_MS = 120_000;

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

function writeResult(result, cwd) {
  process.stdout.write(`${materializeArtifact(result, cwd)}\n`);
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
  const prepared = optimizeToolOutput({ toolName: 'Bash', output, cwd, policy });
  writeResult(prepared, cwd);
  if (result.exitCode !== 0 || result.exitSignal || result.timedOut) process.exitCode = result.exitCode || 1;
}

function runRead(args, cwd, policy) {
  const values = commandArgs(args);
  if (values.length !== 1) throw new Error('read requires one workspace-relative path');
  writeResult(callMcpTool('sando_read', { path: values[0], cwd, policy }), cwd);
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
