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

function buildPrompt({ windowEvents, carriedSummary, carriedFacts }) {
  const excerpt = windowText(windowEvents);
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
  let totalLatencyMs = 0;
  const perWindow = [];
  let failedAtWindow = null;

  for (let index = 0; index < windows.length; index += 1) {
    const windowEvents = windows[index];
    const tokensEstimate = estimate(windowText(windowEvents));
    const prompt = buildPrompt({ windowEvents, carriedSummary, carriedFacts });
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
    totalLatencyMs,
    perWindow,
    failedAtWindow,
  };
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

export function groundingCheck({ summarizedEvents, carriedSummary, carriedFacts }) {
  if (!Array.isArray(summarizedEvents)) throw new TypeError('summarizedEvents are required');
  const firstEventText = summarizedEvents[0]?.output ?? '';
  const lastEventText = summarizedEvents[summarizedEvents.length - 1]?.output ?? '';
  const firstFact = firstNonEmptyFact(firstEventText);
  const lastFact = lastNonEmptyFact(lastEventText);
  const haystack = `${carriedSummary ?? ''}\n${(carriedFacts ?? []).join('\n')}`;
  return {
    firstFact,
    lastFact,
    firstFactSurvived: firstFact !== undefined && haystack.includes(firstFact),
    lastFactSurvived: lastFact !== undefined && haystack.includes(lastFact),
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
      totalLatencyMs: 0,
      perWindow: [],
      failedAtWindow: null,
    };

  const originalText = windowText(events);
  const originalTokens = estimateTokens(originalText);
  const summaryText = foldResult.carriedSummary ?? '';
  const rawRecentText = windowText(retainedEvents);
  const finalText = [summaryText, rawRecentText].filter(Boolean).join('\n---\n');
  const finalSummaryTokens = estimateTokens(summaryText);
  const rawRecentTokens = estimateTokens(rawRecentText);
  const finalResultTokens = estimateTokens(finalText);
  const grossSavedTokens = originalTokens - finalResultTokens;
  const netSavedTokens = grossSavedTokens - foldResult.totalCompactorInputTokens - foldResult.totalCompactorOutputTokens;
  const netSavedPercent = originalTokens > 0 ? (netSavedTokens / originalTokens) * 100 : 0;

  const grounding = groundingCheck({
    summarizedEvents,
    carriedSummary: foldResult.carriedSummary,
    carriedFacts: foldResult.carriedFacts,
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
    originalTokens,
    compactorInputTokens: foldResult.totalCompactorInputTokens,
    compactorOutputTokens: foldResult.totalCompactorOutputTokens,
    finalSummaryTokens,
    rawRecentTokens,
    finalResultTokens,
    netSavedTokens,
    netSavedPercent,
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
    originalTokens,
    compactorInputTokens: report.compactorInputTokens,
    compactorOutputTokens: report.compactorOutputTokens,
    finalSummaryTokens,
    rawRecentTokens,
    finalResultTokens,
    netSavedTokens,
    netSavedPercent,
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
