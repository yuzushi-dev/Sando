#!/usr/bin/env node
//
// Measures the economic value of mid-session compaction across MULTIPLE
// turns of a live session, not a single isolated compaction event. Every
// other live harness in this project (semantic-shadow-live-run.mjs,
// windowed-fold-run.mjs) measures one compaction call in isolation and
// finds it net-negative; the amortization hypothesis (recorded in
// docs/plans/2026-08-24-semantic-compactor-direct-api-design.md) is that the
// isolated event is the wrong unit of measurement — the real saving shows up
// only once a paid-for summary is reused across several subsequent turns
// instead of resending the growing raw history each time.
//
// Two branches over the same turn sequence:
//   baseline  - every turn resends the full cumulative raw history.
//   compacted - at `compactAtTurn`, the history so far is replaced by one
//               real summary call; every later turn sends summary+new-turns
//               instead of the full raw history.
// Turns before `compactAtTurn` are identical in both branches (same prompt,
// same provider-billed cost), so they are paid for ONCE and reused for both
// totals - this is a real-cost optimization, not an approximation: the
// prompt text is byte-identical, so the provider would bill the same amount
// either way.
//
// Turn calls reuse the existing forced-tool-JSON semantic completer
// (semantic-api-adapter.mjs / semantic-codex-api-adapter.mjs) as a generic
// "pay for this prompt, tell me the real usage" primitive: we do not care
// about the semantic content of the per-turn response, only the real
// provider-reported input/output token counts for a request carrying that
// prompt. This avoids inventing a second HTTP protocol - the token cost of
// a request scales with its input regardless of what the forced tool
// response contains.

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadScenario } from '../lib/replay.mjs';
import { estimateTokens } from '../../packages/sando/index.mjs';
import { createApiSemanticCompleter, DEFAULT_API_MODEL } from './semantic-api-adapter.mjs';
import { createCodexApiSemanticCompleter, DEFAULT_CODEX_API_MODEL } from './semantic-codex-api-adapter.mjs';

const API_COMPLETERS = {
  claude: { create: createApiSemanticCompleter, defaultModel: DEFAULT_API_MODEL },
  codex: { create: createCodexApiSemanticCompleter, defaultModel: DEFAULT_CODEX_API_MODEL },
};

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function hasOption(name) {
  return process.argv.includes(`--${name}`);
}

function validatePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function validateNonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

export function buildTurns(events, turnsCount, eventsPerTurn) {
  if (!Array.isArray(events) || events.length === 0) throw new TypeError('events are required');
  if (!Number.isInteger(turnsCount) || turnsCount < 2) throw new TypeError('turnsCount must be an integer >= 2');
  if (!Number.isInteger(eventsPerTurn) || eventsPerTurn < 1) throw new TypeError('eventsPerTurn must be a positive integer');
  const needed = turnsCount * eventsPerTurn;
  if (needed > events.length) {
    throw new Error(`need ${needed} events for ${turnsCount} turns x ${eventsPerTurn} events/turn, only ${events.length} available`);
  }
  const turns = [];
  for (let i = 0; i < turnsCount; i += 1) {
    const slice = events.slice(i * eventsPerTurn, (i + 1) * eventsPerTurn);
    turns.push(slice.map((event) => event.output).join('\n---\n'));
  }
  return turns;
}

export function cumulativeText(turnTexts, uptoIndexInclusive) {
  if (!Array.isArray(turnTexts)) throw new TypeError('turnTexts are required');
  return turnTexts.slice(0, uptoIndexInclusive + 1).join('\n---\n');
}

// Mechanical, independent from any LLM-produced content — same role as
// windowed-fold-run.mjs's fact-ledger extraction, kept as a separate
// implementation here (not imported) so this harness's quality gate cannot
// pass by construction against the same patterns the compactor is scored
// against. Picks up to k "meaningful" lines (paths, errors, numbers) evenly
// spaced across the torso, instead of only the first/last line — a single
// first/last probe was already shown noisy run-to-run in the windowed-fold
// harness (handoff 2026-08-25).
const MEANINGFUL_LINE_RE = /[\w.-]+\/[\w.-]+|error|exception|fail(ed|ure)?|\b\d{2,}\b/i;
// A word token used to require actual prose, not just alphanumeric noise.
const WORD_TOKEN_RE = /^[A-Za-z][A-Za-z'-]{2,}$/;
const MIN_PROSE_WORDS = 4;

// Real multi-tool-output torsos (KiCad project logs, code dumps, coordinate
// tables) are dominated by lines that trivially match MEANINGFUL_LINE_RE
// (a directory listing has a 2+-digit permission count; a footprint
// placement line has coordinates; a `cat -n` dump has a leading line
// number) but that a correct summary is EXPECTED to drop, not preserve
// verbatim — scoring recall against them measures probe quality, not
// compactor quality. Measured on a real 129k-char torso (handoff
// 2026-08-25): of 1368 MEANINGFUL_LINE_RE matches, only 283 also had ≥4
// real words; the rest were coordinate dumps and line-numbered source.
// Requiring prose words in addition is what makes the recall probe
// actually test what a summary is supposed to carry. Still imperfect —
// some short KiCad footprint lines have enough incidental keywords
// (smd/size/drill) to clear the bar — but a large qualitative improvement
// over the unfiltered pool, not a claim of perfect noise exclusion.
function isProseLike(line) {
  const words = line.split(/\s+/).filter((word) => WORD_TOKEN_RE.test(word));
  return words.length >= MIN_PROSE_WORDS;
}

function meaningfulLines(text) {
  return text.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 8 && MEANINGFUL_LINE_RE.test(line) && isProseLike(line));
}

export function pickAnchorFacts(text, k) {
  if (typeof text !== 'string') throw new TypeError('text is required');
  if (!Number.isInteger(k) || k < 1) throw new TypeError('k must be a positive integer');
  const lines = meaningfulLines(text);
  if (lines.length === 0) return [];
  const facts = [];
  const seen = new Set();
  const count = Math.min(k, lines.length);
  for (let i = 0; i < count; i += 1) {
    const idx = Math.floor((i * lines.length) / count);
    const fact = lines[idx].slice(0, 200);
    if (!seen.has(fact)) { seen.add(fact); facts.push(fact); }
  }
  return facts;
}

// A whole anchor line surviving verbatim in an LLM-authored summary is the
// wrong bar: a correct summary REWRITES content, it doesn't copy-paste it.
// The first live run (handoff 2026-08-25) scored factRecall: 0 against a
// summary that was independently confirmed to contain the real substance of
// 6 of 8 anchor facts (verified by extracting each fact's distinctive
// 6+-char tokens — paths, identifiers, numbers, real words — and checking
// how many appear in the haystack). This is the same class of mistake
// windowed-fold-run.mjs's groundingCheck already fixed once for its own
// fact-ledger (whole-line match undercounts when the summary keeps the
// substance but not the surrounding prose) — ported here in general form.
const IDENTIFYING_TOKEN_RE = /[A-Za-z0-9_.-]{6,}/g;

export function extractIdentifyingTokens(fact) {
  if (typeof fact !== 'string') throw new TypeError('fact is required');
  return [...new Set(fact.match(IDENTIFYING_TOKEN_RE) ?? [])];
}

// A fact survives if a majority of its distinctive tokens appear in the
// haystack. A fact with no extractable tokens (all short/generic words)
// falls back to whole-line inclusion — there's nothing more specific to
// check. Majority, not "any", so a fact that only coincidentally shares one
// common token with the summary doesn't count as preserved.
function factSurvived(fact, haystack) {
  const tokens = extractIdentifyingTokens(fact);
  if (tokens.length === 0) return haystack.includes(fact);
  const survivedTokens = tokens.filter((token) => haystack.includes(token)).length;
  return survivedTokens / tokens.length > 0.5;
}

// Fraction of anchor facts whose substance survives in the compactor's
// summary output. No anchor facts (an empty/trivial torso) is vacuously
// full recall — there was nothing to lose, not evidence the compactor did
// anything right.
export function computeRecall(anchorFacts, haystack) {
  if (!Array.isArray(anchorFacts)) throw new TypeError('anchorFacts are required');
  if (typeof haystack !== 'string') throw new TypeError('haystack is required');
  if (anchorFacts.length === 0) return 1;
  const survivedCount = anchorFacts.filter((fact) => factSurvived(fact, haystack)).length;
  return survivedCount / anchorFacts.length;
}

export function findBreakEvenTurn(baselineCumulative, compactedCumulative) {
  if (!Array.isArray(baselineCumulative) || !Array.isArray(compactedCumulative)
    || baselineCumulative.length !== compactedCumulative.length) {
    throw new TypeError('baselineCumulative and compactedCumulative must be arrays of equal length');
  }
  for (let i = 0; i < baselineCumulative.length; i += 1) {
    if (compactedCumulative[i] < baselineCumulative[i]) return i;
  }
  return null;
}

function usageTotal(usage) {
  return usage.inputTokens + usage.outputTokens;
}

// Cache reads/writes are billed at different rates than fresh input tokens
// (see handoff 2026-08-25): a headline that sums raw tokens without this
// breakdown can be off by an order of magnitude once the baseline branch
// starts hitting cache on its repeatedly-resent prefix. Reported alongside
// the raw total, not folded into it — this harness does not assert a $
// conversion, since that requires a verified per-provider price table this
// repo does not yet have (see statusline.mjs INPUT_PRICE_PER_MILLION, Claude
// input-only, no cache/Codex prices).
function cacheBreakdown(usage) {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  return {
    freshInputTokens: usage.inputTokens - cacheReadTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: usage.outputTokens,
  };
}

function sumBreakdowns(a, b) {
  return {
    freshInputTokens: a.freshInputTokens + b.freshInputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

const ZERO_BREAKDOWN = { freshInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

// A baseline turn's prompt is the full cumulative raw history; once that
// exceeds a real model's context window the baseline branch is not just
// expensive, it's infeasible. Flags the first turn (if any) where the
// estimated baseline prompt crosses the threshold, so that outcome is
// reported explicitly instead of silently producing a token-savings number
// for a branch that couldn't actually run.
export function findBaselineInfeasibleTurn(turnTexts, contextWindowTokens, estimate) {
  if (!Array.isArray(turnTexts) || turnTexts.length === 0) throw new TypeError('turnTexts are required');
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens < 1) {
    throw new TypeError('contextWindowTokens must be a positive integer');
  }
  for (let i = 0; i < turnTexts.length; i += 1) {
    if (estimate(cumulativeText(turnTexts, i)) > contextWindowTokens) return i;
  }
  return null;
}

export function computeAmortization({ turnTexts, compactAtTurn, baselineUsages, compactionUsage, compactedUsages }) {
  if (!Array.isArray(turnTexts) || turnTexts.length < 2) throw new TypeError('turnTexts are required');
  if (!Number.isInteger(compactAtTurn) || compactAtTurn < 1 || compactAtTurn >= turnTexts.length) {
    throw new TypeError('compactAtTurn must be between 1 and turnTexts.length - 1');
  }
  if (!Array.isArray(baselineUsages) || baselineUsages.length !== turnTexts.length) {
    throw new TypeError('baselineUsages must have one entry per turn');
  }
  if (!Array.isArray(compactedUsages) || compactedUsages.length !== turnTexts.length - compactAtTurn) {
    throw new TypeError('compactedUsages must have one entry per turn from compactAtTurn onward');
  }
  if (!compactionUsage || typeof compactionUsage.inputTokens !== 'number' || typeof compactionUsage.outputTokens !== 'number') {
    throw new TypeError('compactionUsage is required');
  }

  const baselineCumulative = [];
  const baselineCumulativeBreakdown = [];
  let runningBaseline = 0;
  let runningBaselineBreakdown = ZERO_BREAKDOWN;
  for (const usage of baselineUsages) {
    runningBaseline += usageTotal(usage);
    baselineCumulative.push(runningBaseline);
    runningBaselineBreakdown = sumBreakdowns(runningBaselineBreakdown, cacheBreakdown(usage));
    baselineCumulativeBreakdown.push(runningBaselineBreakdown);
  }

  const compactedCumulative = [];
  const compactedCumulativeBreakdown = [];
  let runningCompacted = 0;
  let runningCompactedBreakdown = ZERO_BREAKDOWN;
  for (let i = 0; i < compactAtTurn; i += 1) {
    runningCompacted += usageTotal(baselineUsages[i]);
    compactedCumulative.push(runningCompacted);
    runningCompactedBreakdown = sumBreakdowns(runningCompactedBreakdown, cacheBreakdown(baselineUsages[i]));
    compactedCumulativeBreakdown.push(runningCompactedBreakdown);
  }
  runningCompacted += usageTotal(compactionUsage);
  runningCompactedBreakdown = sumBreakdowns(runningCompactedBreakdown, cacheBreakdown(compactionUsage));
  for (const usage of compactedUsages) {
    runningCompacted += usageTotal(usage);
    compactedCumulative.push(runningCompacted);
    runningCompactedBreakdown = sumBreakdowns(runningCompactedBreakdown, cacheBreakdown(usage));
    compactedCumulativeBreakdown.push(runningCompactedBreakdown);
  }

  const baselineTotal = baselineCumulative[baselineCumulative.length - 1];
  const compactedTotal = compactedCumulative[compactedCumulative.length - 1];
  const netSavedTokens = baselineTotal - compactedTotal;
  const netSavedPercent = baselineTotal > 0 ? (netSavedTokens / baselineTotal) * 100 : 0;
  const breakEvenTurn = findBreakEvenTurn(baselineCumulative, compactedCumulative);

  return {
    baselineCumulative,
    compactedCumulative,
    baselineCumulativeBreakdown,
    compactedCumulativeBreakdown,
    baselineTotal,
    compactedTotal,
    netSavedTokens,
    netSavedPercent,
    breakEvenTurn,
  };
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// The completers force a sando-semantic-summary/v1 JSON reply, but
// SEMANTIC_SYSTEM_PROMPT (shared with the CLI/windowed-fold adapters) only
// says "return one JSON object" — it never names the schema. windowed-fold-
// run.mjs's buildPrompt() adds that instruction in the user turn; this
// harness sent raw turn text with no such wrapper, so a live run (2026-08-25)
// got a real JSON reply that didn't match the schema and failed to parse.
// Every prompt sent to a completer in this harness needs the same wrapper,
// even for turns whose content we only care about for billed usage — the
// completer still requires a schema-conformant reply to succeed at all.
export function wrapSemanticPrompt(text) {
  return `Summarize the following content. Preserve exact paths, identifiers, errors, numbers, and negations. Return JSON {schema:"sando-semantic-summary/v1", summary: string, preservedFacts: string[]}.\n\n${text}`;
}

// Provider caches expire on a TTL (minutes, not hours); replaying turns
// back-to-back with no delay can see cache hits a real, slower-paced session
// would not. Making the delay an explicit, recorded parameter — rather than
// an implementation detail of how fast this script happens to run — is what
// makes a reported breakEvenTurn reproducible (see handoff 2026-08-25).
export async function runSessionAmortization({
  turnTexts, compactAtTurn, turnCompleter, summaryCompleter, anchorFactCount = 8, interTurnDelayMs = 0,
}) {
  if (!Array.isArray(turnTexts) || turnTexts.length < 2) throw new TypeError('turnTexts are required');
  if (!Number.isInteger(compactAtTurn) || compactAtTurn < 1 || compactAtTurn >= turnTexts.length) {
    throw new TypeError('compactAtTurn must be between 1 and turnTexts.length - 1');
  }
  if (typeof turnCompleter !== 'function') throw new TypeError('turnCompleter is required');
  if (typeof summaryCompleter !== 'function') throw new TypeError('summaryCompleter is required');

  const baselineUsages = [];
  for (let i = 0; i < turnTexts.length; i += 1) {
    if (i > 0 && interTurnDelayMs > 0) await sleep(interTurnDelayMs);
    const response = await turnCompleter({ prompt: wrapSemanticPrompt(cumulativeText(turnTexts, i)) });
    baselineUsages.push(response.usage);
  }

  const torsoText = cumulativeText(turnTexts, compactAtTurn - 1);
  const anchorFacts = pickAnchorFacts(torsoText, anchorFactCount);

  if (interTurnDelayMs > 0) await sleep(interTurnDelayMs);
  const summaryResponse = await summaryCompleter({ prompt: wrapSemanticPrompt(torsoText) });
  const compactionUsage = summaryResponse.usage;
  const summaryText = summaryResponse.summary;
  const preservedFacts = summaryResponse.preservedFacts ?? [];
  const recallHaystack = `${summaryText}\n${preservedFacts.join('\n')}`;
  const factRecall = computeRecall(anchorFacts, recallHaystack);
  // Kept alongside the fraction so a run can be debugged after the fact
  // without re-spending a live call just to see which facts were lost.
  const anchorFactSurvival = anchorFacts.map((fact) => ({ fact, survived: factSurvived(fact, recallHaystack) }));

  const compactedUsages = [];
  for (let i = compactAtTurn; i < turnTexts.length; i += 1) {
    if (interTurnDelayMs > 0) await sleep(interTurnDelayMs);
    const tail = turnTexts.slice(compactAtTurn, i + 1).join('\n---\n');
    const response = await turnCompleter({ prompt: wrapSemanticPrompt(`${summaryText}\n---\n${tail}`) });
    compactedUsages.push(response.usage);
  }

  const totals = computeAmortization({ turnTexts, compactAtTurn, baselineUsages, compactionUsage, compactedUsages });
  return {
    ...totals,
    baselineUsages,
    compactionUsage,
    compactedUsages,
    summaryText,
    preservedFacts,
    anchorFacts,
    anchorFactSurvival,
    factRecall,
  };
}

async function main() {
  if (!hasOption('confirm-cost')) throw new Error('session amortization run requires --confirm-cost');
  const scenarioPath = option('scenario-path');
  if (!scenarioPath) throw new Error('--scenario-path is required');
  const provider = option('provider', 'claude');
  if (!API_COMPLETERS[provider]) throw new Error(`--provider must be one of ${Object.keys(API_COMPLETERS).join('|')}`);
  const { create, defaultModel } = API_COMPLETERS[provider];
  const model = option('model', defaultModel);
  const turnsCount = validatePositiveInteger(option('turns', '6'), '--turns');
  const eventsPerTurn = validatePositiveInteger(option('events-per-turn', '8'), '--events-per-turn');
  const compactAtTurn = validatePositiveInteger(option('compact-at-turn', String(Math.floor(turnsCount / 2))), '--compact-at-turn');
  const timeoutMs = validatePositiveInteger(option('timeout-ms', '180000'), '--timeout-ms');
  const turnMaxOutputTokens = validatePositiveInteger(option('turn-max-output-tokens', '256'), '--turn-max-output-tokens');
  const summaryMaxOutputTokens = validatePositiveInteger(option('summary-max-output-tokens', '2048'), '--summary-max-output-tokens');
  const contextWindowTokens = validatePositiveInteger(option('context-window-tokens', '200000'), '--context-window-tokens');
  const anchorFactCount = validatePositiveInteger(option('anchor-facts', '8'), '--anchor-facts');
  const interTurnDelayMs = validateNonNegativeInteger(option('inter-turn-delay-ms', '0'), '--inter-turn-delay-ms');
  const outPath = option('out');
  if (!outPath) throw new Error('--out is required');
  if (turnsCount < 2) throw new Error('--turns must be >= 2');
  if (compactAtTurn < 1 || compactAtTurn >= turnsCount) throw new Error('--compact-at-turn must be between 1 and turns - 1');

  const scenario = await loadScenario(path.resolve(scenarioPath));
  const turnTexts = buildTurns(scenario.events, turnsCount, eventsPerTurn);

  const estimatedTotalTokens = turnTexts.reduce((sum, text) => sum + estimateTokens(text), 0);
  process.stderr.write(`session-amortization-run: ${turnsCount} turns, ~${estimatedTotalTokens} estimated raw tokens, compacting at turn ${compactAtTurn}\n`);

  const baselineInfeasibleTurn = findBaselineInfeasibleTurn(turnTexts, contextWindowTokens, estimateTokens);
  if (baselineInfeasibleTurn !== null) {
    process.stderr.write(`session-amortization-run: WARNING baseline branch's estimated cumulative prompt exceeds --context-window-tokens (${contextWindowTokens}) at turn ${baselineInfeasibleTurn} — baseline may be infeasible on the real model, not just costlier. Reporting anyway; treat baselineTotal past this turn as evidence of infeasibility, not a valid cost comparison.\n`);
  }

  const turnCompleter = provider === 'claude'
    ? create({ model, timeoutMs, maxOutputTokens: turnMaxOutputTokens })
    : create({ model, timeoutMs });
  const summaryCompleter = provider === 'claude'
    ? create({ model, timeoutMs, maxOutputTokens: summaryMaxOutputTokens })
    : create({ model, timeoutMs });

  const result = await runSessionAmortization({
    turnTexts, compactAtTurn, turnCompleter, summaryCompleter, anchorFactCount, interTurnDelayMs,
  });

  const report = {
    schema: 'sando-session-amortization/v1',
    provider,
    model,
    turnsCount,
    eventsPerTurn,
    compactAtTurn,
    contextWindowTokens,
    baselineInfeasibleTurn,
    anchorFactCount,
    interTurnDelayMs,
    anchorFacts: result.anchorFacts,
    anchorFactSurvival: result.anchorFactSurvival,
    factRecall: result.factRecall,
    summaryText: result.summaryText,
    preservedFacts: result.preservedFacts,
    baselineTotal: result.baselineTotal,
    compactedTotal: result.compactedTotal,
    netSavedTokens: result.netSavedTokens,
    netSavedPercent: result.netSavedPercent,
    breakEvenTurn: result.breakEvenTurn,
    baselineCumulative: result.baselineCumulative,
    compactedCumulative: result.compactedCumulative,
    baselineCumulativeBreakdown: result.baselineCumulativeBreakdown,
    compactedCumulativeBreakdown: result.compactedCumulativeBreakdown,
    compactionUsage: result.compactionUsage,
    baselineUsages: result.baselineUsages,
    compactedUsages: result.compactedUsages,
  };

  const destination = path.resolve(outPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    destination,
    provider,
    model,
    turnsCount,
    compactAtTurn,
    baselineInfeasibleTurn,
    factRecall: report.factRecall,
    baselineTotal: report.baselineTotal,
    compactedTotal: report.compactedTotal,
    netSavedTokens: report.netSavedTokens,
    netSavedPercent: report.netSavedPercent,
    breakEvenTurn: report.breakEvenTurn,
  }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`session-amortization-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
