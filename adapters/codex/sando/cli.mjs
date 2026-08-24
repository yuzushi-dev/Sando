#!/usr/bin/env node

import fs from 'node:fs';
import { spawn } from 'node:child_process';

import { materializeArtifact } from './lib/artifacts.mjs';
import { normalizePolicy, optimizeToolOutput } from './lib/core.mjs';
import { callMcpTool } from './lib/mcp-tools.mjs';

const MAX_CAPTURE_BYTES = 16_777_216;
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

function captureChild(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    const stderr = [];
    let captured = 0;
    let truncated = false;
    let timedOut = false;
    const collect = (bucket, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, MAX_CAPTURE_BYTES - captured);
      if (remaining) {
        bucket.push(buffer.subarray(0, remaining));
        captured += Math.min(buffer.length, remaining);
      }
      if (buffer.length > remaining) truncated = true;
    };
    const terminate = (signal) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
      try { child.kill(signal); } catch {}
    };
    const timer = setTimeout(() => { timedOut = true; terminate('SIGTERM'); }, EXEC_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, signal, truncated, timedOut });
    });
  });
}

function textOrBinary(buffer) {
  if (buffer.includes(0)) return { binary: true, text: '' };
  try { return { binary: false, text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }; }
  catch { return { binary: true, text: '' }; }
}

async function runExec(args, cwd, policy) {
  const command = commandArgs(args);
  if (!command.length) throw new Error('exec requires a command');
  const result = await captureChild(command[0], command.slice(1), cwd);
  const stdout = textOrBinary(result.stdout);
  const stderr = textOrBinary(result.stderr);
  const binary = stdout.binary || stderr.binary;
  const status = `[sando exec exit_code=${result.exitCode ?? 'null'} signal=${result.signal || 'none'} timed_out=${result.timedOut} tty=false]`;
  const output = binary
    ? `${status}\n[binary output withheld]`
    : `${status}\nstdout:\n${stdout.text}\nstderr:\n${stderr.text}${result.truncated ? `\n[sando exec output bounded at ${MAX_CAPTURE_BYTES} bytes]` : ''}`;
  const prepared = optimizeToolOutput({ toolName: 'Bash', output, cwd, policy });
  writeResult(prepared, cwd);
  if (result.exitCode !== 0 || result.signal || result.timedOut) process.exitCode = result.exitCode || 1;
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

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  const cwd = cwdRoot();
  const policy = policyFromEnv();
  if (command === 'read') runRead(args, cwd, policy);
  else if (command === 'grep') runGrep(args, cwd, policy);
  else if (command === 'exec') await runExec(args, cwd, policy);
  else throw new Error('usage: sando {read|grep|exec} ...');
}

main().catch((error) => {
  process.stderr.write(`sando: ${error instanceof Error ? error.message : 'command failed'}\n`);
  process.exitCode = 2;
});
