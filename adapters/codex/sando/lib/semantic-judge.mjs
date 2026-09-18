import { createHash } from 'node:crypto';

import { estimateTokens } from './core.mjs';
import { redact } from './secret-redaction.mjs';

export const SEMANTIC_JUDGMENT_SCHEMA = 'sando-semantic-judgment/v1';
const QUESTION_ID = 'preview_loses_diagnostic_evidence';

const DEFAULT_POLICY = Object.freeze({
  minInputTokens: 8000,
  maxTextChars: 6000,
  timeoutMs: 1500,
  maxRequests: 20,
  lossThreshold: 0.7,
});

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function validatePolicy(policy) {
  const result = { ...DEFAULT_POLICY, ...(policy ?? {}) };
  if (!Number.isInteger(result.minInputTokens) || result.minInputTokens < 1
    || !Number.isInteger(result.maxTextChars) || result.maxTextChars < 64
    || !Number.isInteger(result.timeoutMs) || result.timeoutMs < 1
    || !Number.isInteger(result.maxRequests) || result.maxRequests < 1
    || !Number.isFinite(result.lossThreshold) || result.lossThreshold < 0 || result.lossThreshold > 1) {
    throw new TypeError('invalid semantic judge policy');
  }
  return result;
}

function boundedText(text, maxChars) {
  if (text.length <= maxChars) return { text, sampled: false };
  const marker = '\n[sando semantic judge middle elided]\n';
  if (maxChars <= marker.length) return { text: text.slice(0, maxChars), sampled: true };
  const available = maxChars - marker.length;
  const headChars = Math.ceil(available / 2);
  return {
    text: `${text.slice(0, headChars)}${marker}${text.slice(-available + headChars)}`,
    sampled: true,
  };
}

function redactedBounded(text, maxChars, redactionProfile) {
  const safe = redactionProfile ? redactionProfile.redact(text) : redact(text);
  const bounded = boundedText(safe.text, maxChars);
  return { ...bounded, count: safe.count };
}

function prepareSemanticJudgeRequest(options) {
  const {
    originalText, previewText, maxTextChars = DEFAULT_POLICY.maxTextChars, redactionProfile,
  } = options;
  requireText(originalText, 'originalText');
  requireText(previewText, 'previewText');
  if (!Number.isInteger(maxTextChars) || maxTextChars < 64) throw new TypeError('maxTextChars is invalid');
  if (typeof options.recoverable !== 'boolean') throw new TypeError('recoverable must be a boolean');

  const original = redactedBounded(originalText, maxTextChars, redactionProfile);
  const preview = redactedBounded(previewText, maxTextChars, redactionProfile);
  return {
    request: {
      state: {
        provider: typeof options.provider === 'string' ? options.provider : 'unknown',
        model: typeof options.model === 'string' ? options.model : 'unknown',
        tool: typeof options.toolName === 'string' ? options.toolName : 'unknown',
        original: original.text,
        preview: preview.text,
        originalSampled: original.sampled,
        previewSampled: preview.sampled,
        recoverable: options.recoverable,
      },
      questions: {
        [QUESTION_ID]: {
          type: 'noul',
          instructions: 'Does `preview` omit diagnostic information from `original` that a coding agent would need to diagnose the result? If `recoverable` is true, treat intentionally omitted information as available through the Sando recovery artifact.',
          criteria: 'Answer yes only for task-relevant diagnostic evidence that is absent from the preview and not recoverable; answer no when the preview preserves the evidence or the omission is recoverable.',
        },
      },
    },
    redactions: original.count + preview.count,
  };
}

function requireText(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
}

export function buildSemanticJudgeRequest({
  provider, model, toolName, originalText, previewText, recoverable = false,
  maxTextChars = DEFAULT_POLICY.maxTextChars, redactionProfile,
} = {}) {
  return prepareSemanticJudgeRequest({
    provider, model, toolName, originalText, previewText, recoverable, maxTextChars, redactionProfile,
  }).request;
}

function cacheKey(candidate, request) {
  return sha256(JSON.stringify({
    schema: SEMANTIC_JUDGMENT_SCHEMA,
    id: candidate.id ?? null,
    provider: candidate.provider ?? null,
    model: candidate.model ?? null,
    toolName: candidate.toolName ?? null,
    recoverable: candidate.recoverable === true,
    state: request.state,
  }));
}

function probability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function usageSummary(value) {
  if (!object(value)) return null;
  const result = {};
  const fields = {
    inputTokens: ['inputTokens', 'input_tokens'],
    outputTokens: ['outputTokens', 'output_tokens'],
  };
  for (const [target, keys] of Object.entries(fields)) {
    const tokenValue = keys.map((key) => value[key]).find(
      (item) => Number.isSafeInteger(item) && item >= 0,
    );
    if (tokenValue !== undefined) result[target] = tokenValue;
  }
  return Object.keys(result).length ? result : null;
}

function resultBase(candidate, inputTokens, previewTokens) {
  return {
    schema: SEMANTIC_JUDGMENT_SCHEMA,
    mode: 'shadow',
    status: 'fallback',
    id: typeof candidate.id === 'string' ? candidate.id : null,
    inputTokens,
    previewTokens,
    omittedTokens: Math.max(0, inputTokens - previewTokens),
    lossProbability: null,
    cacheHit: false,
  };
}

function validCandidate(candidate) {
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate);
}

async function evaluateWithTimeout(evaluate, request, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('semantic judge timeout');
      error.code = 'SEMANTIC_JUDGE_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  const operation = Promise.resolve().then(() => evaluate(request, { signal: controller.signal }));
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function cachedResult(value, lossThreshold) {
  const lossProbability = probability(value?.lossProbability);
  if (lossProbability === null) return null;
  const result = {
    status: 'judged',
    lossProbability,
    verdict: lossProbability >= lossThreshold ? 'loss' : 'preserved',
    cacheHit: true,
  };
  if (Number.isSafeInteger(value?.latencyMs) && value.latencyMs >= 0) result.latencyMs = value.latencyMs;
  if (Number.isSafeInteger(value?.redactions) && value.redactions >= 0) result.redactions = value.redactions;
  const usage = usageSummary(value?.usage);
  if (usage) result.usage = usage;
  return result;
}

export function createSemanticJudge({ evaluate, cache = new Map(), policy, redactionProfile } = {}) {
  if (typeof evaluate !== 'function') throw new TypeError('semantic judge evaluate callback is required');
  if (!cache || typeof cache.get !== 'function' || typeof cache.set !== 'function') {
    throw new TypeError('semantic judge cache must implement get and set');
  }
  if (redactionProfile && typeof redactionProfile.redact !== 'function') {
    throw new TypeError('redactionProfile is invalid');
  }
  const options = validatePolicy(policy);
  const pending = new Map();
  let requests = 0;

  return async function judge(candidate = {}) {
    if (!validCandidate(candidate)) throw new TypeError('semantic judge candidate must be an object');
    requireText(candidate.originalText, 'originalText');
    requireText(candidate.previewText, 'previewText');
    const inputTokens = estimateTokens(candidate.originalText);
    const previewTokens = estimateTokens(candidate.previewText);
    const base = resultBase(candidate, inputTokens, previewTokens);
    if (candidate.historical === false) return { ...base, status: 'skipped', reason: 'current-result' };
    if (candidate.isError === true) return { ...base, status: 'skipped', reason: 'error-result' };
    if (inputTokens < options.minInputTokens) return { ...base, status: 'skipped', reason: 'below-threshold' };

    const prepared = prepareSemanticJudgeRequest({
      provider: candidate.provider,
      model: candidate.model,
      toolName: candidate.toolName,
      originalText: candidate.originalText,
      previewText: candidate.previewText,
      recoverable: candidate.recoverable === true,
      maxTextChars: options.maxTextChars,
      redactionProfile,
    });
    const request = prepared.request;
    const key = cacheKey(candidate, request);
    let cached;
    try { cached = cachedResult(cache.get(key), options.lossThreshold); } catch { cached = null; }
    if (cached) return { ...base, ...cached };
    if (pending.has(key)) return { ...base, ...(await pending.get(key)), cacheHit: true };
    if (requests >= options.maxRequests) return { ...base, reason: 'budget' };

    requests += 1;
    const started = Date.now();
    const operation = (async () => {
      let raw;
      try {
        raw = await evaluateWithTimeout(evaluate, request, options.timeoutMs);
      } catch (error) {
        return { ...base, reason: error?.code === 'SEMANTIC_JUDGE_TIMEOUT' ? 'timeout' : 'judge-error', latencyMs: Date.now() - started };
      }
      const lossProbability = probability(raw?.answers?.[QUESTION_ID]?.noul);
      if (lossProbability === null) {
        return { ...base, reason: 'invalid-response', latencyMs: Date.now() - started };
      }
      const judged = {
        status: 'judged',
        lossProbability,
        verdict: lossProbability >= options.lossThreshold ? 'loss' : 'preserved',
        cacheHit: false,
        latencyMs: Number.isSafeInteger(raw?.elapsedMs) ? raw.elapsedMs : Date.now() - started,
        usage: usageSummary(raw?.usage),
        redactions: prepared.redactions,
      };
      try { cache.set(key, judged); } catch { /* cache is best-effort */ }
      return { ...base, ...judged };
    })();
    pending.set(key, operation);
    try {
      return await operation;
    } finally {
      pending.delete(key);
    }
  };
}
