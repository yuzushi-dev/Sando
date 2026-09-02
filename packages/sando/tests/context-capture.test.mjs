import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONTEXT_CAPTURE_RECORD_SCHEMA,
  buildContextCaptureRecord,
  defaultContextCapturePath,
  normalizeProviderUsage,
  recordContextCapture,
} from '../src/context-capture.mjs';

function tempPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sando-f1-')), 'captures.jsonl');
}

test('builds a content-free Anthropic observation with normalized usage', () => {
  const secret = 'fixture-secret-from-user-prompt';
  const rawBody = JSON.stringify({
    model: 'claude-fixture',
    metadata: { user_id: 'session-123' },
    system: `private system ${secret}`,
    messages: [{ role: 'user', content: `hello ${secret}` }],
  });

  const record = buildContextCaptureRecord({
    host: 'claude',
    provider: 'anthropic',
    rawBody,
    model: 'claude-fixture',
    sessionKey: 'session-123',
    providerUsage: {
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 7,
    },
    now: new Date('2026-08-31T10:00:00.000Z'),
  });

  assert.equal(record.schema, CONTEXT_CAPTURE_RECORD_SCHEMA);
  assert.equal(record.host, 'claude');
  assert.equal(record.requestFormat, 'anthropic');
  assert.match(record.sessionKeyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(record.model, 'claude-fixture');
  assert.equal(record.report.observation.status, 'observed');
  assert.equal(record.report.attribution.status, 'partial');
  assert.equal(record.report.attribution.bodyBytes, Buffer.byteLength(rawBody));
  assert.ok(record.report.categories['host-instructions'].bytes > 0);
  assert.ok(record.report.categories['user-prompt'].bytes > 0);
  assert.ok(record.report.attribution.unknownBytes < Buffer.byteLength(rawBody));
  assert.equal(record.report.tokenAccounting.providerReported.inputTokens, 60);
  assert.equal(record.report.tokenAccounting.providerReported.outputTokens, 7);
  assert.equal(record.report.toolSearch.state, 'indeterminate');
  assert.doesNotMatch(JSON.stringify(record), /fixture-secret|session-123|private system/);
});

test('builds a content-free Codex Responses observation', () => {
  const rawBody = JSON.stringify({
    model: 'gpt-fixture',
    prompt_cache_key: 'cache-key-123',
    instructions: 'host instruction secret',
    input: [{ role: 'user', content: 'user secret' }],
  });
  const record = buildContextCaptureRecord({
    host: 'codex',
    provider: 'openai-responses',
    rawBody,
    model: 'gpt-fixture',
    sessionKey: 'codex-session-1',
    providerUsage: {
      input_tokens: 80,
      input_tokens_details: { cached_tokens: 12 },
      output_tokens: 9,
      output_tokens_details: { reasoning_tokens: 3 },
    },
  });

  assert.equal(record.requestFormat, 'openai-responses');
  assert.equal(record.report.tokenAccounting.providerReported.inputTokens, 80);
  assert.equal(record.report.tokenAccounting.providerReported.cachedInputTokens, 12);
  assert.equal(record.report.tokenAccounting.providerReported.outputTokens, 9);
  assert.equal(record.report.tokenAccounting.providerReported.reasoningOutputTokens, 3);
  assert.ok(record.report.categories['host-instructions'].bytes > 0);
  assert.ok(record.report.categories['user-prompt'].bytes > 0);
  assert.ok(record.report.categories['provider-overhead'].bytes > 0);
  assert.doesNotMatch(JSON.stringify(record), /host instruction secret|user secret|codex-session-1/);
});

test('fails closed when a session key is absent', () => {
  assert.equal(buildContextCaptureRecord({
    host: 'claude', provider: 'anthropic', rawBody: '{}',
  }), null);
});

test('normalizes provider usage without inventing incomplete totals', () => {
  assert.deepEqual(normalizeProviderUsage('anthropic', {
    input_tokens: 4,
    cache_creation_input_tokens: 1,
    cache_read_input_tokens: 2,
    output_tokens: 3,
  }), {
    inputTokens: 7,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 1,
    cacheReadInputTokens: 2,
    outputTokens: 3,
    totalTokens: 10,
  });
  assert.equal(normalizeProviderUsage('openai-responses', { output_tokens: 3 }), null);
});

test('persists only safe records in a private JSONL file', () => {
  const storagePath = tempPath();
  const record = buildContextCaptureRecord({
    host: 'claude', provider: 'anthropic', rawBody: JSON.stringify({ secret: 'do-not-store' }),
    sessionKey: 'session-1', providerUsage: { input_tokens: 1, output_tokens: 1 },
  });

  const stored = recordContextCapture({ storagePath, record });
  assert.equal(stored.schema, CONTEXT_CAPTURE_RECORD_SCHEMA);
  const text = fs.readFileSync(storagePath, 'utf8');
  assert.doesNotMatch(text, /do-not-store|session-1/);
  assert.equal(text.trim().split('\n').length, 1);
  assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600);
  assert.equal(defaultContextCapturePath({
    XDG_STATE_HOME: '/tmp/sando-state',
  }), '/tmp/sando-state/sando/context-footprints.jsonl');
});
