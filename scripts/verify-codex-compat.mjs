#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runPreToolUse } from '../adapters/codex/sando/lib/enforcement.mjs';

export const CANDIDATE_VERSIONS = Object.freeze(['0.159.2', '0.153.4']);

const repoRoot = path.resolve(import.meta.dirname, '..');
const fixtureRoot = path.join(repoRoot, 'packages/sando/tests/codex-compat');
const hookPath = path.join(repoRoot, 'adapters/codex/sando/hooks/pre-tool-use.mjs');
const enforcementPath = path.join(repoRoot, 'adapters/codex/sando/lib/enforcement.mjs');
const SAFE_ENV_KEYS = Object.freeze(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL', 'SYSTEMROOT', 'WINDIR']);

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8'));
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

export function createIsolatedEnvironment(root, baseEnv = process.env) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('isolation root must be absolute');
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof baseEnv[key] === 'string' && baseEnv[key]) env[key] = baseEnv[key];
  }
  env.PATH ??= '/usr/bin:/bin';
  env.HOME = path.join(root, 'home');
  env.CODEX_HOME = path.join(root, 'codex');
  env.XDG_CONFIG_HOME = path.join(root, 'xdg-config');
  env.XDG_CACHE_HOME = path.join(root, 'xdg-cache');
  env.XDG_DATA_HOME = path.join(root, 'xdg-data');
  env.XDG_STATE_HOME = path.join(root, 'xdg-state');
  env.DO_NOT_TRACK = '1';
  env.SANDO_CLI_ROUTING = '1';
  env.SANDO_SHELL_WRAP = '1';
  for (const directory of [env.HOME, env.CODEX_HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) {
    ensurePrivateDirectory(directory);
  }
  return env;
}

function normalizeExit(result) {
  if (result.status !== null) return result.status;
  return result.signal ? 128 + (os.constants.signals[result.signal] ?? 0) : null;
}

function parseRoutedOutput(buffer) {
  let text = buffer.toString('utf8');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  const match = /^\[sando exec exit_code=(null|\d+) signal=(none|[A-Z0-9]+) timed_out=(?:true|false) tty=false\]\nstdout:\n([\s\S]*?)\nstderr:\n([\s\S]*)$/.exec(text);
  return match ? {
    exitCode: match[1] === 'null' ? null : Number(match[1]),
    signal: match[2] === 'none' ? null : match[2],
    stdout: Buffer.from(match[3]),
    stderr: Buffer.from(match[4]),
    binary: false,
  }
    : { stdout: null, stderr: null, binary: text.includes('[binary output withheld]') };
}

function snapshot(directory) {
  const entries = [];
  const visit = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full, childRelative);
      else if (entry.isFile()) entries.push({
        path: childRelative,
        sha256: createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
      });
      else entries.push({ path: childRelative, type: entry.isSymbolicLink() ? 'symlink' : 'other' });
    }
  };
  visit(directory);
  return entries;
}

function runShell(command, cwd, env, stdin) {
  return spawnSync('bash', ['-lc', command], {
    cwd,
    env,
    input: stdin === undefined ? undefined : Buffer.from(stdin),
    encoding: null,
    timeout: 20_000,
  });
}

export function runHookFixture(fixture, isolationRoot) {
  const workspace = path.join(isolationRoot, 'workspace');
  ensurePrivateDirectory(workspace);
  const env = createIsolatedEnvironment(path.join(isolationRoot, 'environment'));
  const input = { ...fixture.input, cwd: workspace };
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: workspace,
    env,
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) return { id: fixture.id, status: 'failed', detail: result.stderr || `hook exited ${result.status}` };
  let output;
  try { output = JSON.parse(result.stdout); }
  catch { return { id: fixture.id, status: 'failed', detail: 'hook output was not JSON' }; }
  if (fixture.expected.kind === 'bypass') {
    return Object.keys(output).length === 0
      ? { id: fixture.id, status: 'passed' }
      : { id: fixture.id, status: 'failed', detail: 'unknown tool was rewritten' };
  }
  const specific = output.hookSpecificOutput;
  const preserved = Object.entries(fixture.input.tool_input).every(([key, value]) => (
    key === 'command' || JSON.stringify(specific?.updatedInput?.[key]) === JSON.stringify(value)
  ));
  const passed = specific?.hookEventName === fixture.expected.hookEventName
    && specific?.permissionDecision === 'allow'
    && typeof specific?.updatedInput?.command === 'string'
    && specific.updatedInput.command.includes('sando')
    && preserved;
  return passed
    ? { id: fixture.id, status: 'passed' }
    : { id: fixture.id, status: 'failed', detail: 'rewrite did not satisfy the fixture contract' };
}

export function runShellFixture(fixture, isolationRoot) {
  const nativeDirectory = path.join(isolationRoot, fixture.id, 'native', 'workspace');
  const routedDirectory = path.join(isolationRoot, fixture.id, 'routed', 'workspace');
  ensurePrivateDirectory(nativeDirectory);
  ensurePrivateDirectory(routedDirectory);
  const nativeEnv = createIsolatedEnvironment(path.join(isolationRoot, fixture.id, 'native', 'environment'));
  const routedEnv = createIsolatedEnvironment(path.join(isolationRoot, fixture.id, 'routed', 'environment'));
  const native = runShell(fixture.command, nativeDirectory, nativeEnv, fixture.stdin);
  const hookOutput = runPreToolUse({
    hook_event_name: 'PreToolUse',
    tool_name: 'exec_command',
    tool_input: { command: fixture.command },
    cwd: routedDirectory,
  }, routedEnv);
  const rewritten = hookOutput.hookSpecificOutput?.updatedInput?.command;
  if (typeof rewritten !== 'string') return { id: fixture.id, status: 'failed', detail: 'command was not rewritten' };
  const routed = runShell(rewritten, routedDirectory, routedEnv, fixture.stdin);
  const routedOutput = parseRoutedOutput(routed.stdout ?? Buffer.alloc(0));
  const problems = [];
  if (native.error) problems.push(`native spawn: ${native.error.message}`);
  if (routed.error) problems.push(`routed spawn: ${routed.error.message}`);
  if (normalizeExit(native) !== normalizeExit(routed)) problems.push(`exit ${normalizeExit(native)} != ${normalizeExit(routed)}`);
  if (fixture.signal && native.signal !== fixture.signal) problems.push(`native signal ${native.signal ?? 'none'} != ${fixture.signal}`);
  if (fixture.signal && routedOutput.signal !== fixture.signal) problems.push(`routed envelope signal ${routedOutput.signal ?? 'none'} != ${fixture.signal}`);
  if (JSON.stringify(snapshot(nativeDirectory)) !== JSON.stringify(snapshot(routedDirectory))) problems.push('file effects differ');
  if (fixture.binary) {
    if (!routedOutput.binary) problems.push('binary output was not identified and withheld');
  } else if (!routedOutput.stdout || !routedOutput.stderr) {
    problems.push('routed output envelope could not be parsed');
  } else {
    if (!routedOutput.stdout.equals(native.stdout ?? Buffer.alloc(0))) problems.push('stdout differs');
    if (!routedOutput.stderr.equals(native.stderr ?? Buffer.alloc(0))) problems.push('stderr differs');
    if (fixture.expectedStdout !== undefined && !native.stdout.equals(Buffer.from(fixture.expectedStdout))) problems.push('native stdout does not match fixture expectation');
    if (fixture.expectedStdout !== undefined && !routedOutput.stdout.equals(Buffer.from(fixture.expectedStdout))) problems.push('routed stdout does not match fixture expectation');
  }
  return problems.length
    ? { id: fixture.id, status: 'failed', detail: problems.join('; ') }
    : { id: fixture.id, status: 'passed' };
}

function executablesOnPath(name, env) {
  const matches = [];
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      matches.push(candidate);
    } catch {}
  }
  return matches;
}

function findVendorBinary(launcherPath) {
  let resolved;
  try { resolved = fs.realpathSync(launcherPath); } catch { return null; }
  const packageRoot = path.resolve(path.dirname(resolved), '..');
  const dependencyRoot = path.join(packageRoot, 'node_modules', '@openai');
  if (!fs.statSync(dependencyRoot, { throwIfNoEntry: false })?.isDirectory()) return null;
  const stack = [dependencyRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === 'codex') {
        try { fs.accessSync(full, fs.constants.X_OK); return full; } catch {}
      }
    }
  }
  return null;
}

function probeInstalledCodex(isolationRoot) {
  const env = createIsolatedEnvironment(isolationRoot);
  const commands = executablesOnPath(process.platform === 'win32' ? 'codex.exe' : 'codex', env);
  const command = commands.find((candidate) => fs.lstatSync(candidate).isSymbolicLink()) ?? commands[0];
  if (!command) return null;
  const result = spawnSync(command, ['--version'], { env, encoding: 'utf8', timeout: 10_000 });
  const match = /(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+)/i.exec(result.stdout ?? '');
  if (result.status !== 0 || !match) return null;
  const resolvedPath = fs.realpathSync(command);
  const binaryPath = findVendorBinary(command);
  return {
    command,
    resolvedPath,
    sha256: fileHash(resolvedPath),
    ...(binaryPath ? { binaryPath, binarySha256: fileHash(binaryPath) } : {}),
    version: match[1],
  };
}

function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function codexBundleHash() {
  const adapterRoot = path.join(repoRoot, 'adapters/codex/sando');
  const files = [path.join(adapterRoot, 'cli.mjs'), path.join(adapterRoot, 'bin/sando')];
  for (const directory of ['hooks', 'lib']) {
    const absolute = path.join(adapterRoot, directory);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.json'))) files.push(path.join(absolute, entry.name));
    }
  }
  files.sort();
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(path.relative(adapterRoot, file));
    digest.update('\0');
    digest.update(fs.readFileSync(file));
    digest.update('\0');
  }
  return { algorithm: 'sha256-tree-v1', fileCount: files.length, sha256: digest.digest('hex') };
}

function gitValue(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function runCompatibilityCheck({ probe, loopbackEvidence } = {}) {
  const isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-compat-'));
  try {
    const hooks = readFixture('pre-tool-use.synthetic.json').cases.map((fixture) => runHookFixture(fixture, path.join(isolationRoot, 'hooks', fixture.id)));
    const shell = readFixture('shell-cases.synthetic.json').cases.map((fixture) => runShellFixture(fixture, path.join(isolationRoot, 'shell')));
    const checks = [...hooks, ...shell];
    const installed = probe === undefined ? probeInstalledCodex(path.join(isolationRoot, 'probe')) : probe;
    return {
      schema: 'sando-codex-compatibility-report/v1',
      generatedAt: new Date().toISOString(),
      repository: { sha: gitValue(['rev-parse', 'HEAD']), dirty: Boolean(gitValue(['status', '--porcelain'])) },
      runtime: { platform: process.platform, architecture: process.arch, node: process.version },
      enforcement: {
        source: path.relative(repoRoot, enforcementPath),
        sha256: fileHash(enforcementPath),
      },
      codexBundle: codexBundleHash(),
      fixtures: { synthetic: true, realClientLoopbackCapture: true },
      offline: {
        status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
        checks,
      },
      loopbackClient: loopbackEvidence ?? { status: 'not-run', reason: 'run with --loopback-client to exercise the real Codex client against a synthetic local provider' },
      detectedCodex: installed ? { ...installed, liveCompatibilityProof: false } : null,
      candidates: CANDIDATE_VERSIONS.map((version) => ({
        version,
        status: 'not-run',
        authenticatedProvider: 'not-run',
        syntheticLoopback: loopbackEvidence?.codexVersion === version ? loopbackEvidence.status : 'not-run',
        reason: 'authenticated live proof was not run; an installed binary/version probe is not compatibility evidence',
      })),
      clientBoundary: [
        { scenario: 'startup', status: loopbackEvidence?.assertions?.startupObserved ? 'passed' : 'not-run', scope: loopbackEvidence?.assertions?.startupObserved ? 'synthetic-loopback' : undefined, reason: loopbackEvidence?.assertions?.startupObserved ? undefined : 'requires a live client lifecycle observation' },
        { scenario: 'resume', status: loopbackEvidence?.assertions?.resumeObserved ? 'passed' : 'not-run', scope: loopbackEvidence?.assertions?.resumeObserved ? 'synthetic-loopback' : undefined, reason: loopbackEvidence?.assertions?.resumeObserved ? undefined : 'requires a live client lifecycle observation' },
        { scenario: 'immediate-result-consumption', status: loopbackEvidence?.assertions?.rewrittenCommandConsumed ? 'passed' : 'not-run', scope: loopbackEvidence?.assertions?.rewrittenCommandConsumed ? 'synthetic-loopback' : undefined, reason: loopbackEvidence?.assertions?.rewrittenCommandConsumed ? undefined : 'local hook output does not prove the client consumed updatedInput' },
        { scenario: 'streaming-sse-single-execution', status: loopbackEvidence?.assertions?.streamingSseCompleted && loopbackEvidence?.assertions?.executionCount === 1 ? 'passed' : 'not-run', scope: loopbackEvidence?.assertions?.streamingSseCompleted ? 'synthetic-loopback-sse' : undefined, reason: loopbackEvidence?.assertions?.streamingSseCompleted ? undefined : 'requires proof that streaming neither rewrites nor executes twice' },
        { scenario: 'tool-polling', status: 'not-run', reason: 'the loopback shell surface completed synchronously and did not expose a poll operation' },
        { scenario: 'approval-denial', status: loopbackEvidence?.scenarios?.approvalDenial?.status ?? 'not-run', scope: loopbackEvidence?.scenarios?.approvalDenial ? 'synthetic-loopback' : undefined, ...((loopbackEvidence?.scenarios?.approvalDenial?.reason || !loopbackEvidence?.scenarios?.approvalDenial) ? { reason: loopbackEvidence?.scenarios?.approvalDenial?.reason ?? 'requires an explicit live denial without weakening sandbox or approval settings' } : {}) },
        { scenario: 'unknown-future-hook-event', status: 'unsupported', reason: 'no observed client contract fixture exists' },
      ],
    };
  } finally {
    fs.rmSync(isolationRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const runLoopback = process.argv.includes('--loopback-client');
  const loopbackEvidence = runLoopback
    ? await import('./codex-loopback-contract.mjs').then(({ runLoopbackCodexContract }) => runLoopbackCodexContract())
    : undefined;
  const report = runCompatibilityCheck({ loopbackEvidence });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.offline.status !== 'passed') process.exitCode = 1;
  else if (runLoopback && loopbackEvidence.status !== 'passed') process.exitCode = 2;
}
