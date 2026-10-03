#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runPreToolUse } from '../adapters/codex/sando/lib/enforcement.mjs';

export const CANDIDATE_VERSIONS = Object.freeze(['0.160.0', '0.159.2', '0.153.4']);
const OUTPUT_CONTRACT_SCHEMA = 'sando-openai-output-contract/v1';
const OUTPUT_STATUSES = new Set(['passed', 'failed', 'not-run']);
const BOUNDED_REASONS = new Set([
  'codex-binary-unavailable',
  'codex-client-spawn-failed',
  'codex-client-timeout',
  'codex-surface-unavailable',
  'codex-process-signaled',
  'codex-process-nonzero-exit',
  'capture-limit-exceeded',
  'contract-observation-mismatch',
  'app-server-contract-failed',
  'not-requested',
]);
const REQUIRED_OUTPUT_SCENARIOS = Object.freeze([
  'directNoHook',
  'directCurrentFallback',
  'directContinueFalse',
  'directBlock',
  'codeModeNoHook',
  'codeModeExecuteContinueFalse',
  'codeModeWaitNoHook',
  'codeModeWaitContinueFalse',
  'codeModeBlock',
]);
const OUTPUT_SCENARIO_IDS = new Set([
  'direct-no-hook',
  'direct-current-fallback',
  'direct-continue-false',
  'direct-block',
  'code-mode-no-hook',
  'code-mode-execute-continue-false',
  'code-mode-wait-no-hook',
  'code-mode-wait-continue-false',
  'code-mode-block',
]);
const OUTPUT_SCENARIO_META = Object.freeze({
  'direct-no-hook': ['direct', 'post-tool-use', 'none'],
  'direct-current-fallback': ['direct', 'post-tool-use', 'current-fallback'],
  'direct-continue-false': ['direct', 'post-tool-use', 'continue'],
  'direct-block': ['direct', 'post-tool-use', 'block'],
  'code-mode-no-hook': ['execute', 'code-mode-execute', 'none'],
  'code-mode-execute-continue-false': ['execute', 'code-mode-execute', 'continue'],
  'code-mode-wait-no-hook': ['wait', 'code-mode-wait', 'none'],
  'code-mode-wait-continue-false': ['wait', 'code-mode-wait', 'continue'],
  'code-mode-block': ['execute', 'code-mode-execute', 'block'],
});
const OUTPUT_SCENARIO_KEY_TO_ID = Object.freeze({
  directNoHook: 'direct-no-hook',
  directCurrentFallback: 'direct-current-fallback',
  directContinueFalse: 'direct-continue-false',
  directBlock: 'direct-block',
  codeModeNoHook: 'code-mode-no-hook',
  codeModeExecuteContinueFalse: 'code-mode-execute-continue-false',
  codeModeWaitNoHook: 'code-mode-wait-no-hook',
  codeModeWaitContinueFalse: 'code-mode-wait-continue-false',
  codeModeBlock: 'code-mode-block',
});

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
  if (result.status !== 0) return { id: fixture.id, status: 'failed', detail: 'hook process failed' };
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
  if (native.error) problems.push('native spawn failed');
  if (routed.error) problems.push('routed spawn failed');
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

function assertExactKeys(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} is required`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${label} has unexpected field ${key}`);
}

function assertHash(value, label, { nullable = false, head = false } = {}) {
  if (nullable && value === null) return;
  const pattern = head ? /^[a-f0-9]{40,64}$/ : /^[a-f0-9]{64}$/;
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${label} must be a hexadecimal digest`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function computeOutputReceiptEvidenceDigest(receipt) {
  const { evidenceDigest: _ignored, ...delivery } = receipt.delivery;
  return createHash('sha256').update(stableJson({ ...receipt, delivery })).digest('hex');
}

function validateIdentity(client, sando) {
  assertExactKeys(client, ['name', 'version', 'available', 'wrapperSha256', 'launcherSha256', 'nativeBinarySha256'], [], 'client');
  if (client.name !== 'codex' || typeof client.available !== 'boolean') throw new TypeError('client identity is invalid');
  if (client.version !== null && typeof client.version !== 'string') throw new TypeError('client.version is invalid');
  for (const key of ['wrapperSha256', 'launcherSha256', 'nativeBinarySha256']) assertHash(client[key], `client.${key}`, { nullable: true });
  assertExactKeys(sando, ['head', 'worktreeManifestHash', 'bundleHash'], [], 'sando');
  assertHash(sando.head, 'sando.head', { head: true });
  assertHash(sando.worktreeManifestHash, 'sando.worktreeManifestHash');
  assertHash(sando.bundleHash, 'sando.bundleHash');
}

function validateProvenance(provenance) {
  assertExactKeys(provenance, ['client', 'provider', 'mcpServer', 'externalNetwork', 'authenticatedProvider'], [], 'provenance');
  if (provenance.client !== 'real-installed-codex' || provenance.provider !== 'synthetic-http-sse-loopback'
    || provenance.mcpServer !== 'synthetic-stdio-fixture' || provenance.externalNetwork !== false
    || provenance.authenticatedProvider !== false) throw new TypeError('provenance is invalid');
}

function validateReference(reference) {
  assertExactKeys(reference, ['tag', 'commit', 'commitMatch', 'testedFeatures'], [], 'reference');
  if (reference.tag !== 'rust-v0.160.0' || reference.commit !== 'a956835d020762cb2b570053af06f643a11c0ecc'
    || !['unknown', 'matched', 'mismatched'].includes(reference.commitMatch)
    || !Array.isArray(reference.testedFeatures) || reference.testedFeatures.some((value) => typeof value !== 'string')) {
    throw new TypeError('reference is invalid');
  }
}

function passedScenarioMatches(receipt) {
  const { scenario, observations: value } = receipt;
  const common = value.executionCount === 1 && value.approval.requested === false
    && value.approval.decision === 'not-applicable' && value.cancel.requested === false
    && value.cancel.observed === false;
  if (!common) return false;
  if (scenario.id === 'direct-no-hook') return !value.hookObserved && value.hookEffect === 'absent'
    && value.promiseOutcome === 'not-applicable' && value.rawMarkerVisible && value.typedValueVisible
    && !value.isErrorVisible && !value.replacementMarkerVisible && !value.fallbackMarkerVisible;
  if (scenario.id === 'direct-current-fallback') return value.hookObserved && value.hookEffect === 'current-fallback'
    && !value.rawMarkerVisible && !value.typedValueVisible && !value.isErrorVisible
    && !value.replacementMarkerVisible && value.fallbackMarkerVisible;
  if (scenario.id === 'direct-continue-false') return value.hookObserved && value.hookEffect === 'replacement'
    && !value.rawMarkerVisible && !value.typedValueVisible && !value.isErrorVisible
    && value.replacementMarkerVisible && !value.fallbackMarkerVisible;
  if (scenario.id === 'direct-block') return value.hookObserved && value.hookEffect === 'blocked'
    && !value.rawMarkerVisible && !value.typedValueVisible && !value.isErrorVisible
    && value.replacementMarkerVisible && !value.fallbackMarkerVisible;
  if (scenario.id === 'code-mode-block') return value.hookObserved && value.hookEffect === 'blocked'
    && value.promiseOutcome === 'rejected' && value.blockBehavior === 'rejected'
    && !value.rawMarkerVisible && !value.typedValueVisible && !value.isErrorVisible
    && !value.replacementMarkerVisible && !value.fallbackMarkerVisible;
  const original = value.rawMarkerVisible && value.typedValueVisible && value.isErrorVisible
    && !value.replacementMarkerVisible && !value.fallbackMarkerVisible && value.promiseOutcome === 'resolved';
  if (scenario.id === 'code-mode-no-hook') return original && !value.hookObserved && value.hookEffect === 'absent';
  if (scenario.id === 'code-mode-execute-continue-false') return original && value.hookObserved && value.hookEffect === 'preserved-original';
  if (scenario.id === 'code-mode-wait-no-hook') return original && !value.hookObserved
    && value.hookEffect === 'absent' && value.executeWait === 'observed';
  if (scenario.id === 'code-mode-wait-continue-false') return original && value.hookObserved
    && value.hookEffect === 'preserved-original' && value.executeWait === 'observed';
  return false;
}

export function validateOutputContractReceipt(receipt) {
  assertExactKeys(receipt, [
    'schema', 'verifierVersion', 'status', 'provenance', 'reference', 'client', 'sando', 'scenario', 'observations',
    'delivery', 'usage', 'recovery',
  ], ['reason'], 'receipt');
  if (receipt.schema !== OUTPUT_CONTRACT_SCHEMA) throw new TypeError('receipt.schema is invalid');
  if (typeof receipt.verifierVersion !== 'string' || !receipt.verifierVersion) throw new TypeError('receipt.verifierVersion is invalid');
  if (!OUTPUT_STATUSES.has(receipt.status)) throw new TypeError('receipt.status is invalid');
  validateProvenance(receipt.provenance);
  validateReference(receipt.reference);
  validateIdentity(receipt.client, receipt.sando);
  if (!receipt.client.available && receipt.status !== 'not-run') throw new TypeError('unavailable client cannot pass or fail a receipt');
  assertExactKeys(receipt.scenario, ['id', 'surface', 'stage', 'hook', 'resultType'], [], 'receipt.scenario');
  if (!OUTPUT_SCENARIO_IDS.has(receipt.scenario.id)) throw new TypeError('receipt.scenario.id is invalid');
  if (JSON.stringify([receipt.scenario.surface, receipt.scenario.stage, receipt.scenario.hook])
    !== JSON.stringify(OUTPUT_SCENARIO_META[receipt.scenario.id])) throw new TypeError('receipt scenario metadata is contradictory');
  if (!['direct', 'execute', 'wait'].includes(receipt.scenario.surface)) throw new TypeError('receipt.scenario.surface is invalid');
  if (!['post-tool-use', 'code-mode-execute', 'code-mode-wait'].includes(receipt.scenario.stage)
    || receipt.scenario.resultType !== 'mcp-tool-result') throw new TypeError('receipt.scenario stage/result type is invalid');
  assertExactKeys(receipt.observations, [
    'process', 'executionCount', 'typedValueVisible', 'isErrorVisible', 'rawMarkerVisible', 'replacementMarkerVisible',
    'fallbackMarkerVisible', 'privateTopMetaVisible', 'executeWait', 'blockBehavior',
    'hookObserved', 'hookEffect', 'promiseOutcome', 'approval', 'cancel', 'expectedSatisfied',
  ], [], 'receipt.observations');
  assertExactKeys(receipt.observations.process, ['exitStatus', 'signal', 'termination'], [], 'receipt.observations.process');
  if (receipt.observations.process.exitStatus !== null && !Number.isInteger(receipt.observations.process.exitStatus)) throw new TypeError('process.exitStatus is invalid');
  if (receipt.observations.process.signal !== null && typeof receipt.observations.process.signal !== 'string') throw new TypeError('process.signal is invalid');
  if (!['completed', 'nonzero-exit', 'signal', 'timeout', 'capture-limit', 'not-started'].includes(receipt.observations.process.termination)) throw new TypeError('process.termination is invalid');
  if (!Number.isInteger(receipt.observations.executionCount) || receipt.observations.executionCount < 0) throw new TypeError('executionCount is invalid');
  for (const key of ['typedValueVisible', 'isErrorVisible', 'rawMarkerVisible', 'replacementMarkerVisible', 'fallbackMarkerVisible', 'privateTopMetaVisible', 'expectedSatisfied']) {
    if (![true, false, null].includes(receipt.observations[key])) throw new TypeError(`${key} is invalid`);
  }
  if (typeof receipt.observations.hookObserved !== 'boolean') throw new TypeError('hookObserved is invalid');
  if (!['observed', 'not-observed', 'not-applicable'].includes(receipt.observations.executeWait)) throw new TypeError('executeWait is invalid');
  if (!['rejected', 'withheld', 'not-observed', 'not-applicable'].includes(receipt.observations.blockBehavior)) throw new TypeError('blockBehavior is invalid');
  if (!['absent', 'replacement', 'current-fallback', 'preserved-original', 'blocked', 'not-observed'].includes(receipt.observations.hookEffect)) throw new TypeError('hookEffect is invalid');
  if (!['resolved', 'rejected', 'withheld', 'not-observed', 'not-applicable'].includes(receipt.observations.promiseOutcome)) throw new TypeError('promiseOutcome is invalid');
  assertExactKeys(receipt.observations.approval, ['requested', 'decision'], [], 'receipt.observations.approval');
  if (typeof receipt.observations.approval.requested !== 'boolean' || !['not-applicable', 'approved', 'denied'].includes(receipt.observations.approval.decision)) throw new TypeError('approval observation is invalid');
  assertExactKeys(receipt.observations.cancel, ['requested', 'observed'], [], 'receipt.observations.cancel');
  if (typeof receipt.observations.cancel.requested !== 'boolean' || typeof receipt.observations.cancel.observed !== 'boolean') throw new TypeError('cancel observation is invalid');
  if (receipt.status === 'passed' && receipt.observations.expectedSatisfied !== true) throw new TypeError('passed receipt requires expectedSatisfied=true');
  if (receipt.status === 'failed' && receipt.observations.expectedSatisfied !== false) throw new TypeError('failed receipt requires expectedSatisfied=false');
  if (receipt.status === 'not-run' && receipt.observations.expectedSatisfied !== null) throw new TypeError('not-run receipt requires expectedSatisfied=null');
  if (receipt.status === 'passed' && (receipt.observations.process.exitStatus !== 0
    || receipt.observations.process.signal !== null || receipt.observations.process.termination !== 'completed')) {
    throw new TypeError('passed receipt requires process exitStatus 0 and completed termination');
  }
  if (receipt.status === 'passed' && !passedScenarioMatches(receipt)) throw new TypeError('passed receipt observations contradict the scenario contract');
  assertExactKeys(receipt.delivery, ['actualBytes', 'resultUtf8Bytes', 'sha256', 'controlledField', 'controlledFieldDeltaBytes', 'evidenceDigest'], [], 'receipt.delivery');
  if (receipt.status !== 'not-run') {
    if (!Number.isInteger(receipt.delivery.actualBytes) || receipt.delivery.actualBytes < 0) throw new TypeError('delivery.actualBytes is required');
    assertHash(receipt.delivery.sha256, 'delivery.sha256');
  }
  assertHash(receipt.delivery.evidenceDigest, 'delivery.evidenceDigest');
  if (receipt.delivery.resultUtf8Bytes !== null && (!Number.isInteger(receipt.delivery.resultUtf8Bytes) || receipt.delivery.resultUtf8Bytes < 0)) throw new TypeError('delivery.resultUtf8Bytes is invalid');
  if (computeOutputReceiptEvidenceDigest(receipt) !== receipt.delivery.evidenceDigest) throw new TypeError('delivery.evidenceDigest does not match the deterministic receipt core');
  if (receipt.status === 'passed' && receipt.delivery.controlledField === null) throw new TypeError('delivery.controlledField is required');
  if (receipt.delivery.controlledField !== null) {
    assertExactKeys(receipt.delivery.controlledField, ['classification', 'startByte', 'endByte', 'byteLength', 'sha256'], [], 'delivery.controlledField');
    const field = receipt.delivery.controlledField;
    if (!['raw', 'replacement', 'current-fallback', 'promise-resolved', 'promise-rejected', 'promise-withheld'].includes(field.classification)) throw new TypeError('delivery.controlledField.classification is invalid');
    if (!Number.isInteger(field.startByte) || !Number.isInteger(field.endByte) || !Number.isInteger(field.byteLength)
      || field.endByte - field.startByte !== field.byteLength || field.byteLength < 1) throw new TypeError('delivery.controlledField span is invalid');
    if (Number.isInteger(receipt.delivery.actualBytes) && field.endByte > receipt.delivery.actualBytes) throw new TypeError('delivery.controlledField exceeds delivery bytes');
    assertHash(field.sha256, 'delivery.controlledField.sha256');
  }
  if (receipt.delivery.controlledFieldDeltaBytes !== null && !Number.isInteger(receipt.delivery.controlledFieldDeltaBytes)) throw new TypeError('controlledFieldDeltaBytes is invalid');
  assertExactKeys(receipt.usage, ['provider', 'localEstimates'], [], 'receipt.usage');
  if (receipt.usage.provider !== null) throw new TypeError('provider usage must remain null for loopback evidence');
  assertExactKeys(receipt.usage.localEstimates, ['requestCount', 'requestBytes'], [], 'receipt.usage.localEstimates');
  if (!Number.isInteger(receipt.usage.localEstimates.requestCount) || receipt.usage.localEstimates.requestCount < 0
    || !Number.isInteger(receipt.usage.localEstimates.requestBytes) || receipt.usage.localEstimates.requestBytes < 0) throw new TypeError('local usage estimates are invalid');
  assertExactKeys(receipt.recovery, ['status', 'attempted', 'method', 'artifactRef', 'recoveredBytes', 'errorClass'], [], 'receipt.recovery');
  if (receipt.recovery.status !== 'not-needed' || receipt.recovery.attempted !== false
    || receipt.recovery.method !== null || receipt.recovery.artifactRef !== null
    || receipt.recovery.recoveredBytes !== null || receipt.recovery.errorClass !== null) throw new TypeError('A1 recovery fields must remain not-needed/null');
  if (receipt.status === 'not-run') {
    if (!BOUNDED_REASONS.has(receipt.reason)) throw new TypeError('not-run receipt requires a bounded reason');
    if (!['codex-binary-unavailable', 'codex-client-spawn-failed', 'codex-surface-unavailable'].includes(receipt.reason)) throw new TypeError('not-run is limited to unavailable binary or surface');
  } else if (receipt.status === 'failed') {
    if (!BOUNDED_REASONS.has(receipt.reason)) throw new TypeError('failed receipt requires a bounded reason');
    const process = receipt.observations.process;
    if (receipt.reason === 'codex-process-nonzero-exit' && (process.termination !== 'nonzero-exit' || process.exitStatus === 0 || process.exitStatus === null)) throw new TypeError('nonzero reason contradicts process evidence');
    if (receipt.reason === 'codex-process-signaled' && (process.termination !== 'signal' || process.signal === null)) throw new TypeError('signal reason contradicts process evidence');
    if (receipt.reason === 'codex-client-timeout' && process.termination !== 'timeout') throw new TypeError('timeout reason contradicts process evidence');
    if (receipt.reason === 'capture-limit-exceeded' && process.termination !== 'capture-limit') throw new TypeError('capture reason contradicts process evidence');
    if (receipt.reason === 'contract-observation-mismatch' && (process.exitStatus !== 0 || process.termination !== 'completed')) throw new TypeError('observation mismatch requires a completed process');
  } else if (Object.hasOwn(receipt, 'reason')) throw new TypeError('passed receipt cannot carry a reason');
  return receipt;
}

export function validateOutputContractReport(report) {
  assertExactKeys(report, [
    'schema', 'verifierVersion', 'generatedAt', 'profile', 'status', 'provenance', 'reference', 'client', 'sando', 'authenticatedProvider',
    'surfaces', 'scenarios', 'summary',
  ], ['reason'], 'report');
  if (report.schema !== OUTPUT_CONTRACT_SCHEMA || !OUTPUT_STATUSES.has(report.status)) throw new TypeError('output contract report header is invalid');
  if (!['full-a1', 'not-requested'].includes(report.profile)) throw new TypeError('report.profile is invalid');
  if (!Number.isFinite(Date.parse(report.generatedAt))) throw new TypeError('report.generatedAt is invalid');
  validateProvenance(report.provenance);
  validateReference(report.reference);
  validateIdentity(report.client, report.sando);
  if (report.authenticatedProvider !== false) throw new TypeError('loopback report cannot claim an authenticated provider');
  if (!report.client.available && report.status !== 'not-run') throw new TypeError('unavailable client report must be not-run');
  assertExactKeys(report.surfaces, ['directMcp', 'codeModeExecute', 'codeModeWait', 'serialization'], [], 'report.surfaces');
  for (const value of Object.values(report.surfaces)) if (!OUTPUT_STATUSES.has(value)) throw new TypeError('surface status is invalid');
  if (!report.scenarios || typeof report.scenarios !== 'object' || Array.isArray(report.scenarios)) throw new TypeError('report.scenarios is invalid');
  const keys = Object.keys(report.scenarios).sort();
  if (report.profile === 'full-a1' && JSON.stringify(keys) !== JSON.stringify([...REQUIRED_OUTPUT_SCENARIOS].sort())) {
    throw new TypeError('report scenario cases are missing or renamed');
  }
  if (report.profile === 'not-requested' && (keys.length !== 0 || report.status !== 'not-run' || report.reason !== 'not-requested')) {
    throw new TypeError('not-requested profile is contradictory');
  }
  for (const [key, receipt] of Object.entries(report.scenarios)) {
    validateOutputContractReceipt(receipt);
    if (receipt.scenario.id !== OUTPUT_SCENARIO_KEY_TO_ID[key]) throw new TypeError('report scenario key/id mapping is contradictory');
    if (JSON.stringify(receipt.client) !== JSON.stringify(report.client) || JSON.stringify(receipt.sando) !== JSON.stringify(report.sando)
      || JSON.stringify(receipt.provenance) !== JSON.stringify(report.provenance)
      || JSON.stringify(receipt.reference) !== JSON.stringify(report.reference)) {
      throw new TypeError('scenario identity contradicts aggregate identity');
    }
  }
  if (keys.length > 0) {
    const ids = Object.values(report.scenarios).map(({ scenario }) => scenario.id).sort();
    if (JSON.stringify([...new Set(ids)]) !== JSON.stringify(ids)
      || JSON.stringify([...report.reference.testedFeatures].sort()) !== JSON.stringify(ids)) {
      throw new TypeError('reference tested features contradict scenario cases');
    }
  }
  assertExactKeys(report.summary, ['passed', 'failed', 'notRun'], [], 'report.summary');
  const receipts = Object.values(report.scenarios);
  const expected = {
    passed: receipts.filter(({ status }) => status === 'passed').length,
    failed: receipts.filter(({ status }) => status === 'failed').length,
    notRun: receipts.filter(({ status }) => status === 'not-run').length,
  };
  if (JSON.stringify(report.summary) !== JSON.stringify(expected)) throw new TypeError('report.summary contradicts scenario statuses');
  const expectedStatus = expected.failed ? 'failed' : expected.notRun ? 'not-run' : receipts.length ? 'passed' : report.client.available ? 'not-run' : 'not-run';
  if (report.status !== expectedStatus) throw new TypeError('report.status contradicts scenario statuses');
  const scenarioKeys = REQUIRED_OUTPUT_SCENARIOS;
  if (scenarioKeys.every((key) => Object.hasOwn(report.scenarios, key))) {
    const combine = (keys) => {
      const statuses = keys.map((key) => report.scenarios[key].status);
      return statuses.includes('failed') ? 'failed' : statuses.includes('not-run') ? 'not-run' : 'passed';
    };
    const expectedSurfaces = {
      directMcp: combine(['directNoHook', 'directCurrentFallback', 'directContinueFalse', 'directBlock']),
      codeModeExecute: combine(['codeModeNoHook', 'codeModeExecuteContinueFalse', 'codeModeBlock']),
      codeModeWait: combine(['codeModeWaitNoHook', 'codeModeWaitContinueFalse']),
      serialization: combine(['directNoHook', 'codeModeNoHook']),
    };
    if (JSON.stringify(report.surfaces) !== JSON.stringify(expectedSurfaces)) throw new TypeError('surface statuses contradict scenario statuses');
  }
  if (report.status === 'not-run') {
    if (!BOUNDED_REASONS.has(report.reason)) throw new TypeError('aggregate not-run requires a bounded reason');
    const scenarioReasons = receipts.filter(({ status }) => status === 'not-run').map(({ reason }) => reason);
    if (report.profile === 'full-a1' && !scenarioReasons.includes(report.reason)) throw new TypeError('aggregate not-run reason must come from a not-run scenario');
  } else if (report.status === 'failed') {
    if (!BOUNDED_REASONS.has(report.reason)) throw new TypeError('aggregate failed requires a bounded reason');
  } else if (Object.hasOwn(report, 'reason')) throw new TypeError('passed aggregate cannot carry a reason');
  return report;
}

function projectLoopbackEvidence(evidence) {
  if (!evidence) return evidence;
  return {
    status: OUTPUT_STATUSES.has(evidence.status) ? evidence.status : 'failed',
    ...(BOUNDED_REASONS.has(evidence.reason) ? { reason: evidence.reason } : {}),
    ...(typeof evidence.provider === 'string' ? { provider: evidence.provider } : {}),
    ...(typeof evidence.codexVersion === 'string' || evidence.codexVersion === null ? { codexVersion: evidence.codexVersion } : {}),
    ...(Number.isInteger(evidence.outboundModelCalls) ? { outboundModelCalls: evidence.outboundModelCalls } : {}),
    ...(typeof evidence.authenticatedProvider === 'boolean' ? { authenticatedProvider: evidence.authenticatedProvider } : {}),
    ...(evidence.assertions ? { assertions: Object.fromEntries(Object.entries(evidence.assertions).filter(([, value]) => typeof value === 'boolean' || Number.isInteger(value) || value === 'workspace-write')) } : {}),
    ...(evidence.scenarios ? { scenarios: Object.fromEntries(Object.entries(evidence.scenarios).map(([key, value]) => [key, {
      status: OUTPUT_STATUSES.has(value?.status) ? value.status : 'failed',
    }])) } : {}),
  };
}

function projectReceipt(receipt) {
  const field = receipt.delivery?.controlledField;
  return {
    schema: receipt.schema,
    verifierVersion: receipt.verifierVersion,
    status: receipt.status,
    provenance: {
      client: receipt.provenance?.client,
      provider: receipt.provenance?.provider,
      mcpServer: receipt.provenance?.mcpServer,
      externalNetwork: receipt.provenance?.externalNetwork,
      authenticatedProvider: receipt.provenance?.authenticatedProvider,
    },
    reference: {
      tag: receipt.reference?.tag,
      commit: receipt.reference?.commit,
      commitMatch: receipt.reference?.commitMatch,
      testedFeatures: Array.isArray(receipt.reference?.testedFeatures) ? [...receipt.reference.testedFeatures] : receipt.reference?.testedFeatures,
    },
    client: {
      name: receipt.client?.name,
      version: receipt.client?.version,
      available: receipt.client?.available,
      wrapperSha256: receipt.client?.wrapperSha256,
      launcherSha256: receipt.client?.launcherSha256,
      nativeBinarySha256: receipt.client?.nativeBinarySha256,
    },
    sando: {
      head: receipt.sando?.head,
      worktreeManifestHash: receipt.sando?.worktreeManifestHash,
      bundleHash: receipt.sando?.bundleHash,
    },
    scenario: {
      id: receipt.scenario?.id,
      surface: receipt.scenario?.surface,
      stage: receipt.scenario?.stage,
      hook: receipt.scenario?.hook,
      resultType: receipt.scenario?.resultType,
    },
    observations: Object.fromEntries([
      'process', 'executionCount', 'typedValueVisible', 'isErrorVisible', 'rawMarkerVisible', 'replacementMarkerVisible',
      'fallbackMarkerVisible', 'privateTopMetaVisible', 'executeWait', 'blockBehavior',
      'hookObserved', 'hookEffect', 'promiseOutcome', 'approval', 'cancel', 'expectedSatisfied',
    ].map((key) => [key, ['process', 'approval', 'cancel'].includes(key)
      ? structuredClone(receipt.observations?.[key]) : receipt.observations?.[key]])),
    delivery: {
      actualBytes: receipt.delivery?.actualBytes,
      resultUtf8Bytes: receipt.delivery?.resultUtf8Bytes,
      sha256: receipt.delivery?.sha256,
      controlledField: field === null ? null : {
        classification: field?.classification,
        startByte: field?.startByte,
        endByte: field?.endByte,
        byteLength: field?.byteLength,
        sha256: field?.sha256,
      },
      controlledFieldDeltaBytes: receipt.delivery?.controlledFieldDeltaBytes,
      evidenceDigest: receipt.delivery?.evidenceDigest,
    },
    usage: {
      provider: receipt.usage?.provider,
      localEstimates: {
        requestCount: receipt.usage?.localEstimates?.requestCount,
        requestBytes: receipt.usage?.localEstimates?.requestBytes,
      },
    },
    recovery: {
      status: receipt.recovery?.status,
      attempted: receipt.recovery?.attempted,
      method: receipt.recovery?.method,
      artifactRef: receipt.recovery?.artifactRef,
      recoveredBytes: receipt.recovery?.recoveredBytes,
      errorClass: receipt.recovery?.errorClass,
    },
    ...(BOUNDED_REASONS.has(receipt.reason) ? { reason: receipt.reason } : {}),
  };
}

function projectOutputEvidence(evidence) {
  if (!evidence) return evidence;
  const projected = {
    schema: evidence.schema,
    verifierVersion: evidence.verifierVersion,
    generatedAt: evidence.generatedAt,
    profile: evidence.profile,
    status: evidence.status,
    ...(BOUNDED_REASONS.has(evidence.reason) ? { reason: evidence.reason } : {}),
    provenance: structuredClone(evidence.provenance),
    reference: structuredClone(evidence.reference),
    client: structuredClone(evidence.client),
    sando: structuredClone(evidence.sando),
    authenticatedProvider: evidence.authenticatedProvider,
    surfaces: structuredClone(evidence.surfaces),
    scenarios: Object.fromEntries(Object.entries(evidence.scenarios ?? {}).map(([key, receipt]) => [key, projectReceipt(receipt)])),
    summary: structuredClone(evidence.summary),
  };
  validateOutputContractReport(projected);
  return projected;
}

export function runCompatibilityCheck({ probe, loopbackEvidence, mcpHostEvidence } = {}) {
  const isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-compat-'));
  try {
    const hooks = readFixture('pre-tool-use.synthetic.json').cases.map((fixture) => runHookFixture(fixture, path.join(isolationRoot, 'hooks', fixture.id)));
    const shell = readFixture('shell-cases.synthetic.json').cases.map((fixture) => runShellFixture(fixture, path.join(isolationRoot, 'shell')));
    const checks = [...hooks, ...shell];
    const installed = probe === undefined ? probeInstalledCodex(path.join(isolationRoot, 'probe')) : probe;
    const safeLoopback = projectLoopbackEvidence(loopbackEvidence);
    const bundle = codexBundleHash();
    const head = gitValue(['rev-parse', 'HEAD']) ?? '0'.repeat(40);
    const manifestSource = `${gitValue(['status', '--porcelain=v1', '-z']) ?? ''}\0${gitValue(['diff', '--binary', 'HEAD']) ?? ''}`;
    const defaultClient = {
      name: 'codex',
      version: installed?.version ?? null,
      available: Boolean(installed),
      wrapperSha256: installed?.sha256 ?? null,
      launcherSha256: installed?.sha256 ?? null,
      nativeBinarySha256: installed?.binarySha256 ?? null,
    };
    const defaultMcp = {
      schema: OUTPUT_CONTRACT_SCHEMA,
      verifierVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      profile: 'not-requested',
      status: 'not-run',
      reason: 'not-requested',
      provenance: {
        client: 'real-installed-codex',
        provider: 'synthetic-http-sse-loopback',
        mcpServer: 'synthetic-stdio-fixture',
        externalNetwork: false,
        authenticatedProvider: false,
      },
      reference: {
        tag: 'rust-v0.160.0',
        commit: 'a956835d020762cb2b570053af06f643a11c0ecc',
        commitMatch: 'unknown',
        testedFeatures: [],
      },
      client: defaultClient,
      sando: { head, worktreeManifestHash: createHash('sha256').update(manifestSource).digest('hex'), bundleHash: bundle.sha256 },
      authenticatedProvider: false,
      surfaces: { directMcp: 'not-run', codeModeExecute: 'not-run', codeModeWait: 'not-run', serialization: 'not-run' },
      scenarios: {},
      summary: { passed: 0, failed: 0, notRun: 0 },
    };
    const safeMcp = projectOutputEvidence(mcpHostEvidence ?? defaultMcp);
    return {
      schema: 'sando-codex-compatibility-report/v2',
      generatedAt: new Date().toISOString(),
      repository: { sha: gitValue(['rev-parse', 'HEAD']), dirty: Boolean(gitValue(['status', '--porcelain'])) },
      runtime: { platform: process.platform, architecture: process.arch, node: process.version },
      enforcement: {
        source: path.relative(repoRoot, enforcementPath),
        sha256: fileHash(enforcementPath),
      },
      codexBundle: bundle,
      fixtures: { synthetic: true, realClientLoopbackCapture: true },
      offline: {
        status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
        checks,
      },
      loopbackClient: safeLoopback ?? { status: 'not-run', reason: 'not-requested' },
      mcpHostContract: safeMcp,
      detectedCodex: installed ? { ...installed, liveCompatibilityProof: false } : null,
      candidates: CANDIDATE_VERSIONS.map((version) => ({
        version,
        status: 'not-run',
        authenticatedProvider: 'not-run',
        syntheticLoopback: safeLoopback?.codexVersion === version ? safeLoopback.status : 'not-run',
        reason: 'authenticated live proof was not run; an installed binary/version probe is not compatibility evidence',
      })),
      clientBoundary: [
        { scenario: 'startup', status: safeLoopback?.assertions?.startupObserved ? 'passed' : 'not-run', scope: safeLoopback?.assertions?.startupObserved ? 'synthetic-loopback' : undefined, reason: safeLoopback?.assertions?.startupObserved ? undefined : 'requires a live client lifecycle observation' },
        { scenario: 'resume', status: safeLoopback?.assertions?.resumeObserved ? 'passed' : 'not-run', scope: safeLoopback?.assertions?.resumeObserved ? 'synthetic-loopback' : undefined, reason: safeLoopback?.assertions?.resumeObserved ? undefined : 'requires a live client lifecycle observation' },
        { scenario: 'immediate-result-consumption', status: safeLoopback?.assertions?.rewrittenCommandConsumed ? 'passed' : 'not-run', scope: safeLoopback?.assertions?.rewrittenCommandConsumed ? 'synthetic-loopback' : undefined, reason: safeLoopback?.assertions?.rewrittenCommandConsumed ? undefined : 'local hook output does not prove the client consumed updatedInput' },
        { scenario: 'streaming-sse-single-execution', status: safeLoopback?.assertions?.streamingSseCompleted && safeLoopback?.assertions?.executionCount === 1 ? 'passed' : 'not-run', scope: safeLoopback?.assertions?.streamingSseCompleted ? 'synthetic-loopback-sse' : undefined, reason: safeLoopback?.assertions?.streamingSseCompleted ? undefined : 'requires proof that streaming neither rewrites nor executes twice' },
        { scenario: 'tool-polling', status: 'not-run', reason: 'the loopback shell surface completed synchronously and did not expose a poll operation' },
        { scenario: 'approval-denial', status: safeLoopback?.scenarios?.approvalDenial?.status ?? 'not-run', scope: safeLoopback?.scenarios?.approvalDenial ? 'synthetic-loopback' : undefined, ...((safeLoopback?.scenarios?.approvalDenial?.reason || !safeLoopback?.scenarios?.approvalDenial) ? { reason: safeLoopback?.scenarios?.approvalDenial?.reason ?? 'requires an explicit live denial without weakening sandbox or approval settings' } : {}) },
        { scenario: 'direct-mcp-output-replacement', status: safeMcp.surfaces.directMcp, scope: safeMcp.surfaces.directMcp === 'passed' ? 'stock-client-synthetic-loopback' : undefined, reason: safeMcp.surfaces.directMcp === 'passed' ? undefined : 'requires no-hook and current-fallback controls plus a continue:false replacement observation' },
        { scenario: 'code-mode-execute-value', status: safeMcp.surfaces.codeModeExecute, scope: safeMcp.surfaces.codeModeExecute === 'passed' ? 'stock-client-synthetic-loopback' : undefined, reason: safeMcp.surfaces.codeModeExecute === 'passed' ? undefined : 'the installed client did not pass the complete Code Mode execute contract' },
        { scenario: 'code-mode-wait-value', status: safeMcp.surfaces.codeModeWait, scope: safeMcp.surfaces.codeModeWait === 'passed' ? 'stock-client-synthetic-loopback' : undefined, reason: safeMcp.surfaces.codeModeWait === 'passed' ? undefined : 'the installed client did not pass the complete Code Mode wait contract' },
        { scenario: 'mcp-envelope-serialization', status: safeMcp.surfaces.serialization, scope: safeMcp.surfaces.serialization === 'passed' ? 'stock-client-synthetic-loopback' : undefined, reason: safeMcp.surfaces.serialization === 'passed' ? undefined : 'the raw-marker controls did not prove exact serialized delivery' },
        { scenario: 'mcp-error-result', status: 'not-run', reason: 'A1 does not execute an MCP result with isError true' },
        { scenario: 'unknown-future-hook-event', status: 'not-run', reason: 'no observed client contract fixture exists' },
      ],
    };
  } finally {
    fs.rmSync(isolationRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const runLoopback = process.argv.includes('--loopback-client');
    const loopbackEvidence = runLoopback
      ? await import('./codex-loopback-contract.mjs').then(({ runLoopbackCodexContract }) => runLoopbackCodexContract())
      : undefined;
    const mcpHostEvidence = runLoopback
      ? await import('./codex-loopback-contract.mjs').then(({ runMcpHostContract }) => runMcpHostContract())
      : undefined;
    const report = runCompatibilityCheck({ loopbackEvidence, mcpHostEvidence });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.offline.status !== 'passed') process.exitCode = 1;
    else if (runLoopback && (loopbackEvidence.status !== 'passed' || mcpHostEvidence.status !== 'passed')) process.exitCode = 2;
  } catch {
    process.stdout.write(`${JSON.stringify({ schema: 'sando-codex-compatibility-report/v2', status: 'failed', reason: 'compatibility-runner-failed' }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
