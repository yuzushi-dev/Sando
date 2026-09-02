import { createHash } from 'node:crypto';

import { createRedactionProfile } from './redaction-profile.mjs';

export const CONTEXT_CAPTURE_SCHEMA = 'sando-context-capture/v1';
export const CONTEXT_FOOTPRINT_SCHEMA = 'sando-context-footprint/v1';
export const CONTEXT_FOOTPRINT_VERSION = 1;

export const CONTEXT_CATEGORIES = Object.freeze([
  'host-instructions',
  'project-instructions',
  'skills',
  'builtin-tools',
  'mcp-direct',
  'mcp-deferred',
  'sando',
  'user-prompt',
  'history',
  'provider-overhead',
  'unknown',
]);

const HOSTS = new Set(['claude', 'codex']);
const BODY_STATES = new Set(['observed', 'partial', 'unavailable']);
const TOOL_SEARCH_STATES = new Set(['enabled', 'disabled', 'unavailable', 'indeterminate']);
const FORMATS = Object.freeze({
  claude: new Set(['anthropic']),
  codex: new Set(['openai-responses', 'codex-cli']),
});
const PROVIDER_FIELDS = Object.freeze([
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'cacheReadInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'totalTokens',
  'totalCostUsd',
]);
const DEFAULT_PROFILE = createRedactionProfile();

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function counter(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function add(left, right, name) {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new RangeError(`${name} exceeds safe integer range`);
  return total;
}

function digest(value) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError('digest is invalid');
  return value;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined) throw new TypeError('value is not JSON serializable');
    return result;
  }
  if (seen.has(value)) throw new TypeError('value must not be cyclic');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableJson(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

function estimateBytes(bytes) {
  return bytes === 0 ? 0 : Math.ceil(bytes / 4);
}

function profileFor(candidate) {
  if (candidate === undefined) return DEFAULT_PROFILE;
  if (!object(candidate) || typeof candidate.redact !== 'function') throw new TypeError('redactionProfile is invalid');
  return candidate;
}

function redactedDigest(text, profile) {
  return sha256(profile.redact(text).text);
}

function contentEvidence(value, name, profile) {
  if (typeof value !== 'string') throw new TypeError(`${name}.content must be a string`);
  return { bytes: Buffer.byteLength(value, 'utf8'), digest: redactedDigest(value, profile) };
}

function bodyEvidence(body, profile) {
  if (!object(body)) throw new TypeError('body is invalid');
  const state = body.state ?? 'unavailable';
  if (!BODY_STATES.has(state)) throw new TypeError('body state is invalid');
  if (state === 'unavailable') return { state, bytes: null, digest: null };

  const content = Object.hasOwn(body, 'content') ? contentEvidence(body.content, 'body', profile) : null;
  const bytes = content ? content.bytes : counter(body.bytes, 'body.bytes');
  if (Object.hasOwn(body, 'bytes') && counter(body.bytes, 'body.bytes') !== bytes) {
    throw new TypeError('body bytes contradict content');
  }
  const bodyDigest = content ? content.digest : (body.digest === undefined ? null : digest(body.digest));
  if (content && body.digest !== undefined && digest(body.digest) !== bodyDigest) {
    throw new TypeError('body digest contradicts content');
  }
  return { state, bytes, digest: bodyDigest };
}

function categoryOf(value) {
  if (typeof value !== 'string' || !CONTEXT_CATEGORIES.includes(value)) throw new TypeError('segment category is invalid');
  return value;
}

function normalizeSegments(segments, profile) {
  if (segments === undefined) return [];
  if (!Array.isArray(segments) || segments.length > 10_000) throw new TypeError('segments are invalid');
  return segments.map((segment) => {
    if (!object(segment)) throw new TypeError('segment is invalid');
    const category = categoryOf(segment.category);
    const content = Object.hasOwn(segment, 'content') ? contentEvidence(segment.content, 'segment', profile) : null;
    const bytes = content ? content.bytes : counter(segment.bytes, 'segment.bytes');
    if (Object.hasOwn(segment, 'bytes') && counter(segment.bytes, 'segment.bytes') !== bytes) {
      throw new TypeError('segment bytes contradict content');
    }
    return { category, bytes, digest: content?.digest ?? null };
  });
}

function validateSegmentMembership(body, segments) {
  if (typeof body?.content !== 'string' || !Array.isArray(segments)) return;
  let cursor = 0;
  for (const segment of segments) {
    if (!object(segment) || typeof segment.content !== 'string') continue;
    const position = body.content.indexOf(segment.content, cursor);
    if (position < 0) throw new TypeError('segment content is not a non-overlapping part of the observed body');
    cursor = position + segment.content.length;
  }
}

function providerUsage(value) {
  if (value === undefined || value === null) return null;
  if (!object(value)) throw new TypeError('providerUsage is invalid');
  const result = { source: 'provider-reported' };
  for (const field of PROVIDER_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    if (field === 'totalCostUsd') {
      if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0) {
        throw new TypeError('provider cost is invalid');
      }
      result[field] = value[field];
    } else result[field] = counter(value[field], `providerUsage.${field}`);
  }
  if (!Object.hasOwn(result, 'inputTokens')) throw new TypeError('providerUsage.inputTokens is required');
  if (Object.hasOwn(result, 'cachedInputTokens') && Object.hasOwn(result, 'cacheReadInputTokens')
    && result.cachedInputTokens !== result.cacheReadInputTokens) {
    throw new TypeError('provider cache-read counters contradict each other');
  }
  const cacheRead = result.cacheReadInputTokens ?? result.cachedInputTokens;
  if ([cacheRead, result.cacheWriteInputTokens].some((value) => value !== undefined && value > result.inputTokens)
    || (cacheRead !== undefined && result.cacheWriteInputTokens !== undefined
      && add(cacheRead, result.cacheWriteInputTokens, 'provider cache counters') > result.inputTokens)) {
    throw new TypeError('provider cache counters exceed input tokens');
  }
  if (Object.hasOwn(result, 'reasoningOutputTokens') && Object.hasOwn(result, 'outputTokens')
    && result.reasoningOutputTokens > result.outputTokens) {
    throw new TypeError('provider reasoning tokens exceed output tokens');
  }
  if (Object.hasOwn(result, 'outputTokens') && Object.hasOwn(result, 'totalTokens')
    && add(result.inputTokens, result.outputTokens, 'provider token counters') !== result.totalTokens) {
    throw new TypeError('provider total tokens are invalid');
  }
  return result;
}

export function detectToolSearchState(value) {
  if (!object(value)) return 'indeterminate';
  if (TOOL_SEARCH_STATES.has(value.state)) return value.state;
  if (typeof value.enabled === 'boolean') return value.enabled ? 'enabled' : 'disabled';
  if (value.available === false) return 'unavailable';
  return 'indeterminate';
}

function emptyCategories() {
  return Object.fromEntries(CONTEXT_CATEGORIES.map((category) => [category, {
    bytes: 0, estimatedTokens: 0, segmentCount: 0,
  }]));
}

function categorySummary(segments) {
  const categories = emptyCategories();
  for (const segment of segments) {
    const current = categories[segment.category];
    current.bytes = add(current.bytes, segment.bytes, 'category bytes');
    current.estimatedTokens = estimateBytes(current.bytes);
    current.segmentCount += 1;
  }
  return categories;
}

function safeReport(report) {
  const result = { ...report };
  delete result.provenanceDigest;
  return result;
}

export function serializeContextFootprint(report) {
  if (!object(report) || report.schema !== CONTEXT_FOOTPRINT_SCHEMA) throw new TypeError('context footprint report is invalid');
  return stableJson(report);
}

export function buildContextFootprintReport(capture, { redactionProfile } = {}) {
  if (!object(capture) || capture.schema !== CONTEXT_CAPTURE_SCHEMA) throw new TypeError('context capture schema is invalid');
  if (!HOSTS.has(capture.host)) throw new TypeError('context capture host is invalid');
  const profile = profileFor(redactionProfile);
  validateSegmentMembership(capture.body, capture.segments);
  const body = bodyEvidence(capture.body ?? { state: 'unavailable' }, profile);
  const requestFormat = capture.requestFormat ?? null;
  if (requestFormat !== null && (typeof requestFormat !== 'string' || !FORMATS[capture.host].has(requestFormat))) {
    throw new TypeError('context capture request format is invalid');
  }
  if (requestFormat === null && body.state !== 'unavailable') {
    throw new TypeError('context capture request format is required for an observed body');
  }
  const segments = normalizeSegments(capture.segments, profile);
  const providerReported = providerUsage(capture.providerUsage);
  const toolSearch = { state: detectToolSearchState(capture.toolSearch) };
  const base = {
    schema: CONTEXT_FOOTPRINT_SCHEMA,
    version: CONTEXT_FOOTPRINT_VERSION,
    host: capture.host,
    requestFormat,
    toolSearch,
    observation: { status: body.state, bodyDigest: body.digest },
    attribution: null,
    categories: null,
    tokenAccounting: {
      estimated: {
        source: 'mechanical-estimate',
        formula: 'ceil(UTF-8 bytes / 4)',
        totalTokens: null,
        attributedTokens: null,
        unknownTokens: null,
        categories: null,
      },
      providerReported,
    },
  };

  if (body.state !== 'unavailable') {
    const categories = categorySummary(segments);
    const observedBytes = segments.reduce((total, segment) => add(total, segment.bytes, 'observed bytes'), 0);
    if (observedBytes > body.bytes) throw new RangeError('segments exceed body bytes');
    const unclassifiedBytes = body.bytes - observedBytes;
    categories.unknown.bytes = add(categories.unknown.bytes, unclassifiedBytes, 'unknown bytes');
    categories.unknown.estimatedTokens = estimateBytes(categories.unknown.bytes);
    const unknownBytes = categories.unknown.bytes;
    const attributedBytes = body.bytes - unknownBytes;
    const categoryTokens = Object.fromEntries(
      CONTEXT_CATEGORIES.map((category) => [category, categories[category].estimatedTokens]),
    );
    base.attribution = {
      status: body.state === 'partial' || unknownBytes > 0 ? 'partial' : 'complete',
      bodyBytes: body.bytes,
      observedBytes,
      attributedBytes,
      unknownBytes,
      unknownRatio: body.bytes === 0 ? 0 : unknownBytes / body.bytes,
    };
    base.categories = categories;
    base.tokenAccounting.estimated = {
      ...base.tokenAccounting.estimated,
      totalTokens: estimateBytes(body.bytes),
      attributedTokens: estimateBytes(attributedBytes),
      unknownTokens: estimateBytes(unknownBytes),
      categories: categoryTokens,
    };
  } else {
    base.attribution = {
      status: 'unavailable',
      bodyBytes: null,
      observedBytes: null,
      attributedBytes: null,
      unknownBytes: null,
      unknownRatio: null,
    };
  }

  base.provenanceDigest = sha256(serializeContextFootprint(safeReport(base)));
  return base;
}
