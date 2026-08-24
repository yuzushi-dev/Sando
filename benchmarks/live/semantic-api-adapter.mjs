import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SEMANTIC_SYSTEM_PROMPT } from './semantic-cli-adapter.mjs';

export const DEFAULT_API_MODEL = 'claude-haiku-4-5';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20';
const USER_AGENT = 'claude-cli/2.1.233 (external, cli)';
const MAX_TOKENS = 4096;
const SUMMARY_TOOL_NAME = 'emit_semantic_summary';
const SUMMARY_TOOL = {
  name: SUMMARY_TOOL_NAME,
  description: 'Emit the semantic summary of the tool result.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'summary', 'preservedFacts'],
    properties: {
      schema: { const: 'sando-semantic-summary/v1' },
      summary: { type: 'string' },
      preservedFacts: { type: 'array', items: { type: 'string' } },
    },
  },
};

function nonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function readClaudeOAuthCredential({ credentialsPath } = {}) {
  const filePath = credentialsPath ?? path.join(os.homedir(), '.claude', '.credentials.json');
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    throw new Error(`Claude OAuth credentials not found at ${filePath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude OAuth credentials file is malformed: ${filePath}`);
  }
  const oauth = parsed?.claudeAiOauth;
  const accessToken = oauth?.accessToken;
  const expiresAt = oauth?.expiresAt;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('Claude OAuth credentials missing accessToken');
  }
  if (!Number.isFinite(expiresAt)) {
    throw new Error('Claude OAuth credentials missing expiresAt');
  }
  if (expiresAt <= Date.now()) {
    throw new Error('Claude OAuth credential expired');
  }
  return { accessToken, expiresAt };
}

function parseApiResponse(data) {
  const toolUse = Array.isArray(data?.content)
    ? data.content.find((block) => block?.type === 'tool_use' && block.name === SUMMARY_TOOL_NAME)
    : null;
  const parsed = toolUse?.input;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.schema !== 'sando-semantic-summary/v1'
    || typeof parsed.summary !== 'string'
    || !Array.isArray(parsed.preservedFacts)) {
    throw new Error('claude api returned an invalid semantic response');
  }
  return parsed;
}

function parseApiUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error('claude api returned invalid usage');
  const uncachedInputTokens = nonNegativeInt(usage.input_tokens);
  const outputTokens = nonNegativeInt(usage.output_tokens);
  const cacheCreationInputTokens = usage.cache_creation_input_tokens === undefined
    ? 0 : nonNegativeInt(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = usage.cache_read_input_tokens === undefined
    ? 0 : nonNegativeInt(usage.cache_read_input_tokens);
  if (uncachedInputTokens === null || outputTokens === null
    || cacheCreationInputTokens === null || cacheReadInputTokens === null) {
    throw new Error('claude api returned invalid usage');
  }
  return {
    inputTokens: uncachedInputTokens + cacheCreationInputTokens + cacheReadInputTokens,
    outputTokens,
  };
}

export function createApiSemanticCompleter({
  model = DEFAULT_API_MODEL,
  credentialsPath,
  maxBudgetUsd,
  maxOutputTokens = MAX_TOKENS,
  timeoutMs = 120_000,
  fetchImpl = fetch,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');

  const complete = async ({ prompt, signal } = {}) => {
    if (typeof prompt !== 'string' || !prompt) throw new TypeError('semantic prompt is required');
    const { accessToken } = await readClaudeOAuthCredential({ credentialsPath });
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response;
    try {
      response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
          'anthropic-beta': ANTHROPIC_BETA,
          'User-Agent': USER_AGENT,
          'x-app': 'cli',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxOutputTokens,
          system: SEMANTIC_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
          tools: [SUMMARY_TOOL],
          tool_choice: { type: 'tool', name: SUMMARY_TOOL_NAME },
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
      throw new Error(`claude api semantic failed (${response.status}): ${body.slice(0, 500)}`);
    }
    const data = await response.json();
    const parsed = parseApiResponse(data);
    const usage = parseApiUsage(data?.usage);
    return { schema: parsed.schema, summary: parsed.summary, preservedFacts: parsed.preservedFacts, usage };
  };

  Object.defineProperties(complete, {
    provider: { get: () => 'claude' },
    model: { get: () => model },
  });
  return complete;
}
