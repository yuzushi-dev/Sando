import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendProviderUsage,
  buildProviderUsageReport,
  collectProviderUsage,
  defaultProviderUsagePath,
  parseClaudeTranscript,
  parseCodexTranscript,
  readProviderUsage,
} from '../src/provider-usage.mjs';

function tempPath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-provider-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'provider-usage.json');
}

test('parses Claude assistant usage and expands cache counters', () => {
  const records = parseClaudeTranscript(JSON.stringify({
    type: 'assistant', uuid: 'claude-1', timestamp: '2026-08-24T10:00:00.000Z',
    message: { usage: {
      input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 7,
    } },
  }), { sessionId: 's1', turnId: 't1', arm: 'apply', experimentId: 'exp-1', workloadId: 'work-1' });

  assert.deepEqual(records, [{
    eventKey: records[0].eventKey,
    schema: 'sando-provider-usage/v1', version: 1,
    host: 'claude', source: 'claude-transcript', sessionId: 's1', turnId: 't1',
    at: '2026-08-24T10:00:00.000Z', inputTokens: 150, cachedInputTokens: 30,
    cacheWriteInputTokens: 20, outputTokens: 7, reasoningOutputTokens: 0, totalTokens: 157,
    arm: 'apply', experimentId: 'exp-1', workloadId: 'work-1',
  }]);
  assert.match(records[0].eventKey, /^usage:claude:sha256:/);
});

test('uses deduplicated Claude message ids and final result totals as the session aggregate', () => {
  const assistant = (id, uuid, inputTokens, outputTokens) => JSON.stringify({
    type: 'assistant', uuid, timestamp: '2026-09-10T18:53:00.000Z',
    message: { id, usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
  });
  const records = parseClaudeTranscript([
    assistant('msg-1', 'event-1', 10, 2),
    assistant('msg-1', 'event-2', 10, 2),
    assistant('msg-2', 'event-3', 20, 3),
    JSON.stringify({ type: 'result', usage: {
      input_tokens: 30, cache_creation_input_tokens: 4, cache_read_input_tokens: 6,
      output_tokens: 50, total_tokens: 90,
    } }),
  ].join('\n'), { sessionId: 's1', turnId: 't1' });

  assert.equal(records.length, 1);
  assert.deepEqual({ ...records[0], eventKey: undefined }, {
    eventKey: undefined,
    schema: 'sando-provider-usage/v1', version: 1,
    host: 'claude', source: 'claude-result', sessionId: 's1', turnId: null,
    at: '2026-09-10T18:53:00.000Z', inputTokens: 40, cachedInputTokens: 6,
    cacheWriteInputTokens: 4, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 90,
    aggregation: 'session', turnCount: 2,
  });
  const report = buildProviderUsageReport({ schema: 'sando-provider-usage/v1', version: 1, timezone: 'UTC', records });
  assert.equal(report.inputTokens, 40);
  assert.equal(report.outputTokens, 50);
  assert.equal(report.turnCount, 2);
});

test('retains host-reported transcript cost without calling it billed', () => {
  const records = parseClaudeTranscript([
    JSON.stringify({ type: 'assistant', uuid: 'claude-cost', timestamp: '2026-08-24T10:00:00.000Z', message: { usage: { input_tokens: 10, output_tokens: 2 } } }),
    JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.03 }),
  ].join('\n'), { sessionId: 's1', turnId: 't1' });

  assert.equal(records[0].totalCostUsd, 0.03);
  assert.equal(buildProviderUsageReport({ schema: 'sando-provider-usage/v1', version: 1, timezone: 'UTC', records }).cost.status, 'host-reported');
});

test('uses the latest cumulative transcript cost once for a growing session', (t) => {
  const storagePath = tempPath(t);
  const assistant = (uuid, timestamp, inputTokens) => JSON.stringify({
    type: 'assistant', uuid, timestamp,
    message: { usage: { input_tokens: inputTokens, output_tokens: 2 } },
  });
  const first = parseClaudeTranscript([
    assistant('assistant-1', '2026-08-24T10:00:00.000Z', 10),
    JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01 }),
  ].join('\n'), { sessionId: 's1', turnId: 't1' });
  appendProviderUsage({ storagePath, records: first });

  const second = parseClaudeTranscript([
    assistant('assistant-1', '2026-08-24T10:00:00.000Z', 10),
    assistant('assistant-2', '2026-08-24T10:01:00.000Z', 20),
    JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.03 }),
  ].join('\n'), { sessionId: 's1', turnId: 't2' });
  appendProviderUsage({ storagePath, records: second });

  let report = buildProviderUsageReport(readProviderUsage(storagePath), { sessionId: 's1' });
  assert.equal(report.cost.totalCostUsd, 0.03);

  const updated = parseClaudeTranscript([
    assistant('assistant-2', '2026-08-24T10:01:00.000Z', 20),
    JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.04 }),
  ].join('\n'), { sessionId: 's1', turnId: 't2' });
  appendProviderUsage({ storagePath, records: updated });
  report = buildProviderUsageReport(readProviderUsage(storagePath), { sessionId: 's1' });
  assert.equal(report.cost.totalCostUsd, 0.04);
});

test('keeps cost coverage partial when one session has no reported amount', () => {
  const makeRecord = (eventKey, sessionId, totalCostUsd) => ({
    eventKey, schema: 'sando-provider-usage/v1', version: 1,
    host: 'claude', source: 'test', sessionId, turnId: 't1', at: '2026-08-24T10:00:00.000Z',
    inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2,
    reasoningOutputTokens: 0, totalTokens: 12,
    ...(totalCostUsd === undefined ? {} : { totalCostUsd, costScope: 'session', costSource: 'host-reported' }),
  });
  const report = buildProviderUsageReport({
    schema: 'sando-provider-usage/v1', version: 1, timezone: 'UTC',
    records: [makeRecord('usage:one', 's1', 0.01), makeRecord('usage:two', 's2')],
  });
  assert.equal(report.cost.status, 'host-reported');
  assert.equal(report.cost.coverage, 'partial');
  assert.equal(report.totalCostUsd, null);
});

test('does not merge session aggregates that lack a session id', (t) => {
  const storagePath = tempPath(t);
  const makeRecord = (eventKey, at) => ({
    eventKey, schema: 'sando-provider-usage/v1', version: 1,
    host: 'claude', source: 'claude-result', sessionId: null, turnId: null, at,
    inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2,
    reasoningOutputTokens: 0, totalTokens: 12, aggregation: 'session', turnCount: 1,
  });
  appendProviderUsage({ storagePath, records: [makeRecord('usage:one', '2026-08-24T10:00:00.000Z')] });
  appendProviderUsage({ storagePath, records: [makeRecord('usage:two', '2026-08-24T10:01:00.000Z')] });
  assert.equal(readProviderUsage(storagePath).records.length, 2);
});

test('does not let a Claude session aggregate hide turns from another provider', () => {
  const record = (eventKey, host, sessionId, turnId, inputTokens, aggregation, turnCount) => ({
    eventKey, schema: 'sando-provider-usage/v1', version: 1,
    host, source: aggregation ? `${host}-result` : `${host}-transcript`, sessionId, turnId,
    at: '2026-08-24T10:00:00.000Z', inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 2, reasoningOutputTokens: 0, totalTokens: inputTokens + 2,
    ...(aggregation ? { aggregation, turnCount } : {}),
  });
  const state = {
    schema: 'sando-provider-usage/v1', version: 1, timezone: 'UTC', records: [
      record('usage:claude', 'claude', 'claude-session', null, 30, 'session', 2),
      record('usage:codex-one', 'codex', 'codex-session', 'turn-1', 10),
      record('usage:codex-two', 'codex', 'codex-session', 'turn-2', 20),
    ],
  };

  const report = buildProviderUsageReport(state);
  assert.equal(report.turnCount, 4);
  assert.equal(report.eventCount, 3);
});

test('keeps unknown-session aggregates separate for report totals', () => {
  const record = (eventKey, inputTokens, totalCostUsd, aggregation, turnCount) => ({
    eventKey, schema: 'sando-provider-usage/v1', version: 1,
    host: 'claude', source: aggregation ? 'claude-result' : 'claude-transcript', sessionId: null,
    turnId: aggregation ? null : eventKey, at: '2026-08-24T10:00:00.000Z', inputTokens,
    cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0,
    totalTokens: inputTokens + 2, totalCostUsd, costScope: 'session', costSource: 'host-reported',
    ...(aggregation ? { aggregation, turnCount } : {}),
  });
  const report = buildProviderUsageReport({
    schema: 'sando-provider-usage/v1', version: 1, timezone: 'UTC', records: [
      record('usage:unknown-one', 10, 0.01, 'session', 1),
      record('usage:unknown-two', 20, 0.02, 'session', 1),
      record('usage:unknown-turn', 30, 0.03),
    ],
  });

  assert.equal(report.eventCount, 3);
  assert.equal(report.sessionCount, 3);
  assert.equal(report.turnCount, 3);
  assert.equal(report.totalCostUsd, 0.06);
  assert.equal(report.cost.coverage, 'complete');
});

test('parses Codex last token usage without treating cache reads as extra input', () => {
  const records = parseCodexTranscript(JSON.stringify({
    timestamp: '2026-08-24T10:01:00.000Z', type: 'event_msg', payload: {
      type: 'token_count', info: { last_token_usage: {
        input_tokens: 90, cached_input_tokens: 30, cache_write_input_tokens: 4,
        output_tokens: 7, reasoning_output_tokens: 2, total_tokens: 97,
      } },
    },
  }), { sessionId: 's2', turnId: 't2' });

  assert.equal(records.length, 1);
  assert.deepEqual({ ...records[0], eventKey: undefined }, {
    eventKey: undefined,
    schema: 'sando-provider-usage/v1', version: 1,
    host: 'codex', source: 'codex-transcript', sessionId: 's2', turnId: 'at:2026-08-24T10:01:00.000Z',
    at: '2026-08-24T10:01:00.000Z', inputTokens: 90, cachedInputTokens: 30,
    cacheWriteInputTokens: 4, outputTokens: 7, reasoningOutputTokens: 2, totalTokens: 97,
  });
});

test('derives distinct Codex turn ids when token counts lack an event turn id', () => {
  const usageLine = (timestamp, inputTokens) => JSON.stringify({
    type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: {
      input_tokens: inputTokens, cached_input_tokens: 0, cache_write_input_tokens: 0,
      output_tokens: 1, reasoning_output_tokens: 0, total_tokens: inputTokens + 1,
    } } },
  });
  const records = parseCodexTranscript([
    usageLine('2026-08-24T10:01:00.000Z', 90),
    usageLine('2026-08-24T10:02:00.000Z', 100),
  ].join('\n'), { sessionId: 's2', turnId: 'hook-turn' });

  assert.equal(records.length, 2);
  assert.notEqual(records[0].turnId, records[1].turnId);
  assert.notEqual(records[0].turnId, 'hook-turn');
});

test('appends provider records idempotently and reports session totals', (t) => {
  const storagePath = tempPath(t);
  const records = parseClaudeTranscript(JSON.stringify({
    type: 'assistant', uuid: 'same', timestamp: '2026-08-24T10:00:00.000Z',
    message: { usage: { input_tokens: 10, output_tokens: 2 } },
  }), { sessionId: 's1', turnId: 't1' });

  appendProviderUsage({ storagePath, records });
  appendProviderUsage({ storagePath, records });
  const state = readProviderUsage(storagePath);
  assert.equal(state.records.length, 1);
  assert.deepEqual(buildProviderUsageReport(state, { sessionId: 's1' }), {
    eventCount: 1, sessionCount: 1, inputTokens: 10, cachedInputTokens: 0,
    cacheWriteInputTokens: 0, freshInputTokens: 10, outputTokens: 2, reasoningOutputTokens: 0,
    totalTokens: 12, turnCount: 1, weightedCostUnits: 12,
    weightedCost: { source: 'weighted-estimate', costUnits: 12 },
    cost: { status: 'unavailable', coverage: 'none', totalCostUsd: null, effectiveRateUsdPerMillionTokens: null },
    totalCostUsd: null, providerReportedCostUsd: null,
    sessionBlendedEffectiveRateUsdPerMillionTokens: null, costSource: 'unavailable',
  });
});

test('counts distinct turns instead of raw usage records', () => {
  const state = {
    schema: 'sando-provider-usage/v1', version: 1, timezone: 'UTC', records: [
      {
        eventKey: 'usage:one', schema: 'sando-provider-usage/v1', version: 1,
        host: 'codex', source: 'test', sessionId: 's1', turnId: 't1', at: '2026-08-24T10:00:00.000Z',
        inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2,
        reasoningOutputTokens: 0, totalTokens: 12,
      },
      {
        eventKey: 'usage:two', schema: 'sando-provider-usage/v1', version: 1,
        host: 'codex', source: 'test', sessionId: 's1', turnId: 't1', at: '2026-08-24T10:00:01.000Z',
        inputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1,
        reasoningOutputTokens: 0, totalTokens: 6,
      },
    ],
  };

  assert.equal(buildProviderUsageReport(state, { sessionId: 's1' }).turnCount, 1);
});

test('rejects provider records whose cache counters exceed input', (t) => {
  const storagePath = tempPath(t);
  assert.throws(() => appendProviderUsage({ storagePath, records: [{
    eventKey: 'usage:invalid', schema: 'sando-provider-usage/v1', version: 1,
    host: 'codex', source: 'test', sessionId: 's1', turnId: 't1', at: '2026-08-24T10:00:00.000Z',
    inputTokens: 10, cachedInputTokens: 8, cacheWriteInputTokens: 3, outputTokens: 1,
    reasoningOutputTokens: 0, totalTokens: 11,
  }] }), /provider usage record is invalid/);
});

test('rejects provider records whose reasoning exceeds reported output', (t) => {
  const storagePath = tempPath(t);
  assert.throws(() => appendProviderUsage({ storagePath, records: [{
    eventKey: 'usage:reasoning-invalid', schema: 'sando-provider-usage/v1', version: 1,
    host: 'codex', source: 'test', sessionId: 's1', turnId: 't1', at: '2026-08-24T10:00:00.000Z',
    inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1,
    reasoningOutputTokens: 2, totalTokens: 11,
  }] }), /provider usage record is invalid/);
});

test('uses the provider ledger path override', () => {
  assert.equal(defaultProviderUsagePath({ SANDO_PROVIDER_USAGE_PATH: '/tmp/sando-provider.json' }), '/tmp/sando-provider.json');
});

test('recollecting a timestamp-less Codex event does not duplicate accounting', (t) => {
  const storagePath = tempPath(t);
  const transcriptPath = path.join(path.dirname(storagePath), 'codex.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'turn.completed', id: 'turn-without-timestamp', usage: {
      input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0,
      output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 12,
    },
  }));

  collectProviderUsage({ host: 'codex', transcriptPath, sessionId: 'codex-session', turnId: 'turn-1',
    storagePath, now: '2026-09-11T10:00:00.000Z' });
  collectProviderUsage({ host: 'codex', transcriptPath, sessionId: 'codex-session', turnId: 'turn-1',
    storagePath, now: '2026-09-11T10:05:00.000Z' });

  const state = readProviderUsage(storagePath);
  assert.equal(state.records.length, 1);
  assert.equal(buildProviderUsageReport(state).eventCount, 1);

  collectProviderUsage({ host: 'codex', transcriptPath, sessionId: 'other-codex-session', turnId: 'turn-1',
    storagePath, now: '2026-09-11T10:10:00.000Z' });
  assert.equal(readProviderUsage(storagePath).records.length, 2);
});

test('recollecting a timestamp-less Claude event does not duplicate accounting', (t) => {
  const storagePath = tempPath(t);
  const transcriptPath = path.join(path.dirname(storagePath), 'claude.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant', uuid: 'event-without-timestamp', message: {
      id: 'message-without-timestamp', usage: { input_tokens: 10, output_tokens: 2 },
    },
  }));

  collectProviderUsage({ host: 'claude', transcriptPath, sessionId: 'claude-session', turnId: 'turn-1',
    storagePath, now: '2026-09-11T10:00:00.000Z' });
  collectProviderUsage({ host: 'claude', transcriptPath, sessionId: 'claude-session', turnId: 'turn-1',
    storagePath, now: '2026-09-11T10:05:00.000Z' });

  const state = readProviderUsage(storagePath);
  assert.equal(state.records.length, 1);
  assert.equal(buildProviderUsageReport(state).eventCount, 1);
});
