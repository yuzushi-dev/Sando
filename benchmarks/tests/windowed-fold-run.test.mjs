import assert from 'node:assert/strict';
import test from 'node:test';

import { findCutPoint, planWindows, foldWindows, groundingCheck } from '../live/windowed-fold-run.mjs';

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

test('net savings computed correctly from known numbers', () => {
  const originalTokens = 1000;
  const finalSummaryTokens = 100;
  const compactorInputTokens = 200;
  const compactorOutputTokens = 50;
  const grossSavedTokens = originalTokens - finalSummaryTokens;
  const netSavedTokens = grossSavedTokens - compactorInputTokens - compactorOutputTokens;
  const netSavedPercent = (netSavedTokens / originalTokens) * 100;
  assert.equal(grossSavedTokens, 900);
  assert.equal(netSavedTokens, 650);
  assert.equal(netSavedPercent, 65);
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
