import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCodexApiSemanticCompleter,
  DEFAULT_CODEX_API_MODEL,
  readCodexOAuthCredential,
} from '../live/semantic-codex-api-adapter.mjs';

const FAKE_TOKEN_HEADER = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
const FAKE_TOKEN_PAYLOAD = Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test123' },
})).toString('base64url');
const FAKE_TOKEN = `${FAKE_TOKEN_HEADER}.${FAKE_TOKEN_PAYLOAD}.sig`;

async function writeCredentials(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sando-semantic-codex-api-'));
  const file = path.join(dir, 'auth.json');
  await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function sseStream(events) {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

test('readCodexOAuthCredential throws when credentials file is missing', async () => {
  const missing = path.join(os.tmpdir(), 'sando-semantic-codex-missing', 'auth.json');
  await assert.rejects(() => readCodexOAuthCredential({ credentialsPath: missing }), /not found/);
});

test('readCodexOAuthCredential throws when credentials file is malformed', async () => {
  const file = await writeCredentials('not json');
  await assert.rejects(() => readCodexOAuthCredential({ credentialsPath: file }), /malformed/);
});

test('readCodexOAuthCredential throws when access_token is missing', async () => {
  const file = await writeCredentials({ tokens: {} });
  await assert.rejects(() => readCodexOAuthCredential({ credentialsPath: file }), /access_token/);
});

test('readCodexOAuthCredential resolves accountId via direct tokens.account_id', async () => {
  const file = await writeCredentials({ tokens: { access_token: FAKE_TOKEN, account_id: 'acct_direct' } });
  const { accessToken, accountId } = await readCodexOAuthCredential({ credentialsPath: file });
  assert.equal(accessToken, FAKE_TOKEN);
  assert.equal(accountId, 'acct_direct');
});

test('readCodexOAuthCredential falls back to JWT claim when tokens.account_id is absent', async () => {
  const file = await writeCredentials({ tokens: { access_token: FAKE_TOKEN } });
  const { accountId } = await readCodexOAuthCredential({ credentialsPath: file });
  assert.equal(accountId, 'acct_test123');
});

test('readCodexOAuthCredential returns undefined accountId for a malformed JWT without throwing', async () => {
  const file = await writeCredentials({ tokens: { access_token: 'not-a-jwt' } });
  const { accessToken, accountId } = await readCodexOAuthCredential({ credentialsPath: file });
  assert.equal(accessToken, 'not-a-jwt');
  assert.equal(accountId, undefined);
});

test('createCodexApiSemanticCompleter resolves with schema, summary, preservedFacts, usage on a valid SSE response', async () => {
  const file = await writeCredentials({ tokens: { access_token: FAKE_TOKEN } });
  let capturedHeaders;
  const fetchImpl = async (url, init) => {
    capturedHeaders = init.headers;
    return {
      ok: true,
      status: 200,
      body: sseStream([
        { type: 'response.in_progress' },
        {
          type: 'response.completed',
          response: {
            output_text: JSON.stringify({
              schema: 'sando-semantic-summary/v1',
              summary: 'a summary',
              preservedFacts: ['fact one'],
            }),
            usage: { input_tokens: 100, output_tokens: 20 },
          },
        },
      ]),
    };
  };
  const complete = createCodexApiSemanticCompleter({ credentialsPath: file, fetchImpl });
  const result = await complete({ prompt: 'summarize this' });
  assert.deepEqual(result, {
    schema: 'sando-semantic-summary/v1',
    summary: 'a summary',
    preservedFacts: ['fact one'],
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.equal(capturedHeaders.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(capturedHeaders['chatgpt-account-id'], 'acct_test123');
  assert.equal(capturedHeaders.originator, 'pi');
  assert.equal(capturedHeaders['User-Agent'], 'omp/18.0.3');
  assert.equal(complete.provider, 'codex');
  assert.equal(complete.model, DEFAULT_CODEX_API_MODEL);
});

test('createCodexApiSemanticCompleter parses input_tokens_details.cached_tokens/cache_write_tokens when present', async () => {
  const file = await writeCredentials({ tokens: { access_token: FAKE_TOKEN } });
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: sseStream([
      {
        type: 'response.completed',
        response: {
          output_text: JSON.stringify({
            schema: 'sando-semantic-summary/v1',
            summary: 'a summary',
            preservedFacts: ['fact one'],
          }),
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 60, cache_write_tokens: 15 },
          },
        },
      },
    ]),
  });
  const complete = createCodexApiSemanticCompleter({ credentialsPath: file, fetchImpl });
  const result = await complete({ prompt: 'summarize this' });
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 15 });
});

test('createCodexApiSemanticCompleter strips a markdown fence around output_text', async () => {
  const file = await writeCredentials({ tokens: { access_token: FAKE_TOKEN } });
  const fenced = '```json\n' + JSON.stringify({
    schema: 'sando-semantic-summary/v1',
    summary: 'fenced summary',
    preservedFacts: [],
  }) + '\n```';
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: sseStream([{
      type: 'response.completed',
      response: { output_text: fenced, usage: { input_tokens: 5, output_tokens: 5 } },
    }]),
  });
  const complete = createCodexApiSemanticCompleter({ credentialsPath: file, fetchImpl });
  const result = await complete({ prompt: 'summarize this' });
  assert.equal(result.summary, 'fenced summary');
});

test('createCodexApiSemanticCompleter throws on response.failed event', async () => {
  const file = await writeCredentials({ tokens: { access_token: FAKE_TOKEN } });
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: sseStream([{ type: 'response.failed', response: { error: { message: 'boom' } } }]),
  });
  const complete = createCodexApiSemanticCompleter({ credentialsPath: file, fetchImpl });
  await assert.rejects(() => complete({ prompt: 'summarize this' }), /boom/);
});

test('createCodexApiSemanticCompleter throws when stream ends without response.completed', async () => {
  const file = await writeCredentials({ tokens: { access_token: FAKE_TOKEN } });
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    body: sseStream([{ type: 'response.in_progress' }]),
  });
  const complete = createCodexApiSemanticCompleter({ credentialsPath: file, fetchImpl });
  await assert.rejects(() => complete({ prompt: 'summarize this' }), /response\.completed/);
});

test('createCodexApiSemanticCompleter throws on non-2xx response without leaking the token', async () => {
  const file = await writeCredentials({ tokens: { access_token: FAKE_TOKEN } });
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => 'unauthorized',
  });
  const complete = createCodexApiSemanticCompleter({ credentialsPath: file, fetchImpl });
  await assert.rejects(
    () => complete({ prompt: 'summarize this' }),
    (error) => {
      assert.match(error.message, /codex api semantic failed \(401\)/);
      assert.doesNotMatch(error.message, new RegExp(FAKE_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
});

test('createCodexApiSemanticCompleter throws on timeout', async () => {
  const file = await writeCredentials({ tokens: { access_token: FAKE_TOKEN } });
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const complete = createCodexApiSemanticCompleter({ credentialsPath: file, fetchImpl, timeoutMs: 60_000 });
  await assert.rejects(() => complete({ prompt: 'summarize this', signal: controller.signal }), /timeout/);
});
