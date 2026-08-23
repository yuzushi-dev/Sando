import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateProviderLedger,
  createProviderLedgerEntry,
} from '../src/provider-ledger.mjs';

function entry(overrides = {}) {
  return createProviderLedgerEntry({
    provider: 'claude',
    model: 'claude-test',
    sessionId: 'session-1',
    at: '2026-01-05T12:00:00.000Z',
    usage: {
      promptTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    rawUsage: { input_tokens: 100, output_tokens: 10 },
    ...overrides,
  });
}

test('records cache hits separately and excludes them from effective input', () => {
  const rawUsage = {
    input_tokens: 100,
    cache_read_input_tokens: 80,
    output_tokens: 10,
    provider_extra: { request_id: 'req-1' },
  };
  const result = entry({
    usage: { promptTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0 },
    rawUsage,
  });

  assert.deepEqual(result.usage, {
    promptTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    effectiveInputTokens: 20,
    totalTokens: 110,
  });
  assert.deepEqual(result.rawUsage, rawUsage);
  assert.equal(Object.hasOwn(result, 'savings'), false);
});

test('counts cache writes as uncached prompt input on a miss', () => {
  const result = entry({
    usage: { promptTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 100 },
  });

  assert.equal(result.usage.effectiveInputTokens, 100);
  assert.equal(result.usage.cacheReadTokens, 0);
  assert.equal(result.usage.cacheWriteTokens, 100);
});

test('fails closed when usage is missing or malformed', () => {
  assert.equal(entry({ usage: undefined }), null);
  for (const usage of [
    { promptTokens: -1, outputTokens: 1 },
    { promptTokens: 1.5, outputTokens: 1 },
    { promptTokens: 1, outputTokens: 1, cacheReadTokens: 2 },
    { promptTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 },
    { promptTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
  ]) {
    assert.equal(entry({ usage }), null, JSON.stringify(usage));
  }
});

test('aggregates cumulative usage without turning cache reads into savings', () => {
  const records = [
    entry({ usage: { promptTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0 } }),
    entry({ usage: { promptTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 50 } }),
  ];
  const result = aggregateProviderLedger(records, 'session');

  assert.deepEqual(result.buckets, [{
    period: 'session-1',
    entryCount: 2,
    usage: {
      promptTokens: 150,
      outputTokens: 15,
      cacheReadTokens: 80,
      cacheWriteTokens: 50,
      effectiveInputTokens: 70,
      totalTokens: 165,
    },
  }]);
});

test('aggregates session, UTC day, ISO week, and UTC month periods', () => {
  const records = [
    entry({ sessionId: 'session-1', at: '2025-12-31T23:59:00.000Z' }),
    entry({ sessionId: 'session-2', at: '2026-01-04T23:59:00.000Z' }),
    entry({ sessionId: 'session-3', at: '2026-01-05T00:00:00.000Z' }),
  ];

  assert.deepEqual(aggregateProviderLedger(records, 'session').buckets.map(({ period }) => period), [
    'session-1', 'session-2', 'session-3',
  ]);
  assert.deepEqual(aggregateProviderLedger(records, 'day').buckets.map(({ period }) => period), [
    '2025-12-31', '2026-01-04', '2026-01-05',
  ]);
  assert.deepEqual(aggregateProviderLedger(records, 'week').buckets.map(({ period }) => period), [
    '2026-W01', '2026-W02',
  ]);
  assert.deepEqual(aggregateProviderLedger(records, 'month').buckets.map(({ period }) => period), [
    '2025-12', '2026-01',
  ]);
});

test('rejects malformed records and unsafe aggregate totals', () => {
  assert.throws(() => aggregateProviderLedger([null], 'session'), /invalid provider ledger entry/);
  assert.throws(() => aggregateProviderLedger([entry({
    usage: { promptTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }), entry({
    sessionId: 'session-2',
    usage: { promptTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  })], 'day'), /aggregate overflow/);
});
