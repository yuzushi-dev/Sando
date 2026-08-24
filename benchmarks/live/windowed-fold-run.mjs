#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadScenario } from '../lib/replay.mjs';
import { estimateTokens } from '../../packages/sando/index.mjs';
import { SEMANTIC_SYSTEM_PROMPT } from './semantic-cli-adapter.mjs';
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

export function planWindows(events, budgetTokens, estimate) {
  if (!Array.isArray(events) || events.length === 0) throw new TypeError('events are required');
  if (!Number.isInteger(budgetTokens) || budgetTokens < 1) throw new TypeError('budgetTokens must be positive');
  if (typeof estimate !== 'function') throw new TypeError('estimate is required');
  const windows = [];
  let current = [];
  let currentText = '';
  for (const event of events) {
    const candidateText = currentText ? `${currentText}\n---\n${event.output}` : event.output;
    if (current.length > 0 && estimate(candidateText) > budgetTokens) {
      windows.push(current);
      current = [event];
      currentText = event.output;
      if (estimate(currentText) > budgetTokens) {
        process.stderr.write(`windowed-fold: event ${event.id} alone exceeds window budget (${budgetTokens} tokens)\n`);
      }
    } else {
      current = [...current, event];
      currentText = candidateText;
    }
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

export function findCutPoint(events, keepRecentTokens, estimate) {
  if (!Array.isArray(events) || events.length === 0) throw new TypeError('events are required');
  if (!Number.isInteger(keepRecentTokens) || keepRecentTokens < 0) {
    throw new TypeError('keepRecentTokens must be non-negative');
  }
  if (typeof estimate !== 'function') throw new TypeError('estimate is required');

  let accumulatedTokens = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    accumulatedTokens += estimate(events[index].output);
    if (accumulatedTokens >= keepRecentTokens) return index;
  }
  return 0;
}

function windowText(events) {
  return events.map((event) => event.output).join('\n---\n');
}

// ponytail: collapse-only, no semantic understanding. Cuts terminal-noise/boilerplate
// tokens paid to the compactor for free (no LLM call) before the LLM ever sees them —
// upgrade to a smarter dedup (e.g. near-duplicate, not just exact-line) if this proves
// too coarse on real logs.
export function pruneRepeatedLines(text, { keepFirstN = 2 } = {}) {
  const lines = text.split('\n');
  const seenCount = new Map();
  const out = [];
  for (const line of lines) {
    const key = line.trim();
    if (key.length === 0) {
      out.push(line);
      continue;
    }
    const count = (seenCount.get(key) ?? 0) + 1;
    seenCount.set(key, count);
    if (count <= keepFirstN) out.push(line);
    else if (count === keepFirstN + 1) out.push('[... repeated line collapsed ...]');
  }
  return out.join('\n');
}

const LEDGER_PATH_RE = /(?:^|[\s"'`(])((?:[~.]{0,2}\/|[\w-]+\/)[\w./-]{2,}\.[A-Za-z0-9]{1,8})\b/g;
const LEDGER_SHA_RE = /\b[0-9a-f]{7,40}\b/gi;
const LEDGER_ISSUE_RE = /\b(?:PR|pull request|issue)\s*#?\d+\b/gi;
const LEDGER_ERROR_LINE_RE = /^.*\b(?:error|exception|failed|failure|traceback)\b.*$/gim;
const LEDGER_NEGATION_LINE_RE = /^.*\b(?:not|never|isn't|doesn't|cannot|no longer)\b.*$/gim;

// Mechanical, regex-only extraction — deliberately NOT the same patterns pickFact()
// uses to pick the grounding-probe fact. This ledger is what actually ships in the
// final output (see main()); pickFact stays evaluation-only. Keeping the two
// independent avoids the probe passing by construction.
//
// Bounded like Hermes bounds its summary (~5% of context): on a large torso, a broad
// pattern like "contains not/never/cannot" can match a large fraction of lines and
// itself become the thing that blows the token budget. maxTokens caps that — entries
// are kept in first-seen order until the budget is spent; the rest are reported as
// droppedCount, never silently discarded.
export function extractFactLedger(events, { maxTokens = 2000, estimate = estimateTokens } = {}) {
  const candidates = new Set();
  for (const event of events) {
    const text = event.output ?? '';
    for (const re of [LEDGER_PATH_RE, LEDGER_SHA_RE, LEDGER_ISSUE_RE]) {
      for (const match of text.matchAll(re)) {
        const value = (match[1] ?? match[0]).trim();
        if (value.length >= 4) candidates.add(value);
      }
    }
    for (const re of [LEDGER_ERROR_LINE_RE, LEDGER_NEGATION_LINE_RE]) {
      for (const match of text.matchAll(re)) {
        const line = match[0].trim();
        if (line.length >= 8) candidates.add(line.slice(0, 200));
      }
    }
  }
  const ledger = [];
  let usedTokens = 0;
  let droppedCount = 0;
  for (const candidate of candidates) {
    const candidateTokens = estimate(candidate);
    if (usedTokens + candidateTokens > maxTokens) {
      droppedCount += 1;
      continue;
    }
    ledger.push(candidate);
    usedTokens += candidateTokens;
  }
  return { ledger, droppedCount, usedTokens };
}

function buildPrompt({ excerpt, carriedSummary, carriedFacts }) {
  if (carriedSummary === null) {
    return `${SEMANTIC_SYSTEM_PROMPT}\n\nSummarize the following conversation excerpt. Preserve exact paths, identifiers, errors, numbers, and negations. Return JSON {schema:"sando-semantic-summary/v1", summary: string, preservedFacts: string[]}.\n\n${excerpt}`;
  }
  const factsList = carriedFacts.map((fact) => `- ${fact}`).join('\n');
  return `${SEMANTIC_SYSTEM_PROMPT}\n\nUpdate the existing summary below from the new excerpt, for another instance to resume.\n\nMUST:\n- preserve every fact and detail in the previous summary; do not drop or paraphrase away specifics.\n- preserve exact file paths, identifiers, numbers, error messages, and negations verbatim, from both the previous summary and the new excerpt.\n- integrate new information from the excerpt; do not just append it, merge it into a coherent whole.\n- every fact in "Previously preserved facts" MUST still appear verbatim somewhere in your output.\n- output only the structured JSON; never extra text.\n\nPrevious summary of earlier conversation: ${carriedSummary}\nPreviously preserved facts:\n${factsList}\n\nNew conversation excerpt to fold in:\n${excerpt}\n\nReturn an UPDATED JSON {schema:"sando-semantic-summary/v1", summary: string, preservedFacts: string[]} that represents the ENTIRE conversation so far, not just the new excerpt.`;
}

function dedupFacts(facts) {
  return [...new Set(facts)];
}

export async function foldWindows(windows, complete, { estimate = estimateTokens } = {}) {
  if (!Array.isArray(windows) || windows.length === 0) throw new TypeError('windows are required');
  if (typeof complete !== 'function') throw new TypeError('complete is required');
  let carriedSummary = null;
  let carriedFacts = [];
  let totalCompactorInputTokens = 0;
  let totalCompactorOutputTokens = 0;
  let totalPromptTokensEstimate = 0;
  let totalPrunedTokensSaved = 0;
  let totalLatencyMs = 0;
  const perWindow = [];
  let failedAtWindow = null;

  for (let index = 0; index < windows.length; index += 1) {
    const windowEvents = windows[index];
    const rawWindowText = windowText(windowEvents);
    const tokensEstimate = estimate(rawWindowText);
    const excerpt = pruneRepeatedLines(rawWindowText);
    const prunedTokensEstimate = estimate(excerpt);
    const prunedTokensSaved = tokensEstimate - prunedTokensEstimate;
    totalPrunedTokensSaved += prunedTokensSaved;
    const prompt = buildPrompt({ excerpt, carriedSummary, carriedFacts });
    const promptTokensEstimate = estimate(prompt);
    totalPromptTokensEstimate += promptTokensEstimate;
    const startedAt = Date.now();
    try {
      const response = await complete({ prompt });
      const latencyMs = Date.now() - startedAt;
      carriedSummary = response.summary;
      carriedFacts = dedupFacts([...carriedFacts, ...response.preservedFacts]);
      totalCompactorInputTokens += response.usage.inputTokens;
      totalCompactorOutputTokens += response.usage.outputTokens;
      totalLatencyMs += latencyMs;
      perWindow.push({
        index,
        events: windowEvents.length,
        tokensEstimate,
        prunedTokensEstimate,
        prunedTokensSaved,
        promptTokensEstimate,
        compactorInputTokens: response.usage.inputTokens,
        compactorOutputTokens: response.usage.outputTokens,
        latencyMs,
        status: 'ok',
      });
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      totalLatencyMs += latencyMs;
      perWindow.push({
        index,
        events: windowEvents.length,
        tokensEstimate,
        prunedTokensEstimate,
        prunedTokensSaved,
        compactorInputTokens: 0,
        compactorOutputTokens: 0,
        latencyMs,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      failedAtWindow = index;
      break;
    }
  }

  return {
    carriedSummary,
    carriedFacts,
    totalCompactorInputTokens,
    totalCompactorOutputTokens,
    totalPromptTokensEstimate,
    totalPrunedTokensSaved,
    totalLatencyMs,
    perWindow,
    failedAtWindow,
  };
}

// The local heuristic estimator (character/4-ish) systematically undercounts against
// real provider tokenizers. Rather than trust it for the headline savings number, derive
// a per-run calibration ratio from data this run already has for free: the same prompts
// were both estimated locally (promptTokensEstimate) and billed for real
// (compactorInputTokens) by the compactor call itself. Falls back to 1 (no correction)
// when nothing was sent to a compactor — nothing to calibrate against.
export function computeCalibrationRatio(totalCompactorInputTokens, totalPromptTokensEstimate) {
  if (!Number.isFinite(totalPromptTokensEstimate) || totalPromptTokensEstimate <= 0) return 1;
  return totalCompactorInputTokens / totalPromptTokensEstimate;
}

// All four inputs must share one unit system before subtracting them. compactorInput/
// OutputTokens are always real (provider-billed); the two Estimate args are the local
// heuristic and get scaled by calibrationRatio into the same real-token-equivalent basis
// before the subtraction — mixing raw local estimates with real provider counts here was
// the bug (see handoff 2026-08-24, item 3c).
export function computeNetSavings({
  originalTokensEstimate,
  finalResultTokensEstimate,
  compactorInputTokens,
  compactorOutputTokens,
  calibrationRatio,
}) {
  const originalTokens = originalTokensEstimate * calibrationRatio;
  const finalResultTokens = finalResultTokensEstimate * calibrationRatio;
  const grossSavedTokens = originalTokens - finalResultTokens;
  const netSavedTokens = grossSavedTokens - compactorInputTokens - compactorOutputTokens;
  const netSavedPercent = originalTokens > 0 ? (netSavedTokens / originalTokens) * 100 : 0;
  return { originalTokens, finalResultTokens, grossSavedTokens, netSavedTokens, netSavedPercent };
}

const TRIVIAL_VALUE_RE = /:\s*(\[\]|\{\}|null|none|undefined|n\/a)\s*$/i;
const MEANINGFUL_RE = /[\w.-]+\/[\w.-]+|error|exception|fail(ed|ure)?|\b\d{2,}\b/i;

function isTrivial(line) {
  return TRIVIAL_VALUE_RE.test(line) || !/[a-zA-Z0-9]{3,}/.test(line);
}

// Prefers a line a summary is actually obliged to carry (a path, an error, a
// number) over the first line that merely clears a length threshold — an
// arbitrary short blob like "net RF: []" is not a fact worth grounding on.
function pickFact(lines, startIdx, direction) {
  let idx = startIdx;
  let fallback;
  for (let attempt = 0; attempt < 10 && idx >= 0 && idx < lines.length; attempt += 1) {
    const trimmed = lines[idx].trim();
    if (!isTrivial(trimmed) && trimmed.length >= 8) {
      if (MEANINGFUL_RE.test(trimmed)) return trimmed.slice(0, 200);
      if (fallback === undefined && trimmed.length >= 20) fallback = trimmed.slice(0, 200);
    }
    idx += direction;
  }
  return fallback;
}

function firstNonEmptyFact(text) {
  const lines = text.split('\n');
  const idx = lines.findIndex((line) => line.trim().length > 0);
  return idx === -1 ? undefined : pickFact(lines, idx, 1);
}

function lastNonEmptyFact(text) {
  const lines = text.split('\n');
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length > 0) { idx = i; break; }
  }
  return idx === -1 ? undefined : pickFact(lines, idx, -1);
}

// pickFact() selects a whole line; the ledger's path/SHA/issue patterns capture only
// the matched substring, not the surrounding line (its error/negation patterns do
// capture whole lines). A verbatim haystack.includes(fact) check alone would therefore
// call the fact "lost" whenever the ledger preserved the meaningful token but not the
// prose around it — that's the ledger doing its job, not losing the fact. Count it as
// survived either way: exact line match, or the fact-line containing a ledger entry
// that itself made it into the haystack.
function survived(fact, haystack, ledgerEntries) {
  if (fact === undefined) return false;
  if (haystack.includes(fact)) return true;
  return (ledgerEntries ?? []).some((entry) => entry.length >= 8 && fact.includes(entry));
}

export function groundingCheck({ summarizedEvents, carriedSummary, carriedFacts, factLedger }) {
  if (!Array.isArray(summarizedEvents)) throw new TypeError('summarizedEvents are required');
  const firstEventText = summarizedEvents[0]?.output ?? '';
  const lastEventText = summarizedEvents[summarizedEvents.length - 1]?.output ?? '';
  const firstFact = firstNonEmptyFact(firstEventText);
  const lastFact = lastNonEmptyFact(lastEventText);
  const ledgerEntries = factLedger ?? [];
  const haystack = `${carriedSummary ?? ''}\n${(carriedFacts ?? []).join('\n')}\n${ledgerEntries.join('\n')}`;
  return {
    firstFact,
    lastFact,
    firstFactSurvived: survived(firstFact, haystack, ledgerEntries),
    lastFactSurvived: survived(lastFact, haystack, ledgerEntries),
  };
}

async function main() {
  if (!hasOption('confirm-cost')) throw new Error('windowed fold requires --confirm-cost');
  const scenarioPath = option('scenario-path');
  if (!scenarioPath) throw new Error('--scenario-path is required');
  const provider = option('provider', 'claude');
  if (!API_COMPLETERS[provider]) throw new Error(`--provider must be one of ${Object.keys(API_COMPLETERS).join('|')}`);
  const { create, defaultModel } = API_COMPLETERS[provider];
  const model = option('model', defaultModel);
  const windowBudgetTokens = validatePositiveInteger(option('window-budget-tokens', '65000'), '--window-budget-tokens');
  const keepRecentTokens = validateNonNegativeInteger(option('keep-recent-tokens', '20000'), '--keep-recent-tokens');
  const timeoutMs = validatePositiveInteger(option('timeout-ms', '180000'), '--timeout-ms');
  const maxOutputTokens = validatePositiveInteger(option('max-output-tokens', '8192'), '--max-output-tokens');
  const outPath = option('out');
  if (!outPath) throw new Error('--out is required');

  const scenario = await loadScenario(path.resolve(scenarioPath));
  const events = scenario.events;
  const cutPoint = findCutPoint(events, keepRecentTokens, estimateTokens);
  const summarizedEvents = events.slice(0, cutPoint);
  const retainedEvents = events.slice(cutPoint);
  const windows = summarizedEvents.length > 0
    ? planWindows(summarizedEvents, windowBudgetTokens, estimateTokens)
    : [];

  const complete = provider === 'claude'
    ? create({ model, timeoutMs, maxOutputTokens })
    : create({ model, timeoutMs });
  const foldResult = windows.length > 0
    ? await foldWindows(windows, complete)
    : {
      carriedSummary: null,
      carriedFacts: [],
      totalCompactorInputTokens: 0,
      totalCompactorOutputTokens: 0,
      totalPromptTokensEstimate: 0,
      totalPrunedTokensSaved: 0,
      totalLatencyMs: 0,
      perWindow: [],
      failedAtWindow: null,
    };

  const { ledger: factLedger, droppedCount: factLedgerDroppedCount } = summarizedEvents.length > 0
    ? extractFactLedger(summarizedEvents)
    : { ledger: [], droppedCount: 0 };

  const originalText = windowText(events);
  const originalTokensEstimate = estimateTokens(originalText);
  const summaryText = foldResult.carriedSummary ?? '';
  const ledgerText = factLedger.join('\n');
  const rawRecentText = windowText(retainedEvents);
  const finalText = [summaryText, ledgerText, rawRecentText].filter(Boolean).join('\n---\n');
  const finalSummaryTokens = estimateTokens(summaryText);
  const factLedgerTokens = estimateTokens(ledgerText);
  const rawRecentTokens = estimateTokens(rawRecentText);
  const finalResultTokensEstimate = estimateTokens(finalText);

  const estimatorCalibrationRatio = computeCalibrationRatio(
    foldResult.totalCompactorInputTokens,
    foldResult.totalPromptTokensEstimate,
  );
  const netSavings = computeNetSavings({
    originalTokensEstimate,
    finalResultTokensEstimate,
    compactorInputTokens: foldResult.totalCompactorInputTokens,
    compactorOutputTokens: foldResult.totalCompactorOutputTokens,
    calibrationRatio: estimatorCalibrationRatio,
  });

  const grounding = groundingCheck({
    summarizedEvents,
    carriedSummary: foldResult.carriedSummary,
    carriedFacts: foldResult.carriedFacts,
    factLedger,
  });

  const report = {
    schema: 'sando-windowed-fold/v1',
    provider,
    model,
    windowBudgetTokens,
    keepRecentTokens,
    cutPoint,
    windows: windows.length,
    events: events.length,
    summarizedEvents: summarizedEvents.length,
    retainedEvents: retainedEvents.length,
    originalTokensEstimateLocal: originalTokensEstimate,
    finalResultTokensEstimateLocal: finalResultTokensEstimate,
    estimatorCalibrationRatio,
    compactorInputTokens: foldResult.totalCompactorInputTokens,
    compactorOutputTokens: foldResult.totalCompactorOutputTokens,
    finalSummaryTokens,
    factLedgerCount: factLedger.length,
    factLedgerDroppedCount,
    factLedgerTokens,
    rawRecentTokens,
    totalPrunedTokensSaved: foldResult.totalPrunedTokensSaved,
    originalTokens: netSavings.originalTokens,
    finalResultTokens: netSavings.finalResultTokens,
    netSavedTokens: netSavings.netSavedTokens,
    netSavedPercent: netSavings.netSavedPercent,
    firstFactSurvived: grounding.firstFactSurvived,
    lastFactSurvived: grounding.lastFactSurvived,
    firstFact: grounding.firstFact,
    lastFact: grounding.lastFact,
    totalLatencyMs: foldResult.totalLatencyMs,
    perWindow: foldResult.perWindow,
    failedAtWindow: foldResult.failedAtWindow,
  };

  const destination = path.resolve(outPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    destination,
    provider,
    model,
    windowBudgetTokens,
    keepRecentTokens,
    cutPoint,
    windows: report.windows,
    events: report.events,
    summarizedEvents: report.summarizedEvents,
    retainedEvents: report.retainedEvents,
    originalTokens: report.originalTokens,
    estimatorCalibrationRatio: report.estimatorCalibrationRatio,
    compactorInputTokens: report.compactorInputTokens,
    compactorOutputTokens: report.compactorOutputTokens,
    finalSummaryTokens: report.finalSummaryTokens,
    factLedgerCount: report.factLedgerCount,
    factLedgerDroppedCount: report.factLedgerDroppedCount,
    totalPrunedTokensSaved: report.totalPrunedTokensSaved,
    rawRecentTokens: report.rawRecentTokens,
    finalResultTokens: report.finalResultTokens,
    netSavedTokens: report.netSavedTokens,
    netSavedPercent: report.netSavedPercent,
    firstFactSurvived: report.firstFactSurvived,
    lastFactSurvived: report.lastFactSurvived,
    totalLatencyMs: report.totalLatencyMs,
    failedAtWindow: report.failedAtWindow,
  }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`windowed-fold-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
