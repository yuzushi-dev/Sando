import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectHistoryCandidates,
  validateMaxHistoryTokens,
} from '../src/history-budget.mjs';

test('validates maxHistoryTokens as a positive safe integer', () => {
  assert.equal(validateMaxHistoryTokens(10_000), 10_000);

  for (const value of [undefined, null, 0, -1, 1.5, '10000', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validateMaxHistoryTokens(value), {
      name: 'TypeError',
      message: 'maxHistoryTokens must be a positive safe integer',
    });
  }
});

test('selects nothing until body tokens exceed 80% of the budget', () => {
  const candidates = [
    { id: 'old', position: 0, estimatedTokens: 100, historical: true, safe: true },
  ];

  assert.deepEqual(selectHistoryCandidates({ bodyTokens: 800, maxHistoryTokens: 1_000, candidates }), []);
  assert.deepEqual(selectHistoryCandidates({ bodyTokens: 801, maxHistoryTokens: 1_000, candidates }), candidates);
});

test('fails closed for errors, current results, and ambiguous candidates', () => {
  const eligible = { id: 'eligible', position: 0, estimatedTokens: 10, historical: true, safe: true };
  const candidates = [
    eligible,
    { id: 'error', position: 1, estimatedTokens: 100, historical: true, safe: true, error: true },
    { id: 'current', position: 2, estimatedTokens: 100, historical: true, safe: true, current: true },
    { id: 'not-history', position: 3, estimatedTokens: 100, historical: false, safe: true },
    { id: 'not-proven-safe', position: 4, estimatedTokens: 100, historical: true },
    { id: 'bad-position', position: -1, estimatedTokens: 100, historical: true, safe: true },
    { id: 'bad-size', position: 5, estimatedTokens: 0, historical: true, safe: true },
    { id: '', position: 6, estimatedTokens: 100, historical: true, safe: true },
    { id: 'duplicate', position: 7, estimatedTokens: 100, historical: true, safe: true },
    { id: 'duplicate', position: 8, estimatedTokens: 100, historical: true, safe: true },
    null,
  ];

  assert.deepEqual(selectHistoryCandidates({ bodyTokens: 801, maxHistoryTokens: 1_000, candidates }), [eligible]);
});

test('prioritizes older candidates, then larger candidates at the same position', () => {
  const oldestLarge = { id: 'old-large', position: 1, estimatedTokens: 200, historical: true, safe: true };
  const oldestSmall = { id: 'old-small', position: 1, estimatedTokens: 50, historical: true, safe: true };
  const newerHuge = { id: 'new-huge', position: 2, estimatedTokens: 500, historical: true, safe: true };

  assert.deepEqual(
    selectHistoryCandidates({
      bodyTokens: 900,
      maxHistoryTokens: 1_000,
      candidates: [newerHuge, oldestSmall, oldestLarge],
    }),
    [oldestLarge, oldestSmall, newerHuge],
  );
});

test('fails closed for invalid body token counts and candidate collections', () => {
  const candidate = { id: 'old', position: 0, estimatedTokens: 100, historical: true, safe: true };

  for (const bodyTokens of [undefined, null, -1, 1.5, '801', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(selectHistoryCandidates({ bodyTokens, maxHistoryTokens: 1_000, candidates: [candidate] }), []);
  }
  assert.deepEqual(selectHistoryCandidates({ bodyTokens: 801, maxHistoryTokens: 1_000 }), []);
  assert.deepEqual(selectHistoryCandidates({ bodyTokens: 801, maxHistoryTokens: 1_000, candidates: {} }), []);
});
