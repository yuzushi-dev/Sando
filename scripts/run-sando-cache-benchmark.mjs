#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { prepareSubscriptionEnvironment } from './codex-subscription-contract.mjs';
import { startAppServer } from './codex-loopback-contract.mjs';
import {
  acquireLedgerLock,
  codexExecutableReceipt,
  evaluateSuccessCriteria,
  materializeTaskRepository,
  retainSyntheticEvidence,
  snapshotProtectedFiles,
  verifyProtectedFiles,
} from './run-sando-benchmark.mjs';

const USAGE_FIELDS = Object.freeze([
  'totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
  'outputTokens', 'reasoningOutputTokens',
]);
const SESSION_SCHEMA = 'sando.cache-session-attempt.v1';
const LEDGER_SCHEMA = 'sando.cache-benchmark-ledger.v1';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
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
  return path.join(fs.realpathSync(existing), ...suffix);
}

function pathsOverlap(left, right) {
  const a = canonicalOutputPath(left);
  const b = canonicalOutputPath(right);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

function assertOutputPaths({ manifestPath, sourceReceiptPath, ledgerPath, evidenceRoot, workRoot }) {
  const inputs = [manifestPath, sourceReceiptPath].filter(Boolean);
  const outputs = [ledgerPath, evidenceRoot, workRoot];
  for (const output of outputs) {
    if (inputs.some((input) => pathsOverlap(output, input))) throw new Error('output path overlaps immutable input');
  }
  for (let index = 0; index < outputs.length; index += 1) {
    if (outputs.slice(index + 1).some((other) => pathsOverlap(outputs[index], other))) {
      throw new Error('cache benchmark output paths overlap');
    }
  }
}

function assertPrivateOutputIfExists(target, label, kind) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  const correctKind = kind === 'file' ? stat.isFile() : stat.isDirectory();
  if (stat.isSymbolicLink() || !correctKind || (stat.mode & 0o777) !== (kind === 'file' ? 0o600 : 0o700)) {
    throw new Error(`${label} must be a private ${kind === 'file' ? 'regular file' : 'directory'}`);
  }
}

function validSlug(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function assertManifest(manifest) {
  const protocol = manifest?.id === 'sando-cache-v1'
    ? { model: 'gpt-6.1-sol', taskIds: null, taskCount: 3, repetitionsPerArm: 5 }
    : manifest?.id === 'sando-recovery-v1'
      ? { model: 'gpt-6.1-sol', taskIds: ['noisy-log-incident'], taskCount: 1, repetitionsPerArm: 10 }
      : manifest?.id === 'sando-recovery-luna-v1'
        ? { model: 'gpt-6-luna', taskIds: ['noisy-log-incident'], taskCount: 1, repetitionsPerArm: 10 }
        : null;
  if (manifest?.schemaVersion !== 'sando.benchmark-manifest.v1' || !protocol) {
    throw new TypeError('unsupported cache benchmark manifest');
  }
  const execution = manifest.execution;
  const required = {
    model: protocol.model, reasoningEffort: 'low', sandbox: 'workspace-write',
    approvalPolicy: 'never', authentication: 'chatgpt-subscription',
    forbidMeteredApiFallback: true, wallTimeoutMsPerTurn: 180000, turnsPerSession: 6,
    pairConcurrency: 1, ephemeral: true, ignoreUserConfig: true, ignoreRules: true,
  };
  if (!execution || Object.entries(required).some(([key, value]) => execution[key] !== value)) {
    throw new TypeError('cache benchmark execution contract is not frozen');
  }
  if (manifest.repetitionsPerArm !== protocol.repetitionsPerArm
    || !Array.isArray(manifest.tasks) || manifest.tasks.length !== protocol.taskCount
    || protocol.taskIds?.some((id, index) => manifest.tasks[index]?.id !== id)) {
    throw new TypeError(`${manifest.id} benchmark dimensions are not frozen`);
  }
  if (execution.totalSessions !== manifest.tasks.length * manifest.repetitionsPerArm * 2) {
    throw new TypeError('cache benchmark totalSessions is inconsistent');
  }
  const ids = new Set();
  for (const task of manifest.tasks) {
    if (!validSlug(task?.id) || ids.has(task.id)) throw new TypeError('cache task ids must be unique safe slugs');
    ids.add(task.id);
    if (!Array.isArray(task.turns) || task.turns.length !== 6
      || task.turns.some((turn) => typeof turn !== 'string' || turn.length === 0)) {
      throw new TypeError(`${task.id} must define exactly six non-empty turns`);
    }
    if (!task.fixture?.files || typeof task.fixture.files !== 'object' || Array.isArray(task.fixture.files)) {
      throw new TypeError(`${task.id} fixture is invalid`);
    }
    if (!Array.isArray(task.protectedPaths) || !Array.isArray(task.successCriteria)) {
      throw new TypeError(`${task.id} verification contract is invalid`);
    }
  }
  if (!Array.isArray(manifest.schedule) || manifest.schedule.length !== manifest.tasks.length * manifest.repetitionsPerArm) {
    throw new TypeError('cache benchmark schedule is missing or incomplete');
  }
  const scheduled = new Set();
  for (const entry of manifest.schedule) {
    const key = `${entry?.repetition}:${entry?.task}`;
    if (!Number.isSafeInteger(entry?.repetition) || entry.repetition < 1
      || entry.repetition > manifest.repetitionsPerArm || !ids.has(entry?.task) || scheduled.has(key)
      || !Array.isArray(entry?.arms) || entry.arms.length !== 2
      || [...entry.arms].sort().join(',') !== 'apply,control') {
      throw new TypeError('cache benchmark schedule is invalid');
    }
    scheduled.add(key);
  }
  if (protocol.taskIds && manifest.schedule.some((entry, index) => (
    entry.repetition !== index + 1
    || entry.task !== 'noisy-log-incident'
    || entry.arms.join(',') !== (index % 2 === 0 ? 'control,apply' : 'apply,control')
  ))) {
    throw new TypeError('recovery benchmark schedule is not frozen');
  }
}

export function buildCacheSessionPlan(manifest) {
  assertManifest(manifest);
  const plan = [];
  for (const scheduled of manifest.schedule) {
    const task = manifest.tasks.find(({ id }) => id === scheduled.task);
    scheduled.arms.forEach((arm, orderIndex) => plan.push({
        benchmarkId: manifest.id,
        taskId: task.id,
        scenarioId: task.id,
        task,
        repetition: scheduled.repetition,
        arm,
        orderPosition: orderIndex + 1,
        runKey: `${task.id}:${scheduled.repetition}:${arm}`,
      }));
  }
  return plan;
}

export function normalizeUsageBreakdown(value) {
  return Object.fromEntries(USAGE_FIELDS.map((field) => [
    field,
    Number.isSafeInteger(value?.[field]) && value[field] >= 0 ? value[field] : null,
  ]));
}

function usageStatus(value) {
  return USAGE_FIELDS.every((field) => value?.[field] !== null) ? 'complete' : 'incomplete';
}

function usageDelta(current, previous) {
  return Object.fromEntries(USAGE_FIELDS.map((field) => {
    const left = current?.[field];
    const right = previous?.[field] ?? 0;
    return [field, Number.isSafeInteger(left) && Number.isSafeInteger(right) && left >= right ? left - right : null];
  }));
}

function readHookRecords(file) {
  if (!file || !fs.existsSync(file)) return { records: [], invalidLines: 0 };
  let invalidLines = 0;
  const records = fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [];
    } catch {
      invalidLines += 1;
      return [];
    }
  });
  return { records, invalidLines };
}

function hookSummary(value) {
  const byMode = {};
  for (const record of value.records) {
    const mode = typeof record.mode === 'string' ? record.mode : 'unknown';
    byMode[mode] = (byMode[mode] ?? 0) + 1;
  }
  return { total: value.records.length, byMode, invalidLines: value.invalidLines };
}

function boundedText(value, maxBytes) {
  const original = Buffer.from(String(value ?? ''));
  if (original.length <= maxBytes) return { text: original.toString('utf8'), truncated: false, originalBytes: original.length };
  let retained = original.subarray(0, maxBytes);
  while (retained.length > 0) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(retained);
      return { text, truncated: true, originalBytes: original.length };
    } catch { retained = retained.subarray(0, retained.length - 1); }
  }
  return { text: '', truncated: true, originalBytes: original.length };
}

function redact(value, credentials) {
  let result = String(value ?? '');
  for (const credential of [...new Set(credentials)].sort((a, b) => b.length - a.length)) {
    if (typeof credential === 'string' && credential.length > 0) result = result.replaceAll(credential, '[REDACTED]');
  }
  return result;
}

function completedItems(notifications, threadId, turnId) {
  const items = new Map();
  for (const notification of notifications) {
    if (notification.method !== 'item/completed' || notification.params?.threadId !== threadId
      || notification.params?.turnId !== turnId) continue;
    const item = notification.params.item;
    if (item?.id && !items.has(item.id)) items.set(item.id, item);
  }
  return [...items.values()];
}

function shellWords(command) {
  const words = [];
  let word = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      else if (character === '\\' && quote === '"' && index + 1 < command.length) word += command[++index];
      else word += character;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) { words.push(word); word = ''; started = false; }
    } else if (character === '\\' && index + 1 < command.length) {
      word += command[++index];
      started = true;
    } else {
      word += character;
      started = true;
    }
  }
  if (quote) return [];
  if (started) words.push(word);
  return words;
}

function isArtifactRetrieval(command, nested = false) {
  const words = shellWords(command);
  const executable = words[0];
  if ((executable === 'sando' || (executable?.startsWith('/') && path.posix.basename(executable) === 'sando'))
    && words[1] === 'artifact' && words[2] === 'get') return true;
  return !nested && executable?.startsWith('/') && path.posix.basename(executable) === 'bash'
    && words.length === 3 && words[1] === '-lc' && isArtifactRetrieval(words[2], true);
}

function artifactFiles(workspace) {
  const root = path.join(workspace, '.sando', 'sando', 'artifacts');
  if (!fs.existsSync(root)) return new Set();
  const files = new Set();
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(target);
      else if (entry.isFile() && !entry.isSymbolicLink()) files.add(path.relative(root, target));
    }
  }
  return files;
}

function turnEvidence(notifications, threadId, turnId, credentials) {
  const items = completedItems(notifications, threadId, turnId);
  const commands = items.filter(({ type }) => type === 'commandExecution').map((item) => ({
    command: boundedText(redact(item.command, credentials), 2048).text,
    aggregatedOutput: typeof item.aggregatedOutput === 'string'
      ? boundedText(redact(item.aggregatedOutput, credentials), 8192) : null,
  }));
  const finalMessages = items.filter(({ type }) => type === 'agentMessage').map((item) => (
    boundedText(redact(item.text, credentials), 32 * 1024)
  ));
  const toolItems = items.filter(({ type }) => [
    'commandExecution', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall',
  ].includes(type));
  const artifactRetrievals = commands.filter(({ command }) => isArtifactRetrieval(command)).length;
  return {
    commands,
    finalMessages,
    toolCalls: toolItems.length,
    artifactRetrievals,
    collabAgentToolCalls: items.filter(({ type }) => type === 'collabAgentToolCall').length,
  };
}

function usageForTurn(notifications, threadId, turnId, previousTotal) {
  const requests = [];
  const seenTotals = new Set();
  let total = previousTotal;
  let modelContextWindow = null;
  for (const notification of notifications) {
    if (notification.method !== 'thread/tokenUsage/updated'
      || notification.params?.threadId !== threadId || notification.params?.turnId !== turnId) continue;
    const tokenUsage = notification.params.tokenUsage;
    const normalizedTotal = normalizeUsageBreakdown(tokenUsage?.total);
    const signature = JSON.stringify(normalizedTotal);
    if (seenTotals.has(signature)) continue;
    seenTotals.add(signature);
    total = normalizedTotal;
    modelContextWindow = Number.isSafeInteger(tokenUsage?.modelContextWindow) ? tokenUsage.modelContextWindow : null;
    const usage = normalizeUsageBreakdown(tokenUsage?.last);
    requests.push({ usage, usageStatus: usageStatus(usage), modelContextWindow });
  }
  const delta = usageDelta(total, previousTotal);
  return {
    total,
    delta,
    status: requests.length > 0 && usageStatus(delta) === 'complete' ? 'complete' : 'incomplete',
    providerRequests: requests,
    modelContextWindow,
  };
}

function failure(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function bounded(promise, timeoutMs, signal, timeoutCode) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(failure('INTERRUPTED')); return; }
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, failure('INTERRUPTED'));
    const timer = setTimeout(() => finish(reject, failure(timeoutCode)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function waitForNotification(notifications, method, predicate, timeoutMs, signal, onPoll = () => {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(failure('INTERRUPTED')); return; }
    const started = Date.now();
    let timer = null;
    const finish = (callback, value) => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, failure('INTERRUPTED'));
    const poll = () => {
      onPoll();
      const found = notifications.find((entry) => entry.method === method && predicate(entry.params));
      if (found) { finish(resolve, found); return; }
      if (Date.now() - started >= timeoutMs) { finish(reject, failure('TURN_TIMEOUT')); return; }
      timer = setTimeout(poll, 20);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(poll, 0);
  });
}

function procIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    const fields = stat.slice(end + 2).split(' ');
    return { pid, ppid: Number(fields[1]), processGroup: Number(fields[2]), startTime: fields[19] };
  } catch { return null; }
}

export function snapshotOwnedProcessTree(rootPid, expectedRoot = null) {
  const root = procIdentity(rootPid);
  if (!root || (expectedRoot && root.startTime !== expectedRoot.startTime)) return [];
  const identities = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))
    .map(Number).map(procIdentity).filter(Boolean);
  if (root.processGroup === root.pid) {
    return [root, ...identities.filter(({ pid, processGroup }) => (
      pid !== root.pid && processGroup === root.processGroup
    ))];
  }
  const owned = [];
  const parents = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const identity of identities) {
      if (!parents.has(identity.ppid) || parents.has(identity.pid)) continue;
      parents.add(identity.pid);
      owned.push(identity);
      changed = true;
    }
  }
  return [root, ...owned];
}

function killVerified(identity, signal) {
  const current = procIdentity(identity.pid);
  if (!current || current.startTime !== identity.startTime) return;
  try { process.kill(identity.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export async function cleanupOwnedApp({ app, rootIdentity, snapshots = [] } = {}) {
  snapshots.push(...snapshotOwnedProcessTree(app?.child?.pid, rootIdentity));
  let closeResult = { exited: true };
  try { closeResult = await app?.close?.() ?? closeResult; } catch { closeResult = { exited: false }; }
  const unique = new Map(snapshots.map((entry) => [`${entry.pid}:${entry.startTime}`, entry]));
  const currentRoot = procIdentity(rootIdentity?.pid);
  if (!closeResult.exited && currentRoot?.startTime === rootIdentity?.startTime
    && currentRoot.processGroup === currentRoot.pid) {
    try { process.kill(-currentRoot.processGroup, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (const identity of unique.values()) killVerified(identity, 'SIGTERM');
  if ([...unique.values()].some(({ pid, startTime }) => procIdentity(pid)?.startTime === startTime)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const identity of unique.values()) killVerified(identity, 'SIGKILL');
  return closeResult;
}

function observedExecution(response) {
  const sandbox = response?.sandbox;
  const sandboxName = typeof sandbox === 'string' ? sandbox
    : sandbox?.type === 'workspaceWrite' ? 'workspace-write' : sandbox?.type ?? null;
  return {
    model: typeof response?.model === 'string' ? response.model : null,
    modelProvider: typeof response?.modelProvider === 'string' ? response.modelProvider : null,
    reasoningEffort: typeof response?.reasoningEffort === 'string' ? response.reasoningEffort : null,
    sandbox: sandboxName,
    sandboxDetails: sandbox && typeof sandbox === 'object' ? sandbox : null,
    approvalPolicy: typeof response?.approvalPolicy === 'string' ? response.approvalPolicy : null,
    serviceTier: typeof response?.serviceTier === 'string' ? response.serviceTier : null,
  };
}

function matchesExecution(manifest, observed) {
  return observed.model === manifest.execution.model
    && observed.reasoningEffort === manifest.execution.reasoningEffort
    && observed.sandbox === manifest.execution.sandbox
    && observed.approvalPolicy === manifest.execution.approvalPolicy;
}

export async function boundedExecuteSession({
  manifest,
  run,
  workspace,
  evidenceRoot = null,
  prepared: injectedPrepared = null,
  prepareEnvironment = prepareSubscriptionEnvironment,
  appFactory = startAppServer,
  sourceGuard = () => null,
  signal = null,
  turnTimeoutMs = manifest?.execution?.wallTimeoutMsPerTurn,
} = {}) {
  assertManifest(manifest);
  if (!run || !path.isAbsolute(workspace)) throw new TypeError('run and absolute workspace are required');
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let prepared = injectedPrepared;
  let app;
  let protectedSnapshot;
  let baseline;
  let credentials = [];
  let expectedSource = null;
  let threadId = null;
  let activeTurnId = null;
  let observed = null;
  let usageTotal = normalizeUsageBreakdown({
    totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0,
  });
  const turns = [];
  const processSnapshots = [];
  let appRootIdentity = null;
  let failureCode = null;
  let evidence = { status: 'not-requested' };
  try {
    baseline = materializeTaskRepository(workspace, run.task);
    protectedSnapshot = snapshotProtectedFiles(workspace, run.task.protectedPaths);
    prepared ??= await prepareEnvironment({
      workspace, arm: run.arm, minAuthValidityMs: 20 * 60 * 1000,
      startupTimeoutMs: 30_000, signal,
    });
    credentials = prepared.credentialValues();
    prepared.env = { ...prepared.env, SANDO_CLI_ROUTING: run.arm === 'apply' ? '1' : '0' };
    expectedSource = sourceGuard({ prepared, manifest, run, phase: 'before-thread' });
    app = appFactory(prepared.codexPath, {
      cwd: workspace,
      env: prepared.env,
      detached: true,
      onServerRequest(message) {
        if (String(message?.method ?? '').includes('requestApproval')) return { decision: 'decline' };
        return {};
      },
    });
    appRootIdentity = procIdentity(app?.child?.pid);
    processSnapshots.push(...snapshotOwnedProcessTree(app?.child?.pid, appRootIdentity));
    const startupTimeoutMs = Math.min(30_000, manifest.execution.wallTimeoutMsPerTurn);
    await bounded(app.initialize({ experimentalApi: true }), startupTimeoutMs, signal, 'STARTUP_TIMEOUT');
    const threadResponse = await bounded(app.request('thread/start', {
      cwd: workspace,
      model: manifest.execution.model,
      approvalPolicy: manifest.execution.approvalPolicy,
      approvalsReviewer: 'user',
      sandbox: manifest.execution.sandbox,
      config: { model_reasoning_effort: manifest.execution.reasoningEffort },
      ephemeral: true,
      experimentalRawEvents: false,
      allowProviderModelFallback: false,
      multiAgentMode: 'explicitRequestOnly',
      developerInstructions: 'Complete each request in this thread. Do not spawn or delegate to other agents.',
    }), startupTimeoutMs, signal, 'STARTUP_TIMEOUT');
    threadId = threadResponse?.thread?.id ?? threadResponse?.threadId;
    if (!threadId) throw failure('INVALID_THREAD_RESPONSE');
    observed = observedExecution(threadResponse);
    if (!matchesExecution(manifest, observed)) throw failure('EXECUTION_CONTRACT_MISMATCH');

    for (let index = 0; index < run.task.turns.length; index += 1) {
      if (signal?.aborted) throw failure('INTERRUPTED');
      const beforeSource = sourceGuard({ prepared, manifest, run, turnIndex: index + 1 });
      if (JSON.stringify(beforeSource) !== JSON.stringify(expectedSource)) throw failure('SOURCE_DRIFT');
      const notificationStart = app.notifications.length;
      const serverRequestStart = app.serverRequests?.length ?? 0;
      const hookBefore = readHookRecords(prepared.hookLog);
      const artifactsBefore = artifactFiles(workspace);
      const turnStarted = Date.now();
      const turnDeadline = turnStarted + turnTimeoutMs;
      const response = await bounded(app.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: run.task.turns[index], text_elements: [] }],
        cwd: workspace,
        approvalPolicy: manifest.execution.approvalPolicy,
        approvalsReviewer: 'user',
        effort: manifest.execution.reasoningEffort,
      }), turnTimeoutMs, signal, 'TURN_TIMEOUT');
      activeTurnId = response?.turn?.id ?? response?.turnId;
      if (!activeTurnId) throw failure('INVALID_TURN_RESPONSE');
      processSnapshots.push(...snapshotOwnedProcessTree(app?.child?.pid, appRootIdentity));
      const completionBudgetMs = Math.max(1, turnDeadline - Date.now());
      let completed;
      let terminalError = null;
      try {
        completed = await waitForNotification(
          app.notifications,
          'turn/completed',
          (params) => params?.threadId === threadId && params?.turn?.id === activeTurnId,
          completionBudgetMs,
          signal,
          () => processSnapshots.push(...snapshotOwnedProcessTree(app?.child?.pid, appRootIdentity)),
        );
      } catch (error) {
        terminalError = error;
        const interruptedTurnId = activeTurnId;
        activeTurnId = null;
        try { await bounded(app.request('turn/interrupt', { threadId, turnId: interruptedTurnId }), 5_000, null, 'INTERRUPT_TIMEOUT'); } catch {}
        activeTurnId = interruptedTurnId;
        completed = { params: { turn: { id: interruptedTurnId, status: 'interrupted' } } };
      }
      await new Promise((resolve) => setImmediate(resolve));
      const selected = app.notifications.slice(notificationStart);
      const usage = usageForTurn(selected, threadId, activeTurnId, usageTotal);
      usageTotal = usage.total;
      credentials = prepared.credentialValues();
      const details = turnEvidence(selected, threadId, activeTurnId, credentials);
      const approvalRequests = (app.serverRequests ?? []).slice(serverRequestStart)
        .filter(({ method }) => String(method).includes('requestApproval')).length;
      const hookAfter = readHookRecords(prepared.hookLog);
      const artifactsAfter = artifactFiles(workspace);
      const createdArtifacts = [...artifactsAfter].filter((artifact) => !artifactsBefore.has(artifact)).length;
      const newHooks = {
        records: hookAfter.records.slice(hookBefore.records.length),
        invalidLines: Math.max(0, hookAfter.invalidLines - hookBefore.invalidLines),
      };
      const status = completed?.params?.turn?.status ?? 'unknown';
      turns.push({
        index: index + 1,
        turnIdDigest: sha256(activeTurnId),
        status,
        durationMs: Date.now() - turnStarted,
        usage: { status: usage.status, delta: usage.delta, requests: usage.providerRequests },
        toolCalls: details.toolCalls,
        artifactRetrievals: details.artifactRetrievals,
        createdArtifacts,
        commands: details.commands,
        finalMessages: details.finalMessages,
        hooks: hookSummary(newHooks),
        collabAgentToolCalls: details.collabAgentToolCalls,
        approvalRequests,
      });
      activeTurnId = null;
      const afterSource = sourceGuard({ prepared, manifest, run, turnIndex: index + 1 });
      if (JSON.stringify(afterSource) !== JSON.stringify(expectedSource)) throw failure('SOURCE_DRIFT');
      if (terminalError) throw terminalError;
      if (status !== 'completed') { failureCode = 'turn-failed'; break; }
      if (details.collabAgentToolCalls > 0) { failureCode = 'unpriced-collab-agent-call'; break; }
      if (approvalRequests > 0) { failureCode = 'unexpected-approval-request'; break; }
    }
  } catch (error) {
    if (activeTurnId && app) {
      try { await bounded(app.request('turn/interrupt', { threadId, turnId: activeTurnId }), 5_000, null, 'INTERRUPT_TIMEOUT'); } catch {}
    }
    failureCode = error?.code === 'INTERRUPTED' || error?.code === 'SUBSCRIPTION_SETUP_INTERRUPTED' ? 'interrupted'
      : ['TURN_TIMEOUT', 'STARTUP_TIMEOUT', 'SUBSCRIPTION_SETUP_TIMEOUT'].includes(error?.code) ? 'timeout'
        : error?.code === 'AUTH_CREDENTIAL_CAPTURE_FAILED' ? 'auth-credential-capture-failed'
          : error?.code === 'SOURCE_DRIFT' ? 'source-provenance-drift'
            : error?.code === 'EXECUTION_CONTRACT_MISMATCH' ? 'execution-contract-mismatch'
              : 'session-error';
  } finally {
    if (app) await cleanupOwnedApp({ app, rootIdentity: appRootIdentity, snapshots: processSnapshots });
  }

  const protectedVerification = protectedSnapshot
    ? verifyProtectedFiles(workspace, protectedSnapshot) : { passed: false, changed: [] };
  let criteriaVerification = { passed: false, checks: [] };
  try {
    criteriaVerification = evaluateSuccessCriteria(workspace, run.task.successCriteria, {
      protectedPaths: run.task.protectedPaths,
    });
  } catch { failureCode ??= 'verification-error'; }
  const collabAgentToolCalls = turns.reduce((sum, turn) => sum + turn.collabAgentToolCalls, 0);
  const qualityPassed = !failureCode && turns.length === 6
    && turns.every(({ status }) => status === 'completed')
    && protectedVerification.passed && criteriaVerification.passed && collabAgentToolCalls === 0;
  if (!qualityPassed) failureCode ??= 'verification-failed';
  const allHooks = readHookRecords(prepared?.hookLog);
  const attempt = {
    schemaVersion: SESSION_SCHEMA,
    benchmarkId: manifest.id,
    taskId: run.taskId,
    scenarioId: run.taskId,
    arm: run.arm,
    repetition: run.repetition,
    orderPosition: run.orderPosition,
    outcome: qualityPassed ? 'passed' : 'failed',
    qualityPassed,
    failure: failureCode,
    durationMs: Date.now() - started,
    startedAt,
    finishedAt: new Date().toISOString(),
    threadIdDigest: threadId ? sha256(threadId) : null,
    observedExecution: observed,
    turns,
    usage: {
      status: turns.length === 6 && turns.every((turn) => turn.usage.status === 'complete')
        && usageStatus(usageTotal) === 'complete' ? 'complete' : 'incomplete',
      total: usageTotal,
    },
    verification: { protected: protectedVerification, criteria: criteriaVerification },
    hooks: hookSummary(allHooks),
    collabAgentToolCalls,
    billing: { kind: 'chatgpt-subscription', apiCostUsd: null, status: 'unpriced' },
    provenance: { fixtureCommit: baseline?.commit ?? null, source: expectedSource },
  };

  if (evidenceRoot && failureCode !== 'auth-credential-capture-failed') {
    try {
      credentials = prepared?.credentialValues?.() ?? credentials;
      const commands = turns.flatMap((turn) => turn.commands.map(({ command }) => command));
      const finalMessage = turns.flatMap((turn) => turn.finalMessages.map(({ text }) => text)).at(-1) ?? '';
      evidence = retainSyntheticEvidence({
        workspace,
        evidenceRoot,
        task: run.task,
        run,
        verification: attempt.verification,
        provenance: attempt.provenance,
        diagnostics: { commands, finalMessage },
        credentialValues: credentials,
      });
    } catch (error) {
      evidence = { status: 'error', error: error?.name ?? 'Error' };
      attempt.outcome = 'failed';
      attempt.qualityPassed = false;
      attempt.failure ??= error?.code === 'AUTH_CREDENTIAL_CAPTURE_FAILED'
        ? 'auth-credential-capture-failed' : 'evidence-retention-failed';
    }
  }
  attempt.evidence = evidence;
  try { prepared?.cleanup?.(); } catch {
    attempt.outcome = 'failed';
    attempt.qualityPassed = false;
    attempt.failure ??= 'private-state-cleanup-failed';
  }
  return { attempt, evidence };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
  return JSON.stringify(value);
}

function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
      return [value];
    } catch { throw new Error(`invalid cache benchmark ledger JSON at line ${index + 1}`); }
  });
}

function appendLedger(file, event) {
  privateDirectory(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function ledgerHeader(manifest, manifestPath, plan, evidenceRoot, sourceReceiptPath) {
  const manifestBytes = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : Buffer.from(canonicalJson(manifest));
  return {
    type: 'header', schemaVersion: LEDGER_SCHEMA, benchmarkId: manifest.id,
    manifestSha256: sha256(manifestBytes), planSha256: sha256(canonicalJson(plan.map(({ runKey }) => runKey))),
    repetitionsPerArm: manifest.repetitionsPerArm, totalSessions: plan.length,
    evidenceRoot: path.resolve(evidenceRoot),
    sourceReceiptPath: sourceReceiptPath ? path.resolve(sourceReceiptPath) : null,
    sourceReceiptSha256: sourceReceiptPath && fs.existsSync(sourceReceiptPath)
      ? sha256(fs.readFileSync(sourceReceiptPath)) : null,
  };
}

function validateLedger(events, expectedHeader, plan) {
  const known = new Set(plan.map(({ runKey }) => runKey));
  const headers = events.filter(({ type }) => type === 'header');
  if (events.length > 0 && (headers.length !== 1 || events[0].type !== 'header')) {
    throw new Error('cache benchmark ledger header is missing or duplicated');
  }
  if (headers.length === 1 && JSON.stringify(headers[0]) !== JSON.stringify(expectedHeader)) {
    throw new Error('cache benchmark ledger frozen metadata mismatch');
  }
  const started = new Set();
  const completed = new Set();
  for (const event of events.filter(({ type }) => type !== 'header')) {
    if (!['started', 'completed'].includes(event.type)) throw new Error('unknown cache benchmark ledger event');
    if (!known.has(event.runKey)) throw new Error(`unknown run key: ${event.runKey}`);
    if (event.type === 'started') {
      if (started.has(event.runKey)) throw new Error(`duplicate started run: ${event.runKey}`);
      started.add(event.runKey);
    } else {
      if (!started.has(event.runKey) || completed.has(event.runKey)) throw new Error(`invalid completed run: ${event.runKey}`);
      if (event.attempt?.schemaVersion !== SESSION_SCHEMA) throw new Error(`invalid attempt for ${event.runKey}`);
      completed.add(event.runKey);
    }
  }
  return { started, completed };
}

function interruptedAttempt(run) {
  return {
    schemaVersion: SESSION_SCHEMA, benchmarkId: run.benchmarkId, taskId: run.taskId,
    scenarioId: run.taskId, arm: run.arm, repetition: run.repetition,
    orderPosition: run.orderPosition, outcome: 'failed', qualityPassed: false,
    failure: 'interrupted-before-completion', durationMs: null, startedAt: null,
    finishedAt: new Date().toISOString(), threadIdDigest: null, observedExecution: null,
    turns: [], usage: { status: 'incomplete', total: normalizeUsageBreakdown(null) },
    verification: null, hooks: { total: 0, byMode: {}, invalidLines: 0 },
    collabAgentToolCalls: 0, billing: { kind: 'chatgpt-subscription', apiCostUsd: null, status: 'unpriced' },
    provenance: null, evidence: { status: 'unavailable' },
  };
}

export async function runCacheBenchmark({
  manifest,
  manifestPath,
  ledgerPath,
  evidenceRoot,
  workRoot,
  sessionLimit = Infinity,
  execute = boundedExecuteSession,
  signal = null,
  sourceGuard = () => null,
  sourceReceiptPath = null,
} = {}) {
  assertManifest(manifest);
  assertOutputPaths({ manifestPath, sourceReceiptPath, ledgerPath, evidenceRoot, workRoot });
  assertPrivateOutputIfExists(ledgerPath, 'ledger', 'file');
  assertPrivateOutputIfExists(evidenceRoot, 'evidence root', 'directory');
  assertPrivateOutputIfExists(workRoot, 'work root', 'directory');
  const plan = buildCacheSessionPlan(manifest);
  const eventsBeforeLock = readLedger(ledgerPath);
  const expectedHeader = ledgerHeader(manifest, manifestPath, plan, evidenceRoot, sourceReceiptPath);
  validateLedger(eventsBeforeLock, expectedHeader, plan);
  const ledgerLock = acquireLedgerLock(ledgerPath);
  let evidenceLock;
  try {
    evidenceLock = acquireLedgerLock(evidenceRoot);
    privateDirectory(workRoot);
    let events = readLedger(ledgerPath);
    if (events.length === 0) {
      appendLedger(ledgerPath, expectedHeader);
      events = [expectedHeader];
    }
    const state = validateLedger(events, expectedHeader, plan);
    for (const runKey of state.started) {
      if (state.completed.has(runKey)) continue;
      const run = plan.find((candidate) => candidate.runKey === runKey);
      appendLedger(ledgerPath, { type: 'completed', runKey, attempt: interruptedAttempt(run) });
      state.completed.add(runKey);
    }
    let launched = 0;
    for (const run of plan) {
      if (state.completed.has(run.runKey) || launched >= sessionLimit || signal?.aborted) continue;
      appendLedger(ledgerPath, { type: 'started', runKey: run.runKey, startedAt: new Date().toISOString() });
      const workspace = path.join(workRoot, `${run.taskId}-r${run.repetition}-${run.arm}`);
      const result = await execute({ manifest, run, workspace, evidenceRoot, signal, sourceGuard });
      appendLedger(ledgerPath, { type: 'completed', runKey: run.runKey, attempt: result.attempt });
      state.completed.add(run.runKey);
      launched += 1;
    }
    return {
      totalSessions: plan.length,
      completedSessions: state.completed.size,
      launchedSessions: launched,
      remainingSessions: plan.length - state.completed.size,
    };
  } finally {
    evidenceLock?.release();
    ledgerLock.release();
  }
}

function safeReceiptFile(repoRoot, relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`${label} is unsafe`);
  }
  const root = fs.realpathSync(repoRoot);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`${label} is unsafe`);
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} is unsafe`);
  }
  if (!fs.statSync(target).isFile()) throw new Error(`${label} is unsafe`);
  return target;
}

function recursiveRegularFiles(repoRoot, directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('critical source tree contains a symlink');
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) files.push(path.relative(repoRoot, target));
    }
  }
  return files;
}

export function cacheRequiredSourceFiles({ repoRoot, manifestPath } = {}) {
  const root = path.resolve(repoRoot);
  const resolvedManifest = path.resolve(manifestPath);
  const relativeManifest = path.relative(root, resolvedManifest);
  if (!relativeManifest || relativeManifest.startsWith(`..${path.sep}`) || path.isAbsolute(relativeManifest)) {
    throw new Error('manifest must be inside repository root');
  }
  const manifest = JSON.parse(fs.readFileSync(resolvedManifest, 'utf8'));
  return [...new Set([
    relativeManifest,
    'scripts/run-sando-cache-benchmark.mjs',
    'scripts/run-sando-benchmark.mjs',
    'scripts/codex-subscription-contract.mjs',
    'scripts/codex-loopback-contract.mjs',
    'scripts/summarize-cache-native-benchmark.mjs',
    'packages/sando/src/pricing.mjs',
    'packages/sando/src/responses-usage.mjs',
    'packages/sando/pricing/openai-gpt-6.1-sol-standard-2026-09-30.json',
    ...(manifest?.id === 'sando-recovery-luna-v1'
      ? ['packages/sando/pricing/openai-gpt-6-luna-standard-2026-10-01.json'] : []),
    ...recursiveRegularFiles(root, path.join(root, 'adapters/codex/sando')),
  ])].sort();
}

export function verifyCacheSourceReceipt({
  repoRoot, manifestPath, sourceReceiptPath, codexPath = null, env = process.env,
} = {}) {
  let receipt;
  let manifest;
  try {
    const stat = fs.lstatSync(sourceReceiptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    receipt = JSON.parse(fs.readFileSync(sourceReceiptPath, 'utf8'));
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch { throw new Error('frozen source receipt is invalid'); }
  if (receipt?.schemaVersion !== 'sando.cache-benchmark-source-receipt.v1'
    || typeof manifest?.id !== 'string' || receipt.benchmarkId !== manifest.id || !receipt.files
    || typeof receipt.files !== 'object' || Array.isArray(receipt.files)) {
    throw new Error('frozen source receipt is invalid');
  }
  const requiredFiles = cacheRequiredSourceFiles({ repoRoot, manifestPath });
  if (requiredFiles.some((relative) => !Object.hasOwn(receipt.files, relative))) {
    throw new Error('frozen source receipt is missing required files');
  }
  const mismatch = () => { throw new Error('frozen source receipt mismatch'); };
  if (sha256(fs.readFileSync(manifestPath)) !== receipt.manifestSha256) mismatch();
  const archive = safeReceiptFile(repoRoot, receipt.archivePath, 'source archive');
  if (sha256(fs.readFileSync(archive)) !== receipt.archiveSha256) mismatch();
  for (const [relative, expected] of Object.entries(receipt.files)) {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error('frozen source receipt is invalid');
    }
    const target = safeReceiptFile(repoRoot, relative, 'source receipt file');
    if (sha256(fs.readFileSync(target)) !== expected) mismatch();
  }
  if (receipt.runtime?.node !== process.version || receipt.runtime?.platform !== process.platform
    || receipt.runtime?.arch !== process.arch) mismatch();
  if (codexPath) {
    const observed = codexExecutableReceipt(codexPath, env);
    if (receipt.codex?.version !== observed.version
      || receipt.codex?.binarySha256 !== observed.binarySha256
      || fs.realpathSync(receipt.codex?.binaryPath ?? '') !== fs.realpathSync(observed.binaryPath)) mismatch();
  }
  return {
    sourceReceiptSha256: sha256(fs.readFileSync(sourceReceiptPath)),
    archiveSha256: receipt.archiveSha256,
    manifestSha256: receipt.manifestSha256,
    codexBinarySha256: receipt.codex?.binarySha256 ?? null,
  };
}

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : null;
}

async function main(argv) {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const manifestPath = path.resolve(option(argv, 'manifest') ?? path.join(repoRoot, 'packages/sando/benchmarks/sando-cache-v1.json'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assertManifest(manifest);
  if (!argv.includes('--pilot') && !argv.includes('--run')) throw new Error('pass --pilot or --run');
  if (argv.includes('--pilot') && argv.includes('--run')) throw new Error('choose --pilot or --run');
  const ledgerPath = path.resolve(option(argv, 'ledger') ?? path.join(repoRoot, 'packages/sando/benchmarks/results/sando-cache-v1-events.jsonl'));
  const evidenceRoot = path.resolve(option(argv, 'evidence-dir') ?? path.join(repoRoot, 'packages/sando/benchmarks/results/sando-cache-v1-evidence'));
  const sourceReceiptPath = path.resolve(option(argv, 'source-receipt')
    ?? path.join(path.dirname(ledgerPath), 'sando-cache-v1-source-receipt.json'));
  if (argv.includes('--run') && !option(argv, 'source-receipt')) {
    throw new Error('--run requires explicit --source-receipt');
  }
  if (!fs.existsSync(sourceReceiptPath) || !fs.statSync(sourceReceiptPath).isFile()) {
    throw new Error('frozen source receipt is required');
  }
  const frozenReceipt = verifyCacheSourceReceipt({ repoRoot, manifestPath, sourceReceiptPath });
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-benchmark-'));
  fs.chmodSync(workRoot, 0o700);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const sourceGuard = ({ prepared }) => {
    try {
      const observed = verifyCacheSourceReceipt({
        repoRoot, manifestPath, sourceReceiptPath, codexPath: prepared.codexPath, env: prepared.env,
      });
      if (observed.sourceReceiptSha256 !== frozenReceipt.sourceReceiptSha256) throw new Error('receipt drift');
      return observed;
    } catch { throw failure('SOURCE_DRIFT'); }
  };
  try {
    const result = await runCacheBenchmark({
      manifest, manifestPath, ledgerPath, evidenceRoot, workRoot,
      sessionLimit: argv.includes('--pilot') ? 6 : Infinity,
      signal: controller.signal,
      sourceGuard,
      sourceReceiptPath,
    });
    process.stdout.write(`${JSON.stringify({ event: 'complete', ...result })}\n`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
