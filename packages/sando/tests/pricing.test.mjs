import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LUNA_STANDARD_PROFILE_ID, SOL_STANDARD_PROFILE_ID, loadPricingProfile, validatePricingProfile,
  buildApiUsageRequest, estimateApiRequestCost, aggregateApiRequestCosts,
} from '../src/pricing.mjs';
import { runAccountingCli } from '../src/accounting-cli.mjs';
import { DEFAULT_ACCOUNTING_WEIGHTS, summarizePairedSessions } from '../src/paired-accounting.mjs';
import { buildProviderUsageReport } from '../src/provider-usage.mjs';

const response = {
  object: 'response', status: 'completed', id: 'resp-synthetic-1',
  model: 'gpt-6.1-sol', service_tier: 'default',
  usage: { input_tokens: 100_000, output_tokens: 2_000,
    input_tokens_details: { cached_tokens: 80_000, cache_write_tokens: 10_000 },
    output_tokens_details: { reasoning_tokens: 1_500 } },
};
function request(overrides = {}, options = {}) {
  return buildApiUsageRequest({ response: { ...response, ...overrides },
    regionalSurcharge: false, provenance: 'synthetic', sessionId: 'session-1', ...options });
}
const profile = () => loadPricingProfile(SOL_STANDARD_PROFILE_ID);
const lunaProfile = () => loadPricingProfile(LUNA_STANDARD_PROFILE_ID);

function lunaRequest(inputTokens = 100_000, cachedInputTokens = 90_000, cacheWriteInputTokens = 0) {
  return buildApiUsageRequest({ response: {
    object: 'response', status: 'completed', id: `resp-luna-${inputTokens}`,
    model: 'gpt-6-luna', service_tier: 'default',
    usage: { input_tokens: inputTokens, output_tokens: 1_000,
      input_tokens_details: { cached_tokens: cachedInputTokens, cache_write_tokens: cacheWriteInputTokens },
      output_tokens_details: { reasoning_tokens: 250 } },
  }, regionalSurcharge: false, provenance: 'synthetic', sessionId: 'luna-session' });
}

test('versioned profile keeps exact scope, threshold, date and official sources', () => {
  const value = profile();
  assert.equal(value.id, 'openai-gpt-6.1-sol-standard-2026-09-30');
  assert.equal(value.long_context_input_threshold, 272_000);
  assert.equal(value.long_context_operator, '>');
  assert.equal(value.verified_on, '2026-09-30');
  assert.ok(value.sources.includes('https://developers.openai.com/api/docs/pricing'));
  assert.throws(() => loadPricingProfile('../outside'), /unsupported|invalid/);
  assert.throws(() => loadPricingProfile('unknown'), /unsupported/);
  for (const change of [{ short: { ...value.short, fresh: -1 } }, { unit_tokens: '1000000' },
    { long_context_operator: '>=' }, { sources: [] }, { currency: 'EUR' },
    { short: { ...value.short, fresh: 0 } }, { verified_on: '2099-99-99' }]) {
    assert.throws(() => validatePricingProfile({ ...value, ...change }));
  }
  assert.deepEqual(DEFAULT_ACCOUNTING_WEIGHTS, { freshInput: 1, cacheRead: 0.1,
    cacheWrite: 1.25, output: 1, reasoningOutput: 1 });
});

test('synthetic reference costs 0.073 USD with output reasoning counted once', () => {
  const cost = estimateApiRequestCost(request(), profile());
  assert.equal(cost.status, 'priced');
  assert.ok(Math.abs(cost.estimatedApiCostUsd - 0.073) < 1e-12);
  assert.equal(cost.estimatedApiCostNanoUsd, '73000000');
  assert.deepEqual(cost.componentsUsd, { fresh: 0.02, cacheRead: 0.008, cacheWrite: 0.025, output: 0.02 });
  assert.equal(cost.profileId, SOL_STANDARD_PROFILE_ID);
  assert.equal(cost.provenance, 'synthetic');
});

test('Luna standard profile prices short requests with its immutable rates', () => {
  const value = lunaProfile();
  assert.equal(value.id, 'openai-gpt-6-luna-standard-2026-10-01');
  assert.equal(value.model, 'gpt-6-luna');
  assert.equal(value.verified_on, '2026-10-01');
  assert.deepEqual(value.short, { fresh: 0.1, cache_read: 0.01, cache_write: 0.125, output: 0.5 });
  assert.ok(value.sources.includes('https://developers.openai.com/api/docs/models/gpt-6-luna'));

  const cost = estimateApiRequestCost(lunaRequest(), value);
  assert.equal(cost.status, 'priced');
  assert.equal(cost.contextTier, 'short');
  assert.equal(cost.estimatedApiCostUsd, 0.0024);
  assert.equal(cost.estimatedApiCostNanoUsd, '2400000');
  assert.deepEqual(cost.componentsUsd, { fresh: 0.001, cacheRead: 0.0009, cacheWrite: 0, output: 0.0005 });
  assert.equal(cost.profileId, LUNA_STANDARD_PROFILE_ID);

  const withWrite = estimateApiRequestCost(lunaRequest(100_000, 80_000, 10_000), value);
  assert.equal(withWrite.estimatedApiCostNanoUsd, '3550000');
  assert.deepEqual(withWrite.componentsUsd,
    { fresh: 0.001, cacheRead: 0.0008, cacheWrite: 0.00125, output: 0.0005 });
});

test('Luna uses the long tier only above 272000 total input tokens', () => {
  const value = lunaProfile();
  const short = estimateApiRequestCost(lunaRequest(272_000), value);
  const long = estimateApiRequestCost(lunaRequest(272_001), value);
  assert.equal(short.contextTier, 'short');
  assert.equal(long.contextTier, 'long');
  assert.equal(short.estimatedApiCostNanoUsd, '19600000');
  assert.equal(long.estimatedApiCostNanoUsd, '38950200');
});

test('each profile reports its own immutable hash and rejects cross-model pricing or tampering', () => {
  const sol = profile();
  const luna = lunaProfile();
  const solCost = estimateApiRequestCost(request(), sol);
  const lunaCost = estimateApiRequestCost(lunaRequest(), luna);
  assert.notEqual(lunaCost.profileHash, solCost.profileHash);
  assert.equal(aggregateApiRequestCosts([lunaRequest()], luna).profileHash, lunaCost.profileHash);
  assert.equal(estimateApiRequestCost(lunaRequest(), sol).status, 'unpriced');
  assert.equal(estimateApiRequestCost(request(), luna).status, 'unpriced');
  assert.throws(() => validatePricingProfile({ ...luna, short: { ...luna.short, fresh: 0.101 } }), /immutable/);
});

test('the total input including cache selects the tier for the entire request', () => {
  for (const input of [271_999, 272_000, 272_001]) {
    const cost = estimateApiRequestCost(request({ usage: { ...response.usage, input_tokens: input } }), profile());
    const long = input > 272_000;
    assert.equal(cost.contextTier, long ? 'long' : 'short');
    const expected = (input - 90_000) * (long ? 4 : 2) / 1e6
      + 80_000 * (long ? 0.2 : 0.1) / 1e6 + 10_000 * (long ? 5 : 2.5) / 1e6
      + 2_000 * (long ? 15 : 10) / 1e6;
    assert.ok(Math.abs(cost.estimatedApiCostUsd - expected) < 1e-12);
  }
});

test('unsupported model, tier, provider, region and unknown scope do not inherit standard prices', () => {
  for (const record of [request({ model: 'gpt-6-sol' }), request({ service_tier: 'priority' }),
    request({ service_tier: 'auto' }), request({ service_tier: undefined }),
    request({}, { regionalSurcharge: true }), request({}, { regionalSurcharge: undefined }),
    { ...request(), provider: 'other' }, { ...request(), scope: 'turn' },
    { ...request(), provenance: 'unverified' }]) {
    const result = estimateApiRequestCost(record, profile());
    assert.notEqual(result.status, 'priced');
    assert.equal(result.estimatedApiCostUsd, null);
  }
});

test('missing counters and invalid raw values remain unpriceable', () => {
  for (const usage of [{ input_tokens: 2, output_tokens: 1 },
    { ...response.usage, input_tokens: -1 }, { ...response.usage, cache_write_input_tokens: 1 },
    { ...response.usage, output_tokens: '2000' }, { ...response.usage, total_tokens: 0 }]) {
    const result = estimateApiRequestCost(request({ usage }), profile());
    assert.equal(result.estimatedApiCostUsd, null);
    assert.notEqual(result.status, 'priced');
  }
  assert.equal(estimateApiRequestCost(request({ id: undefined }), profile()).estimatedApiCostUsd, null);
  assert.equal(estimateApiRequestCost(request({ status: 'in_progress' }), profile()).estimatedApiCostUsd, null);
});

test('legacy transcript aliases do not establish Responses monetary eligibility', () => {
  const record = request({ usage: { input_tokens: 100_000, output_tokens: 2_000,
    cached_input_tokens: 80_000, cache_write_input_tokens: 10_000, reasoning_output_tokens: 1_500 } });
  assert.equal(record.usageQuality.status, 'complete', 'legacy normalization remains compatible');
  assert.equal(estimateApiRequestCost(record, profile()).estimatedApiCostUsd, null);
});

test('historical completeness assertions cannot hide missing or tampered counters', () => {
  const record = request();
  const missing = { ...record, usage: { ...record.usage } };
  delete missing.usage.cacheWriteInputTokens;
  for (const change of [missing, { ...record, usageQuality: { status: 'complete' } },
    { ...record, usage: { ...record.usage, cachedInputTokens: 110_000 } },
    { ...record, usageQuality: { ...record.usageQuality, missing: ['cacheWriteInputTokens'] } }]) {
    assert.equal(estimateApiRequestCost(change, profile()).estimatedApiCostUsd, null);
  }
});

test('adapter retains only safe accounting data and provider-reported money stays separate', () => {
  const record = request({ output: [{ text: 'private-payload' }], secret: 'private-key',
    usage: { ...response.usage, total_cost_usd: 0.9 } }, { provenance: 'provider-response' });
  const result = estimateApiRequestCost(record, profile());
  assert.equal(result.providerReportedCostUsd, 0.9);
  assert.equal(result.estimatedApiCostUsd, 0.073);
  assert.match(record.requestKey, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(record), /private-payload|private-key|resp-synthetic-1|session-1/);
});

test('synthetic observations cannot establish a provider-reported amount', () => {
  const record = request({ usage: { ...response.usage, total_cost_usd: 0.9 } });
  assert.equal(estimateApiRequestCost(record, profile()).providerReportedCostUsd, null);
  assert.equal(aggregateApiRequestCosts([record], profile()).providerReportedCostUsd, null);
  assert.equal(estimateApiRequestCost({ ...record, providerReportedCostUsd: 0.9 }, profile()).providerReportedCostUsd, null);
});

test('reported decimal amounts aggregate exactly without silently rounding unsupported precision', () => {
  const records = [0.1, 0.2].map((value, index) => request({ id: `reported-${index}`,
    usage: { ...response.usage, total_cost_usd: value } }, { provenance: 'provider-response' }));
  const report = aggregateApiRequestCosts(records, profile());
  assert.equal(report.providerReportedCostUsd, 0.3);
  assert.equal(report.providerReportedCostNanoUsd, '300000000');
  const invalid = request({ usage: { ...response.usage, total_cost_usd: 1e-10 } }, { provenance: 'provider-response' });
  const result = estimateApiRequestCost(invalid, profile());
  assert.equal(result.estimatedApiCostUsd, 0.073);
  assert.equal(result.providerReportedCostUsd, null);
  assert.equal(result.providerReportedCostStatus, 'invalid');
});

test('mixed requests expose supported subtotal and leave the whole cost indeterminate', () => {
  const report = aggregateApiRequestCosts([request(), request({ id: 'resp-2', model: 'gpt-6-sol' }),
    request({ id: 'resp-3', usage: { input_tokens: 10, output_tokens: 2 } })], profile());
  assert.equal(report.pricedRequestCount, 1);
  assert.equal(report.unpricedRequestCount, 2);
  assert.equal(report.supportedEstimatedApiCostUsd, 0.073);
  assert.equal(report.estimatedApiCostUsd, null);
  assert.equal(report.status, 'partial');
});

function ledgerRecord(inputTokens = 10) {
  return { schema: 'sando-provider-usage/v1', version: 1, eventKey: `event-${inputTokens}`,
    host: 'codex', source: 'fixture', sessionId: 'session-1', turnId: 'turn-1', at: '2026-09-30T00:00:00Z',
    inputTokens, outputTokens: 0, totalTokens: inputTokens, cachedInputTokens: 0,
    cacheWriteInputTokens: 0, reasoningOutputTokens: 0, arm: 'apply' };
}

test('provider and paired reports keep API estimates apart from normalized weights', () => {
  const apiRequests = [request({}, { arm: 'apply' }), request({ id: 'control-request' }, { arm: 'control' })];
  const state = { schema: 'sando-provider-usage/v1', version: 1, timezone: 'UTC', records: [ledgerRecord()] };
  const report = buildProviderUsageReport(state, { apiRequests, pricingProfile: profile() });
  assert.equal(report.weightedCostUnits, 10);
  assert.equal(report.apiCost.estimatedApiCostUsd, 0.146);
  assert.equal(report.totalCostUsd, null);
  const paired = summarizePairedSessions(state.records, { host: 'codex', apiRequests, pricingProfile: profile() });
  assert.equal(paired[0].costUnits, 10);
  assert.equal(paired[0].apiCost.estimatedApiCostUsd, 0.073);
});

test('legacy provider reports reject aggregate overflow before publishing totals', () => {
  const first = ledgerRecord(Number.MAX_SAFE_INTEGER);
  const second = { ...ledgerRecord(1), eventKey: 'second-event' };
  assert.throws(() => buildProviderUsageReport({ schema: 'sando-provider-usage/v1', version: 1,
    timezone: 'UTC', records: [first, second] }), /overflow/);
});

test('deduplication preserves distinct requests and quarantines conflicting revisions', () => {
  const first = request();
  const duplicate = structuredClone(first);
  const second = request({ id: 'resp-2' });
  const report = aggregateApiRequestCosts([first, duplicate, second], profile());
  assert.equal(report.pricedRequestCount, 2);
  assert.equal(report.duplicateRequestCount, 1);
  assert.equal(report.estimatedApiCostUsd, 0.146);
  const conflict = request({ usage: { ...response.usage, input_tokens: 100_001 } });
  const invalid = aggregateApiRequestCosts([first, conflict, second], profile());
  assert.equal(invalid.pricedRequestCount, 1);
  assert.equal(invalid.unpricedRequestCount, 1);
  assert.equal(invalid.estimatedApiCostUsd, null);
  const reordered = { ...first, usage: Object.fromEntries(Object.entries(first.usage).reverse()),
    usageQuality: { ...first.usageQuality, sources: Object.fromEntries(Object.entries(first.usageQuality.sources).reverse()) } };
  assert.equal(aggregateApiRequestCosts([first, reordered], profile()).duplicateRequestCount, 1);
});

test('aggregation does not round per request and rejects unsafe counter totals', () => {
  const records = Array.from({ length: 1000 }, (_, index) => request({ id: `resp-${index}` }));
  assert.equal(aggregateApiRequestCosts(records, profile()).estimatedApiCostNanoUsd, '73000000000');
  assert.ok(Math.abs(aggregateApiRequestCosts(records, profile()).estimatedApiCostUsd - 73) < 1e-12);
  const usage = { input_tokens: Number.MAX_SAFE_INTEGER - 1, output_tokens: 1,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 } };
  assert.throws(() => aggregateApiRequestCosts([request({ id: 'large-1', usage }),
    request({ id: 'large-2', usage })], profile()), /overflow/);
});

test('distributed pricing modules load the same versioned profile', async () => {
  for (const root of ['adapters/claude/sando', 'adapters/codex/sando', 'plugins/sando']) {
    const module = await import(`../../../${root}/lib/pricing.mjs`);
    assert.deepEqual(module.loadPricingProfile(SOL_STANDARD_PROFILE_ID), profile());
    assert.equal(module.estimateApiRequestCost(request(), profile()).estimatedApiCostUsd, 0.073);
  }
});

test('CLI requires an explicit profile and request source and emits completeness', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-pricing-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'requests.jsonl');
  fs.writeFileSync(file, `${JSON.stringify(request())}\n`);
  let output = '';
  const report = runAccountingCli({ argv: ['--json', '--requests', file, '--profile', SOL_STANDARD_PROFILE_ID],
    stdout: { write: (text) => { output += text; } }, stderr: { write: () => {} } });
  assert.equal(report.apiCost.estimatedApiCostUsd, 0.073);
  assert.equal(JSON.parse(output).apiCost.pricedRequestCount, 1);
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  for (const argv of [['--requests', file], ['--profile', SOL_STANDARD_PROFILE_ID],
    ['--profile'], ['--unknown'], ['--profile', SOL_STANDARD_PROFILE_ID, '--requests']]) {
    const result = runAccountingCli({ argv, stdout: { write: () => {} }, stderr: { write: () => {} } });
    assert.equal(result, null);
    assert.equal(process.exitCode, 1);
  }
});
