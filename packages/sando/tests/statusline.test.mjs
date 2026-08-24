import assert from 'node:assert/strict';
import test from 'node:test';

import { renderStatusLine } from '../src/statusline.mjs';

const current = '2026-08-24T10:00:00.000Z';

test('renders estimated savings and provider-reported usage separately', () => {
  assert.equal(renderStatusLine({
    metrics: { updatedAt: current, source: 'estimate', savedTokens: 40 },
    providerUsage: {
      updatedAt: current, eventCount: 1, inputTokens: 150,
      cachedInputTokens: 30, cacheWriteInputTokens: 20, outputTokens: 7,
    },
  }, Date.parse(current)), '🥪 ~40 saved · 150in/7out · c30/w20');
});

test('renders provider usage when no Sando savings metric exists', () => {
  assert.equal(renderStatusLine({
    providerUsage: { updatedAt: current, eventCount: 1, inputTokens: 10, outputTokens: 2 },
  }, Date.parse(current)), '🥪 provider 10in/2out');
});

test('marks old data stale and missing data empty', () => {
  assert.equal(renderStatusLine({
    metrics: { updatedAt: current, source: 'estimate', savedTokens: 40 },
  }, Date.parse(current) + 5 * 60 * 1000 + 1), '🥪 stale');
  assert.equal(renderStatusLine({}, Date.parse(current)), '🥪 —');
});
