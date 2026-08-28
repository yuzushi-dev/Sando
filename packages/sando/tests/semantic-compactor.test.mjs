import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSemanticPrompt,
  createSemanticCompactor,
  validateSemanticSummary,
} from '../src/semantic-compactor.mjs';
import { createRedactionProfile } from '../src/redaction-profile.mjs';

const longText = [
  'READ_HEAD_FACT /workspace/src/app.mjs',
  ...Array.from({ length: 120 }, (_, index) => `line ${index}: repeated diagnostic output`),
  'READ_TAIL_FACT error: exit 1',
].join('\n');

function validResponse(summary = 'READ_HEAD_FACT /workspace/src/app.mjs\nREAD_TAIL_FACT error: exit 1') {
  return {
    schema: 'sando-semantic-summary/v1',
    summary,
    preservedFacts: ['READ_HEAD_FACT', 'READ_TAIL_FACT', '/workspace/src/app.mjs', 'error: exit 1'],
  };
}

test('skips small, current, and error results without calling the compactor', async () => {
  let calls = 0;
  const compact = createSemanticCompactor({ complete: async () => { calls += 1; return validResponse(); } });

  const small = await compact({ provider: 'openai-responses', model: 'gpt', toolName: 'Bash', text: 'small' });
  const current = await compact({ provider: 'openai-responses', model: 'gpt', toolName: 'Bash', text: longText, historical: false });
  const error = await compact({ provider: 'openai-responses', model: 'gpt', toolName: 'Bash', text: longText, isError: true });

  assert.equal(small.status, 'skipped');
  assert.equal(small.reason, 'below-threshold');
  assert.equal(current.reason, 'current-result');
  assert.equal(error.reason, 'error-result');
  assert.equal(calls, 0);
});

test('builds a redacted prompt and accepts a compact summary that preserves required facts', async () => {
  let request;
  const compact = createSemanticCompactor({
    complete: async (value) => { request = value; return validResponse(); },
    policy: { minInputTokens: 1 },
  });

  const result = await compact({
    provider: 'openai-responses',
    model: 'gpt',
    toolName: 'Bash',
    text: `${longText}\napi_key=sk-example-secret-value`,
    requiredFacts: ['READ_HEAD_FACT', 'READ_TAIL_FACT', '/workspace/src/app.mjs', 'error: exit 1'],
  });

  assert.equal(result.status, 'candidate');
  assert.equal(result.mode, 'shadow');
  assert.ok(result.grossSavedTokens > 0);
  assert.ok(Number.isSafeInteger(result.netSavedTokens));
  assert.match(request.prompt, /\[REDACTED\]/);
  assert.doesNotMatch(request.prompt, /sk-example-secret-value/);
  assert.equal(request.provider, 'openai-responses');
});

test('redacts sensitive required facts before the adapter boundary', async () => {
  let request;
  const compact = createSemanticCompactor({
    complete: async (value) => { request = value; return validResponse(); },
    policy: { minInputTokens: 1 },
  });

  const result = await compact({
    provider: 'openai-responses',
    model: 'gpt',
    toolName: 'Bash',
    text: longText,
    requiredFacts: ['password=supersecret'],
  });

  assert.doesNotMatch(request.prompt, /supersecret/);
  assert.deepEqual(request.requiredFacts, ['password=[REDACTED]']);
  assert.equal(result.status, 'fallback');
});

test('redacts PEM and token-shaped secrets before the adapter boundary', async () => {
  let request;
  const compact = createSemanticCompactor({
    complete: async (value) => { request = value; return validResponse(); },
    policy: { minInputTokens: 1 },
  });
  const pem = '-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----';
  const token = 'sk-example-secret-token-123456';

  await compact({ provider: 'openai-responses', model: 'gpt', toolName: 'Bash', text: `${longText}\n${pem}\n${token}` });

  assert.doesNotMatch(request.prompt, /secret-material|sk-example-secret-token-123456/);
});

test('uses project-defined redaction rules before the adapter boundary', async () => {
  let request;
  const compact = createSemanticCompactor({
    redactionProfile: createRedactionProfile([{ type: 'assignment-key', key: 'TEAM_DB_URL' }]),
    complete: async (value) => { request = value; return validResponse(); },
    policy: { minInputTokens: 1 },
  });

  const result = await compact({
    provider: 'openai-responses',
    model: 'gpt',
    toolName: 'Bash',
    text: `${longText}\nTEAM_DB_URL=fixture-team-secret`,
  });

  assert.equal(result.status, 'candidate');
  assert.equal(result.redactions, 1);
  assert.doesNotMatch(request.prompt, /fixture-team-secret/);
  assert.match(request.prompt, /TEAM_DB_URL=\[REDACTED\]/);
});

test('rejects model facts that are not grounded in the redacted tool result', async () => {
  const compact = createSemanticCompactor({
    complete: async () => ({
      schema: 'sando-semantic-summary/v1',
      summary: 'FACT',
      preservedFacts: ['FACT', 'invented user email@example.com'],
    }),
    policy: { minInputTokens: 1 },
  });
  const result = await compact({
    provider: 'claude',
    model: 'claude-haiku-4-5',
    toolName: 'Bash',
    text: 'FACT '.repeat(100),
    requiredFacts: ['FACT'],
  });
  assert.equal(result.status, 'fallback');
  assert.equal(result.reason, 'response-ungrounded-fact');
});

test('repairs a summary that lists required facts but omits them from the prose', async () => {
  const compact = createSemanticCompactor({
    complete: async () => ({
      schema: 'sando-semantic-summary/v1',
      summary: 'repeated diagnostics were compacted',
      preservedFacts: ['READ_HEAD_FACT', 'READ_TAIL_FACT', '/workspace/src/app.mjs', 'error: exit 1'],
    }),
    policy: { minInputTokens: 1 },
  });
  const result = await compact({
    provider: 'codex',
    model: 'gpt-5.6-luna',
    toolName: 'Bash',
    text: longText,
    requiredFacts: ['READ_HEAD_FACT', 'READ_TAIL_FACT', '/workspace/src/app.mjs', 'error: exit 1'],
  });
  assert.equal(result.status, 'candidate');
  assert.match(result.summary, /READ_HEAD_FACT/);
  assert.match(result.summary, /error: exit 1/);
});

test('rejects summaries that lose facts or contain secrets', () => {
  const result = validateSemanticSummary({
    originalText: longText,
    summary: 'READ_HEAD_FACT only',
    requiredFacts: ['READ_HEAD_FACT', 'READ_TAIL_FACT'],
    maxSummaryRatio: 0.2,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing-required-fact');

  const secret = validateSemanticSummary({
    originalText: longText,
    summary: 'READ_HEAD_FACT password=supersecret READ_TAIL_FACT',
    requiredFacts: ['READ_HEAD_FACT', 'READ_TAIL_FACT'],
    maxSummaryRatio: 0.2,
  });
  assert.equal(secret.valid, false);
  assert.equal(secret.reason, 'secret-detected');

  const invalidRatio = validateSemanticSummary({
    originalText: longText,
    summary: 'READ_HEAD_FACT',
    requiredFacts: ['READ_HEAD_FACT'],
    maxSummaryRatio: Number.NaN,
  });
  assert.equal(invalidRatio.valid, false);
  assert.equal(invalidRatio.reason, 'invalid-ratio');
});

test('fails open on timeout and reuses only validated cache entries', async () => {
  let calls = 0;
  const compact = createSemanticCompactor({
    complete: async () => {
      calls += 1;
      return validResponse();
    },
    policy: { minInputTokens: 1, timeoutMs: 100 },
  });
  const first = await compact({ provider: 'openai-responses', model: 'gpt', toolName: 'Bash', text: longText });
  const second = await compact({ provider: 'openai-responses', model: 'gpt', toolName: 'Bash', text: longText });

  assert.equal(first.status, 'candidate');
  assert.equal(second.status, 'candidate');
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);

  const timeout = createSemanticCompactor({
    complete: async () => new Promise((resolve) => setTimeout(() => resolve(validResponse()), 50)),
    policy: { minInputTokens: 1, timeoutMs: 5 },
  });
  const timed = await timeout({ provider: 'openai-responses', model: 'gpt', toolName: 'Bash', text: longText });
  assert.equal(timed.status, 'fallback');
  assert.equal(timed.reason, 'timeout');
  assert.equal(timed.fallbackText, longText);
});

test('fails open when cache operations throw', async () => {
  const cache = {
    get() { throw new Error('cache unavailable'); },
    set() { throw new Error('cache unavailable'); },
  };
  const compact = createSemanticCompactor({
    cache,
    complete: async () => validResponse(),
    policy: { minInputTokens: 1 },
  });
  const result = await compact({ provider: 'openai-responses', model: 'gpt', toolName: 'Bash', text: longText });
  assert.equal(result.status, 'candidate');
  assert.ok(result.grossSavedTokens > 0);
});

test('prompt structure is stable and versioned', () => {
  const prompt = buildSemanticPrompt({
    provider: 'openai-responses',
    model: 'gpt',
    toolName: 'Read',
    text: 'FACT',
    requiredFacts: ['FACT'],
  });
  assert.match(prompt, /sando-semantic-summary\/v1/);
  assert.match(prompt, /Required facts: FACT/);
  assert.match(prompt, /Tool: Read/);
});
