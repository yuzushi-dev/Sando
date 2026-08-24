import { createHash } from 'node:crypto';

import { estimateTokens } from './core.mjs';

export const SEMANTIC_SUMMARY_SCHEMA = 'sando-semantic-summary/v1';

const DEFAULT_POLICY = Object.freeze({
  minInputTokens: 8000,
  maxSummaryRatio: 0.2,
  timeoutMs: 1500,
});

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function facts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((fact) => typeof fact !== 'string' || fact.length === 0)) {
    throw new TypeError('requiredFacts must be non-empty strings');
  }
  return [...new Set(value)];
}

function redact(text) {
  let count = 0;
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      count += 1;
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    });
  };
  replace(/-----BEGIN [A-Z ]+ KEY-----[\s\S]*?-----END [A-Z ]+ KEY-----/g, '[REDACTED PRIVATE KEY]');
  replace(/\b(?:sk|rk|gh[pousr])-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED TOKEN]');
  replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED TOKEN]');
  replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,"'}]+/gi, (_match, prefix) => `${prefix}[REDACTED]`);
  replace(/(["']?(?:api[_-]?key|access[_-]?token|password|secret|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, (_match, prefix) => `${prefix}[REDACTED]`);
  return { text, count };
}

function hasSecret(text) {
  return /(?:authorization|api[_-]?key|access[_-]?token|password|secret|private[_-]?key)\s*[:=]\s*(?!\[REDACTED\])\S+|-----BEGIN [A-Z ]+ KEY-----|\b(?:sk|gh[pousr])-[A-Za-z0-9_-]{12,}/i.test(text);
}

function parseResponse(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function usageCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validatePolicy(policy) {
  const result = { ...DEFAULT_POLICY, ...(policy ?? {}) };
  if (!Number.isInteger(result.minInputTokens) || result.minInputTokens < 1
    || !Number.isFinite(result.maxSummaryRatio) || result.maxSummaryRatio <= 0 || result.maxSummaryRatio >= 1
    || !Number.isInteger(result.timeoutMs) || result.timeoutMs < 1) {
    throw new TypeError('invalid semantic compactor policy');
  }
  return result;
}

export function buildSemanticPrompt({ provider, model, toolName, text, requiredFacts = [] } = {}) {
  const required = facts(requiredFacts);
  return [
    `Schema: ${SEMANTIC_SUMMARY_SCHEMA}`,
    'Summarize the historical tool result for a coding agent.',
    'Keep exact paths, identifiers, errors, numbers, negations, and every required fact.',
    'Preserved facts must be copied verbatim from the tool result or required-facts list; do not invent or estimate counts.',
    'Return JSON only with schema, summary, and preservedFacts fields.',
    `Provider: ${provider ?? 'unknown'}`,
    `Model: ${model ?? 'unknown'}`,
    `Tool: ${toolName ?? 'unknown'}`,
    `Required facts: ${required.length ? required.join(', ') : '(none)'}`,
    `<tool_result>\n${text}\n</tool_result>`,
  ].join('\n');
}

export function validateSemanticSummary({ originalText, summary, requiredFacts = [], maxSummaryRatio = DEFAULT_POLICY.maxSummaryRatio } = {}) {
  if (typeof originalText !== 'string' || typeof summary !== 'string') {
    return { valid: false, reason: 'invalid-text' };
  }
  if (!Number.isFinite(maxSummaryRatio) || maxSummaryRatio <= 0 || maxSummaryRatio >= 1) {
    return { valid: false, reason: 'invalid-ratio' };
  }
  const required = facts(requiredFacts);
  const inputTokens = estimateTokens(originalText);
  const outputTokens = estimateTokens(summary);
  if (!summary.trim()) return { valid: false, reason: 'empty-summary', inputTokens, outputTokens };
  if (outputTokens >= inputTokens) return { valid: false, reason: 'not-smaller', inputTokens, outputTokens };
  if (outputTokens / Math.max(1, inputTokens) > maxSummaryRatio) {
    return { valid: false, reason: 'summary-too-large', inputTokens, outputTokens };
  }
  const missing = required.find((fact) => !summary.includes(fact));
  if (missing) return { valid: false, reason: 'missing-required-fact', missing, inputTokens, outputTokens };
  if (hasSecret(summary)) return { valid: false, reason: 'secret-detected', inputTokens, outputTokens };
  return { valid: true, inputTokens, outputTokens };
}

function cacheKey({ provider, model, toolName, text, requiredFacts }) {
  return sha256(JSON.stringify({
    schema: SEMANTIC_SUMMARY_SCHEMA,
    provider: provider ?? null,
    model: model ?? null,
    toolName: toolName ?? null,
    text,
    requiredFacts,
  }));
}

async function withTimeout(complete, request, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('semantic compactor timeout');
      error.code = 'SEMANTIC_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  const operation = Promise.resolve().then(() => complete({ ...request, signal: controller.signal }));
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createSemanticCompactor({ complete, cache = new Map(), policy } = {}) {
  if (typeof complete !== 'function') throw new TypeError('semantic compactor complete callback is required');
  if (!cache || typeof cache.get !== 'function' || typeof cache.set !== 'function') {
    throw new TypeError('semantic compactor cache must implement get and set');
  }
  const options = validatePolicy(policy);

  return async function compact({ provider, model, toolName, text, historical = true, isError = false, requiredFacts = [] } = {}) {
    if (typeof text !== 'string') throw new TypeError('semantic compactor text must be a string');
    const required = facts(requiredFacts);
    const inputTokens = estimateTokens(text);
    const base = {
      mode: 'shadow',
      status: 'fallback',
      fallbackText: text,
      inputTokens,
      outputTokens: inputTokens,
      grossSavedTokens: 0,
      netSavedTokens: 0,
      cacheHit: false,
    };
    if (!historical) return { ...base, status: 'skipped', reason: 'current-result' };
    if (isError) return { ...base, status: 'skipped', reason: 'error-result' };
    if (inputTokens < options.minInputTokens) return { ...base, status: 'skipped', reason: 'below-threshold' };

    const safe = redact(text);
    const safeFacts = required.map((fact) => redact(fact).text);
    const prompt = buildSemanticPrompt({ provider, model, toolName, text: safe.text, requiredFacts: safeFacts });
    const key = cacheKey({ provider, model, toolName, text: safe.text, requiredFacts: safeFacts });
    const started = Date.now();
    let cached;
    try { cached = cache.get(key); } catch { cached = undefined; }
    if (cached?.summary) {
      const validation = validateSemanticSummary({
        originalText: text, summary: cached.summary, requiredFacts: required,
        maxSummaryRatio: options.maxSummaryRatio,
      });
      if (validation.valid) {
        const grossSavedTokens = inputTokens - validation.outputTokens;
        return {
          ...base,
          status: 'candidate',
          summary: cached.summary,
          outputTokens: validation.outputTokens,
          grossSavedTokens,
          netSavedTokens: grossSavedTokens,
          cacheHit: true,
          providerUsage: null,
          latencyMs: Date.now() - started,
          redactions: safe.count,
        };
      }
      try { cache.delete?.(key); } catch { /* fail open */ }
    }

    let raw;
    try {
      raw = await withTimeout(complete, { provider, model, toolName, prompt, text: safe.text, requiredFacts: safeFacts }, options.timeoutMs);
    } catch (error) {
      return { ...base, reason: error?.code === 'SEMANTIC_TIMEOUT' ? 'timeout' : 'compactor-error', latencyMs: Date.now() - started };
    }
    const response = parseResponse(raw);
    if (response?.schema !== SEMANTIC_SUMMARY_SCHEMA || typeof response.summary !== 'string'
      || !Array.isArray(response.preservedFacts)
      || response.preservedFacts.some((fact) => typeof fact !== 'string')) {
      return { ...base, reason: 'invalid-response', latencyMs: Date.now() - started };
    }
    if (response.preservedFacts.some((fact) => !safe.text.includes(fact))) {
      return { ...base, reason: 'response-ungrounded-fact', latencyMs: Date.now() - started };
    }
    if (required.some((fact) => !response.preservedFacts.includes(fact))) {
      return { ...base, reason: 'response-missing-fact', latencyMs: Date.now() - started };
    }
    const summary = required.reduce(
      (value, fact) => value.includes(fact) ? value : `${value}\n${fact}`,
      response.summary,
    );
    const validation = validateSemanticSummary({
      originalText: text, summary, requiredFacts: required,
      maxSummaryRatio: options.maxSummaryRatio,
    });
    if (!validation.valid) return { ...base, reason: validation.reason, latencyMs: Date.now() - started };

    const usage = response.usage && typeof response.usage === 'object' ? response.usage : {};
    const compactorInputTokens = usageCounter(usage.inputTokens) ?? estimateTokens(prompt);
    const compactorOutputTokens = usageCounter(usage.outputTokens) ?? estimateTokens(JSON.stringify(response));
    const grossSavedTokens = inputTokens - validation.outputTokens;
    const netSavedTokens = grossSavedTokens - compactorInputTokens - compactorOutputTokens;
    try { cache.set(key, { summary }); } catch { /* fail open */ }
    return {
      ...base,
      status: 'candidate',
      summary,
      outputTokens: validation.outputTokens,
      grossSavedTokens,
      netSavedTokens,
      cacheHit: false,
      providerUsage: usage,
      compactorInputTokens,
      compactorOutputTokens,
      latencyMs: Date.now() - started,
      redactions: safe.count,
    };
  };
}
