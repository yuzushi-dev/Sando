import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeWeightedUsage } from './paired-accounting.mjs';
import { normalizeResponsesUsage } from './responses-usage.mjs';
import { aggregateApiRequestCosts } from './pricing.mjs';

const SCHEMA = 'sando-provider-usage/v1';
const VERSION = 1;
const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 250;
const STALE_LOCK_MS = 30_000;
const COST_SCOPES = new Set(['session', 'event']);
const COST_SOURCES = new Set(['host-reported', 'provider-reported']);
const AGGREGATIONS = new Set(['session']);

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
function codexEventIdentity(value, sessionId) {
  const stableId = value.turn_id ?? value.id;
  return text(stableId) ? sha256(JSON.stringify(['codex', 'codex-transcript', sessionId, value.type, stableId])) : undefined;
}
function usageSignature(entry) {
  return JSON.stringify([entry.inputTokens, entry.cachedInputTokens, entry.cacheWriteInputTokens,
    entry.outputTokens, entry.reasoningOutputTokens, entry.usageQuality]);
}
function quarantineUsage(entry) {
  entry.usageQuality = { ...entry.usageQuality, status: 'invalid', errors: [{ code: 'conflicting-event-revisions' }] };
}
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
    ? { ...item, totalCostUsd, costScope: 'session', costSource: 'host-reported' } : item);
}

function usageRecord({ host, source, sourceKey, sessionId, turnId, at, inputTokens, cachedInputTokens = 0,
  cacheWriteInputTokens = 0, outputTokens, reasoningOutputTokens = 0, totalCostUsd, costSource,
  aggregation, turnCount, arm, experimentId, workloadId, identityAt }) {
  if (!text(host) || !text(source) || !text(sourceKey)
    || (sessionId !== null && !text(sessionId)) || (turnId !== null && !text(turnId))
    || !text(at) || !counter(inputTokens) || !counter(cachedInputTokens)
    || !counter(cacheWriteInputTokens) || !cacheFits(inputTokens, cachedInputTokens, cacheWriteInputTokens)
    || !counter(outputTokens) || !counter(reasoningOutputTokens) || reasoningOutputTokens > outputTokens) return null;
  const totalTokens = safeSum(inputTokens, outputTokens);
  if (totalTokens === null) return null;
  const identity = JSON.stringify({ host, source, sourceKey,
    ...(identityAt === undefined ? { sessionId, turnId } : { at: identityAt }),
    inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens,
    totalTokens, aggregation, turnCount, arm, experimentId, workloadId });
  const result = {
    eventKey: `usage:${host}:${sha256(identity)}`,
    schema: SCHEMA, version: VERSION, host, source,
    sessionId: sessionId ?? null, turnId: turnId ?? null, at,
    inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens,
    reasoningOutputTokens, totalTokens,
  };
  if (totalCostUsd !== undefined && usd(totalCostUsd)) result.totalCostUsd = totalCostUsd;
  if (costSource !== undefined) result.costSource = costSource;
  if (aggregation !== undefined) result.aggregation = aggregation;
  if (turnCount !== undefined) result.turnCount = turnCount;
  if (arm !== undefined) result.arm = arm;
  if (experimentId !== undefined) result.experimentId = experimentId;
  if (workloadId !== undefined) result.workloadId = workloadId;
  return result;
}

function claudeUsageRecord(usage, { source, sourceKey, sessionId = null, turnId = null, at,
  arm, experimentId, workloadId, aggregation, turnCount, identityAt } = {}) {
  if (!record(usage)) return null;
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
    host: 'claude', source, sourceKey, sessionId, turnId, at,
    inputTokens: totalInputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens,
    aggregation, turnCount, identityAt,
    arm, experimentId, workloadId,
  });
}

function claudeRecord(value, index, { sessionId = null, turnId = null, now, arm, experimentId, workloadId } = {}) {
  if (value.type !== 'assistant' || !record(value.message?.usage)) return null;
  const identityAt = value.timestamp === undefined ? undefined : isoDate(value.timestamp, now);
  return claudeUsageRecord(value.message.usage, {
    source: 'claude-transcript', sourceKey: value.message.id ?? value.uuid ?? value.request_id ?? value.timestamp ?? String(index),
    sessionId, turnId: value.turn_id ?? turnId, at: isoDate(value.timestamp, now), identityAt,
    arm, experimentId, workloadId,
  });
}

function claudeResultRecord(value, entries, { sessionId = null, arm, experimentId, workloadId, now } = {}) {
  const identityTimestamp = value.timestamp ?? entries.slice().reverse().map((entry) => entry.value.timestamp).find(text);
  const at = identityTimestamp ?? now;
  const messages = new Set(entries
    .filter(({ value: entry }) => entry.type === 'assistant' && record(entry.message?.usage))
    .map(({ value: entry }, index) => entry.message.id ?? entry.uuid ?? entry.request_id ?? String(index)));
  const turnCount = counter(value.num_turns ?? value.numTurns) ? value.num_turns ?? value.numTurns : messages.size || undefined;
  return claudeUsageRecord(value.usage, {
    source: 'claude-result', sourceKey: sessionId === null ? value.uuid ?? value.request_id ?? 'final' : 'session',
    sessionId, turnId: null, at: isoDate(at, now), identityAt: identityTimestamp === undefined ? undefined : isoDate(identityTimestamp, now),
    aggregation: 'session', turnCount, arm, experimentId, workloadId,
  });
}

function codexRecord(value, index, { sessionId = null, turnId = null, now, arm, experimentId, workloadId, onDiagnostic } = {}) {
  const usage = value.type === 'turn.completed'
    ? value.usage
    : value.type === 'event_msg' && value.payload?.type === 'token_count'
      ? value.payload.info?.last_token_usage
      : undefined;
  if (!record(usage)) {
    if (value.type === 'event_msg' && value.payload?.type === 'token_count'
      && value.payload.info?.total_token_usage !== undefined) {
      onDiagnostic?.({ schema: 'sando-usage-quality/v1', status: 'unsupported', scope: 'cumulative',
        errors: [{ code: 'unverified-cumulative-provenance' }] });
    } else if (value.type === 'event_msg' && value.payload?.type === 'token_count'
      && value.payload.info?.usage !== undefined) {
      onDiagnostic?.({ schema: 'sando-usage-quality/v1', status: 'unsupported', scope: 'unknown',
        errors: [{ code: 'unverified-usage-provenance' }] });
    }
    return null;
  }
  const normalized = normalizeResponsesUsage(usage);
  const usageQuality = { ...normalized.quality, scope: value.type === 'turn.completed' ? 'turn' : 'last-usage',
    provenance: 'unverified',
    ...(codexEventIdentity(value, sessionId) ? { eventIdentity: codexEventIdentity(value, sessionId) } : {}) };
  if (usageQuality.status !== 'complete') onDiagnostic?.(usageQuality);
  if (!normalized.usage) return null;
  const { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens } = normalized.usage;
  const identityAt = value.timestamp === undefined ? undefined : isoDate(value.timestamp, now);
  const result = usageRecord({
    host: 'codex', source: 'codex-transcript', sourceKey: value.turn_id ?? value.id ?? value.timestamp ?? String(index),
    sessionId, turnId: value.turn_id ?? value.id ?? (value.timestamp ? `at:${value.timestamp}` : turnId), at: isoDate(value.timestamp, now), identityAt,
    inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens,
    arm, experimentId, workloadId,
  });
  return result && { ...result, usageQuality };
}

export function parseClaudeTranscript(textValue, options = {}) {
  const entries = jsonLines(textValue);
  const unique = new Map();
  entries.forEach(({ value }, index) => {
    const result = claudeRecord(value, index, options);
    if (!result) return;
    const messageId = text(value.message?.id);
    const key = messageId ? `message:${messageId}` : result.eventKey;
    unique.set(key, result);
  });
  const resultEntry = entries.findLast(({ value }) => value.type === 'result' && record(value.usage));
  const totalCostUsd = options.totalCostUsd ?? entries.slice().reverse().map(({ value }) => reportedCost(value)).find(usd);
  const aggregate = resultEntry ? claudeResultRecord(resultEntry.value, entries, options) : null;
  return attachReportedCost(aggregate ? [aggregate] : [...unique.values()], totalCostUsd);
}

export function parseCodexTranscript(textValue, options = {}) {
  const entries = jsonLines(textValue);
  const unique = new Map();
  const conflicted = new Set();
  entries.forEach(({ value }, index) => {
    const item = codexRecord(value, index, { ...options, onDiagnostic: (diagnostic) => {
      if (diagnostic.status === 'invalid' && diagnostic.eventIdentity) {
        conflicted.add(diagnostic.eventIdentity);
        unique.delete(diagnostic.eventIdentity);
      }
      options.onDiagnostic?.(diagnostic);
    } });
    if (!item) return;
    const key = item.usageQuality.eventIdentity ?? item.eventKey;
    if (conflicted.has(key)) return;
    const previous = unique.get(key);
    if (previous && usageSignature(previous) !== usageSignature(item)) {
      unique.delete(key);
      conflicted.add(key);
      options.onDiagnostic?.({ schema: 'sando-usage-quality/v1', status: 'invalid', scope: item.usageQuality.scope,
        eventIdentity: item.usageQuality.eventIdentity,
        errors: [{ code: 'conflicting-event-revisions' }] });
    } else if (!previous) unique.set(key, item);
  });
  const records = [...unique.values()];
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
    || (value.costSource !== undefined && !COST_SOURCES.has(value.costSource))
    || (value.aggregation !== undefined && !AGGREGATIONS.has(value.aggregation))
    || (value.turnCount !== undefined && !counter(value.turnCount))
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

export function appendProviderUsage({ storagePath = defaultProviderUsagePath(), records = [], invalidEventIdentities = [] } = {}) {
  if (!Array.isArray(records)) throw new TypeError('provider usage records must be an array');
  if (!Array.isArray(invalidEventIdentities)
    || invalidEventIdentities.some((value) => typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value))) {
    throw new TypeError('invalid event identities must be SHA256 digests');
  }
  for (const item of records) validateUsage(item);
  const filePath = resolvePath(storagePath);
  ensureDirectory(path.dirname(filePath));
  return withLock(`${filePath}.lock`, () => {
    const state = readProviderUsage(filePath);
    const invalid = new Set(invalidEventIdentities);
    for (const item of state.records) {
      if (invalid.has(item.usageQuality?.eventIdentity)) quarantineUsage(item);
    }
    const existing = new Map(state.records.map((item, index) => [item.eventKey, index]));
    for (const item of records) {
      const identity = item.usageQuality?.eventIdentity;
      if (identity) {
        const previous = state.records.find((candidate) => candidate.usageQuality?.eventIdentity === identity);
        if (previous) {
          if (previous.usageQuality.status === 'invalid') continue;
          if (usageSignature(previous) !== usageSignature(item)) {
            quarantineUsage(previous);
            continue;
          }
          // A repeated stable observation may still carry a newer session cost.
          if (item.costScope === 'session') {
            previous.totalCostUsd = item.totalCostUsd;
            previous.costScope = item.costScope;
            previous.costSource = item.costSource;
          }
          continue;
        }
        if (invalid.has(identity)) continue;
      }
      const index = item.aggregation === 'session'
        ? item.sessionId === null
          ? existing.get(item.eventKey) ?? -1
          : state.records.findIndex((candidate) => candidate.aggregation === 'session'
            && candidate.host === item.host && candidate.source === item.source && candidate.sessionId === item.sessionId)
        : existing.get(item.eventKey);
      if (index === undefined) {
        existing.set(item.eventKey, state.records.length);
        state.records.push(item);
      } else if (index < 0) {
        existing.set(item.eventKey, state.records.length);
        state.records.push(item);
      } else if (item.aggregation === 'session' || item.costScope === 'session') {
        state.records[index] = item;
      }
    }
    atomicWrite(filePath, state);
    return state;
  });
}

export function collectProviderUsage({ host, transcriptPath, sessionId = null, turnId = null,
  storagePath = defaultProviderUsagePath(), now, totalCostUsd, arm, experimentId, workloadId } = {}) {
  const diagnostics = [];
  if (!['claude', 'codex'].includes(host) || typeof transcriptPath !== 'string' || !transcriptPath) return { records: [], state: readProviderUsage(storagePath) };
  try {
    const textValue = fs.readFileSync(transcriptPath, 'utf8');
    const parse = host === 'claude' ? parseClaudeTranscript : parseCodexTranscript;
    const records = parse(textValue, { sessionId, turnId, now, totalCostUsd, arm, experimentId, workloadId,
      onDiagnostic: (value) => diagnostics.push(value) });
    const invalidEventIdentities = diagnostics.filter((item) => item.status === 'invalid' && item.eventIdentity)
      .map((item) => item.eventIdentity);
    return { records, state: appendProviderUsage({ storagePath, records, invalidEventIdentities }), diagnostics };
  } catch {
    return { records: [], state: readProviderUsage(storagePath) };
  }
}

export function buildProviderUsageReport(state, { sessionId, pricing, apiRequests, pricingProfile } = {}) {
  if ((apiRequests === undefined) !== (pricingProfile === undefined)) throw new TypeError('API requests and pricing profile are required together');
  const scoped = validateState(state).records.filter((item) => sessionId === undefined || item.sessionId === sessionId);
  const selected = scoped.filter((item) => item.usageQuality?.status !== 'invalid');
  const aggregateSessions = new Set(selected
    .filter((item) => item.aggregation === 'session' && item.sessionId !== null)
    .map(sessionKey));
  const records = selected.filter((item) => item.aggregation === 'session'
    || item.sessionId === null || !aggregateSessions.has(sessionKey(item)));
  const sessions = new Set(records.map(sessionKey));
  const turns = new Set(records.map(turnKey));
  const aggregateRecords = records.filter((item) => item.aggregation === 'session');
  const aggregateCounts = aggregateRecords.map((item) => item.turnCount);
  const nonAggregateTurns = new Set(records.filter((item) => item.aggregation !== 'session').map(turnKey));
  const turnCount = aggregateRecords.length
    ? aggregateCounts.every(counter) ? safeSum(...aggregateCounts, nonAggregateTurns.size) : null
    : turns.size;
  const sum = (field) => checkedCounterSum(records.map((item) => item[field]));
  const weightedCostUnits = records.reduce((total, item) => {
    const next = total + computeWeightedUsage(item, pricing).costUnits;
    if (!Number.isFinite(next)) throw new RangeError('provider weighted usage aggregate overflow');
    return next;
  }, 0);
  const freshInputTokens = checkedCounterSum(records.map((item) => item.inputTokens - item.cachedInputTokens - item.cacheWriteInputTokens));
  const billing = reportedCostSummary(records);
  const totalCostUsd = billing.complete ? billing.totalCostUsd : null;
  const effectiveRate = totalCostUsd !== null && totalTokens(records) > 0
    ? totalCostUsd / totalTokens(records) * 1_000_000 : null;
  const cost = {
    status: billing.complete ? billing.source : billing.partial ? billing.source : 'unavailable',
    coverage: billing.complete ? 'complete' : billing.partial ? 'partial' : 'none',
    totalCostUsd,
    effectiveRateUsdPerMillionTokens: effectiveRate,
  };
  return {
    eventCount: records.length, sessionCount: sessions.size,
    inputTokens: sum('inputTokens'), cachedInputTokens: sum('cachedInputTokens'),
    cacheWriteInputTokens: sum('cacheWriteInputTokens'), freshInputTokens,
    outputTokens: sum('outputTokens'), reasoningOutputTokens: sum('reasoningOutputTokens'), totalTokens: sum('totalTokens'),
    turnCount, weightedCostUnits,
    weightedCost: { source: 'weighted-estimate', costUnits: weightedCostUnits },
    cost,
    totalCostUsd,
    providerReportedCostUsd: billing.source === 'provider-reported' && billing.complete ? totalCostUsd : null,
    sessionBlendedEffectiveRateUsdPerMillionTokens: effectiveRate,
    costSource: cost.status,
    usageQuality: {
      completeRecords: records.filter((item) => item.usageQuality?.status === 'complete').length,
      incompleteRecords: records.filter((item) => item.usageQuality?.status === 'incomplete').length,
      legacyRecords: records.filter((item) => item.usageQuality === undefined).length,
      unverifiedScopeRecords: records.filter((item) => item.usageQuality?.provenance === 'unverified').length,
      excludedInvalidRecords: scoped.filter((item) => item.usageQuality?.status === 'invalid').length,
    },
    ...(apiRequests === undefined ? {} : { apiCost: aggregateApiRequestCosts(apiRequests, pricingProfile, { sessionId }) }),
  };
}

function billingKey(item) {
  return sessionKey(item);
}

function sessionKey(item) {
  return item.sessionId === null
    ? `${item.host}\0unknown:${item.eventKey}`
    : `${item.host}\0${item.sessionId}`;
}

function turnKey(item, index) {
  return `${sessionKey(item)}\0${item.turnId ?? `record:${index}`}`;
}

function reportedCostSummary(records) {
  const groups = new Map();
  records.forEach((item) => {
    const entries = groups.get(billingKey(item)) ?? [];
    entries.push(item);
    groups.set(billingKey(item), entries);
  });
  const totals = [];
  const sources = new Set();
  for (const entries of groups.values()) {
    const sessionCosts = entries.filter((item) => item.costScope === 'session' && usd(item.totalCostUsd));
    if (sessionCosts.length) {
      const latest = sessionCosts.reduce((left, right) => right.at >= left.at ? right : left);
      totals.push(latest.totalCostUsd);
      sources.add(latest.costSource ?? 'unknown');
      continue;
    }
    if (entries.every((item) => usd(item.totalCostUsd))) {
      totals.push(sumUsd(entries.map((item) => item.totalCostUsd)));
      entries.forEach((item) => sources.add(item.costSource ?? 'unknown'));
    }
  }
  const complete = groups.size > 0 && totals.length === groups.size && !totals.includes(null);
  const totalCostUsd = complete ? sumUsd(totals) : null;
  const source = sources.size === 1 ? [...sources][0] : sources.size ? 'mixed' : null;
  return { complete: complete && totalCostUsd !== null, partial: totals.length > 0, totalCostUsd, source: source ?? 'unknown' };
}

function totalTokens(records) {
  return checkedCounterSum(records.map((item) => item.totalTokens));
}

function checkedCounterSum(values) {
  return values.reduce((sum, value) => {
    const total = sum + value;
    if (!Number.isSafeInteger(total) || total < 0) throw new RangeError('provider usage aggregate overflow');
    return total;
  }, 0);
}
