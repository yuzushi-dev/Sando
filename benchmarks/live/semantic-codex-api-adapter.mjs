import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SEMANTIC_SYSTEM_PROMPT } from './semantic-cli-adapter.mjs';

export const DEFAULT_CODEX_API_MODEL = 'gpt-5.6-luna';

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const OPENAI_BETA = 'responses=experimental';
const ORIGINATOR = 'pi';
const CODEX_VERSION = '0.144.1';
const USER_AGENT = 'omp/18.0.3';

function nonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function decodeJwtPayload(accessToken) {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

export async function readCodexOAuthCredential({ credentialsPath } = {}) {
  const filePath = credentialsPath ?? path.join(os.homedir(), '.codex', 'auth.json');
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new Error(`Codex OAuth credentials not found at ${filePath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Codex OAuth credentials file is malformed: ${filePath}`);
  }
  const accessToken = parsed?.tokens?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('Codex OAuth credentials missing tokens.access_token');
  }
  const payload = decodeJwtPayload(accessToken);
  if (Number.isFinite(payload?.exp) && payload.exp * 1000 <= Date.now()) {
    throw new Error('Codex OAuth credential expired');
  }
  const directAccountId = parsed?.tokens?.account_id;
  const accountId = typeof directAccountId === 'string' && directAccountId
    ? directAccountId
    : payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
  return { accessToken, accountId };
}

function stripMarkdownFence(text) {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  return match ? match[1] : text;
}

function parseSemanticJson(outputText) {
  if (typeof outputText !== 'string' || !outputText) {
    throw new Error('codex api returned an invalid semantic response');
  }
  let parsed;
  try {
    parsed = JSON.parse(outputText.trim());
  } catch {
    try {
      parsed = JSON.parse(stripMarkdownFence(outputText.trim()));
    } catch {
      throw new Error('codex api returned an invalid semantic response');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.schema !== 'sando-semantic-summary/v1'
    || typeof parsed.summary !== 'string'
    || !Array.isArray(parsed.preservedFacts)) {
    throw new Error('codex api returned an invalid semantic response');
  }
  return parsed;
}

// Cache field names verified against the openai-python SDK's ResponseUsage/
// InputTokensDetails type definitions (input_tokens_details.cached_tokens,
// input_tokens_details.cache_write_tokens) — not observed on a live Codex
// payload in this repo, so treat as unverified against the ChatGPT-OAuth
// Codex Responses backend specifically until confirmed on a real call.
function parseApiUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error('codex api returned invalid usage');
  const inputTokens = nonNegativeInt(usage.input_tokens);
  const outputTokens = nonNegativeInt(usage.output_tokens);
  if (inputTokens === null || outputTokens === null) throw new Error('codex api returned invalid usage');
  const details = usage.input_tokens_details;
  const cacheReadTokens = details && details.cached_tokens !== undefined
    ? nonNegativeInt(details.cached_tokens) ?? 0 : 0;
  const cacheWriteTokens = details && details.cache_write_tokens !== undefined
    ? nonNegativeInt(details.cache_write_tokens) ?? 0 : 0;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

async function readSseBody(body) {
  let text = '';
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const decoder = new TextDecoder();
    for await (const chunk of body) {
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } else if (typeof body === 'string') {
    text = body;
  } else {
    throw new Error('codex api response body is not readable');
  }
  return text;
}

function parseSseEvents(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // ignore malformed SSE data lines
      }
    }
  }
  return events;
}

export function createCodexApiSemanticCompleter({
  model = DEFAULT_CODEX_API_MODEL,
  credentialsPath,
  timeoutMs = 120_000,
  fetchImpl = fetch,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');

  const complete = async ({ prompt, signal } = {}) => {
    if (typeof prompt !== 'string' || !prompt) throw new TypeError('semantic prompt is required');
    const { accessToken, accountId } = await readCodexOAuthCredential({ credentialsPath });
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'OpenAI-Beta': OPENAI_BETA,
      originator: ORIGINATOR,
      version: CODEX_VERSION,
      'User-Agent': USER_AGENT,
      accept: 'text/event-stream',
      'content-type': 'application/json',
    };
    if (accountId) headers['chatgpt-account-id'] = accountId;

    let response;
    try {
      response = await fetchImpl(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          input: [{
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `${SEMANTIC_SYSTEM_PROMPT}\n\n${prompt}` }],
          }],
          stream: true,
          store: false,
        }),
        signal: combinedSignal,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        const timeoutError = new Error('semantic compactor timeout');
        timeoutError.code = 'SEMANTIC_TIMEOUT';
        throw timeoutError;
      }
      throw error;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`codex api semantic failed (${response.status}): ${body.slice(0, 500)}`);
    }

    const text = await readSseBody(response.body);
    const events = parseSseEvents(text);
    const failed = events.find((event) => event?.type === 'response.failed');
    if (failed) {
      const reason = failed?.response?.error?.message ?? 'unknown error';
      throw new Error(`codex api semantic failed: ${reason}`);
    }
    const completed = events.find((event) => event?.type === 'response.completed');
    if (!completed) throw new Error('codex api stream ended without response.completed');

    const doneEvent = events.findLast((event) => event?.type === 'response.output_text.done');
    const deltaText = events
      .filter((event) => event?.type === 'response.output_text.delta')
      .map((event) => event.delta)
      .join('');
    const outputText = completed.response?.output_text ?? doneEvent?.text ?? (deltaText || undefined);

    const parsed = parseSemanticJson(outputText);
    const usage = parseApiUsage(completed.response?.usage);
    return { schema: parsed.schema, summary: parsed.summary, preservedFacts: parsed.preservedFacts, usage };
  };

  Object.defineProperties(complete, {
    provider: { get: () => 'codex' },
    model: { get: () => model },
  });
  return complete;
}
