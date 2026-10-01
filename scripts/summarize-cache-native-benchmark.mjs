#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  LUNA_STANDARD_PROFILE_ID,
  SOL_STANDARD_PROFILE_ID,
  buildApiUsageRequest,
  estimateApiRequestCost,
  loadPricingProfile,
} from '../packages/sando/src/pricing.mjs';
import {
  buildCacheSessionPlan,
  verifyCacheSourceReceipt,
} from './run-sando-cache-benchmark.mjs';

const LEDGER_SCHEMA = 'sando.cache-benchmark-ledger.v1';
const ATTEMPT_SCHEMA = 'sando.cache-session-attempt.v1';
const USAGE_FIELDS = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
  'outputTokens', 'reasoningOutputTokens'];
const repoRoot = path.resolve(import.meta.dirname, '..');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileSha256 = (file) => sha256(fs.readFileSync(file));
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
  return JSON.stringify(value);
};
const fail = (message) => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) fail(message); };
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const add = (left, right, label) => {
  const result = left + right;
  assert(Number.isSafeInteger(result), `${label} overflow`);
  return result;
};
const same = (left, right) => canonicalJson(left) === canonicalJson(right);

function privateEntry(file, mode, label, kind = 'file') {
  const stat = fs.lstatSync(file);
  assert(!stat.isSymbolicLink(), `${label} must not be a symlink`);
  assert(kind === 'file' ? stat.isFile() : stat.isDirectory(), `${label} must be a ${kind}`);
  assert((stat.mode & 0o777) === mode, `${label} mode must be ${mode.toString(8)}`);
  return stat;
}

function safeStoredFile(base, relative, label) {
  assert(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), `${label} path is invalid`);
  const target = path.resolve(base, relative);
  assert(target.startsWith(`${path.resolve(base)}${path.sep}`), `${label} escapes its root`);
  privateEntry(target, 0o600, label);
  assert(fs.realpathSync(target).startsWith(`${fs.realpathSync(base)}${path.sep}`), `${label} resolves outside its root`);
  return target;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail(`invalid JSON: ${file}`); }
}

function readLedger(file) {
  privateEntry(file, 0o600, 'ledger');
  const text = fs.readFileSync(file, 'utf8');
  assert(text.endsWith('\n'), 'ledger must end with a newline');
  const lines = text.slice(0, -1).split('\n');
  assert(lines.length > 0 && lines.every(Boolean), 'ledger contains a blank line');
  return lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch { fail(`invalid ledger JSON at line ${index + 1}`); }
  });
}

function buildPlan(manifest) {
  const plan = buildCacheSessionPlan(manifest).map(({ task: _task, ...run }) => run);
  const scheduledKeys = manifest.schedule.flatMap((pair) => pair.arms.map((arm) => (
    `${pair.task}:${pair.repetition}:${arm}`
  )));
  assert(same(plan.map(({ runKey }) => runKey), scheduledKeys), 'manifest schedule differs from runner plan');
  const sessionsPerArm = manifest.tasks.length * manifest.repetitionsPerArm;
  assert(plan.length === manifest.execution.totalSessions
    && plan.length === sessionsPerArm * 2
    && plan.filter(({ arm }) => arm === 'apply').length === sessionsPerArm
    && plan.filter(({ arm }) => arm === 'control').length === sessionsPerArm,
  'manifest plan coverage is invalid');
  return plan;
}

function validateHeader(header, manifest, manifestBytes, plan) {
  assert(header?.type === 'header' && header.schemaVersion === LEDGER_SCHEMA, 'ledger header is missing');
  assert(header.benchmarkId === manifest.id && header.manifestSha256 === sha256(manifestBytes),
    'ledger manifest provenance mismatch');
  assert(header.planSha256 === sha256(canonicalJson(plan.map(({ runKey }) => runKey))),
    'ledger plan provenance mismatch');
  assert(header.repetitionsPerArm === manifest.repetitionsPerArm
    && header.totalSessions === manifest.execution.totalSessions, 'ledger dimensions mismatch');
}

function validateEvents(events, selected) {
  assert(events.filter(({ type }) => type === 'header').length === 1 && events[0].type === 'header',
    'ledger header must appear exactly once at the start');
  assert(events.every(({ type }) => ['header', 'started', 'completed'].includes(type)), 'unknown ledger event type');
  const seenStarted = new Set();
  const seenCompleted = new Set();
  for (const event of events.slice(1)) {
    if (event.type === 'started') {
      assert(!seenStarted.has(event.runKey), `duplicate started event: ${event.runKey}`);
      seenStarted.add(event.runKey);
    } else {
      assert(seenStarted.has(event.runKey), `completed event has no matching started event: ${event.runKey}`);
      assert(!seenCompleted.has(event.runKey), `duplicate completed event: ${event.runKey}`);
      seenCompleted.add(event.runKey);
    }
  }
  const expectedKeys = selected.map(({ runKey }) => runKey);
  const started = events.filter(({ type }) => type === 'started');
  const completed = events.filter(({ type }) => type === 'completed');
  const duplicate = (values) => values.find((value, index) => values.indexOf(value) !== index);
  const startedKeys = started.map(({ runKey }) => runKey);
  const completedKeys = completed.map(({ runKey }) => runKey);
  const duplicateStarted = duplicate(startedKeys);
  const duplicateCompleted = duplicate(completedKeys);
  assert(!duplicateStarted, `duplicate started event: ${duplicateStarted}`);
  assert(!duplicateCompleted, `duplicate completed event: ${duplicateCompleted}`);
  assert(same(startedKeys, expectedKeys), 'started events do not match the exact expected schedule subset');
  assert(same(completedKeys, expectedKeys), 'completed events do not match the exact expected schedule subset');
  const startedSet = new Set(startedKeys);
  assert(completedKeys.every((key) => startedSet.has(key)), 'completed event has no matching started event');
  return new Map(completed.map((event) => [event.runKey, event.attempt]));
}

function validateCounter(value, label) {
  assert(integer(value), `${label} must be an observed non-negative integer`);
  return value;
}

function observedCounters(value, label) {
  assert(object(value), `${label} is missing`);
  const result = Object.fromEntries(USAGE_FIELDS.map((field) => [field, validateCounter(value[field], `${label}.${field}`)]));
  assert(result.totalTokens === result.inputTokens + result.outputTokens, `${label}.totalTokens is inconsistent`);
  assert(result.cacheWriteInputTokens <= result.inputTokens
    && result.cachedInputTokens <= result.inputTokens - result.cacheWriteInputTokens,
  `${label} cache counters exceed input`);
  assert(result.reasoningOutputTokens <= result.outputTokens, `${label} reasoning output exceeds output`);
  return result;
}

function nullableCounters(value, label) {
  assert(object(value), `${label} is missing`);
  const result = {};
  for (const field of USAGE_FIELDS) {
    assert(value[field] === null || integer(value[field]), `${label}.${field} must be an observed integer or null`);
    result[field] = value[field];
  }
  if ([result.totalTokens, result.inputTokens, result.outputTokens].every(integer)) {
    assert(result.totalTokens === result.inputTokens + result.outputTokens, `${label}.totalTokens is inconsistent`);
  }
  if ([result.inputTokens, result.cachedInputTokens, result.cacheWriteInputTokens].every(integer)) {
    assert(result.cacheWriteInputTokens <= result.inputTokens
      && result.cachedInputTokens <= result.inputTokens - result.cacheWriteInputTokens,
    `${label} cache counters exceed input`);
  }
  if ([result.reasoningOutputTokens, result.outputTokens].every(integer)) {
    assert(result.reasoningOutputTokens <= result.outputTokens, `${label} reasoning output exceeds output`);
  }
  return result;
}

function maybeCounters(value) {
  if (!object(value) || USAGE_FIELDS.some((field) => !integer(value[field]))) return null;
  try { return observedCounters(value, 'request usage'); } catch { return null; }
}

function emptyCounters() { return Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0])); }
function addCounters(target, value, label) {
  for (const field of USAGE_FIELDS) target[field] = add(target[field], value[field], `${label}.${field}`);
  return target;
}

function mergeNullableCounters(target, value, label) {
  for (const field of USAGE_FIELDS) {
    if (target[field] === null) continue;
    if (value[field] === null) target[field] = null;
    else target[field] = add(target[field], value[field], `${label}.${field}`);
  }
  return target;
}

function validateExecution(attempt, manifest, run) {
  for (const field of ['benchmarkId', 'taskId', 'scenarioId', 'arm', 'repetition', 'orderPosition']) {
    assert(attempt[field] === run[field], `${run.runKey} identity mismatch: ${field}`);
  }
  assert(attempt.schemaVersion === ATTEMPT_SCHEMA, `${run.runKey} attempt schema mismatch`);
  assert(attempt.outcome === (attempt.qualityPassed ? 'passed' : 'failed'), `${run.runKey} quality outcome mismatch`);
  const protectedPassed = attempt.verification?.protected?.passed === true
    && Array.isArray(attempt.verification.protected.changed)
    && attempt.verification.protected.changed.length === 0;
  const criteria = attempt.verification?.criteria;
  const expectedCriteria = manifest.tasks.find(({ id }) => id === run.taskId)?.successCriteria;
  const criteriaCoverage = Array.isArray(expectedCriteria) && Array.isArray(criteria?.checks)
    && criteria.checks.length === expectedCriteria.length
    && criteria.checks.every((check, index) => check.index === index
      && check.type === expectedCriteria[index].type && typeof check.passed === 'boolean');
  assert(criteriaCoverage, `${run.runKey} criteria coverage mismatch`);
  const checksPassed = criteria.checks.every(({ passed }) => passed === true);
  assert(criteria.passed === checksPassed, `${run.runKey} criteria summary mismatch`);
  const criteriaPassed = criteria.passed;
  const sixCompletedTurns = Array.isArray(attempt.turns) && attempt.turns.length === 6
    && attempt.turns.every(({ status }) => status === 'completed');
  const verifiedQuality = protectedPassed && criteriaPassed && sixCompletedTurns
    && attempt.collabAgentToolCalls === 0 && attempt.failure === null;
  assert(attempt.qualityPassed === verifiedQuality, `${run.runKey} quality contradicts verification`);
  assert(attempt.qualityPassed || (typeof attempt.failure === 'string' && attempt.failure.length > 0),
    `${run.runKey} failed quality has no failure code`);
  assert(typeof attempt.threadIdDigest === 'string' && /^[a-f0-9]{64}$/.test(attempt.threadIdDigest),
    `${run.runKey} thread identity is unavailable`);
  const observed = attempt.observedExecution;
  for (const [field, expected] of Object.entries({ model: manifest.execution.model,
    reasoningEffort: manifest.execution.reasoningEffort, sandbox: manifest.execution.sandbox,
    approvalPolicy: manifest.execution.approvalPolicy })) {
    assert(observed?.[field] === expected, `${run.runKey} native execution mismatch: ${field}`);
  }
  assert(typeof observed.modelProvider === 'string' && observed.modelProvider.length > 0,
    `${run.runKey} model provider is unavailable`);
  assert(attempt.billing?.kind === 'chatgpt-subscription' && attempt.billing.apiCostUsd === null,
    `${run.runKey} native billing contract mismatch`);
}

function summarizeTurn(attempt, turn, runKey, pricingProfile, requestIndexBase) {
  assert(turn.index >= 1 && turn.index <= 6 && turn.status === 'completed', `${runKey} turn ${turn.index} is incomplete`);
  assert(typeof turn.turnIdDigest === 'string' && /^[a-f0-9]{64}$/.test(turn.turnIdDigest),
    `${runKey} turn ${turn.index} identity is unavailable`);
  assert(integer(turn.durationMs) && integer(turn.toolCalls) && integer(turn.artifactRetrievals),
    `${runKey} turn ${turn.index} metrics are invalid`);
  const delta = nullableCounters(turn.usage?.delta, `${runKey} turn ${turn.index} delta`);
  const requests = Array.isArray(turn.usage?.requests) ? turn.usage.requests : [];
  const requestSum = emptyCounters();
  const costs = [];
  let requestCoverageComplete = requests.length > 0;
  let requestNumber = requestIndexBase;
  for (const request of requests) {
    requestNumber += 1;
    const usage = maybeCounters(request?.usage);
    const contextObserved = integer(request?.modelContextWindow) && request.modelContextWindow > 0;
    if (!usage || !contextObserved) {
      requestCoverageComplete = false;
      costs.push({ status: 'unpriced', estimatedApiCostNanoUsd: null });
      continue;
    }
    addCounters(requestSum, usage, 'provider request sum');
    const apiRequest = buildApiUsageRequest({
      response: {
        object: 'response', status: 'completed', model: attempt.observedExecution.model, service_tier: 'default',
        id: `cache-native-${sha256(`${runKey}:${turn.index}:${requestNumber}`)}`,
        usage: {
          input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
          input_tokens_details: { cached_tokens: usage.cachedInputTokens,
            cache_write_tokens: usage.cacheWriteInputTokens },
          output_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens },
          total_tokens: usage.totalTokens,
        },
      },
      provenance: 'synthetic', regionalSurcharge: false, sessionId: runKey,
      arm: attempt.arm,
    });
    costs.push(estimateApiRequestCost(apiRequest, pricingProfile));
  }
  if (USAGE_FIELDS.some((field) => delta[field] === null) || !same(requestSum, delta)) requestCoverageComplete = false;
  if (!requestCoverageComplete) costs.forEach((cost) => { cost.status = 'unpriced'; cost.estimatedApiCostNanoUsd = null; });
  const commandOutputs = Array.isArray(turn.commands) ? turn.commands.map(({ aggregatedOutput }) => aggregatedOutput) : [];
  const finalMessages = Array.isArray(turn.finalMessages) ? turn.finalMessages : [];
  for (const output of [...commandOutputs.filter(Boolean), ...finalMessages]) {
    assert(typeof output.text === 'string' && typeof output.truncated === 'boolean' && integer(output.originalBytes),
      `${runKey} turn ${turn.index} retained text metadata is invalid`);
  }
  const hooks = turn.hooks;
  assert(integer(hooks?.total) && integer(hooks.invalidLines) && object(hooks.byMode),
    `${runKey} turn ${turn.index} hook metrics are invalid`);
  assert(Object.values(hooks.byMode).every(integer)
    && Object.values(hooks.byMode).reduce((sum, value) => sum + value, 0) === hooks.total,
  `${runKey} turn ${turn.index} hook modes are inconsistent`);
  assert(integer(turn.collabAgentToolCalls), `${runKey} turn ${turn.index} collaboration count is invalid`);
  const createdKnown = integer(turn.createdArtifacts);
  return {
    delta, costs, requestCoverageComplete, requestCount: requests.length,
    requestUsages: requests.map((request) => request?.usage),
    metrics: {
      sessions: 0, turns: 1, durationMs: turn.durationMs, toolCalls: turn.toolCalls,
      artifactRetrievals: turn.artifactRetrievals,
      artifactCreations: createdKnown ? turn.createdArtifacts : null,
      artifactCreationsObservedTurns: createdKnown ? 1 : 0,
      commandOutputs: commandOutputs.filter(Boolean).length,
      finalMessages: finalMessages.length,
      truncatedOutputs: [...commandOutputs.filter(Boolean), ...finalMessages].filter(({ truncated }) => truncated).length,
      retainedOriginalBytes: [...commandOutputs.filter(Boolean), ...finalMessages]
        .reduce((sum, { originalBytes }) => add(sum, originalBytes, 'retained bytes'), 0),
      hooks: hooks.total, invalidHookLines: hooks.invalidLines,
      collabAgentToolCalls: turn.collabAgentToolCalls,
    },
  };
}

function emptyMetrics() {
  return { sessions: 0, turns: 0, durationMs: 0, toolCalls: 0, artifactRetrievals: 0,
    artifactCreations: 0, artifactCreationsObservedTurns: 0, commandOutputs: 0, finalMessages: 0,
    truncatedOutputs: 0, retainedOriginalBytes: 0, hooks: 0, invalidHookLines: 0,
    collabAgentToolCalls: 0 };
}

function mergeMetrics(target, source) {
  for (const field of Object.keys(target)) {
    if (field === 'artifactCreations') {
      if (source[field] !== null) target[field] = add(target[field], source[field], field);
    } else target[field] = add(target[field], source[field], field);
  }
  return target;
}

function publicMetrics(metrics) {
  const totalTurns = metrics.turns;
  return { ...metrics,
    artifactCreations: metrics.artifactCreationsObservedTurns === totalTurns ? metrics.artifactCreations : null,
    artifactCreationsStatus: metrics.artifactCreationsObservedTurns === totalTurns ? 'observed' : 'unavailable' };
}

function validateAttempt(attempt, run, manifest, pricingProfile, requestIndexBase) {
  validateExecution(attempt, manifest, run);
  assert(Array.isArray(attempt.turns) && attempt.turns.length === 6, `${run.runKey} must contain six turns`);
  assert(attempt.turns.every((turn, index) => turn.index === index + 1), `${run.runKey} turn order is invalid`);
  assert(new Set(attempt.turns.map(({ turnIdDigest }) => turnIdDigest)).size === 6,
    `${run.runKey} turn identities must be unique within one thread`);
  const nativeTotal = emptyCounters();
  const metrics = emptyMetrics();
  metrics.sessions = 1;
  const turns = [];
  let nextRequestIndex = requestIndexBase;
  for (const turn of attempt.turns) {
    const summary = summarizeTurn(attempt, turn, run.runKey, pricingProfile, nextRequestIndex);
    nextRequestIndex += summary.requestCount;
    mergeNullableCounters(nativeTotal, summary.delta, `${run.runKey} native usage`);
    mergeMetrics(metrics, summary.metrics);
    turns.push(summary);
  }
  const recordedTotal = nullableCounters(attempt.usage?.total, `${run.runKey} cumulative usage`);
  assert(same(nativeTotal, recordedTotal), `${run.runKey} cumulative usage differs from turn deltas`);
  const turnHooks = turns.reduce((sum, turn) => add(sum, turn.metrics.hooks, 'turn hooks'), 0);
  const turnInvalidHooks = turns.reduce((sum, turn) => add(sum, turn.metrics.invalidHookLines, 'invalid hooks'), 0);
  const turnCollab = turns.reduce((sum, turn) => add(sum, turn.metrics.collabAgentToolCalls, 'collaboration calls'), 0);
  assert(attempt.hooks?.total === turnHooks && attempt.hooks.invalidLines === turnInvalidHooks,
    `${run.runKey} cumulative hooks mismatch`);
  assert(attempt.collabAgentToolCalls === turnCollab, `${run.runKey} cumulative collaboration calls mismatch`);
  return { attempt, run, nativeTotal, metrics, turns, requestCount: nextRequestIndex - requestIndexBase };
}

function auditReceipt(receiptPath, manifestPath, manifestHash, benchmarkId) {
  privateEntry(receiptPath, 0o600, 'source receipt');
  const receipt = readJson(receiptPath);
  verifyCacheSourceReceipt({ repoRoot, manifestPath, sourceReceiptPath: receiptPath });
  assert(receipt.schemaVersion === 'sando.cache-benchmark-source-receipt.v1' && receipt.benchmarkId === benchmarkId,
    'source receipt identity mismatch');
  assert(receipt.manifestSha256 === manifestHash, 'source receipt manifest hash mismatch');
  assert(object(receipt.files) && Object.keys(receipt.files).length > 0, 'source receipt has no files');
  assert(receipt.billing?.kind === 'chatgpt-subscription' && receipt.billing.usdCost === null
    && receipt.billing.apiFallback === false, 'source receipt billing contract mismatch');
  assert(object(receipt.runtime) && typeof receipt.runtime.node === 'string'
    && typeof receipt.runtime.platform === 'string' && typeof receipt.runtime.arch === 'string',
  'source receipt runtime is unavailable');
  assert(receipt.runtime.node === process.version && receipt.runtime.platform === process.platform
    && receipt.runtime.arch === process.arch, 'source receipt runtime differs from reporter runtime');
  const archivePath = path.resolve(repoRoot,
    receipt.archivePath ?? receiptPath.replace(/-source-receipt\.json$/, '-source.tar.gz'));
  return { receipt, archivePath };
}

function auditSource(attempts, receipt, receiptHash, manifestHash) {
  const sources = attempts.map((attempt) => attempt.provenance?.source);
  assert(sources.every(object) && sources.every((source) => same(source, sources[0])), 'session source provenance drift');
  const source = sources[0];
  assert(source.sourceReceiptSha256 === receiptHash
    && source.archiveSha256 === receipt.archiveSha256
    && source.manifestSha256 === manifestHash
    && source.codexBinarySha256 === receipt.codex?.binarySha256,
  'session source receipt mismatch');
  return source;
}

function auditEvidence(attempts, evidenceRoot) {
  privateEntry(evidenceRoot, 0o700, 'evidence root', 'directory');
  const expectedDirectories = new Set();
  const expectedNestedDirectories = new Set();
  const expectedFiles = new Set();
  let retainedFiles = 0;
  let retainedBytes = 0;
  let collectionLimits = null;
  for (const attempt of attempts) {
    assert(attempt.evidence?.status === 'available', `${attempt.taskId} evidence is unavailable`);
    const name = `${attempt.taskId}-r${attempt.repetition}-${attempt.arm}`;
    expectedDirectories.add(name);
    expectedNestedDirectories.add(name);
    expectedNestedDirectories.add(`${name}/outputs`);
    const directory = path.join(evidenceRoot, name);
    privateEntry(directory, 0o700, `${name} evidence`, 'directory');
    privateEntry(path.join(directory, 'outputs'), 0o700, `${name} outputs`, 'directory');
    const metadataPath = path.join(directory, 'evidence.json');
    const metadataStat = privateEntry(metadataPath, 0o600, `${name} metadata`);
    retainedFiles += 1;
    retainedBytes = add(retainedBytes, metadataStat.size, 'evidence bytes');
    assert(path.resolve(attempt.evidence.metadataPath) === metadataPath, `${name} metadata path mismatch`);
    expectedFiles.add(path.relative(evidenceRoot, metadataPath));
    const metadata = readJson(metadataPath);
    for (const field of ['benchmarkId', 'taskId', 'arm', 'repetition', 'orderPosition']) {
      assert(metadata[field] === attempt[field], `${name} evidence identity mismatch: ${field}`);
    }
    assert(same(metadata.verification, attempt.verification) && same(metadata.provenance, attempt.provenance),
      `${name} evidence metadata mismatch`);
    assert(same(metadata.files, attempt.evidence.files) && metadata.overflow === attempt.evidence.overflow,
      `${name} evidence ledger mismatch`);
    assert(object(metadata.limits) && ['perFileBytes', 'perAttemptBytes', 'totalBytes']
      .every((field) => Number.isSafeInteger(metadata.limits[field]) && metadata.limits[field] > 0),
    `${name} evidence limits are invalid`);
    collectionLimits ??= metadata.limits;
    assert(same(metadata.limits, collectionLimits), `${name} evidence limits changed`);
    let attemptBytes = metadataStat.size;
    for (const file of metadata.files) {
      const retained = safeStoredFile(directory, file.storedAs, `${name} evidence file`);
      const stat = fs.statSync(retained);
      assert(stat.size === file.bytes, `${name} evidence byte count mismatch`);
      assert(fileSha256(retained) === file.sha256, `${name} evidence hash mismatch`);
      assert(file.bytes <= metadata.limits.perFileBytes, `${name} evidence exceeds per-file limit`);
      attemptBytes = add(attemptBytes, file.bytes, 'attempt evidence bytes');
      retainedBytes = add(retainedBytes, file.bytes, 'evidence bytes');
      retainedFiles += 1;
      expectedFiles.add(path.relative(evidenceRoot, retained));
    }
    assert(attemptBytes <= metadata.limits.perAttemptBytes, `${name} evidence exceeds per-attempt limit`);
  }
  const actualDirectories = fs.readdirSync(evidenceRoot, { withFileTypes: true });
  assert(actualDirectories.length === expectedDirectories.size
    && actualDirectories.every((entry) => entry.isDirectory() && expectedDirectories.has(entry.name)),
  'evidence contains unexpected session directories');
  const actualFiles = [];
  const actualNestedDirectories = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), 'evidence contains a symlink');
      if (entry.isDirectory()) {
        const relative = path.relative(evidenceRoot, target);
        assert(expectedNestedDirectories.has(relative), 'evidence contains an unexpected directory');
        privateEntry(target, 0o700, `${relative} evidence directory`, 'directory');
        actualNestedDirectories.push(relative);
        walk(target);
      }
      else if (entry.isFile()) actualFiles.push(path.relative(evidenceRoot, target));
      else fail('evidence contains an unsupported entry');
    }
  };
  walk(evidenceRoot);
  assert(actualFiles.length === expectedFiles.size && actualFiles.every((file) => expectedFiles.has(file)),
    'evidence file coverage mismatch');
  assert(actualNestedDirectories.length === expectedNestedDirectories.size,
    'evidence directory coverage mismatch');
  assert(retainedBytes <= collectionLimits.totalBytes, 'collection exceeds total evidence limit');
  return { sessions: attempts.length, retainedFiles, retainedBytes, hashesAndPermissionsVerified: true,
    treeSha256: sha256(actualFiles.sort().map((file) => `${file}\0${fileSha256(path.join(evidenceRoot, file))}\n`).join('')) };
}

function costSummary(sessionSummaries) {
  const byArm = {};
  const bySession = new Map();
  let totalRequests = 0;
  let unpricedRequests = 0;
  let missingRequestCoverageTurns = 0;
  let missingRequestCountUnknown = false;
  let supportedNanoUsd = 0n;
  let allComplete = true;
  const observedRequestTotals = emptyCounters();
  const observedFieldCounts = Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]));
  for (const arm of ['control', 'apply']) {
    let nano = 0n;
    let supported = 0n;
    let complete = true;
    let requests = 0;
    for (const session of sessionSummaries.filter(({ attempt }) => attempt.arm === arm)) {
      let sessionNano = 0n;
      let sessionComplete = true;
      for (const turn of session.turns) {
        totalRequests += turn.requestCount;
        requests += turn.requestCount;
        if (!turn.requestCoverageComplete) sessionComplete = false;
        for (const cost of turn.costs) {
          if (cost.status === 'priced' && typeof cost.estimatedApiCostNanoUsd === 'string') {
            const value = BigInt(cost.estimatedApiCostNanoUsd);
            sessionNano += value;
            supported += value;
            supportedNanoUsd += value;
          } else {
            unpricedRequests += 1;
            sessionComplete = false;
          }
        }
        if (!turn.requestCoverageComplete) {
          missingRequestCoverageTurns += 1;
          if (turn.requestCount === 0) missingRequestCountUnknown = true;
        }
        for (const usage of turn.requestUsages) {
          for (const field of USAGE_FIELDS) {
            if (integer(usage?.[field])) {
              observedRequestTotals[field] = add(observedRequestTotals[field], usage[field], `request ${field}`);
              observedFieldCounts[field] += 1;
            }
          }
        }
      }
      if (!sessionComplete) complete = false;
      bySession.set(`${session.attempt.scenarioId}:${session.attempt.repetition}:${arm}`,
        { complete: sessionComplete, nanoUsd: sessionComplete ? sessionNano : null });
      if (sessionComplete) nano += sessionNano;
    }
    if (!complete) allComplete = false;
    byArm[arm] = { status: complete ? 'complete' : 'incomplete', requestCount: requests,
      estimatedApiCostUsd: complete ? Number(nano) / 1e9 : null,
      supportedEstimatedApiCostUsd: Number(supported) / 1e9 };
  }
  return {
    allComplete, byArm, bySession, totalRequests, unpricedRequests, missingRequestCoverageTurns,
    missingRequestCount: missingRequestCountUnknown ? null : 0,
    estimatedApiCostUsd: allComplete ? Number(supportedNanoUsd) / 1e9 : null,
    supportedEstimatedApiCostUsd: Number(supportedNanoUsd) / 1e9,
    tokenTotals: Object.fromEntries(USAGE_FIELDS.map((field) => [field,
      totalRequests > 0 && observedFieldCounts[field] === totalRequests ? observedRequestTotals[field] : null])),
  };
}

function descriptiveDecision(scope, manifest, sessions, costs) {
  const scenarios = manifest.tasks.map(({ id }) => id);
  const quality = scenarios.map((scenarioId) => {
    const selected = sessions.filter(({ attempt }) => attempt.scenarioId === scenarioId);
    const passed = (arm) => selected.filter(({ attempt }) => attempt.arm === arm && attempt.qualityPassed).length;
    return { scenarioId, controlPassed: passed('control'), applyPassed: passed('apply'),
      applyMinusControl: passed('apply') - passed('control') };
  });
  const paired = scenarios.map((scenarioId) => {
    const reductions = [];
    for (let repetition = 1; repetition <= manifest.repetitionsPerArm; repetition += 1) {
      const control = costs.bySession.get(`${scenarioId}:${repetition}:control`);
      const apply = costs.bySession.get(`${scenarioId}:${repetition}:apply`);
      if (!control?.complete || !apply?.complete || control.nanoUsd <= 0n) continue;
      reductions.push(Number(control.nanoUsd - apply.nanoUsd) / Number(control.nanoUsd));
    }
    const mean = reductions.length ? reductions.reduce((sum, value) => sum + value, 0) / reductions.length : null;
    const sampleVariance = reductions.length >= 2
      ? reductions.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (reductions.length - 1) : null;
    return { scenarioId, pairs: reductions.length, meanEstimatedReduction: mean, sampleVariance };
  });
  const control = costs.byArm.control.estimatedApiCostUsd;
  const apply = costs.byArm.apply.estimatedApiCostUsd;
  const overallReduction = costs.allComplete && control > 0 ? (control - apply) / control : null;
  const scenarioCosts = scenarios.map((scenarioId) => {
    let controlNano = 0n;
    let applyNano = 0n;
    let complete = true;
    for (let repetition = 1; repetition <= manifest.repetitionsPerArm; repetition += 1) {
      const controlSession = costs.bySession.get(`${scenarioId}:${repetition}:control`);
      const applySession = costs.bySession.get(`${scenarioId}:${repetition}:apply`);
      if (!controlSession?.complete || !applySession?.complete) { complete = false; continue; }
      controlNano += controlSession.nanoUsd;
      applyNano += applySession.nanoUsd;
    }
    const estimatedReduction = complete && controlNano > 0n
      ? Number(controlNano - applyNano) / Number(controlNano) : null;
    return { scenarioId, complete, estimatedReduction };
  });
  const scenarioIncreases = scenarioCosts.filter(({ complete, estimatedReduction }) => complete && estimatedReduction < -0.05)
    .map(({ scenarioId, estimatedReduction }) => ({ scenarioId, estimatedIncrease: -estimatedReduction }));
  if (scope === 'pilot') return {
    status: 'inconclusive-pilot', descriptiveRepetitionsPerArm: 1, statisticalProof: false,
    overallEstimatedReduction: overallReduction, scenarioQuality: quality, scenarioCosts, paired,
    limitation: 'Six-session pilot only; descriptive screening is not statistical proof.',
  };
  const sufficient = costs.allComplete
    && paired.every(({ pairs }) => pairs === manifest.repetitionsPerArm);
  const passed = sufficient && quality.every(({ applyMinusControl }) => applyMinusControl >= 0)
    && overallReduction >= 0.10 && scenarioIncreases.length === 0;
  return {
    status: sufficient ? (passed ? 'passed' : 'failed') : 'inconclusive-unpriced',
    descriptiveRepetitionsPerArm: manifest.repetitionsPerArm, statisticalProof: false,
    overallEstimatedReduction: overallReduction, scenarioQuality: quality, scenarioCosts, paired, scenarioIncreases,
    thresholds: { minimumOverallEstimatedReduction: 0.10, maximumScenarioEstimatedIncrease: 0.05,
      allowQualityRegression: false },
    limitation: `${manifest.repetitionsPerArm === 10 ? 'Ten' : manifest.repetitionsPerArm} repetitions per arm are a descriptive screening gate, not statistical proof.`,
  };
}

function summarize({ manifestPath, ledgerPath, sourceReceiptPath, outputPath, expectedSessions }) {
  assert(!fs.existsSync(`${ledgerPath}.lock`), 'ledger lock exists; collection may still be running');
  assert(!fs.existsSync(outputPath), 'output already exists; refusing to overwrite');
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const plan = buildPlan(manifest);
  assert(expectedSessions === plan.length || (plan.length === 30 && expectedSessions === 6),
    `--expected-sessions must be ${plan.length === 30 ? '6 or 30' : plan.length}`);
  const selected = plan.slice(0, expectedSessions);
  const events = readLedger(ledgerPath);
  validateHeader(events[0], manifest, manifestBytes, plan);
  const attemptsByKey = validateEvents(events, selected);
  const pricingProfileId = manifest.execution.model === 'gpt-6-luna'
    ? LUNA_STANDARD_PROFILE_ID : SOL_STANDARD_PROFILE_ID;
  const pricingProfile = loadPricingProfile(pricingProfileId);
  let requestIndex = 0;
  const sessions = selected.map((run) => {
    const summary = validateAttempt(attemptsByKey.get(run.runKey), run, manifest, pricingProfile, requestIndex);
    requestIndex += summary.requestCount;
    return summary;
  });
  const attempts = sessions.map(({ attempt }) => attempt);
  const { receipt, archivePath } = auditReceipt(
    sourceReceiptPath, manifestPath, sha256(manifestBytes), manifest.id);
  assert(path.resolve(events[0].sourceReceiptPath) === sourceReceiptPath
    && events[0].sourceReceiptSha256 === fileSha256(sourceReceiptPath),
  'ledger source receipt provenance mismatch');
  auditSource(attempts, receipt, fileSha256(sourceReceiptPath), sha256(manifestBytes));
  const evidenceRoot = path.resolve(events[0].evidenceRoot
    ?? path.join(path.dirname(ledgerPath), `${manifest.id}-evidence`));
  assert(!fs.existsSync(`${evidenceRoot}.lock`), 'evidence lock exists; collection may still be running');
  const evidence = auditEvidence(attempts, evidenceRoot);
  const overall = emptyMetrics();
  const byArm = { control: emptyMetrics(), apply: emptyMetrics() };
  const byTurnIndex = Array.from({ length: 6 }, (_, index) => ({
    index: index + 1, overall: emptyMetrics(), control: emptyMetrics(), apply: emptyMetrics(),
  }));
  const nativeUsage = { overall: emptyCounters(), control: emptyCounters(), apply: emptyCounters(),
    byTurnIndex: Array.from({ length: 6 }, (_, index) => ({ index: index + 1, ...emptyCounters() })) };
  for (const session of sessions) {
    mergeMetrics(overall, session.metrics);
    mergeMetrics(byArm[session.attempt.arm], session.metrics);
    mergeNullableCounters(nativeUsage.overall, session.nativeTotal, 'overall native usage');
    mergeNullableCounters(nativeUsage[session.attempt.arm], session.nativeTotal, `${session.attempt.arm} native usage`);
    session.turns.forEach((turn, index) => {
      mergeMetrics(byTurnIndex[index].overall, turn.metrics);
      mergeMetrics(byTurnIndex[index][session.attempt.arm], turn.metrics);
      mergeNullableCounters(nativeUsage.byTurnIndex[index], turn.delta, `turn ${index + 1} native usage`);
    });
  }
  const costs = costSummary(sessions);
  const scope = expectedSessions === plan.length ? 'complete' : 'pilot';
  const decision = descriptiveDecision(scope, manifest, sessions, costs);
  const observedValues = (field) => [...new Set(attempts.map(({ observedExecution }) => observedExecution[field]))]
    .sort((left, right) => String(left).localeCompare(String(right)));
  const report = {
    schemaVersion: 'sando.cache-native-benchmark-summary.v1', benchmarkId: manifest.id, scope,
    sessions: { expected: expectedSessions, completed: sessions.length, turns: sessions.length * 6 },
    quality: { passed: attempts.filter(({ qualityPassed }) => qualityPassed).length,
      failed: attempts.filter(({ qualityPassed }) => !qualityPassed).length },
    metrics: { overall: publicMetrics(overall),
      byArm: Object.fromEntries(Object.entries(byArm).map(([arm, value]) => [arm, publicMetrics(value)])),
      byTurnIndex: byTurnIndex.map(({ index, ...groups }) => ({ index,
        ...Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, publicMetrics(value)])) })) },
    nativeUsage,
    nativeBilling: { kind: 'chatgpt-subscription', usdCost: null, subscriptionQuotaCost: null,
      status: 'unknown', apiFallback: false },
    nativeExecution: {
      models: observedValues('model'), modelProviders: observedValues('modelProvider'),
      reasoningEfforts: observedValues('reasoningEffort'), sandboxes: observedValues('sandbox'),
      approvalPolicies: observedValues('approvalPolicy'), serviceTiers: observedValues('serviceTier'),
    },
    counterfactualApi: {
      label: 'COUNTERFACTUAL_API', profileId: pricingProfileId,
      serviceTierAssumption: 'standard', regionalSurchargeAssumption: false,
      modelAssumption: manifest.execution.model, nativeInvoice: false,
      status: costs.allComplete ? 'complete' : 'incomplete',
      estimatedApiCostUsd: costs.estimatedApiCostUsd,
      supportedEstimatedApiCostUsd: costs.supportedEstimatedApiCostUsd,
      requestCount: costs.totalRequests, unpricedRequests: costs.unpricedRequests,
      missingRequestCoverageTurns: costs.missingRequestCoverageTurns,
      missingRequestCount: costs.missingRequestCount,
      ...costs.tokenTotals,
      byArm: costs.byArm,
      limitation: 'Standard API list-price counterfactual from complete per-request native usage; not a subscription invoice.',
    },
    decision,
    integrity: {
      manifestSha256: sha256(manifestBytes), ledgerSha256: fileSha256(ledgerPath),
      sourceReceiptSha256: fileSha256(sourceReceiptPath), sourceArchiveSha256: fileSha256(archivePath),
      frozenSourceVerified: true, sourceFilesVerified: Object.keys(receipt.files).length,
      evidence,
    },
  };
  const descriptor = fs.openSync(outputPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.chmodSync(outputPath, 0o600);
  return report;
}

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) fail(`--${name} is required`);
  return argv[index + 1];
}

export function runCacheNativeSummary(argv) {
  const manifestPath = path.resolve(option(argv, 'manifest'));
  const manifestId = JSON.parse(fs.readFileSync(manifestPath)).id;
  const ledgerPath = path.resolve(option(argv, 'ledger'));
  const expectedSessions = Number(option(argv, 'expected-sessions'));
  const sourceReceiptOption = argv.indexOf('--source-receipt');
  const sourceReceiptPath = sourceReceiptOption >= 0
    ? path.resolve(argv[sourceReceiptOption + 1])
    : path.join(path.dirname(ledgerPath), `${manifestId}-source-receipt.json`);
  const outputOption = argv.indexOf('--output');
  const outputPath = outputOption >= 0
    ? path.resolve(argv[outputOption + 1])
    : path.join(path.dirname(ledgerPath), `${manifestId}-${expectedSessions === 6 ? 'pilot' : 'complete'}-summary.json`);
  return summarize({ manifestPath, ledgerPath, sourceReceiptPath, outputPath, expectedSessions });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = runCacheNativeSummary(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ output: 'written', scope: report.scope,
      sessions: report.sessions.completed, decision: report.decision.status })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'unknown summarizer error'}\n`);
    process.exitCode = 1;
  }
}
