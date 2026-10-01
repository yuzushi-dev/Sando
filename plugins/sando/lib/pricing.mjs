import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeResponsesUsage } from './responses-usage.mjs';

export const SOL_STANDARD_PROFILE_ID = 'openai-gpt-6.1-sol-standard-2026-09-30';
export const LUNA_STANDARD_PROFILE_ID = 'openai-gpt-6-luna-standard-2026-10-01';
export const API_USAGE_REQUEST_SCHEMA = 'sando-api-usage-request/v1';
const PROFILE_SPECS = Object.freeze({
  [SOL_STANDARD_PROFILE_ID]: Object.freeze({
    model: 'gpt-6.1-sol',
    hash: 'sha256:e46e5baff1cbe761e007b334792f9cdb4787a63fe69c74ca4f0dcd39b745de8c',
  }),
  [LUNA_STANDARD_PROFILE_ID]: Object.freeze({
    model: 'gpt-6-luna',
    hash: 'sha256:e972bd46faca8ef11d0ba1d3fa3736831492fee66d902725b4480e89ee6eb489',
  }),
});
const NANO_USD = 1_000_000_000;
const COUNTERS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const SOURCE_FIELDS = {
  inputTokens: ['input_tokens'], outputTokens: ['output_tokens'],
  cachedInputTokens: ['input_tokens_details.cached_tokens'],
  cacheWriteInputTokens: ['input_tokens_details.cache_write_tokens'],
  reasoningOutputTokens: ['output_tokens_details.reasoning_tokens'],
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const validDigest = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const money = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const boundedText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

function reportedCost(request) {
  const empty = (status) => ({ providerReportedCostUsd: null, providerReportedCostNanoUsd: null, providerReportedCostStatus: status });
  if (request?.schema !== API_USAGE_REQUEST_SCHEMA || request.provenance !== 'provider-response') return empty('unavailable');
  const value = request.providerReportedCostUsd;
  if (value === undefined) return empty('unavailable');
  if (!money(value) || value > Number.MAX_SAFE_INTEGER) return empty('invalid');
  const decimal = value.toFixed(9);
  if (Number(decimal) !== value) return empty('invalid');
  return { providerReportedCostUsd: value,
    providerReportedCostNanoUsd: BigInt(decimal.replace('.', '')).toString(), providerReportedCostStatus: 'reported' };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function validatePricingProfile(profile) {
  const specification = object(profile) ? PROFILE_SPECS[profile.id] : null;
  if (!object(profile) || profile.schema !== 'sando-pricing-profile/v1'
    || !specification || profile.model !== specification.model
    || profile.provider !== 'openai-responses' || profile.service !== 'standard'
    || profile.regional_surcharge !== false || profile.currency !== 'USD'
    || profile.unit_tokens !== 1_000_000 || profile.long_context_input_threshold !== 272_000
    || profile.long_context_operator !== '>' || !/^\d{4}-\d{2}-\d{2}$/.test(profile.verified_on)
    || !Array.isArray(profile.sources) || !profile.sources.length
    || profile.sources.some((source) => typeof source !== 'string'
      || !source.startsWith('https://developers.openai.com/'))) throw new TypeError('invalid pricing profile');
  for (const tier of ['short', 'long']) {
    for (const field of ['fresh', 'cache_read', 'cache_write', 'output']) {
      const rate = profile[tier]?.[field];
      // Rates have at most three decimal places per million: exact integer nanodollars per token.
      if (!money(rate) || !Number.isSafeInteger(rate * 1000)) throw new TypeError('invalid pricing rate');
    }
  }
  if (digest(canonicalJson(profile)) !== specification.hash) throw new TypeError('pricing profile content does not match its immutable version');
  return profile;
}

export function loadPricingProfile(id) {
  if (!Object.hasOwn(PROFILE_SPECS, id)) throw new TypeError('unsupported pricing profile');
  return validatePricingProfile(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'pricing', `${id}.json`), 'utf8')));
}

// Caller supplies regional billing context. Missing context is never standard by default.
// Only the completed response's actual tier and model are used; request preferences are insufficient.
export function buildApiUsageRequest({ response, regionalSurcharge, provenance = 'provider-response', sessionId, arm } = {}) {
  const normalized = normalizeResponsesUsage(response?.usage);
  return {
    schema: API_USAGE_REQUEST_SCHEMA,
    requestKey: boundedText(response?.id) ? digest(response.id) : null,
    sessionKeyDigest: boundedText(sessionId) ? digest(sessionId) : null,
    scope: response?.object === 'response' && response?.status === 'completed' ? 'request' : 'unknown',
    provenance: ['provider-response', 'synthetic'].includes(provenance) ? provenance : null,
    provider: 'openai-responses',
    model: boundedText(response?.model) ? response.model : null,
    service: response?.service_tier === 'default' ? 'standard' : boundedText(response?.service_tier) ? response.service_tier : null,
    regionalSurcharge: typeof regionalSurcharge === 'boolean' ? regionalSurcharge : null,
    usage: normalized.usage,
    usageQuality: { ...normalized.quality, scope: 'request' },
    ...(provenance === 'provider-response' && money(normalized.usage?.totalCostUsd)
      ? { providerReportedCostUsd: normalized.usage.totalCostUsd } : {}),
    ...(['apply', 'control'].includes(arm) ? { arm } : {}),
  };
}

function checkedUsage(request) {
  const usage = request.usage;
  const quality = request.usageQuality;
  if (!object(quality) || quality.schema !== 'sando-usage-quality/v1' || quality.scope !== 'request'
    || quality.status !== 'complete' || !Array.isArray(quality.missing) || quality.missing.length
    || !Array.isArray(quality.errors) || quality.errors.length || !object(quality.sources)
    || Object.entries(SOURCE_FIELDS).some(([field, paths]) => !paths.includes(quality.sources[field]))) return null;
  if (!object(usage) || COUNTERS.some((field) => !Number.isSafeInteger(usage[field]) || usage[field] < 0)) return null;
  const result = normalizeResponsesUsage({ input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    input_tokens_details: { cached_tokens: usage.cachedInputTokens, cache_write_tokens: usage.cacheWriteInputTokens },
    output_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens } });
  if (usage.cacheReadInputTokens !== undefined && usage.cacheReadInputTokens !== usage.cachedInputTokens) return null;
  return result.quality.status === 'complete' ? result.usage : null;
}

function unpriced(request, reason) {
  return { requestKey: validDigest(request?.requestKey) ? request.requestKey : null,
    status: 'unpriced', reason, estimatedApiCostUsd: null, estimatedApiCostNanoUsd: null,
    provenance: ['provider-response', 'synthetic'].includes(request?.provenance) ? request.provenance : null,
    ...reportedCost(request) };
}

export function estimateApiRequestCost(request, profile) {
  validatePricingProfile(profile);
  const profileHash = PROFILE_SPECS[profile.id].hash;
  if (!object(request) || request.schema !== API_USAGE_REQUEST_SCHEMA) return unpriced(request, 'unsupported-record-schema');
  if (!validDigest(request.requestKey)) return unpriced(request, 'missing-request-identity');
  if (request.scope !== 'request' || !['provider-response', 'synthetic'].includes(request.provenance)) {
    return unpriced(request, 'unverified-request-scope');
  }
  if (request.provider !== profile.provider || request.model !== profile.model || request.service !== profile.service
    || request.regionalSurcharge !== profile.regional_surcharge) return unpriced(request, 'unsupported-billing-context');
  const usage = checkedUsage(request);
  if (!usage) return unpriced(request, 'incomplete-or-invalid-counters');
  const contextTier = usage.inputTokens > profile.long_context_input_threshold ? 'long' : 'short';
  const rates = profile[contextTier];
  const charge = (tokens, rate) => BigInt(tokens) * BigInt(rate * 1000);
  const components = {
    fresh: charge(usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens, rates.fresh),
    cacheRead: charge(usage.cachedInputTokens, rates.cache_read),
    cacheWrite: charge(usage.cacheWriteInputTokens, rates.cache_write),
    output: charge(usage.outputTokens, rates.output),
  };
  const total = Object.values(components).reduce((sum, value) => sum + value, 0n);
  return {
    requestKey: request.requestKey, status: 'priced', profileId: profile.id,
    profileHash, currency: profile.currency, verifiedOn: profile.verified_on,
    contextTier, provenance: request.provenance, completeness: 'complete',
    estimatedApiCostUsd: Number(total) / NANO_USD, estimatedApiCostNanoUsd: total.toString(),
    componentsUsd: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Number(value) / NANO_USD])),
    ...reportedCost(request),
  };
}

function requestSignature(request) {
  if (!object(request)) return JSON.stringify([typeof request]);
  const quality = request.usageQuality;
  const usage = request.usage;
  return JSON.stringify([request.schema, request.provider, request.model, request.service, request.regionalSurcharge,
    request.scope, request.provenance, COUNTERS.map((field) => usage?.[field]), usage?.cacheReadInputTokens,
    quality?.schema, quality?.status, quality?.scope,
    Object.keys(SOURCE_FIELDS).map((field) => quality?.sources?.[field]),
    Array.isArray(quality?.missing) ? [...quality.missing].sort() : quality?.missing,
    Array.isArray(quality?.errors) ? quality.errors.map((error) => [error?.code, error?.field]).sort() : quality?.errors,
    request.providerReportedCostUsd]);
}

export function aggregateApiRequestCosts(requests, profile, { sessionId, arm } = {}) {
  validatePricingProfile(profile);
  const profileHash = PROFILE_SPECS[profile.id].hash;
  if (!Array.isArray(requests)) throw new TypeError('API usage requests must be an array');
  const selected = requests.filter((request) => (sessionId === undefined || request?.sessionKeyDigest === digest(sessionId))
    && (arm === undefined || request?.arm === arm));
  const unique = new Map();
  const conflicts = new Set();
  let duplicateRequestCount = 0;
  selected.forEach((request, index) => {
    const key = validDigest(request?.requestKey) ? request.requestKey : `missing:${index}`;
    const previous = unique.get(key);
    if (unique.has(key)) {
      if (requestSignature(previous) !== requestSignature(request)) conflicts.add(key);
      else duplicateRequestCount += 1;
    } else unique.set(key, request);
  });
  const results = [];
  const tokenTotals = Object.fromEntries(COUNTERS.map((field) => [field, 0]));
  let total = 0n;
  let providerSubtotal = 0n;
  let reportedCount = 0;
  for (const [key, request] of unique) {
    const cost = conflicts.has(key) ? unpriced(request, 'conflicting-request-revisions') : estimateApiRequestCost(request, profile);
    results.push(cost);
    if (cost.status === 'priced') {
      for (const field of COUNTERS) {
        tokenTotals[field] += request.usage[field];
        if (!Number.isSafeInteger(tokenTotals[field])) throw new RangeError('API usage aggregate overflow');
      }
      total += BigInt(cost.estimatedApiCostNanoUsd);
    }
    if (cost.providerReportedCostUsd !== null && !conflicts.has(key)) {
      providerSubtotal += BigInt(cost.providerReportedCostNanoUsd);
      reportedCount += 1;
    }
  }
  const pricedRequestCount = results.filter((result) => result.status === 'priced').length;
  const unpricedRequestCount = results.length - pricedRequestCount;
  const complete = results.length > 0 && unpricedRequestCount === 0;
  return {
    schema: 'sando-api-cost-report/v1', profileId: profile.id, profileHash,
    currency: 'USD', status: complete ? 'complete' : pricedRequestCount ? 'partial' : 'indeterminate',
    requestCount: results.length, pricedRequestCount, unpricedRequestCount, duplicateRequestCount,
    estimatedApiCostUsd: complete ? Number(total) / NANO_USD : null,
    estimatedApiCostNanoUsd: complete ? total.toString() : null,
    supportedEstimatedApiCostUsd: Number(total) / NANO_USD,
    supportedEstimatedApiCostNanoUsd: total.toString(),
    providerReportedCostUsd: results.length && reportedCount === results.length ? Number(providerSubtotal) / NANO_USD : null,
    providerReportedCostNanoUsd: results.length && reportedCount === results.length ? providerSubtotal.toString() : null,
    providerReportedCostSubtotalUsd: Number(providerSubtotal) / NANO_USD,
    providerReportedCostSubtotalNanoUsd: providerSubtotal.toString(),
    tokenTotals, requests: results,
    limitation: 'API list-price estimate; Codex subscription usage is not an API invoice.',
  };
}
