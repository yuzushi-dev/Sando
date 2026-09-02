import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONTEXT_CAPTURE_SCHEMA,
  buildContextFootprintReport,
  serializeContextFootprint,
} from './context-footprint.mjs';
import { classifyContextRequest } from './context-classifier.mjs';

export const CONTEXT_CAPTURE_RECORD_SCHEMA = 'sando-context-capture-record/v1';
export const CONTEXT_CAPTURE_RECORD_VERSION = 1;

const PROVIDER_FORMATS = Object.freeze({
  anthropic: { host: 'claude', requestFormat: 'anthropic' },
  'openai-responses': { host: 'codex', requestFormat: 'openai-responses' },
});

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function add(left, right) {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : null;
}

function optionalCounter(value) {
  return value === undefined || value === null ? 0 : counter(value);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError('capture timestamp is invalid');
  return date.toISOString();
}

function safeModel(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 256) throw new TypeError('capture model is invalid');
  return value;
}

function rawText(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  throw new TypeError('raw request body is invalid');
}

function anthropicUsage(value) {
  if (!object(value)) return null;
  const input = counter(value.input_tokens);
  const cacheRead = optionalCounter(value.cache_read_input_tokens);
  const cacheWrite = optionalCounter(value.cache_creation_input_tokens);
  const output = counter(value.output_tokens);
  if (input === null || cacheRead === null || cacheWrite === null || output === null) return null;
  const inputTokens = add(add(input, cacheRead), cacheWrite);
  const totalTokens = inputTokens === null ? null : add(inputTokens, output);
  if (totalTokens === null) return null;
  const result = {
    inputTokens,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    cacheReadInputTokens: cacheRead,
    outputTokens: output,
    totalTokens,
  };
  if (counter(value.reasoning_output_tokens) !== null) result.reasoningOutputTokens = value.reasoning_output_tokens;
  if (typeof value.total_cost_usd === 'number' && Number.isFinite(value.total_cost_usd) && value.total_cost_usd >= 0) {
    result.totalCostUsd = value.total_cost_usd;
  }
  return result;
}

function responsesUsage(value) {
  if (!object(value)) return null;
  const input = counter(value.input_tokens);
  const output = counter(value.output_tokens);
  const cached = optionalCounter(value.cached_input_tokens
    ?? value.cache_read_input_tokens
    ?? value.input_tokens_details?.cached_tokens);
  const cacheWrite = optionalCounter(value.cache_write_input_tokens);
  const reasoning = optionalCounter(value.reasoning_output_tokens
    ?? value.output_tokens_details?.reasoning_tokens);
  if ([input, output, cached, cacheWrite, reasoning].some((item) => item === null)
    || reasoning > output) return null;
  const totalTokens = value.total_tokens === undefined ? add(input, output) : counter(value.total_tokens);
  if (totalTokens === null || totalTokens !== input + output) return null;
  const result = {
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    cacheReadInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    totalTokens,
  };
  if (typeof value.total_cost_usd === 'number' && Number.isFinite(value.total_cost_usd) && value.total_cost_usd >= 0) {
    result.totalCostUsd = value.total_cost_usd;
  }
  return result;
}

export function normalizeProviderUsage(provider, usage) {
  if (usage === undefined || usage === null) return null;
  if (provider === 'anthropic') return anthropicUsage(usage);
  if (provider === 'openai-responses') return responsesUsage(usage);
  return null;
}

export function defaultContextCapturePath(env = process.env) {
  const configured = env.SANDO_CONTEXT_FOOTPRINT_PATH;
  if (configured !== undefined) {
    if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw new Error('context capture path must be absolute');
    return configured;
  }
  const stateHome = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  if (!path.isAbsolute(stateHome)) throw new Error('state directory must be absolute');
  return path.join(stateHome, 'sando', 'context-footprints.jsonl');
}

export function buildContextCaptureRecord({
  host, provider, rawBody, requestBody, sessionKey, model, providerUsage, now = new Date(), toolSearch,
} = {}) {
  const format = PROVIDER_FORMATS[provider];
  if (!format || host !== format.host) throw new TypeError('provider and capture host do not match');
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) return null;
  const content = rawText(rawBody);
  let body = requestBody;
  if (body === undefined) {
    try { body = JSON.parse(content); } catch { body = null; }
  }
  const classification = classifyContextRequest({ provider, body });
  const report = buildContextFootprintReport({
    schema: CONTEXT_CAPTURE_SCHEMA,
    host,
    requestFormat: format.requestFormat,
    body: { state: 'observed', content },
    segments: classification.segments,
    providerUsage: normalizeProviderUsage(provider, providerUsage),
    toolSearch: toolSearch ?? { state: 'indeterminate' },
  });
  return {
    schema: CONTEXT_CAPTURE_RECORD_SCHEMA,
    version: CONTEXT_CAPTURE_RECORD_VERSION,
    at: isoDate(now),
    host,
    provider,
    requestFormat: format.requestFormat,
    model: safeModel(model),
    sessionKeyDigest: sha256(sessionKey),
    report,
  };
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('context capture directory is unsafe');
  fs.chmodSync(directory, 0o700);
}

function validateRecord(record) {
  if (!object(record)
    || record.schema !== CONTEXT_CAPTURE_RECORD_SCHEMA
    || record.version !== CONTEXT_CAPTURE_RECORD_VERSION
    || typeof record.at !== 'string'
    || typeof record.host !== 'string'
    || typeof record.provider !== 'string'
    || typeof record.requestFormat !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(record.sessionKeyDigest)
    || !object(record.report)
    || record.report.schema !== 'sando-context-footprint/v1') {
    throw new TypeError('context capture record is invalid');
  }
  serializeContextFootprint(record.report);
}

export function recordContextCapture({ storagePath, record } = {}) {
  if (typeof storagePath !== 'string' || !path.isAbsolute(storagePath)) throw new Error('context capture path must be absolute');
  validateRecord(record);
  ensureDirectory(path.dirname(storagePath));
  if (fs.existsSync(storagePath)) {
    const stat = fs.lstatSync(storagePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('context capture file is unsafe');
  }
  fs.appendFileSync(storagePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.chmodSync(storagePath, 0o600);
  return record;
}
