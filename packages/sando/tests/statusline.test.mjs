import assert from 'node:assert/strict';
import test from 'node:test';

import { renderStatusLine } from '../src/statusline.mjs';

const current = '2026-08-24T10:00:00.000Z';

test('renders estimated context savings without provider usage', () => {
  assert.equal(renderStatusLine({
    metrics: {
      updatedAt: current, source: 'estimate', savedTokens: 2_510_000, estimatedInputTokens: 6_605_263,
    },
  }, Date.parse(current)), '🥪 saved ~2.51M ctx tok (38%)');
});

test('does not turn an estimate into a cost claim', () => {
  assert.equal(renderStatusLine({
    metrics: {
      updatedAt: current, source: 'estimate', savedTokens: 2_510_000, estimatedInputTokens: 6_605_263,
    },
    providerUsage: { totalTokens: 5_000_000 },
    totalCostUsd: 10,
  }, Date.parse(current)), '🥪 saved ~2.51M ctx tok (38%)');
});

test('renders provider-reported context savings without a tilde', () => {
  assert.equal(renderStatusLine({
    metrics: {
      updatedAt: current, source: 'provider-reported', savedTokens: 2_500_000, estimatedInputTokens: 5_000_000,
    },
    providerUsage: { totalTokens: 5_000_000, turnCount: 4, weightedCostUnits: 2_000_000 },
    totalCostUsd: 10,
  }, Date.parse(current)), '🥪 saved 2.5M ctx tok (50%)');
});

test('renders estimated savings with compact tokens and percentage', () => {
  assert.equal(renderStatusLine({
    metrics: { updatedAt: current, source: 'estimate', savedTokens: 2_510, estimatedInputTokens: 6_605 },
  }, Date.parse(current)), '🥪 saved ~2.5k ctx tok (38%)');
});

test('renders no data when metrics are unavailable', () => {
  assert.equal(renderStatusLine({
    providerUsage: { totalTokens: 5_000_000, turnCount: 4, weightedCostUnits: 2_000_000 },
    totalCostUsd: 10,
  }, Date.parse(current)), '🥪 —');
});

test('does not mark old savings stale', () => {
  assert.equal(renderStatusLine({
    metrics: { updatedAt: current, source: 'estimate', savedTokens: 40, estimatedInputTokens: 100 },
  }, Date.parse(current) + 5 * 60 * 1000 + 1), '🥪 saved ~40 ctx tok (40%)');
  assert.equal(renderStatusLine({}, Date.parse(current)), '🥪 —');
});
