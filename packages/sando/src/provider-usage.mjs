import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeWeightedUsage } from './paired-accounting.mjs';

const SCHEMA = 'sando-provider-usage/v1';
const VERSION = 1;
const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 250;
const STALE_LOCK_MS = 30_000;
const COST_SCOPES = new Set(['session', 'event']);

export const PROVIDER_USAGE_SCHEMA = SCHEMA;
export const PROVIDER_USAGE_VERSION = VERSION;

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && value.length > 0; }
function counter(value) { return Number.isSafeInteger(value) && value >= 0; }
function usd(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function cacheFits(inputTokens, cachedInputTokens, cacheWriteInputTokens) {
  return cacheWriteInputTokens <= inputTokens
    && cachedInputTokens <= inputTokens - cacheWriteInputTokens;
}
function safeSum(...values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}
function sumUsd(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) ? Number(total.toFixed(12)) : null;
}
function sha256(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function isoDate(value, fallback = new Date()) {
  const date = value === undefined ? new Date(fallback) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
function optionalCounter(value) { return value === undefined ? 0 : counter(value) ? value : null; }
function jsonLines(textValue) {
  if (typeof textValue !== 'string') throw new TypeError('transcript must be text');
  return textValue.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line);
      return record(value) ? [{ value, line }] : [];
    } catch {
      return [];
    }
  });
}

function reportedCost(value) {
  const candidates = [
    value?.total_cost_usd,
    value?.totalCostUsd,
    value?.cost_usd,
    value?.costUsd,
    value?.usage?.total_cost_usd,
    value?.usage?.totalCostUsd,
    value?.message?.usage?.total_cost_usd,
    value?.message?.usage?.totalCostUsd,
    value?.cost?.total_cost_usd,
    value?.cost?.totalCostUsd,
    value?.cost?.usd,
  ];
  return candidates.find(usd);
}

function attachReportedCost(records, totalCostUsd) {
  if (!records.length || !usd(totalCostUsd)) return records;
  return records.map((item, index) => index === records.length - 1
    ? { ...item, totalCostUsd, costScope: 'session' } : item);
}

function usageRecord({ host, source, sourceKey, sessionId, turnId, at, inputTokens, cachedInputTokens = 0,
  cacheWriteInputTokens = 0, outputTokens, reasoningOutputTokens = 0, totalCostUsd, arm, experimentId, workloadId }) {
  if (!text(host) || !text(source) || !text(sourceKey)
    || (sessionId !== null && !text(sessionId)) || (turnId !== null && !text(turnId))
    || !text(at) || !counter(inputTokens) || !counter(cachedInputTokens)
    || !counter(cacheWriteInputTokens) || !cacheFits(inputTokens, cachedInputTokens, cacheWriteInputTokens)
    || !counter(outputTokens) || !counter(reasoningOutputTokens) || reasoningOutputTokens > outputTokens) return null;
  const totalTokens = safeSum(inputTokens, outputTokens);
  if (totalTokens === null) return null;
  const identity = JSON.stringify({ host, source, sourceKey, at, inputTokens, cachedInputTokens,
    cacheWriteInputTokens, outputTokens, reasoningOutputTokens, totalTokens, arm, experimentId, workloadId });
  const result = {
    eventKey: `usage:${host}:${sha256(identity)}`,
    schema: SCHEMA, version: VERSION, host, source,
    sessionId: sessionId ?? null, turnId: turnId ?? null, at,
    inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens,
    reasoningOutputTokens, totalTokens,
  };
  if (totalCostUsd !== undefined && usd(totalCostUsd)) result.totalCostUsd = totalCostUsd;
  if (arm !== undefined) result.arm = arm;
  if (experimentId !== undefined) result.experimentId = experimentId;
  if (workloadId !== undefined) result.workloadId = workloadId;
  return result;
}

function claudeRecord(value, index, { sessionId = null, turnId = null, now, arm, experimentId, workloadId } = {}) {
  if (value.type !== 'assistant' || !record(value.message?.usage)) return null;
  const usage = value.message.usage;
  const inputTokens = usage.input_tokens;
  const cachedInputTokens = optionalCounter(usage.cache_read_input_tokens);
  const cacheWriteInputTokens = optionalCounter(usage.cache_creation_input_tokens);
  const outputTokens = usage.output_tokens;
  if (!counter(inputTokens) || cachedInputTokens === null || cacheWriteInputTokens === null || !counter(outputTokens)) return null;
  const totalInputTokens = safeSum(inputTokens, cachedInputTokens, cacheWriteInputTokens);
  if (totalInputTokens === null) return null;
  const totalTokens = usage.total_tokens === undefined ? safeSum(totalInputTokens, outputTokens) : usage.total_tokens;
  if (!counter(totalTokens) || totalTokens !== totalInputTokens + outputTokens) return null;
  return usageRecord({
    host: 'claude', source: 'claude-transcript', sourceKey: value.uuid ?? value.request_id ?? value.timestamp ?? String(index),
    sessionId, turnId: value.turn_id ?? turnId, at: isoDate(value.timestamp, now),
    inputTokens: totalInputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens,
    arm, experimentId, workloadId,
  });
}

function codexRecord(value, index, { sessionId = null, turnId = null, now, arm, experimentId, workloadId } = {}) {
  const usage = value.type === 'turn.completed'
    ? value.usage
    : value.type === 'event_msg' && value.payload?.type === 'token_count'
      ? value.payload.info?.last_token_usage ?? value.payload.info?.usage
      : undefined;
  if (!record(usage)) return null;
  const inputTokens = usage.input_tokens;
  const cachedInputTokens = optionalCounter(usage.cached_input_tokens ?? usage.cache_read_input_tokens);
  const cacheWriteInputTokens = optionalCounter(usage.cache_write_input_tokens);
  const outputTokens = usage.output_tokens;
  const reasoningOutputTokens = optionalCounter(usage.reasoning_output_tokens);
  if (!counter(inputTokens) || cachedInputTokens === null || cacheWriteInputTokens === null
    || !counter(outputTokens) || reasoningOutputTokens === null) return null;
  const totalTokens = usage.total_tokens === undefined ? safeSum(inputTokens, outputTokens) : usage.total_tokens;
  if (!counter(totalTokens) || totalTokens !== inputTokens + outputTokens) return null;
  return usageRecord({
    host: 'codex', source: 'codex-transcript', sourceKey: value.turn_id ?? value.id ?? value.timestamp ?? String(index),
    sessionId, turnId: value.turn_id ?? value.id ?? (value.timestamp ? `at:${value.timestamp}` : turnId), at: isoDate(value.timestamp, now),
    inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens,
    arm, experimentId, workloadId,
  });
}

export function parseClaudeTranscript(textValue, options = {}) {
  const entries = jsonLines(textValue);
  const records = entries.map(({ value }, index) => claudeRecord(value, index, options)).filter(Boolean);
  const totalCostUsd = options.totalCostUsd ?? entries.slice().reverse().map(({ value }) => reportedCost(value)).find(usd);
  return attachReportedCost(records, totalCostUsd);
}

export function parseCodexTranscript(textValue, options = {}) {
  const entries = jsonLines(textValue);
  const records = entries.map(({ value }, index) => codexRecord(value, index, options)).filter(Boolean);
  const totalCostUsd = options.totalCostUsd ?? entries.slice().reverse().map(({ value }) => reportedCost(value)).find(usd);
  return attachReportedCost(records, totalCostUsd);
}

export function defaultProviderUsagePath(env = process.env) {
  const configured = env.SANDO_PROVIDER_USAGE_PATH;
  if (configured !== undefined) {
    if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw new Error('provider usage path must be absolute');
    return configured;
  }
  const stateHome = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  if (!path.isAbsolute(stateHome)) throw new Error('state directory must be absolute');
  return path.join(stateHome, 'sando', 'provider-usage.json');
}

function timezone() { return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
function emptyState() { return { schema: SCHEMA, version: VERSION, timezone: timezone(), records: [] }; }
function resolvePath(storagePath) {
  if (typeof storagePath !== 'string' || !path.isAbsolute(storagePath)) throw new Error('provider usage path must be absolute');
  return storagePath;
}

function validateUsage(value) {
  if (!record(value) || value.schema !== SCHEMA || value.version !== VERSION || !text(value.eventKey)
    || !text(value.host) || !text(value.source) || !text(value.at)
    || (value.sessionId !== null && !text(value.sessionId)) || (value.turnId !== null && !text(value.turnId))
    || !counter(value.inputTokens) || !counter(value.cachedInputTokens) || !counter(value.cacheWriteInputTokens)
    || !cacheFits(value.inputTokens, value.cachedInputTokens, value.cacheWriteInputTokens)
    || !counter(value.outputTokens) || !counter(value.reasoningOutputTokens) || value.reasoningOutputTokens > value.outputTokens
    || !counter(value.totalTokens)
    || value.totalTokens !== value.inputTokens + value.outputTokens
    || (value.arm !== undefined && !['apply', 'control'].includes(value.arm))
    || (value.experimentId !== undefined && !text(value.experimentId))
    || (value.workloadId !== undefined && !text(value.workloadId))
    || (value.totalCostUsd !== undefined && !usd(value.totalCostUsd))
    || (value.costScope !== undefined && (!COST_SCOPES.has(value.costScope) || value.totalCostUsd === undefined))) {
    throw new Error('provider usage record is invalid');
  }
}

function validateState(value) {
  if (!record(value) || value.schema !== SCHEMA || value.version !== VERSION || !Array.isArray(value.records)) {
    throw new Error('provider usage state is invalid');
  }
  const keys = new Set();
  for (const item of value.records) {
    validateUsage(item);
    if (keys.has(item.eventKey)) throw new Error('provider usage state contains duplicate events');
    keys.add(item.eventKey);
  }
  return value;
}

export function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('provider usage directory is unsafe');
  fs.chmodSync(directory, 0o700);
}

function waitForLock() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS); }
export function withLock(lockPath, operation) {
  let handle;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try { handle = fs.openSync(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) fs.rmSync(lockPath, { force: true });
      else waitForLock();
    }
  }
  if (handle === undefined) throw new Error('provider usage lock timeout');
  try { return operation(); } finally { fs.closeSync(handle); fs.rmSync(lockPath, { force: true }); }
}

export function atomicWrite(filePath, value) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, filePath); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  fs.chmodSync(filePath, 0o600);
}

export function readProviderUsage(storagePath = defaultProviderUsagePath()) {
  const filePath = resolvePath(storagePath);
  if (!fs.existsSync(filePath)) return emptyState();
  return validateState(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function appendProviderUsage({ storagePath = defaultProviderUsagePath(), records = [] } = {}) {
  if (!Array.isArray(records)) throw new TypeError('provider usage records must be an array');
  for (const item of records) validateUsage(item);
  const filePath = resolvePath(storagePath);
  ensureDirectory(path.dirname(filePath));
  return withLock(`${filePath}.lock`, () => {
    const state = readProviderUsage(filePath);
    const existing = new Map(state.records.map((item, index) => [item.eventKey, index]));
    for (const item of records) {
      const index = existing.get(item.eventKey);
      if (index === undefined) {
        existing.set(item.eventKey, state.records.length);
        state.records.push(item);
      } else if (item.costScope === 'session') {
        state.records[index] = item;
      }
    }
    atomicWrite(filePath, state);
    return state;
  });
}

export function collectProviderUsage({ host, transcriptPath, sessionId = null, turnId = null,
  storagePath = defaultProviderUsagePath(), now, totalCostUsd, arm, experimentId, workloadId } = {}) {
  if (!['claude', 'codex'].includes(host) || typeof transcriptPath !== 'string' || !transcriptPath) return { records: [], state: readProviderUsage(storagePath) };
  try {
    const textValue = fs.readFileSync(transcriptPath, 'utf8');
    const parse = host === 'claude' ? parseClaudeTranscript : parseCodexTranscript;
    const records = parse(textValue, { sessionId, turnId, now, totalCostUsd, arm, experimentId, workloadId });
    return { records, state: appendProviderUsage({ storagePath, records }) };
  } catch {
    return { records: [], state: readProviderUsage(storagePath) };
  }
}

export function buildProviderUsageReport(state, { sessionId, pricing } = {}) {
  const records = validateState(state).records.filter((item) => sessionId === undefined || item.sessionId === sessionId);
  const sessions = new Set(records.map((item) => `${item.host}\0${item.sessionId ?? '<unknown>'}`));
  const turns = new Set(records.map((item, index) => `${item.host}\0${item.sessionId ?? '<unknown>'}\0${item.turnId ?? `record:${index}`}`));
  const sum = (field) => records.reduce((total, item) => total + item[field], 0);
  const weightedCostUnits = records.reduce((total, item) => total + computeWeightedUsage(item, pricing).costUnits, 0);
  const freshInputTokens = records.reduce((total, item) => total + item.inputTokens - item.cachedInputTokens - item.cacheWriteInputTokens, 0);
  const billing = reportedCostSummary(records);
  const totalCostUsd = billing.complete ? billing.totalCostUsd : null;
  const effectiveRate = totalCostUsd !== null && totalTokens(records) > 0
    ? totalCostUsd / totalTokens(records) * 1_000_000 : null;
  const cost = {
    status: billing.complete ? 'provider-reported' : 'unavailable',
    coverage: billing.complete ? 'complete' : billing.partial ? 'partial' : 'none',
    totalCostUsd,
    effectiveRateUsdPerMillionTokens: effectiveRate,
  };
  return {
    eventCount: records.length, sessionCount: sessions.size,
    inputTokens: sum('inputTokens'), cachedInputTokens: sum('cachedInputTokens'),
    cacheWriteInputTokens: sum('cacheWriteInputTokens'), freshInputTokens,
    outputTokens: sum('outputTokens'), reasoningOutputTokens: sum('reasoningOutputTokens'), totalTokens: sum('totalTokens'),
    turnCount: turns.size, weightedCostUnits,
    weightedCost: { source: 'weighted-estimate', costUnits: weightedCostUnits },
    cost,
    totalCostUsd,
    providerReportedCostUsd: totalCostUsd,
    sessionBlendedEffectiveRateUsdPerMillionTokens: effectiveRate,
    costSource: cost.status,
  };
}

function billingKey(item) {
  return `${item.host}\0${item.sessionId ?? '<unknown>'}`;
}

function reportedCostSummary(records) {
  const groups = new Map();
  records.forEach((item) => {
    const entries = groups.get(billingKey(item)) ?? [];
    entries.push(item);
    groups.set(billingKey(item), entries);
  });
  const totals = [];
  for (const entries of groups.values()) {
    const sessionCosts = entries.filter((item) => item.costScope === 'session' && usd(item.totalCostUsd));
    if (sessionCosts.length) {
      const latest = sessionCosts.reduce((left, right) => right.at >= left.at ? right : left);
      totals.push(latest.totalCostUsd);
      continue;
    }
    if (entries.every((item) => usd(item.totalCostUsd))) totals.push(sumUsd(entries.map((item) => item.totalCostUsd)));
  }
  const complete = groups.size > 0 && totals.length === groups.size && !totals.includes(null);
  const totalCostUsd = complete ? sumUsd(totals) : null;
  return { complete: complete && totalCostUsd !== null, partial: totals.length > 0, totalCostUsd };
}

function totalTokens(records) {
  return records.reduce((total, item) => total + item.totalTokens, 0);
}
