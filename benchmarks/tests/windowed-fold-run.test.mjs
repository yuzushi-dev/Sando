import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findCutPoint,
  planWindows,
  foldWindows,
  groundingCheck,
  pruneRepeatedLines,
  extractFactLedger,
  computeCalibrationRatio,
  computeNetSavings,
} from '../live/windowed-fold-run.mjs';

function ev(id, output) {
  return { id, toolName: 'test', output, isError: false };
}

const estimate = (text) => text.length;

test('findCutPoint keeps the newest events until the estimated budget is reached', () => {
  const events = [ev('a', 'aaa'), ev('b', 'bbbb'), ev('c', 'ccccc'), ev('d', 'dddddd')];
  assert.equal(findCutPoint(events, 10, estimate), 2);
});

test('findCutPoint with zero budget keeps only the newest event', () => {
  const events = [ev('a', 'aaa'), ev('b', 'bbbb')];
  assert.equal(findCutPoint(events, 0, estimate), 1);
});

test('planWindows packs events until budget, opens new window on overflow', () => {
  const events = [ev('a', 'xxx'), ev('b', 'xxx'), ev('c', 'xxx')];
  const windows = planWindows(events, 11, estimate);
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0].map((e) => e.id), ['a', 'b']);
  assert.deepEqual(windows[1].map((e) => e.id), ['c']);
});

test('planWindows puts an oversized single event alone in its own window', () => {
  const events = [ev('a', 'x'.repeat(5)), ev('big', 'x'.repeat(100)), ev('c', 'x'.repeat(5))];
  const windows = planWindows(events, 20, estimate);
  assert.equal(windows.length, 3);
  assert.deepEqual(windows[1].map((e) => e.id), ['big']);
});

test('foldWindows carries prior summary and facts into the next prompt', async () => {
  const events = [[ev('a', 'first excerpt')], [ev('b', 'second excerpt')]];
  const prompts = [];
  const complete = async ({ prompt }) => {
    prompts.push(prompt);
    if (prompts.length === 1) {
      return { summary: 'summary one', preservedFacts: ['fact-one'], usage: { inputTokens: 10, outputTokens: 5 } };
    }
    return { summary: 'summary two', preservedFacts: ['fact-two'], usage: { inputTokens: 12, outputTokens: 6 } };
  };
  const result = await foldWindows(events, complete, { estimate: (t) => t.length });
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[0].includes('Previous summary'));
  assert.ok(prompts[1].includes('summary one'));
  assert.ok(prompts[1].includes('fact-one'));
  assert.equal(result.carriedSummary, 'summary two');
  assert.deepEqual(result.carriedFacts, ['fact-one', 'fact-two']);
  assert.equal(result.totalCompactorInputTokens, 22);
  assert.equal(result.totalCompactorOutputTokens, 11);
  assert.equal(result.failedAtWindow, null);
  assert.equal(result.perWindow.length, 2);
  assert.equal(result.perWindow[0].status, 'ok');
  assert.equal(result.perWindow[1].status, 'ok');
});

test('foldWindows stops after a failing window and does not call later windows', async () => {
  const events = [[ev('a', 'first')], [ev('b', 'second')], [ev('c', 'third')]];
  let calls = 0;
  const complete = async () => {
    calls += 1;
    if (calls === 1) return { summary: 's1', preservedFacts: [], usage: { inputTokens: 1, outputTokens: 1 } };
    throw new Error('boom');
  };
  const result = await foldWindows(events, complete, { estimate: (t) => t.length });
  assert.equal(calls, 2);
  assert.equal(result.failedAtWindow, 1);
  assert.equal(result.perWindow.length, 2);
  assert.equal(result.perWindow[1].status, 'failed');
  assert.equal(result.perWindow[1].error, 'boom');
});

test('computeNetSavings with calibrationRatio 1 matches the plain-arithmetic case', () => {
  const result = computeNetSavings({
    originalTokensEstimate: 1000,
    finalResultTokensEstimate: 100,
    compactorInputTokens: 200,
    compactorOutputTokens: 50,
    calibrationRatio: 1,
  });
  assert.equal(result.grossSavedTokens, 900);
  assert.equal(result.netSavedTokens, 650);
  assert.equal(result.netSavedPercent, 65);
});

test('computeNetSavings scales estimator-basis tokens by calibrationRatio before subtracting real provider tokens', () => {
  // Local estimator says 1000/100; the run's own calibration shows it undercounts by 1.4x
  // against what the provider actually billed for the compactor call.
  const result = computeNetSavings({
    originalTokensEstimate: 1000,
    finalResultTokensEstimate: 100,
    compactorInputTokens: 1300,
    compactorOutputTokens: 50,
    calibrationRatio: 1.4,
  });
  assert.equal(result.originalTokens, 1400);
  assert.equal(result.finalResultTokens, 140);
  assert.equal(result.grossSavedTokens, 1260);
  assert.equal(result.netSavedTokens, -90);
});

test('computeCalibrationRatio derives the run-specific undercount from real vs. estimated compactor input', () => {
  assert.equal(computeCalibrationRatio(140, 100), 1.4);
});

test('computeCalibrationRatio falls back to 1 (no correction) when nothing was estimated', () => {
  assert.equal(computeCalibrationRatio(0, 0), 1);
});

test('pruneRepeatedLines keeps the first N repeats and collapses the rest', () => {
  const text = ['same', 'same', 'same', 'same', 'other'].join('\n');
  const pruned = pruneRepeatedLines(text, { keepFirstN: 2 });
  assert.equal(pruned, ['same', 'same', '[... repeated line collapsed ...]', 'other'].join('\n'));
});

test('pruneRepeatedLines leaves non-repeated content untouched', () => {
  const text = 'line one\nline two\nline three';
  assert.equal(pruneRepeatedLines(text), text);
});

test('extractFactLedger pulls file paths, SHAs, issue refs, error and negation lines mechanically', () => {
  const events = [
    ev('a', 'changed src/core/index.mjs at commit 4a9f8c2e1'),
    ev('b', 'fixes issue #421, closes PR 88'),
    ev('c', 'Error: cannot read property of undefined'),
    ev('d', 'the migration does not touch the users table'),
  ];
  const { ledger, droppedCount } = extractFactLedger(events);
  assert.ok(ledger.some((f) => f.includes('src/core/index.mjs')));
  assert.ok(ledger.some((f) => f.includes('4a9f8c2e1')));
  assert.ok(ledger.some((f) => /issue\s*#?421/i.test(f) || /PR\s*88/i.test(f)));
  assert.ok(ledger.some((f) => f.includes('cannot read property of undefined')));
  assert.ok(ledger.some((f) => f.includes('does not touch')));
  assert.equal(droppedCount, 0);
});

test('extractFactLedger caps total tokens and reports how many entries were dropped, never silently', () => {
  const events = Array.from({ length: 50 }, (_, i) => ev(`e${i}`, `this does not touch item ${i} at all`));
  const { ledger, droppedCount, usedTokens } = extractFactLedger(events, { maxTokens: 50, estimate: (t) => t.length });
  assert.ok(usedTokens <= 50);
  assert.ok(ledger.length < events.length);
  assert.equal(droppedCount, events.length - ledger.length);
});

test('groundingCheck survives via the mechanical ledger even when the LLM summary drops the fact (whole-line capture)', () => {
  const summarizedEvents = [ev('e', 'Error: cannot read property of undefined')];
  const droppedByLlm = groundingCheck({
    summarizedEvents,
    carriedSummary: 'a summary that lost the specific fact',
    carriedFacts: [],
  });
  assert.equal(droppedByLlm.firstFactSurvived, false);

  const withLedger = groundingCheck({
    summarizedEvents,
    carriedSummary: 'a summary that lost the specific fact',
    carriedFacts: [],
    factLedger: extractFactLedger(summarizedEvents).ledger,
  });
  assert.equal(withLedger.firstFactSurvived, true);
});

test('groundingCheck counts a fact as survived when the ledger preserves a meaningful substring, not just a whole-line match', () => {
  // pickFact() selects the whole line "changed path /tmp/sando/core.mjs at commit
  // 4a9f8c2e1"; the path/SHA ledger patterns capture only the matched substrings, not
  // the surrounding prose. That's the ledger doing its job (Hermes-style anchor
  // preservation), not the fact getting lost — groundingCheck must count it as survived.
  const summarizedEvents = [ev('e', 'changed path /tmp/sando/core.mjs at commit 4a9f8c2e1')];
  const { ledger } = extractFactLedger(summarizedEvents);
  const withLedgerOnly = groundingCheck({
    summarizedEvents,
    carriedSummary: 'an unrelated paraphrased summary',
    carriedFacts: [],
    factLedger: ledger,
  });
  assert.equal(withLedgerOnly.firstFactSurvived, true);

  const withoutLedger = groundingCheck({
    summarizedEvents,
    carriedSummary: 'an unrelated paraphrased summary',
    carriedFacts: [],
  });
  assert.equal(withoutLedger.firstFactSurvived, false);
});

test('groundingCheck detects survived and lost facts', () => {
  const summarizedEvents = [
    ev('first', 'the first meaningful line here\nmore text'),
    ev('last', 'trailing content\nthe last meaningful line here'),
  ];
  const survived = groundingCheck({
    summarizedEvents,
    carriedSummary: 'recap includes the first meaningful line here and other stuff',
    carriedFacts: ['the last meaningful line here'],
  });
  assert.equal(survived.firstFactSurvived, true);
  assert.equal(survived.lastFactSurvived, true);

  const lost = groundingCheck({
    summarizedEvents,
    carriedSummary: 'completely unrelated summary text',
    carriedFacts: [],
  });
  assert.equal(lost.firstFactSurvived, false);
  assert.equal(lost.lastFactSurvived, false);
});

test('groundingCheck selects anchors from the summarized torso, never the retained tail', () => {
  const events = [
    ev('torso-start', 'changed path /tmp/sando/core.mjs'),
    ev('torso-end', 'failed assertion error 42'),
    ev('raw-tail', 'tail-only fact 9001'),
  ];
  const cutPoint = findCutPoint(events, 5, estimate);
  const result = groundingCheck({
    summarizedEvents: events.slice(0, cutPoint),
    retainedEvents: events.slice(cutPoint),
    carriedSummary: 'tail-only fact 9001',
    carriedFacts: ['tail-only fact 9001'],
  });

  assert.equal(cutPoint, 2);
  assert.equal(result.firstFact, 'changed path /tmp/sando/core.mjs');
  assert.equal(result.lastFact, 'failed assertion error 42');
  assert.equal(result.firstFactSurvived, false);
  assert.equal(result.lastFactSurvived, false);
});
