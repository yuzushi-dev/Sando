import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createApiSemanticCompleter,
  DEFAULT_API_MODEL,
  readClaudeOAuthCredential,
} from '../live/semantic-api-adapter.mjs';

const FAKE_TOKEN = 'sk-ant-oat01-test-token';

async function writeCredentials(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sando-semantic-api-'));
  const file = path.join(dir, '.credentials.json');
  await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

test('readClaudeOAuthCredential throws when credentials file is missing', async () => {
  const missing = path.join(os.tmpdir(), 'sando-semantic-api-missing', '.credentials.json');
  await assert.rejects(() => readClaudeOAuthCredential({ credentialsPath: missing }), /not found/);
});

test('readClaudeOAuthCredential throws when credentials file is malformed', async () => {
  const file = await writeCredentials('not json');
  await assert.rejects(() => readClaudeOAuthCredential({ credentialsPath: file }), /malformed/);
});

test('readClaudeOAuthCredential throws when expiresAt is in the past', async () => {
  const file = await writeCredentials({
    claudeAiOauth: { accessToken: FAKE_TOKEN, expiresAt: Date.now() - 60_000 },
  });
  await assert.rejects(() => readClaudeOAuthCredential({ credentialsPath: file }), /expired/);
});

test('createApiSemanticCompleter resolves with schema, summary, preservedFacts, usage on a valid 200 response', async () => {
  const file = await writeCredentials({
    claudeAiOauth: { accessToken: FAKE_TOKEN, expiresAt: Date.now() + 3_600_000 },
  });
  let capturedHeaders;
  const fetchImpl = async (url, init) => {
    capturedHeaders = init.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{
          type: 'tool_use',
          name: 'emit_semantic_summary',
          input: {
            schema: 'sando-semantic-summary/v1',
            summary: 'a summary',
            preservedFacts: ['fact one'],
          },
        }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
      }),
    };
  };
  const complete = createApiSemanticCompleter({ credentialsPath: file, fetchImpl });
  const result = await complete({ prompt: 'summarize this' });
  assert.deepEqual(result, {
    schema: 'sando-semantic-summary/v1',
    summary: 'a summary',
    preservedFacts: ['fact one'],
    usage: { inputTokens: 105, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 },
  });
  assert.equal(capturedHeaders.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(complete.provider, 'claude');
  assert.equal(complete.model, DEFAULT_API_MODEL);
});

test('createApiSemanticCompleter throws on a non-2xx response without leaking the token', async () => {
  const file = await writeCredentials({
    claudeAiOauth: { accessToken: FAKE_TOKEN, expiresAt: Date.now() + 3_600_000 },
  });
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => 'unauthorized',
  });
  const complete = createApiSemanticCompleter({ credentialsPath: file, fetchImpl });
  await assert.rejects(
    () => complete({ prompt: 'summarize this' }),
    (error) => {
      assert.match(error.message, /401/);
      assert.equal(error.message.includes(FAKE_TOKEN), false);
      return true;
    },
  );
});

test('createApiSemanticCompleter throws when no summary tool_use block is returned', async () => {
  const file = await writeCredentials({
    claudeAiOauth: { accessToken: FAKE_TOKEN, expiresAt: Date.now() + 3_600_000 },
  });
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text: 'not json at all' }],
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
  });
  const complete = createApiSemanticCompleter({ credentialsPath: file, fetchImpl });
  await assert.rejects(() => complete({ prompt: 'summarize this' }), /invalid semantic response/);
});

test('createApiSemanticCompleter throws on timeout', async () => {
  const file = await writeCredentials({
    claudeAiOauth: { accessToken: FAKE_TOKEN, expiresAt: Date.now() + 3_600_000 },
  });
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const complete = createApiSemanticCompleter({ credentialsPath: file, fetchImpl, timeoutMs: 60_000 });
  await assert.rejects(() => complete({ prompt: 'summarize this', signal: controller.signal }), /timeout/);
});
