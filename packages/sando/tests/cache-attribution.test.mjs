import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attributeSession,
  attributeTurn,
  CACHE_MISS_CAUSES,
  firstDivergence,
  hasBreakpoint,
  messageDigests,
} from '../src/cache-attribution.mjs';

const MARK = { type: 'ephemeral' };
const usage = (cached, write = 0, fresh = 0) =>
  ({ cachedInputTokens: cached, cacheWriteInputTokens: write, inputTokens: fresh });

function turn({ at = '2026-08-25T10:00:00.000Z', cached = 0, write = 0, fresh = 2000,
  tools = ['Read'], system = ['sys'], messages = [{ role: 'user', content: 'a' }], body } = {}) {
  return { at, usage: usage(cached, write, fresh), tools, system, messages,
    body: body ?? { messages, cache_control: MARK } };
}

test('a turn with cache reads is a hit and carries no cause', () => {
  const result = attributeTurn({ current: turn({ cached: 5000 }), previous: turn() });
  assert.equal(result.hit, true);
  assert.equal(result.cause, null);
  assert.equal(result.cacheReadTokens, 5000);
});

test('the first turn of a session is a cold start, not a defect', () => {
  const result = attributeTurn({ current: turn(), previous: null });
  assert.equal(result.hit, false);
  assert.equal(result.cause, 'cold-start');
});

test('a changed tool array outranks every later cause', () => {
  // Anthropic invalidates tools -> system -> messages, so a tools change explains
  // the system and message misses that follow it.
  const previous = turn();
  const current = turn({ tools: ['Read', 'Write'], system: ['different'],
    messages: [{ role: 'user', content: 'rewritten' }] });
  assert.equal(attributeTurn({ current, previous }).cause, 'tools-changed');
});

test('a reordered tool array counts as changed', () => {
  const previous = turn({ tools: ['Read', 'Write'] });
  const current = turn({ tools: ['Write', 'Read'] });
  assert.equal(attributeTurn({ current, previous }).cause, 'tools-changed');
});

test('a changed system prompt outranks a message rewrite', () => {
  const previous = turn();
  const current = turn({ system: ['sys', 'plus a per-turn timestamp'],
    messages: [{ role: 'user', content: 'rewritten' }] });
  assert.equal(attributeTurn({ current, previous }).cause, 'system-changed');
});

test('rewriting an already-sent message is attributed and located', () => {
  const previous = turn({ messages: [
    { role: 'user', content: 'one' },
    { role: 'user', content: 'two' },
    { role: 'user', content: 'three' },
  ] });
  const current = turn({ messages: [
    { role: 'user', content: 'one' },
    { role: 'user', content: 'REWRITTEN' },
    { role: 'user', content: 'three' },
  ] });
  const result = attributeTurn({ current, previous });
  assert.equal(result.cause, 'history-rewritten');
  assert.equal(result.divergedAtMessage, 1);
  assert.equal(result.messagesBeforeDivergence, 1);
});

test('appending to history is not a rewrite', () => {
  const previous = turn({ messages: [{ role: 'user', content: 'one' }] });
  const current = turn({ messages: [
    { role: 'user', content: 'one' },
    { role: 'user', content: 'two' },
  ] });
  const result = attributeTurn({ current, previous });
  assert.equal(result.divergedAtMessage, null);
  assert.notEqual(result.cause, 'history-rewritten');
});

test('a request with no breakpoint is attributed to that, not to the history', () => {
  const messages = [{ role: 'user', content: 'same' }];
  const result = attributeTurn({
    current: { ...turn({ messages }), body: { messages } },
    previous: turn({ messages }),
  });
  assert.equal(result.cause, 'no-breakpoint');
  assert.equal(result.breakpointPresent, false);
});

test('a prompt below the cacheable minimum is expected to miss', () => {
  const messages = [{ role: 'user', content: 'short' }];
  const result = attributeTurn({
    current: turn({ messages, fresh: 100 }),
    previous: turn({ messages }),
  });
  assert.equal(result.cause, 'below-minimum');
});

test('a gap wider than the longest TTL explains the miss', () => {
  const messages = [{ role: 'user', content: 'same' }];
  const result = attributeTurn({
    current: turn({ messages, at: '2026-08-25T12:00:00.000Z' }),
    previous: turn({ messages, at: '2026-08-25T10:00:00.000Z' }),
  });
  assert.equal(result.cause, 'ttl-expired');
});

test('an unexplained miss is reported as such rather than guessed', () => {
  const messages = [{ role: 'user', content: 'same' }];
  const result = attributeTurn({
    current: turn({ messages, at: '2026-08-25T10:00:30.000Z' }),
    previous: turn({ messages, at: '2026-08-25T10:00:00.000Z' }),
  });
  assert.equal(result.cause, 'unexplained');
  assert.ok(CACHE_MISS_CAUSES.includes(result.cause));
});

test('session summary reports write volume, not just hit rate', () => {
  // A session can look healthy on hit rate while re-writing most of the prompt:
  // writes bill at 1.25x-2x base input, reads at 0.1x.
  const summary = attributeSession([
    turn({ cached: 0, write: 10_000 }),
    turn({ cached: 100, write: 40_000 }),
    turn({ cached: 100, write: 40_000 }),
  ]);
  assert.equal(summary.turns, 3);
  assert.equal(summary.hits, 2);
  assert.ok(Math.abs(summary.hitRate - 2 / 3) < 1e-9);
  assert.equal(summary.cacheWriteTokens, 90_000);
  assert.equal(summary.cacheReadTokens, 200);
  assert.equal(summary.writeToReadRatio, 450);
  assert.equal(summary.causes['cold-start'], 1);
});

test('helpers behave', () => {
  assert.deepEqual(messageDigests(null), []);
  assert.equal(firstDivergence(['a', 'b'], ['a', 'b', 'c']), null);
  assert.equal(firstDivergence(['a', 'b'], ['a']), 1);
  assert.equal(hasBreakpoint({ messages: [{ content: [{ cache_control: MARK }] }] }), true);
  assert.equal(hasBreakpoint({ messages: [{ content: [{ text: 'x' }] }] }), false);
});
