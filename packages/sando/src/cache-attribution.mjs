/**
 * Why did the provider prompt cache miss on this turn?
 *
 * The provider ledger already records `cachedInputTokens` / `cacheWriteInputTokens`
 * per turn, but a raw hit rate cannot say *why* a miss happened, and on its own it
 * is the wrong instrument: a divergence behind the last cache breakpoint still costs
 * a re-prefill while the hit is scored against the prefix that did match. So this
 * module classifies each turn against the previous one and reports cache-write
 * volume alongside hit/miss.
 *
 * Deterministic: pure functions over recorded counters and request shapes. No
 * network, no LLM, no provider call.
 *
 * Anthropic invalidates hierarchically — `tools` -> `system` -> `messages` — and any
 * change at one level invalidates that level and everything after it, so the causes
 * below are ordered and the first match wins.
 */

const CAUSES = [
  'tools-changed',
  'system-changed',
  'history-rewritten',
  'below-minimum',
  'no-breakpoint',
  'cold-start',
  'ttl-expired',
  'unexplained',
];

export const CACHE_MISS_CAUSES = Object.freeze([...CAUSES]);

// Anthropic's smallest cacheable prompt across current models. Below this the
// request is processed uncached with no error, so a "miss" is expected, not a defect.
const DEFAULT_MIN_CACHEABLE_TOKENS = 1024;

// Longest cache lifetime Anthropic offers (1h). A gap wider than this guarantees the
// entry is gone regardless of anything the client did.
const DEFAULT_MAX_TTL_MS = 60 * 60 * 1000;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Stable digest of a JSON-serializable value. Order-sensitive by design: a reordered
 * tool array is a different byte prefix to the provider even if the set is equal. */
export function shapeDigest(value) {
  const json = JSON.stringify(value ?? null);
  let hash = 0;
  for (let index = 0; index < json.length; index += 1) {
    hash = ((hash << 5) - hash + json.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Per-message digests, so a rewritten historical message is visible as a prefix
 * divergence rather than only as a changed whole-history digest. */
export function messageDigests(messages) {
  return Array.isArray(messages) ? messages.map((message) => shapeDigest(message)) : [];
}

/** Index of the first message whose bytes differ from the previous turn's, or null
 * when the previous turn is a prefix of this one (i.e. this turn only appended). */
export function firstDivergence(previousDigests, currentDigests) {
  const bound = Math.min(previousDigests.length, currentDigests.length);
  for (let index = 0; index < bound; index += 1) {
    if (previousDigests[index] !== currentDigests[index]) return index;
  }
  return currentDigests.length < previousDigests.length ? bound : null;
}

/** Does this request carry any cache_control breakpoint at all? */
export function hasBreakpoint(body) {
  if (!object(body) && !Array.isArray(body)) return false;
  if (Array.isArray(body)) return body.some((item) => hasBreakpoint(item));
  for (const [key, value] of Object.entries(body)) {
    if (key === 'cache_control' && value !== undefined) return true;
    if (hasBreakpoint(value)) return true;
  }
  return false;
}

/**
 * Classify one turn.
 *
 * `current` / `previous` are `{ at, usage, tools, system, messages, body }`, where
 * `usage` is `{ cachedInputTokens, cacheWriteInputTokens, inputTokens }` as recorded
 * in the provider ledger. `previous` is null on the first turn of a session.
 */
export function attributeTurn({
  current,
  previous = null,
  minCacheableTokens = DEFAULT_MIN_CACHEABLE_TOKENS,
  maxTtlMs = DEFAULT_MAX_TTL_MS,
} = {}) {
  if (!object(current)) throw new TypeError('current turn is required');

  const usage = object(current.usage) ? current.usage : {};
  const cacheReadTokens = counter(usage.cachedInputTokens);
  const cacheWriteTokens = counter(usage.cacheWriteInputTokens);
  const freshInputTokens = counter(usage.inputTokens);
  const totalPromptTokens = cacheReadTokens + cacheWriteTokens + freshInputTokens;
  const hit = cacheReadTokens > 0;

  const currentDigests = messageDigests(current.messages);
  const previousDigests = previous ? messageDigests(previous.messages) : [];
  const divergedAt = previous ? firstDivergence(previousDigests, currentDigests) : null;

  const detail = {
    cacheReadTokens,
    cacheWriteTokens,
    freshInputTokens,
    totalPromptTokens,
    divergedAtMessage: divergedAt,
    messagesBeforeDivergence: divergedAt ?? currentDigests.length,
    breakpointPresent: hasBreakpoint(current.body ?? current),
  };

  if (hit) return { hit: true, cause: null, ...detail };

  // Ordered by Anthropic's invalidation hierarchy: the first true cause explains
  // everything after it, so reporting a later one would be misleading.
  let cause;
  if (!previous) cause = 'cold-start';
  else if (shapeDigest(current.tools) !== shapeDigest(previous.tools)) cause = 'tools-changed';
  else if (shapeDigest(current.system) !== shapeDigest(previous.system)) cause = 'system-changed';
  else if (divergedAt !== null) cause = 'history-rewritten';
  else if (!detail.breakpointPresent) cause = 'no-breakpoint';
  else if (totalPromptTokens > 0 && totalPromptTokens < minCacheableTokens) cause = 'below-minimum';
  else if (elapsedMs(previous.at, current.at) > maxTtlMs) cause = 'ttl-expired';
  else cause = 'unexplained';

  return { hit: false, cause, ...detail };
}

function elapsedMs(from, to) {
  const start = Date.parse(from ?? '');
  const end = Date.parse(to ?? '');
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
}

/**
 * Classify a whole session and summarize it.
 *
 * Reports cache-write volume as a first-class figure, not just hit rate: a turn can
 * be scored a "hit" against a short matched prefix while re-writing most of the
 * conversation, and that cost is invisible to hit rate alone.
 */
export function attributeSession(turns, options = {}) {
  if (!Array.isArray(turns)) throw new TypeError('turns must be an array');

  const results = turns.map((turn, index) =>
    attributeTurn({ ...options, current: turn, previous: index === 0 ? null : turns[index - 1] }));

  const misses = results.filter((result) => !result.hit);
  const causes = Object.fromEntries(CAUSES.map((cause) => [cause, 0]));
  for (const miss of misses) causes[miss.cause] += 1;

  const sum = (key) => results.reduce((total, result) => total + result[key], 0);
  const cacheReadTokens = sum('cacheReadTokens');
  const cacheWriteTokens = sum('cacheWriteTokens');
  const freshInputTokens = sum('freshInputTokens');

  return {
    schema: 'sando-cache-attribution/v1',
    turns: results.length,
    hits: results.length - misses.length,
    misses: misses.length,
    hitRate: results.length === 0 ? null : (results.length - misses.length) / results.length,
    causes,
    cacheReadTokens,
    cacheWriteTokens,
    freshInputTokens,
    // Cache writes bill at 1.25x (5m) or 2x (1h) of base input while reads bill at
    // 0.1x, so write volume relative to reads is the ratio that actually tracks spend.
    writeToReadRatio: cacheReadTokens === 0 ? null : cacheWriteTokens / cacheReadTokens,
    perTurn: results,
  };
}
