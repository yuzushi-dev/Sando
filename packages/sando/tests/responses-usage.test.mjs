import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeResponsesUsage } from '../src/responses-usage.mjs';

const complete = {
  input_tokens: 100_000, output_tokens: 2_000,
  input_tokens_details: { cached_tokens: 80_000, cache_write_tokens: 10_000 },
  output_tokens_details: { reasoning_tokens: 1_500 },
};

test('distributed normalizers match canonical behavior', async () => {
  for (const directory of ['adapters/claude/sando', 'adapters/codex/sando', 'plugins/sando']) {
    const bundle = await import(`../../../${directory}/lib/responses-usage.mjs`);
    for (const usage of [complete, { input_tokens: 2, output_tokens: 1 }, { ...complete, cache_write_input_tokens: 1 }]) {
      assert.deepEqual(bundle.normalizeResponsesUsage(usage), normalizeResponsesUsage(usage));
    }
  }
});

test('complete counters retain observed zero and the selected field sources', () => {
  const result = normalizeResponsesUsage(complete);
  assert.equal(result.quality.status, 'complete');
  assert.equal(result.usage.cacheWriteInputTokens, 10_000);
  assert.equal(result.quality.sources.cacheWriteInputTokens, 'input_tokens_details.cache_write_tokens');
  const zero = normalizeResponsesUsage({ ...complete, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } });
  assert.equal(zero.quality.status, 'complete');
  assert.equal(zero.usage.cacheWriteInputTokens, 0);
});

test('legacy counters remain compatible but missing counters are not observed zeros', () => {
  const result = normalizeResponsesUsage({ input_tokens: 10, output_tokens: 2 });
  assert.equal(result.usage.cacheWriteInputTokens, 0);
  assert.equal(result.quality.status, 'incomplete');
  assert.deepEqual(result.quality.missing, ['cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens']);
  const legacy = normalizeResponsesUsage({ input_tokens: 10, output_tokens: 2,
    cached_input_tokens: 3, cache_write_input_tokens: 2, reasoning_output_tokens: 1 });
  assert.equal(legacy.quality.status, 'complete');
  assert.equal(legacy.usage.cacheWriteInputTokens, 2);
});

test('discordant aliases fail closed and diagnostics contain only field identifiers', () => {
  for (const alias of [
    { cache_write_input_tokens: 999 },
    { cached_input_tokens: 999 },
    { cache_read_input_tokens: 999 },
    { reasoning_output_tokens: 999 },
  ]) {
    const result = normalizeResponsesUsage({ ...complete, ...alias, secret: 'private-value' });
    assert.equal(result.usage, null);
    assert.equal(result.quality.status, 'invalid');
    assert.ok(result.quality.errors.some((error) => error.code === 'conflicting-aliases'));
    assert.doesNotMatch(JSON.stringify(result), /private-value/);
  }
  assert.equal(normalizeResponsesUsage({ ...complete, cache_write_input_tokens: 10_000 }).quality.status, 'complete');
});

test('rejects malformed counters, unsafe totals and impossible subdivisions', () => {
  for (const value of [-1, '10', 1.5, NaN, Infinity, null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeResponsesUsage({ ...complete, input_tokens: value }).quality.status, 'invalid');
    assert.equal(normalizeResponsesUsage({ ...complete, cache_write_input_tokens: value }).quality.status, 'invalid');
  }
  for (const change of [
    { input_tokens: 89_999 }, { output_tokens: 1_499 }, { total_tokens: 0 },
    { input_tokens: Number.MAX_SAFE_INTEGER }, { input_tokens_details: [] },
    { output_tokens_details: 'invalid' },
  ]) {
    assert.equal(normalizeResponsesUsage({ ...complete, ...change }).usage, null);
  }
});
