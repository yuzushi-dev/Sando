#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { prepareSubscriptionEnvironment } from './codex-subscription-contract.mjs';

const FIXED_GIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'Sando Benchmark',
  GIT_AUTHOR_EMAIL: 'benchmark@sando.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Sando Benchmark',
  GIT_COMMITTER_EMAIL: 'benchmark@sando.invalid',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
});

function safeTarget(root, relativePath, label = 'fixture path') {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new TypeError(`${label} must be relative`);
  }
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new TypeError(`${label} escapes workspace`);
  return target;
}

function validateBenchmarkId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new TypeError('benchmark id must contain only lowercase letters, digits, and hyphens');
  }
  return id;
}

function canonicalOutputPath(target) {
  const resolved = path.resolve(target);
  const suffix = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  try { return path.join(fs.realpathSync(existing), ...suffix); } catch { return resolved; }
}

function historicalV1Outputs(repoRoot) {
  const benchmarksRoot = path.join(repoRoot, 'packages/sando/benchmarks');
  const resultsRoot = path.join(benchmarksRoot, 'results');
  const resultFiles = fs.existsSync(resultsRoot)
    ? fs.readdirSync(resultsRoot).filter((name) => name.startsWith('sando-v1'))
      .map((name) => path.join(resultsRoot, name))
    : [];
  return [path.join(benchmarksRoot, 'sando-v1.json'), ...resultFiles].map(canonicalOutputPath);
}

function sameFileIdentity(left, right) {
  try {
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch { return false; }
}

function collidesWithHistorical(target, historical) {
  const canonical = canonicalOutputPath(target);
  return historical.some((candidate) => candidate === canonical || sameFileIdentity(canonical, candidate));
}

function pathsOverlap(left, right) {
  const canonicalLeft = canonicalOutputPath(left);
  const canonicalRight = canonicalOutputPath(right);
  return canonicalLeft === canonicalRight
    || canonicalLeft.startsWith(`${canonicalRight}${path.sep}`)
    || canonicalRight.startsWith(`${canonicalLeft}${path.sep}`)
    || sameFileIdentity(canonicalLeft, canonicalRight);
}

function overlapsAny(target, candidates) {
  return candidates.some((candidate) => pathsOverlap(target, candidate));
}

function evidenceOverlapsHistorical(evidenceRoot, historical) {
  return overlapsAny(evidenceRoot, historical);
}

function protectedBenchmarkInputs(repoRoot, manifestPath) {
  return [
    path.resolve(manifestPath),
    path.join(repoRoot, 'packages/sando/benchmarks/sando-v1.json'),
    path.join(repoRoot, 'scripts/run-sando-benchmark.mjs'),
    path.join(repoRoot, 'scripts/codex-subscription-contract.mjs'),
    path.join(repoRoot, 'scripts/codex-loopback-contract.mjs'),
    path.join(repoRoot, 'adapters/codex/sando'),
  ];
}

export function resolveBenchmarkPaths({ repoRoot, manifestPath, manifest, ledgerPath, evidenceRoot }) {
  const root = path.resolve(repoRoot);
  const id = validateBenchmarkId(manifest?.id);
  const resultsRoot = path.join(root, 'packages/sando/benchmarks/results');
  const resolvedLedger = path.resolve(ledgerPath ?? path.join(resultsRoot, `${id}-events.jsonl`));
  const resolvedEvidence = path.resolve(evidenceRoot ?? path.join(resultsRoot, `${id}-evidence`));
  const historical = historicalV1Outputs(root);
  const canonicalLedger = canonicalOutputPath(resolvedLedger);
  const canonicalEvidence = canonicalOutputPath(resolvedEvidence);
  if (id !== 'sando-v1' && (overlapsAny(resolvedLedger, historical)
    || overlapsAny(resolvedEvidence, historical))) {
    throw new TypeError('benchmark output collision with a historical sando-v1 artifact');
  }
  if (canonicalLedger === canonicalEvidence
    || canonicalLedger.startsWith(`${canonicalEvidence}${path.sep}`)
    || canonicalEvidence.startsWith(`${canonicalLedger}${path.sep}`)) {
    throw new TypeError('benchmark ledger and evidence paths must differ');
  }
  const protectedInputs = protectedBenchmarkInputs(root, manifestPath);
  if (overlapsAny(resolvedLedger, protectedInputs) || overlapsAny(resolvedEvidence, protectedInputs)) {
    throw new TypeError('benchmark output overlaps a protected benchmark input');
  }
  return {
    manifestPath: path.resolve(manifestPath),
    ledgerPath: resolvedLedger,
    evidenceRoot: resolvedEvidence,
  };
}

function processStartIdentity(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ');
    return fields[21] ?? null;
  } catch {
    return null;
  }
}

function processIsOwner(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); } catch { return false; }
  const observedStart = processStartIdentity(owner.pid);
  return !owner.pidStart || !observedStart || owner.pidStart === observedStart;
}

export function acquireLedgerLock(ledgerPath, ownerOverrides = {}) {
  const lockPath = `${path.resolve(ledgerPath)}.lock`;
  const token = randomUUID();
  const ticketPath = path.join(lockPath, `${token}.json`);
  let recoveredStale = false;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  const lockStat = fs.lstatSync(lockPath);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) throw new Error('ledger lock path is unsafe');
  fs.chmodSync(lockPath, 0o700);
  const pid = ownerOverrides.pid ?? process.pid;
  const owner = {
    pid,
    pidStart: ownerOverrides.pidStart ?? processStartIdentity(pid),
    startedAt: ownerOverrides.startedAt ?? new Date().toISOString(),
    token,
  };
  fs.writeFileSync(ticketPath, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(ticketPath, 0o600);
  const discardOwnTicket = () => {
    fs.rmSync(ticketPath, { force: true });
    try { fs.rmdirSync(lockPath); } catch {}
  };
  try {
    for (const entry of fs.readdirSync(lockPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === `${token}.json`) continue;
      const competingPath = path.join(lockPath, entry.name);
      let competing = null;
      try { competing = JSON.parse(fs.readFileSync(competingPath, 'utf8')); } catch {}
      if (!Number.isSafeInteger(competing?.pid) || competing.pid <= 0
        || typeof competing.startedAt !== 'string' || typeof competing.token !== 'string') {
        throw new Error('cannot verify stale ledger lock owner');
      }
      if (processIsOwner(competing)) {
        throw new Error(`active supervisor owns ledger lock (pid ${competing.pid})`);
      }
      fs.rmSync(competingPath, { force: true });
      recoveredStale = true;
    }
  } catch (error) {
    discardOwnTicket();
    throw error;
  }
  let released = false;
  return {
    lockPath,
    owner,
    recoveredStale,
    release() {
      if (released) return;
      released = true;
      let current = null;
      try { current = JSON.parse(fs.readFileSync(ticketPath, 'utf8')); } catch {}
      if (current?.token === token) fs.rmSync(ticketPath, { force: true });
      try { fs.rmdirSync(lockPath); } catch {}
    },
  };
}

function retainedBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) total += fs.statSync(target).size;
    }
  }
  return total;
}

function credentialBuffers(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === 'string' && value.length > 0))]
    .map((value) => Buffer.from(value))
    .sort((left, right) => right.length - left.length);
}

function redactCredentialBytes(contents, credentialValues) {
  let redacted = Buffer.from(contents);
  let count = 0;
  const replacement = Buffer.from('[REDACTED]');
  for (const credential of credentialBuffers(credentialValues)) {
    const chunks = [];
    let start = 0;
    let index;
    while ((index = redacted.indexOf(credential, start)) !== -1) {
      chunks.push(redacted.subarray(start, index), replacement);
      start = index + credential.length;
      count += 1;
    }
    if (start > 0) {
      chunks.push(redacted.subarray(start));
      redacted = Buffer.concat(chunks);
    }
  }
  return { contents: redacted, count };
}

function redactDiagnostic(value, maxBytes = 32 * 1024, credentialValues = []) {
  const original = String(value ?? '');
  const credentialRedaction = redactCredentialBytes(Buffer.from(original), credentialValues);
  const text = credentialRedaction.contents.toString('utf8')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b([A-Za-z][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY))\b["']?\s*[=:]\s*["']?[^"',\s}]+["']?/gi,
      '$1=[REDACTED]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|secret)\b["']?\s*[=:]\s*["']?[^"',\s}]+["']?/gi,
      '$1=[REDACTED]')
    .replace(/\b(password|api[_-]?key|token)\s*[=:]\s*[^\s]+/gi, '$1=[REDACTED]');
  const bytes = Buffer.from(text);
  let retained = bytes.subarray(0, Math.min(bytes.length, maxBytes));
  while (retained.length > 0) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(retained); break; }
    catch { retained = retained.subarray(0, retained.length - 1); }
  }
  return {
    text: retained.toString('utf8'),
    truncated: retained.length < bytes.length,
    originalBytes: Buffer.byteLength(original),
    redactedBytes: bytes.length,
    retainedBytes: retained.length,
    credentialRedactions: credentialRedaction.count,
  };
}

function mkdirPrivate(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function isRegularFileWithoutSymlinks(root, target) {
  const relative = path.relative(root, target);
  let current = root;
  for (const [index, part] of relative.split(path.sep).entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch { return false; }
    if (stat.isSymbolicLink()) return false;
    const final = index === relative.split(path.sep).length - 1;
    if (final ? !stat.isFile() : !stat.isDirectory()) return false;
  }
  const resolvedRoot = fs.realpathSync(root);
  const resolvedTarget = fs.realpathSync(target);
  return resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function isPrivateEvidencePath(relativePath) {
  const parts = path.normalize(relativePath).split(path.sep);
  const privateDirectories = new Set(['.aws', '.codex', '.config', '.gnupg', '.npm', '.ssh']);
  const privateFiles = new Set(['.env', '.npmrc', 'auth.json', 'credentials']);
  return parts.some((part) => privateDirectories.has(part)) || privateFiles.has(parts.at(-1));
}

export function retainSyntheticEvidence({
  workspace, evidenceRoot, task, run, verification, provenance = {}, diagnostics = {},
  credentialValues = [],
  limits = { perFileBytes: 64 * 1024, perAttemptBytes: 256 * 1024, totalBytes: 32 * 1024 * 1024 },
}) {
  let attemptDirectory;
  let ownsAttemptDirectory = false;
  try {
    for (const value of [limits.perFileBytes, limits.perAttemptBytes, limits.totalBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('evidence limits must be positive integers');
    }
    const workspaceRoot = path.resolve(workspace);
    const evidenceBase = path.resolve(evidenceRoot);
    const collectionBytesBefore = retainedBytes(evidenceBase);
    mkdirPrivate(evidenceBase);
    const attemptName = `${validateBenchmarkId(run.taskId)}-r${run.repetition}-${run.arm}`;
    attemptDirectory = safeTarget(evidenceBase, attemptName, 'evidence attempt path');
    const attemptDirectoryExists = fs.existsSync(attemptDirectory);
    if (attemptDirectoryExists) throw new Error('evidence attempt already exists');
    mkdirPrivate(attemptDirectory);
    ownsAttemptDirectory = !attemptDirectoryExists;
    const outputsDirectory = path.join(attemptDirectory, 'outputs');
    mkdirPrivate(outputsDirectory);
    const protectedTargets = new Set((task.protectedPaths ?? [])
      .map((protectedPath) => safeTarget(workspaceRoot, protectedPath, 'protected path')));
    const protectedFileIdentities = new Set([...protectedTargets].flatMap((target) => {
      try {
        const stat = fs.statSync(target);
        return stat.isFile() ? [`${stat.dev}:${stat.ino}`] : [];
      } catch { return []; }
    }));
    const declaredPaths = [...new Set((task.successCriteria ?? [])
      .filter(({ type }) => type === 'file_contains' || type === 'file_not_contains')
      .map(({ path: outputPath }) => outputPath))];
    let attemptBytes = 0;
    let overflow = false;
    const files = [];
    const retainedSources = new Set();
    for (const relativePath of declaredPaths) {
      if (isPrivateEvidencePath(relativePath)) continue;
      const source = safeTarget(workspaceRoot, relativePath, 'evidence source path');
      if (protectedTargets.has(source) || retainedSources.has(source)) continue;
      if (!isRegularFileWithoutSymlinks(workspaceRoot, source)) continue;
      const sourceStat = fs.statSync(source);
      if (protectedFileIdentities.has(`${sourceStat.dev}:${sourceStat.ino}`)) continue;
      retainedSources.add(source);
      const available = Math.max(0, Math.min(
        limits.perFileBytes,
        limits.perAttemptBytes - attemptBytes,
        limits.totalBytes - collectionBytesBefore - attemptBytes,
      ));
      const sourceContents = fs.readFileSync(source);
      const credentialRedaction = redactCredentialBytes(sourceContents, credentialValues);
      const contents = credentialRedaction.contents;
      const retained = contents.subarray(0, available);
      const truncated = retained.length < contents.length;
      overflow ||= truncated;
      if (retained.length === 0) continue;
      const storedAs = path.join('outputs', relativePath);
      const target = safeTarget(attemptDirectory, storedAs, 'evidence output path');
      mkdirPrivate(path.dirname(target));
      fs.writeFileSync(target, retained, { mode: 0o600 });
      fs.chmodSync(target, 0o600);
      const stored = fs.readFileSync(target);
      const digest = sha256(stored);
      if (digest !== sha256(retained)) throw new Error('evidence integrity verification failed');
      attemptBytes += stored.length;
      files.push({
        path: relativePath, storedAs, bytes: stored.length, sha256: digest, truncated,
        redacted: credentialRedaction.count > 0,
        credentialRedactions: credentialRedaction.count,
      });
    }
    const selectedDiagnostics = {};
    if (typeof diagnostics.finalMessage === 'string') {
      selectedDiagnostics.finalMessage = redactDiagnostic(diagnostics.finalMessage, 32 * 1024, credentialValues);
      overflow ||= selectedDiagnostics.finalMessage.truncated;
    }
    if (Array.isArray(diagnostics.commands)) {
      const items = diagnostics.commands.slice(0, 64)
        .map((command) => redactDiagnostic(command, 2048, credentialValues));
      const omittedCount = Math.max(0, diagnostics.commands.length - items.length);
      selectedDiagnostics.commands = { items, omittedCount };
      overflow ||= omittedCount > 0 || items.some(({ truncated }) => truncated);
    }
    const recordedAt = new Date().toISOString();
    const serializeMetadata = () => Buffer.from(`${JSON.stringify({
      schemaVersion: 'sando.benchmark-evidence.v1', benchmarkId: run.benchmarkId,
      taskId: run.taskId, arm: run.arm, repetition: run.repetition,
      orderPosition: run.orderPosition, recordedAt, verification, provenance,
      diagnostics: selectedDiagnostics, files, overflow, limits,
      lifecycle: 'Retain through benchmark audit; delete explicitly after publication or cancellation.',
    }, null, 2)}\n`);
    const allowedAttemptBytes = Math.max(0, Math.min(
      limits.perAttemptBytes,
      limits.totalBytes - collectionBytesBefore,
    ));
    let metadataContents = serializeMetadata();
    if (metadataContents.length > allowedAttemptBytes) throw new RangeError('evidence metadata exceeds cap');
    let excess = attemptBytes + metadataContents.length - allowedAttemptBytes;
    for (let index = files.length - 1; excess > 0 && index >= 0; index -= 1) {
      const file = files[index];
      const target = safeTarget(attemptDirectory, file.storedAs, 'evidence output path');
      const contents = fs.readFileSync(target);
      const keep = Math.max(0, contents.length - excess);
      overflow = true;
      if (keep === 0) {
        fs.rmSync(target);
        attemptBytes -= contents.length;
        files.splice(index, 1);
      } else {
        const retained = contents.subarray(0, keep);
        fs.writeFileSync(target, retained, { mode: 0o600 });
        attemptBytes -= contents.length - keep;
        file.bytes = keep;
        file.sha256 = sha256(retained);
        file.truncated = true;
      }
      metadataContents = serializeMetadata();
      excess = attemptBytes + metadataContents.length - allowedAttemptBytes;
    }
    if (attemptBytes + metadataContents.length > allowedAttemptBytes) {
      throw new RangeError('evidence attempt exceeds cap');
    }
    for (const file of files) {
      const stored = fs.readFileSync(safeTarget(attemptDirectory, file.storedAs, 'evidence output path'));
      if (stored.length !== file.bytes || sha256(stored) !== file.sha256) {
        throw new Error('evidence integrity verification failed');
      }
    }
    const metadataPath = path.join(attemptDirectory, 'evidence.json');
    fs.writeFileSync(metadataPath, metadataContents, { mode: 0o600 });
    fs.chmodSync(metadataPath, 0o600);
    return { status: 'available', metadataPath, files, overflow };
  } catch (error) {
    if (ownsAttemptDirectory) fs.rmSync(attemptDirectory, { recursive: true, force: true });
    return {
      status: 'error',
      error: error instanceof Error ? error.name : 'UnknownError',
      overflow: error instanceof RangeError,
    };
  }
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...FIXED_GIT_ENV },
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function directorySha256(directory) {
  const hash = createHash('sha256');
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) hash.update(relative).update('\0').update(fs.readFileSync(absolute)).update('\0');
    }
  };
  visit(directory);
  return hash.digest('hex');
}

function isNativeExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    const file = fs.openSync(candidate, 'r');
    try {
      const magic = Buffer.alloc(4);
      return fs.readSync(file, magic, 0, magic.length, 0) === magic.length
        && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    } finally { fs.closeSync(file); }
  } catch { return false; }
}

function shellExecTarget(launcher) {
  let source;
  try { source = fs.readFileSync(launcher, 'utf8'); } catch { return null; }
  if (!/^#!.*\b(?:ba|z|k)?sh\b/m.test(source.split('\n', 1)[0])) return null;
  const match = /^\s*exec\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))/m.exec(source);
  const target = match?.[1] ?? match?.[2] ?? match?.[3];
  return target && path.isAbsolute(target) && fs.existsSync(target) ? target : null;
}

function codexExecutableChain(entry, seen = new Set()) {
  const target = fs.realpathSync(entry);
  if (seen.has(target)) throw new Error('cyclic Codex launcher chain');
  seen.add(target);
  const current = { realpath: target, sha256: sha256(fs.readFileSync(target)) };
  if (isNativeExecutable(target)) return [current];
  const wrappedTarget = shellExecTarget(target);
  if (wrappedTarget) return [current, ...codexExecutableChain(wrappedTarget, seen)];
  const packageRoot = path.dirname(path.dirname(target));
  const candidates = [
    ...fs.globSync(path.join(packageRoot, 'node_modules/@openai/*/vendor/*/bin/codex')),
    ...fs.globSync(path.join(packageRoot, 'vendor/*/bin/codex')),
  ];
  const native = candidates.find(isNativeExecutable);
  if (!native) throw new Error(`could not resolve native Codex binary behind ${target}`);
  return [current, ...codexExecutableChain(native, seen)];
}

export function codexExecutableReceipt(codexPath, env) {
  const resolvedPath = fs.realpathSync(codexPath);
  const versionResult = spawnSync(codexPath, ['--version'], { env, encoding: 'utf8', timeout: 10_000 });
  if (versionResult.status !== 0) throw new Error('could not verify Codex version');
  const version = /(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+)/i.exec(versionResult.stdout)?.[1];
  if (version !== '0.159.2') throw new Error(`unexpected Codex version: ${version ?? 'unknown'}`);
  const chain = codexExecutableChain(resolvedPath);
  const launcher = chain[0];
  const binary = chain.at(-1);
  return {
    version,
    launcherPath: launcher.realpath,
    launcherSha256: launcher.sha256,
    binaryPath: binary.realpath,
    binarySha256: binary.sha256,
    chain,
  };
}

function benchmarkSourceReceipt(repoRoot) {
  const runnerSha256 = sha256(fs.readFileSync(path.join(repoRoot, 'scripts/run-sando-benchmark.mjs')));
  const subscriptionContractSha256 = sha256(fs.readFileSync(
    path.join(repoRoot, 'scripts/codex-subscription-contract.mjs')));
  const loopbackContractSha256 = sha256(fs.readFileSync(path.join(repoRoot, 'scripts/codex-loopback-contract.mjs')));
  const bundleSha256 = directorySha256(path.join(repoRoot, 'adapters/codex/sando'));
  const sourceSha256 = sha256([
    runnerSha256, subscriptionContractSha256, loopbackContractSha256, bundleSha256,
  ].join('\0'));
  return { runnerSha256, subscriptionContractSha256, loopbackContractSha256, bundleSha256, sourceSha256 };
}

function executionProvenanceReceipt(repoRoot, codexPath, env) {
  return { ...benchmarkSourceReceipt(repoRoot), codex: codexExecutableReceipt(codexPath, env) };
}

export function assertExecutionProvenance(expected, observed) {
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    const error = new Error('benchmark execution provenance drift');
    error.code = 'BENCHMARK_EXECUTION_DRIFT';
    throw error;
  }
}

function gitValue(repoRoot, args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

export function runtimeFreezeReceipt(repoRoot, manifest, manifestPath) {
  const trackedDirty = gitValue(repoRoot, ['status', '--porcelain', '--untracked-files=no']).length > 0;
  const sourceInputsUntracked = protectedBenchmarkInputs(repoRoot, manifestPath)
    .some((input) => {
      const relative = path.relative(repoRoot, input);
      if (relative.startsWith('..')) return true;
      const result = spawnSync('git', ['ls-files', '--error-unmatch', relative], {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      return result.status !== 0;
    });
  return {
    repository: {
      head: gitValue(repoRoot, ['rev-parse', 'HEAD']),
      dirty: trackedDirty || sourceInputsUntracked,
    },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    execution: {
      client: manifest.execution.client,
      model: manifest.execution.model,
      reasoningEffort: manifest.execution.reasoningEffort,
      sandbox: manifest.execution.sandbox,
      approvalPolicy: manifest.execution.approvalPolicy,
      authentication: manifest.execution.authentication,
      pairConcurrency: manifest.execution.pairConcurrency,
      wallTimeoutMsPerRun: manifest.execution.wallTimeoutMsPerRun,
      ephemeral: manifest.execution.ephemeral,
      ignoreUserConfig: manifest.execution.ignoreUserConfig,
      ignoreRules: manifest.execution.ignoreRules,
    },
  };
}

export function assertRuntimeFreeze(expected, observed) {
  if (JSON.stringify(expected) !== JSON.stringify(observed)) throw new Error('benchmark runtime freeze drift');
}

function parseJsonLines(contents) {
  return contents.split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function runKey(run) {
  return `${run.taskId}:${run.repetition}:${run.arm}`;
}

function countArtifactFiles(workspace) {
  const directory = path.join(workspace, '.sando/sando/artifacts');
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.txt')).length : 0;
}

export function boundedProcess(codexPath, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const detached = process.platform !== 'win32';
    const child = spawn(codexPath, args, {
      cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let cleanupError = null;
    let groupDrain = Promise.resolve();
    const limit = 32 * 1024 * 1024;
    const signalOwnedProcessGroup = (signal) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
        return true;
      } catch (error) {
        if (error?.code === 'ESRCH') return false;
        cleanupError ??= error;
        return false;
      }
    };
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= limit) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= limit) stderr.push(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      signalOwnedProcessGroup('SIGKILL');
    }, timeoutMs);
    child.on('exit', () => {
      if (timedOut || !detached || !child.pid) return;
      if (!signalOwnedProcessGroup('SIGTERM')) return;
      groupDrain = new Promise((finish) => {
        setTimeout(() => {
          signalOwnedProcessGroup('SIGKILL');
          finish();
        }, 100);
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, error, stdout: '', stderr: '' });
    });
    child.on('close', async (status, signal) => {
      clearTimeout(timer);
      await groupDrain;
      resolve({
        status,
        signal,
        timedOut,
        error: cleanupError,
        truncated: stdoutBytes > limit || stderrBytes > limit,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

export function normalizeBenchmarkUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = usage.input_tokens;
  const cachedInputTokens = usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens;
  const cacheWriteInputTokens = usage.cache_write_input_tokens ?? usage.cache_write_tokens
    ?? usage.input_tokens_details?.cache_write_tokens;
  const outputTokens = usage.output_tokens;
  if (![inputTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  return {
    inputTokens,
    cachedInputTokens: Number.isSafeInteger(cachedInputTokens) && cachedInputTokens >= 0 ? cachedInputTokens : null,
    cacheWriteInputTokens: Number.isSafeInteger(cacheWriteInputTokens) && cacheWriteInputTokens >= 0 ? cacheWriteInputTokens : null,
    outputTokens,
  };
}

function observedUsage(events) {
  return normalizeBenchmarkUsage(events.filter((event) => event.type === 'turn.completed').at(-1)?.usage);
}

function toolItems(events) {
  const types = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);
  return events.filter((event) => event.type === 'item.completed' && types.has(event.item?.type));
}

function quotaFailure(result) {
  return /(?:usage|rate|quota).{0,40}(?:limit|exceed)|too many requests/i.test(`${result.stderr}\n${result.stdout}`);
}

function benchmarkPrompt(manifest, run) {
  const protectedList = run.task.protectedPaths.join(', ');
  return `${manifest.sharedInstructions}\n\nProtected fixture files: ${protectedList}.\n\nTask:\n${run.task.prompt}`;
}

export function buildBenchmarkPlan(manifest) {
  if (manifest?.schemaVersion !== 'sando.benchmark-manifest.v1' || !Array.isArray(manifest.tasks)) {
    throw new TypeError('unsupported benchmark manifest');
  }
  const runs = [];
  const taskIds = new Set();
  for (const task of manifest.tasks) {
    try { validateBenchmarkId(task?.id); }
    catch { throw new TypeError('task id must be a safe lowercase slug'); }
    if (taskIds.has(task.id)) throw new TypeError(`duplicate task id: ${task.id}`);
    taskIds.add(task.id);
    if (!Array.isArray(task.schedule) || task.schedule.length !== manifest.repetitionsPerArm) {
      throw new TypeError(`${task.id} schedule does not match repetitionsPerArm`);
    }
    task.schedule.forEach((order, repetitionIndex) => {
      if (!Array.isArray(order) || order.length !== 2 || [...order].sort().join(',') !== 'apply,control') {
        throw new TypeError(`${task.id} has an invalid arm order`);
      }
      order.forEach((arm, orderIndex) => runs.push({
        benchmarkId: manifest.id,
        taskId: task.id,
        task,
        repetition: repetitionIndex + 1,
        arm,
        orderPosition: orderIndex + 1,
      }));
    });
  }
  return runs;
}

export function materializeTaskRepository(directory, task) {
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const files = task?.fixture?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length === 0) {
    throw new TypeError('task fixture must contain files');
  }
  for (const [relativePath, contents] of Object.entries(files)) {
    if (typeof contents !== 'string') throw new TypeError('fixture contents must be text');
    const target = safeTarget(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, { mode: 0o600 });
  }
  git(root, ['init', '-q', '-b', 'benchmark']);
  git(root, ['add', '--all']);
  git(root, ['commit', '-q', '-m', 'Frozen synthetic benchmark fixture']);
  return {
    commit: git(root, ['rev-parse', 'HEAD']),
    dirty: git(root, ['status', '--porcelain']).length > 0,
  };
}

export function snapshotProtectedFiles(directory, relativePaths) {
  const root = path.resolve(directory);
  if (!Array.isArray(relativePaths)) throw new TypeError('protectedPaths must be an array');
  return Object.fromEntries(relativePaths.map((relativePath) => {
    const target = safeTarget(root, relativePath, 'protected path');
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new TypeError(`protected path is not a file: ${relativePath}`);
    }
    return [relativePath, sha256(fs.readFileSync(target))];
  }));
}

export function verifyProtectedFiles(directory, snapshot) {
  const root = path.resolve(directory);
  const changed = Object.entries(snapshot).flatMap(([relativePath, expected]) => {
    const target = safeTarget(root, relativePath, 'protected path');
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return [relativePath];
    return sha256(fs.readFileSync(target)) === expected ? [] : [relativePath];
  });
  return { passed: changed.length === 0, changed };
}

export function evaluateSuccessCriteria(directory, criteria, { timeoutMs = 30_000, protectedPaths = [] } = {}) {
  const root = path.resolve(directory);
  const protectedTargets = new Set(protectedPaths.map((relativePath) => (
    safeTarget(root, relativePath, 'protected path')
  )));
  const protectedIdentities = new Set([...protectedTargets].flatMap((target) => {
    try {
      const stat = fs.statSync(target);
      return stat.isFile() ? [`${stat.dev}:${stat.ino}`] : [];
    } catch { return []; }
  }));
  const checks = criteria.map((check, index) => {
    if (check?.type === 'command') {
      const result = spawnSync('sh', ['-c', check.command], {
        cwd: root,
        encoding: 'utf8',
        timeout: timeoutMs,
        env: {
          HOME: root,
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        },
      });
      return {
        index,
        type: check.type,
        passed: result.status === 0,
        exitCode: result.status,
        timedOut: result.error?.code === 'ETIMEDOUT',
      };
    }
    if (!['file_contains', 'file_not_contains'].includes(check?.type)) {
      throw new TypeError(`unsupported success criterion at index ${index}`);
    }
    const target = safeTarget(root, check.path, 'success check path');
    let exists = isRegularFileWithoutSymlinks(root, target);
    if (exists) {
      const stat = fs.statSync(target);
      exists = protectedTargets.has(target) || !protectedIdentities.has(`${stat.dev}:${stat.ino}`);
    }
    const found = exists && fs.readFileSync(target, 'utf8').includes(check.value);
    return {
      index,
      type: check.type,
      passed: exists && (check.type === 'file_contains' ? found : !found),
    };
  });
  return { passed: checks.every((check) => check.passed), checks };
}

export function blockedBenchmarkReceipt(manifest, budgetCapUsd) {
  if (!Number.isFinite(budgetCapUsd) || budgetCapUsd <= 0) throw new TypeError('budget cap must be positive');
  return {
    schemaVersion: 'sando.benchmark-run-receipt.v1',
    benchmarkId: manifest.id,
    status: 'not-run',
    reason: 'api-key-required-for-input-token-preflight',
    budgetCapUsd,
    attemptedRuns: 0,
    modelRequests: 0,
    estimatedApiCostUsd: 0,
  };
}

function interruptedAttempt(run, { startedAt = null, finishedAt = new Date().toISOString() } = {}) {
  return {
    schemaVersion: 'sando.benchmark-attempt.v1',
    benchmarkId: run.benchmarkId,
    taskId: run.taskId,
    arm: run.arm,
    repetition: run.repetition,
    orderPosition: run.orderPosition,
    outcome: 'failed',
    successVerified: false,
    attempts: 1,
    durationMs: null,
    startedAt,
    finishedAt,
    toolCalls: null,
    artifactRetrievals: null,
    cache: { status: 'unavailable', readInputTokens: null, writeInputTokens: null },
    cost: { status: 'incomplete', estimatedApiCostUsd: null, supportedSubtotalUsd: null },
    billing: { kind: 'chatgpt-subscription', apiCostUsd: null, status: 'unpriced' },
    failure: 'interrupted-before-completion',
  };
}

function appendEvent(file, event) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError();
      return [event];
    } catch {
      throw new Error(`invalid benchmark ledger JSON at line ${index + 1}`);
    }
  });
}

async function executeRun(run, manifest, workRoot, executionGuard = null) {
  const workspace = path.join(workRoot, `${run.taskId}-r${run.repetition}-${run.arm}`);
  let prepared;
  let baseline;
  let credentialValues = [];
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  try {
    baseline = materializeTaskRepository(workspace, run.task);
    const protectedSnapshot = snapshotProtectedFiles(workspace, run.task.protectedPaths);
    prepared = await prepareSubscriptionEnvironment({
      workspace, arm: run.arm, minAuthValidityMs: 5 * 60 * 1000,
    });
    credentialValues = prepared.credentialValues();
    if (executionGuard) assertExecutionProvenance(
      executionGuard.expected,
      executionProvenanceReceipt(executionGuard.repoRoot, prepared.codexPath, prepared.env),
    );
    const prompt = benchmarkPrompt(manifest, run);
    const result = await boundedProcess(prepared.codexPath, [
      'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules',
      '--sandbox', 'workspace-write', '-m', manifest.execution.model,
      '-c', `model_reasoning_effort=${JSON.stringify(manifest.execution.reasoningEffort)}`,
      prompt,
    ], {
      cwd: workspace,
      env: { ...prepared.env, SANDO_CLI_ROUTING: run.arm === 'apply' ? '1' : '0' },
      timeoutMs: manifest.execution.wallTimeoutMsPerRun,
    });
    const events = parseJsonLines(result.stdout);
    credentialValues = prepared.credentialValues();
    if (executionGuard) assertExecutionProvenance(
      executionGuard.expected,
      executionProvenanceReceipt(executionGuard.repoRoot, prepared.codexPath, prepared.env),
    );
    const tools = toolItems(events);
    const usage = observedUsage(events);
    const firstProtected = verifyProtectedFiles(workspace, protectedSnapshot);
    const verification = evaluateSuccessCriteria(workspace, run.task.successCriteria, {
      protectedPaths: run.task.protectedPaths,
    });
    const finalProtected = verifyProtectedFiles(workspace, protectedSnapshot);
    const hooks = fs.existsSync(prepared.hookLog) ? parseJsonLines(fs.readFileSync(prepared.hookLog, 'utf8')) : [];
    const preHooks = hooks.filter((entry) => entry.mode === 'pre');
    const preOutputs = hooks.filter((entry) => entry.mode === 'pre-output');
    const postHooks = hooks.filter((entry) => entry.mode === 'post');
    const rewritten = postHooks.filter((entry) => entry.input?.tool_input?.command?.includes('sando')).length;
    const subscriptionCompleted = result.status === 0 && !result.error
      && events.some((event) => event.type === 'turn.completed');
    const commands = tools.filter((event) => event.item?.type === 'command_execution');
    const finalMessage = events.filter((event) => (
      event.type === 'item.completed' && event.item?.type === 'agent_message'
    )).at(-1)?.item?.text;
    const modelSubstitution = /model.{0,60}(?:unavailable|fallback|substitut)/i.test(`${result.stderr}\n${result.stdout}`);
    const armEvidence = run.arm === 'apply'
      ? commands.length > 0 && preOutputs.length >= commands.length && rewritten >= commands.length
      : hooks.length === 0;
    const passed = subscriptionCompleted && !modelSubstitution && armEvidence
      && verification.passed && firstProtected.passed && finalProtected.passed;
    const artifactRetrievals = commands.filter((event) => /\bartifact\s+get\b/.test(
      String(event.item?.command ?? event.item?.aggregated_output ?? ''))).length;
    return {
      attempt: {
        schemaVersion: 'sando.benchmark-attempt.v1',
        benchmarkId: run.benchmarkId,
        taskId: run.taskId,
        arm: run.arm,
        repetition: run.repetition,
        orderPosition: run.orderPosition,
        outcome: passed ? 'passed' : 'failed',
        successVerified: true,
        attempts: 1,
        durationMs: Date.now() - started,
        startedAt,
        finishedAt: new Date().toISOString(),
        toolCalls: tools.length,
        artifactRetrievals,
        createdArtifacts: countArtifactFiles(workspace),
        cache: usage && Number.isSafeInteger(usage.cachedInputTokens) && Number.isSafeInteger(usage.cacheWriteInputTokens)
          ? { status: 'observed', readInputTokens: usage.cachedInputTokens, writeInputTokens: usage.cacheWriteInputTokens }
          : { status: 'unavailable', readInputTokens: null, writeInputTokens: null },
        usage,
        cost: { status: 'incomplete', estimatedApiCostUsd: null, supportedSubtotalUsd: null },
        billing: { kind: 'chatgpt-subscription', apiCostUsd: null, status: 'unpriced' },
        model: {
          requested: manifest.execution.model,
          observed: preHooks.find((entry) => entry.input?.model)?.input.model ?? null,
        },
        fixtureCommit: baseline.commit,
        verification: {
          checks: verification.checks,
          protectedBeforeChecks: firstProtected,
          protectedAfterChecks: finalProtected,
        },
        hooks: {
          preToolUse: preHooks.length,
          preToolUseOutputs: preOutputs.length,
          postToolUse: postHooks.length,
          rewrittenCommandsConsumed: rewritten,
        },
        process: {
          exitStatus: result.status,
          signal: result.signal,
          timedOut: Boolean(result.timedOut),
          outputTruncated: Boolean(result.truncated),
          modelSubstitution,
          cleanupErrorCode: typeof result.error?.code === 'string' ? result.error.code : null,
        },
      },
      diagnostics: {
        finalMessage,
        commands: commands.map((event) => String(event.item?.command ?? '')).filter(Boolean),
      },
      credentialValues,
      quotaFailure: quotaFailure(result),
    };
  } catch (error) {
    let failure = error;
    try { credentialValues = prepared?.credentialValues?.() ?? credentialValues; }
    catch (credentialError) { failure = credentialError; }
    const credentialCaptureFailed = failure?.code === 'AUTH_CREDENTIAL_CAPTURE_FAILED';
    return {
      attempt: {
        ...interruptedAttempt(run),
        durationMs: Date.now() - started,
        startedAt,
        finishedAt: new Date().toISOString(),
        failure: credentialCaptureFailed ? 'auth-credential-capture-failed'
          : failure instanceof Error ? failure.name : 'unknown-error',
      },
      credentialValues,
      suppressEvidence: credentialCaptureFailed,
      fatalFailure: credentialCaptureFailed || failure?.code === 'BENCHMARK_EXECUTION_DRIFT',
      quotaFailure: false,
    };
  } finally {
    prepared?.cleanup();
  }
}

export async function runBenchmark({
  manifest, ledgerPath, workRoot, concurrency = 2, onProgress = () => {}, execute = executeRun,
  signal, evidenceRoot, evidenceLimits, provenance = {}, executionGuard = null,
}) {
  const plan = buildBenchmarkPlan(manifest);
  const byKey = new Map(plan.map((run) => [runKey(run), run]));
  const prior = readEvents(ledgerPath);
  const runEvents = prior.filter((event) => ['started', 'completed'].includes(event.type));
  for (const event of runEvents) if (!byKey.has(event.runKey)) throw new Error(`ledger contains unknown run key: ${event.runKey}`);
  const completedEvents = prior.filter((event) => event.type === 'completed');
  const completed = new Set(completedEvents.map((event) => event.runKey));
  if (completed.size !== completedEvents.length) throw new Error('ledger contains duplicate completed run keys');
  const started = new Map(prior.filter((event) => event.type === 'started')
    .map((event) => [event.runKey, event]));
  for (const [stale, startedEvent] of started) {
    if (completed.has(stale) || !byKey.has(stale)) continue;
    const attempt = interruptedAttempt(byKey.get(stale), { startedAt: startedEvent.startedAt ?? null });
    appendEvent(ledgerPath, { schemaVersion: 'sando.benchmark-run-event.v1', type: 'completed', runKey: stale, attempt });
    completed.add(stale);
  }
  const pairs = [];
  for (let index = 0; index < plan.length; index += 2) {
    const pair = plan.slice(index, index + 2).filter((run) => !completed.has(runKey(run)));
    if (pair.length) pairs.push(pair);
  }
  let cursor = 0;
  let stop = false;
  let completedCount = completed.size;
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  async function worker() {
    while (!stop) {
      if (signal?.aborted) { stop = true; return; }
      const pair = pairs[cursor++];
      if (!pair) return;
      for (const run of pair) {
        if (stop || signal?.aborted) { stop = true; break; }
        const key = runKey(run);
        appendEvent(ledgerPath, {
          schemaVersion: 'sando.benchmark-run-event.v1', type: 'started', runKey: key,
          taskId: run.taskId, repetition: run.repetition, arm: run.arm, orderPosition: run.orderPosition,
          startedAt: new Date().toISOString(),
        });
        const result = await execute(run, manifest, workRoot, executionGuard);
        if (evidenceRoot && result.suppressEvidence) {
          result.attempt.evidence = {
            status: 'error', error: 'AuthCredentialCaptureFailed', overflow: false,
          };
        } else if (evidenceRoot) {
          const workspace = path.join(workRoot, `${run.taskId}-r${run.repetition}-${run.arm}`);
          result.attempt.evidence = retainSyntheticEvidence({
            workspace,
            evidenceRoot,
            task: run.task,
            run,
            verification: result.attempt.verification ?? { passed: false, checks: [] },
            diagnostics: result.diagnostics,
            credentialValues: result.credentialValues,
            provenance: {
              ...provenance,
              promptSha256: sha256(benchmarkPrompt(manifest, run)),
              requestedModel: result.attempt.model?.requested ?? manifest.execution?.model ?? null,
              observedModel: result.attempt.model?.observed ?? null,
              requestedEffort: manifest.execution?.reasoningEffort ?? null,
              startedAt: result.attempt.startedAt ?? null,
              finishedAt: result.attempt.finishedAt ?? null,
              traceTruncated: result.attempt.process?.outputTruncated ?? null,
            },
            limits: evidenceLimits,
          });
        }
        appendEvent(ledgerPath, {
          schemaVersion: 'sando.benchmark-run-event.v1', type: 'completed', runKey: key, attempt: result.attempt,
        });
        fs.rmSync(path.join(workRoot, `${run.taskId}-r${run.repetition}-${run.arm}`), { recursive: true, force: true });
        completedCount += 1;
        onProgress({ completed: completedCount, total: plan.length, attempt: result.attempt });
        if (result.quotaFailure || result.fatalFailure || signal?.aborted) { stop = true; break; }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const finalEvents = readEvents(ledgerPath);
  const finalByKey = new Map(finalEvents.filter((event) => event.type === 'completed')
    .map((event) => [event.runKey, event.attempt]));
  const attempts = plan.flatMap((run) => finalByKey.has(runKey(run)) ? [finalByKey.get(runKey(run))] : []);
  return { status: attempts.length === plan.length ? 'complete' : 'partial', attempts, scheduledRuns: plan.length };
}

function option(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
}

async function main(argv = process.argv.slice(2)) {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const manifestPath = path.resolve(option(argv, 'manifest', path.join(repoRoot, 'packages/sando/benchmarks/sando-v1.json')));
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const paths = resolveBenchmarkPaths({
    repoRoot,
    manifestPath,
    manifest,
    ledgerPath: option(argv, 'ledger'),
    evidenceRoot: option(argv, 'evidence-dir'),
  });
  const plan = buildBenchmarkPlan(manifest);
  if (!argv.includes('--run')) {
    process.stdout.write(`${JSON.stringify({
      benchmarkId: manifest.id,
      manifestPath: paths.manifestPath,
      ledgerPath: paths.ledgerPath,
      evidenceRoot: paths.evidenceRoot,
      status: 'not-run',
      runs: plan.length,
    }, null, 2)}\n`);
    return;
  }
  const historical = historicalV1Outputs(repoRoot);
  if (manifest.id === 'sando-v1' && overlapsAny(paths.ledgerPath, historical)) {
    throw new Error('historical sando-v1 artifacts are read-only; provide a separate --ledger for a diagnostic run');
  }
  if (manifest.id === 'sando-v1' && !option(argv, 'evidence-dir')) {
    throw new Error('historical sando-v1 diagnostics require a separate --evidence-dir');
  }
  if (manifest.id === 'sando-v1' && evidenceOverlapsHistorical(paths.evidenceRoot, historical)) {
    throw new Error('historical sando-v1 artifacts are read-only; provide a separate --evidence-dir');
  }
  const lock = acquireLedgerLock(paths.ledgerPath);
  let evidenceLock;
  let workRoot;
  const controller = new AbortController();
  const requestStop = () => controller.abort();
  try {
    evidenceLock = acquireLedgerLock(paths.evidenceRoot);
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${manifest.id}-runs-`));
    process.once('SIGINT', requestStop);
    process.once('SIGTERM', requestStop);
    const manifestSha256 = sha256(manifestBytes);
    const sourceReceipt = benchmarkSourceReceipt(repoRoot);
    const { runnerSha256, bundleSha256, sourceSha256 } = sourceReceipt;
    const runtimeFreeze = runtimeFreezeReceipt(repoRoot, manifest, manifestPath);
    const plannedRunKeysSha256 = sha256(plan.map(runKey).join('\n'));
    const authHorizonMs = Math.ceil(plan.length / manifest.execution.pairConcurrency)
      * manifest.execution.wallTimeoutMsPerRun + 10 * 60 * 1000;
    const startupAuth = await prepareSubscriptionEnvironment({
      workspace: workRoot, arm: 'control', minAuthValidityMs: authHorizonMs,
    });
    let frozenExecution;
    try { frozenExecution = executionProvenanceReceipt(repoRoot, startupAuth.codexPath, startupAuth.env); }
    finally { startupAuth.cleanup(); }
    const { codex } = frozenExecution;
    if (!fs.existsSync(paths.ledgerPath) || fs.statSync(paths.ledgerPath).size === 0) {
      appendEvent(paths.ledgerPath, {
        schemaVersion: 'sando.benchmark-run-event.v1', type: 'metadata',
        benchmarkId: manifest.id, manifestSha256, sourceSha256, plannedRunKeysSha256,
        ...sourceReceipt, scheduledRuns: plan.length, runtimeFreeze,
        authentication: manifest.execution.authentication, codex,
        supervisor: { pid: process.pid, startedAt: lock.owner.startedAt, recoveredStaleLock: lock.recoveredStale },
      });
    } else {
      const metadata = readEvents(paths.ledgerPath).find((event) => event.type === 'metadata');
      if (metadata?.manifestSha256 !== manifestSha256 || metadata?.sourceSha256 !== sourceSha256
        || metadata?.plannedRunKeysSha256 !== plannedRunKeysSha256 || metadata?.scheduledRuns !== plan.length
        || metadata?.codex?.binarySha256 !== codex.binarySha256 || metadata?.codex?.version !== codex.version) {
        throw new Error('ledger metadata does not match frozen benchmark');
      }
      assertExecutionProvenance(frozenExecution, {
        runnerSha256: metadata.runnerSha256,
        subscriptionContractSha256: metadata.subscriptionContractSha256,
        loopbackContractSha256: metadata.loopbackContractSha256,
        bundleSha256: metadata.bundleSha256,
        sourceSha256: metadata.sourceSha256,
        codex: metadata.codex,
      });
      assertRuntimeFreeze(metadata.runtimeFreeze, runtimeFreeze);
    }
    appendEvent(paths.ledgerPath, {
      schemaVersion: 'sando.benchmark-run-event.v1', type: 'supervisor-start',
      pid: process.pid, startedAt: lock.owner.startedAt, recoveredStaleLock: lock.recoveredStale,
    });
    process.stdout.write(`${JSON.stringify({ event: 'start', manifestSha256, sourceSha256, runs: plan.length })}\n`);
    const result = await runBenchmark({
      manifest,
      ledgerPath: paths.ledgerPath,
      workRoot,
      concurrency: manifest.execution.pairConcurrency,
      signal: controller.signal,
      evidenceRoot: paths.evidenceRoot,
      evidenceLimits: manifest.evidenceProtocol ? {
        perFileBytes: manifest.evidenceProtocol.perFileBytes,
        perAttemptBytes: manifest.evidenceProtocol.perAttemptBytes,
        totalBytes: manifest.evidenceProtocol.totalBytes,
      } : undefined,
      executionGuard: { repoRoot, expected: frozenExecution },
      provenance: {
        manifestSha256,
        runnerSha256,
        bundleSha256,
        sourceSha256,
        clientVersion: codex.version,
        launcherSha256: codex.launcherSha256,
        binarySha256: codex.binarySha256,
        authenticationMode: manifest.execution.authentication,
      },
      onProgress(progress) {
        process.stdout.write(`${JSON.stringify({
          event: 'progress', completed: progress.completed, total: progress.total,
          taskId: progress.attempt.taskId, arm: progress.attempt.arm,
          outcome: progress.attempt.outcome,
        })}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify({
      event: 'complete', status: result.status, attempts: result.attempts.length,
      passed: result.attempts.filter((attempt) => attempt.outcome === 'passed').length,
      failed: result.attempts.filter((attempt) => attempt.outcome === 'failed').length,
    })}\n`);
    if (result.status !== 'complete') process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    evidenceLock?.release();
    lock.release();
    if (workRoot) fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`sando benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
