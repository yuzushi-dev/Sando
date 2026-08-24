import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendProviderUsage,
  buildProviderUsageReport,
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
  }), { sessionId: 's1', turnId: 't1' });

  assert.deepEqual(records, [{
    eventKey: records[0].eventKey,
    schema: 'sando-provider-usage/v1', version: 1,
    host: 'claude', source: 'claude-transcript', sessionId: 's1', turnId: 't1',
    at: '2026-08-24T10:00:00.000Z', inputTokens: 150, cachedInputTokens: 30,
    cacheWriteInputTokens: 20, outputTokens: 7, reasoningOutputTokens: 0, totalTokens: 157,
  }]);
  assert.match(records[0].eventKey, /^usage:claude:sha256:/);
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
    host: 'codex', source: 'codex-transcript', sessionId: 's2', turnId: 't2',
    at: '2026-08-24T10:01:00.000Z', inputTokens: 90, cachedInputTokens: 30,
    cacheWriteInputTokens: 4, outputTokens: 7, reasoningOutputTokens: 2, totalTokens: 97,
  });
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
    cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 12,
  });
});

test('uses the provider ledger path override', () => {
  assert.equal(defaultProviderUsagePath({ SANDO_PROVIDER_USAGE_PATH: '/tmp/sando-provider.json' }), '/tmp/sando-provider.json');
});
