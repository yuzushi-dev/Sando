import { estimateTokens } from './core.mjs';
import { dedupeHistory } from './history-dedupe.mjs';
import { selectHistoryCandidates, validateMaxHistoryTokens } from './history-budget.mjs';
import { shakeHistoricalResult } from './history-shake.mjs';
import { compactHistoricalStructure } from './history-structure.mjs';

const SUPERSEDED = '[sando superseded by newer read]';
const USELESS = '[sando elided useless success]';
const USELESS_SUCCESSES = new Set([
  'command completed successfully with no output.',
  'no output.',
  '(no output)',
]);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function estimate(body) {
  const json = JSON.stringify(body);
  if (json === undefined) throw new TypeError('body must be JSON-serializable');
  return estimateTokens(json);
}

function parseArguments(value) {
  if (object(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return object(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readIdentity(name, input) {
  if (typeof name !== 'string' || name.toLowerCase() !== 'read' || !object(input)) return null;
  const paths = ['file_path', 'path'].filter((key) => Object.hasOwn(input, key));
  if (paths.length !== 1 || typeof input[paths[0]] !== 'string' || input[paths[0]].length === 0) return null;

  let path = input[paths[0]];
  let range = null;
  const suffix = path.match(/^(.*):(\d+)-(\d+)$/);
  const selectorKeys = ['offset', 'limit', 'line_start', 'line_end', 'start_line', 'end_line']
    .filter((key) => Object.hasOwn(input, key));
  if (suffix && selectorKeys.length === 0) {
    path = suffix[1];
    range = [Number(suffix[2]), Number(suffix[3])];
  } else if (selectorKeys.length > 0) {
    if (selectorKeys.length !== 2) return null;
    if (selectorKeys.includes('offset') && selectorKeys.includes('limit')) {
      const { offset, limit } = input;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) return null;
      range = [offset, offset + limit - 1];
    } else {
      const pair = selectorKeys.includes('line_start') ? ['line_start', 'line_end'] : ['start_line', 'end_line'];
      if (!pair.every((key) => selectorKeys.includes(key))) return null;
      const [start, end] = pair.map((key) => input[key]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
      range = [start, end];
    }
  }
  if (range && range[1] < range[0]) return null;
  return { path, range };
}

function covers(newer, older) {
  if (newer.path !== older.path) return false;
  if (newer.range === null) return true;
  return older.range !== null && newer.range[0] <= older.range[0] && newer.range[1] >= older.range[1];
}

function resultError(item, text) {
  if (item.is_error === true || item.error !== undefined || ['error', 'failed'].includes(item.status)) return true;
  return /^\s*(?:error|failed|failure)\b[:\s-]*/i.test(text);
}

function useless(text) {
  return USELESS_SUCCESSES.has(text.trim().toLowerCase());
}

function resultText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0
    && value.every((item) => ['text', 'input_text'].includes(item?.type) && typeof item.text === 'string')) {
    return value.map((item) => item.text).join('\n');
  }
  return null;
}

// Collapsing a run of text blocks into one drops every block after index 0. Any
// `cache_control` breakpoint the host (e.g. Claude Code) placed on a later block
// would vanish silently, costing a cache read on every subsequent turn. Carry the
// deepest marker onto the surviving block: cache semantics cover everything up to
// and including a marked block, so the collapsed block inherits that boundary.
function collapseTextBlocks(blocks, value) {
  const collapsed = { ...blocks[0], text: value };
  const marker = blocks.findLast((block) => block?.cache_control !== undefined)?.cache_control;
  if (marker !== undefined) collapsed.cache_control = marker;
  return [collapsed];
}

function replaceResult(item, key, value) {
  if (typeof item[key] === 'string' && typeof value === 'string') item[key] = value;
  else if (Array.isArray(item[key]) && Array.isArray(value)) item[key] = value;
  else if (Array.isArray(item[key]) && typeof value === 'string'
    && item[key].every((block) => ['text', 'input_text'].includes(block?.type))) {
    item[key] = collapseTextBlocks(item[key], value);
  }
}

function collectAnthropic(body) {
  if (!Array.isArray(body.messages)) return [];
  const entries = [];
  body.messages.forEach((message, position) => {
    if (!Array.isArray(message?.content)) return;
    message.content.forEach((item) => {
      if (item?.type === 'tool_use') {
        entries.push({ kind: 'call', id: item.id, name: item.name, input: object(item.input) ? item.input : null, position });
      } else if (item?.type === 'tool_result') {
        entries.push({
          kind: 'result', id: item.tool_use_id, item, key: 'content', position,
          current: position === body.messages.length - 1,
        });
      }
    });
  });
  return entries;
}

function collectChat(body) {
  if (!Array.isArray(body.messages)) return [];
  const entries = [];
  const lastNonToolPosition = body.messages.reduce(
    (last, message, position) => message?.role === 'tool' ? last : position,
    -1,
  );
  body.messages.forEach((message, position) => {
    if (Array.isArray(message?.tool_calls)) {
      message.tool_calls.forEach((item) => {
        if (item?.type === 'function' && object(item.function)) {
          entries.push({
            kind: 'call', id: item.id, name: item.function.name,
            input: parseArguments(item.function.arguments), position,
          });
        }
      });
    }
    if (message?.role === 'tool') {
      entries.push({
        kind: 'result', id: message.tool_call_id, item: message, key: 'content', position,
        current: position > lastNonToolPosition,
      });
    }
  });
  return entries;
}

function collectResponses(body) {
  if (!Array.isArray(body.input)) return [];
  const entries = [];
  const lastCallPosition = body.input.reduce(
    (last, item, position) => ['function_call', 'custom_tool_call'].includes(item?.type) ? position : last,
    -1,
  );
  body.input.forEach((item, position) => {
    if (['function_call', 'custom_tool_call'].includes(item?.type)) {
      entries.push({
        kind: 'call', id: item.call_id, name: item.name,
        input: parseArguments(item.arguments ?? item.input), position,
      });
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item?.type)) {
      entries.push({
        kind: 'result', id: item.call_id, item, key: 'output', position,
        current: position > lastCallPosition,
      });
    }
  });
  return entries;
}

const COLLECTORS = {
  anthropic: collectAnthropic,
  'openai-chat': collectChat,
  'openai-responses': collectResponses,
};

function historyRecords(entries, calls) {
  return entries.flatMap((entry) => {
    if (entry.kind !== 'result') return [];
    const call = calls.get(entry.id);
    const text = resultText(entry.item[entry.key]);
    if (!call || text === null) return [];
    const isError = resultError(entry.item, text);
    return [{
      id: entry.id,
      toolName: call.name,
      input: call.input,
      output: entry.item[entry.key],
      current: entry.current,
      historical: !entry.current,
      safe: !isError,
      isError,
      position: entry.position,
      estimatedTokens: estimateTokens(text),
      entry,
    }];
  });
}

function collectHistoryRecords(provider, body) {
  const collector = COLLECTORS[provider];
  if (!collector) return [];
  const entries = collector(body);
  const calls = new Map();
  const results = new Map();
  const ambiguous = new Set();
  for (const entry of entries) {
    const map = entry.kind === 'call' ? calls : results;
    if (typeof entry.id !== 'string' || entry.id.length === 0 || map.has(entry.id)) ambiguous.add(entry.id);
    else map.set(entry.id, entry);
  }
  for (const id of ambiguous) {
    calls.delete(id);
    results.delete(id);
  }
  return historyRecords(entries, calls);
}

export function detectProviderBody(body, headers = {}) {
  if (!object(body)) return null;
  const header = typeof headers.get === 'function'
    ? headers.get('anthropic-version')
    : headers['anthropic-version'] ?? headers['Anthropic-Version'];
  if (header && Array.isArray(body.messages)) return 'anthropic';

  const responses = Array.isArray(body.input) && body.input.some((item) =>
    ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(item?.type));
  if (responses) return 'openai-responses';
  if (!Array.isArray(body.messages)) return null;
  const anthropic = body.messages.some((message) => Array.isArray(message?.content)
    && message.content.some((item) => ['tool_use', 'tool_result'].includes(item?.type)));
  const chat = body.messages.some((message) => Array.isArray(message?.tool_calls) || message?.role === 'tool');
  if (anthropic === chat) return null;
  return anthropic ? 'anthropic' : 'openai-chat';
}

export function listSemanticCandidates({ provider, body, model } = {}) {
  const selectedProvider = provider ?? detectProviderBody(body);
  const selectedModel = model ?? (typeof body?.model === 'string' ? body.model : null);
  return collectHistoryRecords(selectedProvider, body)
    .filter((record) => record.safe && record.historical)
    .map((record) => ({
      id: record.id,
      model: selectedModel,
      toolName: record.toolName,
      text: resultText(record.output),
      current: record.current,
      historical: record.historical,
      isError: record.isError,
      estimatedTokens: record.estimatedTokens,
    }));
}

function carriesBreakpoint(value) {
  if (Array.isArray(value)) return value.some(carriesBreakpoint);
  if (!object(value)) return false;
  if (value.cache_control !== undefined) return true;
  return Object.values(value).some(carriesBreakpoint);
}

/**
 * Minimum fraction of the re-prefilled suffix a rewrite must reclaim to pay for itself.
 *
 * Derived from Anthropic's published multipliers (cache read 0.1x, 5-minute cache
 * write 1.25x of base input). With `S` tokens reclaimed, `P` tokens of suffix forced
 * back through a cache write, and `K` further turns to amortize over:
 *
 *   rewrite: 1.25(P-S) + 0.10(P-S)K        leave: 0.10P(K+1)
 *   rewrite wins  <=>  S/P > 1.15 / (1.25 + 0.10K)
 *
 * The threshold is a RATIO and is independent of P — an absolute token budget is the
 * wrong parameterization. K=0 needs 92%, K=10 needs 51%, K=50 needs 18%. Sando cannot
 * know K (how much longer the session runs), so this uses the K=10 point: a rewrite
 * must reclaim over half the suffix it invalidates. Conservative for short sessions,
 * slightly cautious for very long ones.
 */
const DEFAULT_CACHE_REWRITE_RATIO = 0.51;

/**
 * Below this idle time, the ratio guard above governs. At or beyond it, the host's
 * prompt cache has already expired on its own — Anthropic's longest published ephemeral
 * TTL is 1h (measured on a real Claude Code request: `{"type":"ephemeral","ttl":"1h"}`),
 * so a request idle this long forces a full cache-write regardless of what Sando does.
 * Rewriting costs nothing extra at that point, so the ratio guard is bypassed entirely.
 * Set `policy.cacheIdleFlushMs: null` to disable (ratio guard always governs).
 */
const DEFAULT_CACHE_IDLE_FLUSH_MS = 65 * 60_000;

/**
 * Token counts of the suffix following each message index.
 *
 * Position relative to a breakpoint is the wrong metric here. A real Claude Code
 * request (measured: 90 tools, 2 system markers, 1 message marker, all ttl 1h) marks
 * the LAST message, moving the breakpoint forward every turn so the growing
 * conversation stays one cached span — the same strategy Cline documents. Protecting
 * everything at or before that marker would protect the entire conversation and
 * disable the transform outright (measured: 17.1% mechanical saving -> 0%).
 *
 * What actually matters is how much has to be re-prefilled, which is the size of the
 * suffix after the rewritten message.
 */
function suffixTokensByPosition(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const suffix = new Array(messages.length).fill(0);
  let running = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    suffix[index] = running;
    running += estimateTokens(JSON.stringify(messages[index]) ?? '');
  }
  return suffix;
}

export function transformProviderRequest({ provider, body, policy, idleMs } = {}) {
  const clone = structuredClone(body);
  const estimatedInputTokens = estimate(body);
  const selectedProvider = provider ?? detectProviderBody(body);
  const collector = COLLECTORS[selectedProvider];
  let supersededReads = 0;
  let elidedUselessSuccesses = 0;
  let deduplicatedResults = 0;
  let compactedStructures = 0;
  let shakenResults = 0;
  const maxHistoryTokens = object(policy) && Object.hasOwn(policy, 'maxHistoryTokens')
    ? validateMaxHistoryTokens(policy.maxHistoryTokens)
    : null;
  const budgetTriggered = maxHistoryTokens !== null
    && BigInt(estimatedInputTokens) * 5n > BigInt(maxHistoryTokens) * 4n;
  // Don't rewrite warm cached history unless the rewrite reclaims enough of the suffix
  // it invalidates to pay the cache-write premium. Only applies when the host actually
  // asked for caching — with no breakpoint there is no warm prefix to protect.
  // Set `policy.cacheRewriteRatio: 0` to disable.
  const cacheRewriteRatio = object(policy) && Object.hasOwn(policy, 'cacheRewriteRatio')
    ? policy.cacheRewriteRatio
    : DEFAULT_CACHE_REWRITE_RATIO;
  if (typeof cacheRewriteRatio !== 'number' || !(cacheRewriteRatio >= 0) || cacheRewriteRatio > 1) {
    throw new TypeError('cacheRewriteRatio must be a number between 0 and 1');
  }
  const cacheIdleFlushMs = object(policy) && Object.hasOwn(policy, 'cacheIdleFlushMs')
    ? policy.cacheIdleFlushMs
    : DEFAULT_CACHE_IDLE_FLUSH_MS;
  if (cacheIdleFlushMs !== null && (typeof cacheIdleFlushMs !== 'number' || !(cacheIdleFlushMs >= 0))) {
    throw new TypeError('cacheIdleFlushMs must be a non-negative number or null');
  }
  const cacheWarm = cacheRewriteRatio > 0 && carriesBreakpoint(clone);
  const suffixTokens = cacheWarm ? suffixTokensByPosition(clone) : null;
  // The host's own cache has already gone cold from inactivity: any rewrite here is
  // free, since the provider will cache-write the whole prefix again regardless.
  const idleCold = cacheIdleFlushMs !== null && typeof idleMs === 'number' && idleMs >= cacheIdleFlushMs;
  // `reclaimed` is how many tokens this particular rewrite removes.
  const cacheProtected = (entry, reclaimed) => {
    if (!cacheWarm || idleCold) return false;
    const suffix = suffixTokens[entry.position] ?? 0;
    if (suffix === 0) return false;
    return reclaimed / suffix < cacheRewriteRatio;
  };
  let cacheProtectedSkips = 0;
  const reclaimedTokens = (before, after) =>
    Math.max(0, estimateTokens(before) - estimateTokens(after));

  if (collector) {
    const entries = collector(clone);
    const calls = new Map();
    const results = new Map();
    const ambiguous = new Set();
    for (const entry of entries) {
      const map = entry.kind === 'call' ? calls : results;
      if (typeof entry.id !== 'string' || entry.id.length === 0 || map.has(entry.id)) ambiguous.add(entry.id);
      else map.set(entry.id, entry);
    }
    for (const id of ambiguous) {
      calls.delete(id);
      results.delete(id);
    }

    const reads = [];
    for (const call of calls.values()) {
      const result = results.get(call.id);
      const identity = readIdentity(call.name, call.input);
      const text = result && resultText(result.item[result.key]);
      if (!result || !identity || text === null) continue;
      if (!resultError(result.item, text)) reads.push({ call, result, identity, text });
    }
    reads.sort((a, b) => a.call.position - b.call.position);
    for (let index = 0; index < reads.length; index += 1) {
      const old = reads[index];
      if (old.result.current) continue;
      const newer = reads.slice(index + 1).find((candidate) =>
        covers(candidate.identity, old.identity) && !useless(candidate.text));
      if (!newer) continue;
      if (cacheProtected(old.result, reclaimedTokens(old.text, SUPERSEDED))) { cacheProtectedSkips += 1; continue; }
      replaceResult(old.result.item, old.result.key, SUPERSEDED);
      supersededReads += 1;
    }

    for (const [id, result] of results) {
      if (!calls.has(id) || result.current) continue;
      const text = resultText(result.item[result.key]);
      if (text === null) continue;
      if (text === SUPERSEDED || resultError(result.item, text) || !useless(text)) continue;
      if (cacheProtected(result, reclaimedTokens(text, USELESS))) { cacheProtectedSkips += 1; continue; }
      replaceResult(result.item, result.key, USELESS);
      elidedUselessSuccesses += 1;
    }

    const records = historyRecords(entries, calls);
    const candidates = maxHistoryTokens === null
      ? records.filter((record) => record.safe && record.historical)
      : selectHistoryCandidates({ bodyTokens: estimatedInputTokens, maxHistoryTokens, candidates: records });
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const reductions = dedupeHistory(records);
    const recordsById = new Map(records.map((record) => [record.id, record]));
    for (const reduced of reductions.entries) {
      if (!candidateIds.has(reduced.id)) continue;
      const original = recordsById.get(reduced.id);
      if (!original || reduced.output === original.output) continue;
      if (cacheProtected(original.entry, reclaimedTokens(
        resultText(original.output) ?? '', resultText(reduced.output) ?? ''))) { cacheProtectedSkips += 1; continue; }
      replaceResult(original.entry.item, original.entry.key, reduced.output);
      deduplicatedResults += 1;
    }

    for (const record of records) {
      if (!candidateIds.has(record.id)) continue;
      const text = resultText(record.entry.item[record.entry.key]);
      if (text === null) continue;
      const compacted = compactHistoricalStructure({
        toolName: record.toolName,
        text,
        historical: record.historical,
        isError: record.isError,
      });
      if (compacted === text) continue;
      if (cacheProtected(record.entry, reclaimedTokens(text, compacted))) { cacheProtectedSkips += 1; continue; }
      replaceResult(record.entry.item, record.entry.key, compacted);
      compactedStructures += 1;
    }

    if (maxHistoryTokens !== null && budgetTriggered) {
      for (const record of records) {
        if (!candidateIds.has(record.id)) continue;
        const text = resultText(record.entry.item[record.entry.key]);
        if (text === null) continue;
        const shaken = shakeHistoricalResult({
          toolName: record.toolName,
          text,
          historical: record.historical,
          isError: record.isError,
        });
        if (!shaken.changed) continue;
        if (cacheProtected(record.entry, reclaimedTokens(text, shaken.text))) { cacheProtectedSkips += 1; continue; }
        replaceResult(record.entry.item, record.entry.key, shaken.text);
        shakenResults += 1;
      }
    }
  }

  const reasons = [];
  if (supersededReads > 0) reasons.push('superseded-read');
  if (elidedUselessSuccesses > 0) reasons.push('useless-success');
  if (deduplicatedResults > 0) reasons.push('duplicate-history');
  if (compactedStructures > 0) reasons.push('repeated-lines');
  if (shakenResults > 0) reasons.push('history-shake');
  return {
    body: clone,
    changed: reasons.length > 0,
    reasons,
    stats: {
      estimatedInputTokens,
      estimatedOutputTokens: estimate(clone),
      supersededReads,
      elidedUselessSuccesses,
      deduplicatedResults,
      compactedStructures,
      shakenResults,
      budgetTriggered,
      cacheProtectedSkips,
      cacheRewriteRatio: cacheWarm ? cacheRewriteRatio : null,
      cacheIdleFlushed: cacheWarm ? idleCold : false,
    },
  };
}
