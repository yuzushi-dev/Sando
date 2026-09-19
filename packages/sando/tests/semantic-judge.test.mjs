import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSemanticJudgeRequest,
  createSemanticJudge,
} from '../index.mjs';

const longText = [
  'READ_HEAD_FACT /workspace/src/app.mjs',
  ...Array.from({ length: 160 }, (_, index) => `line ${index}: diagnostic output`),
  'READ_TAIL_FACT error: exit 1',
].join('\n');

function verdict(lossProbability = 0.12) {
  return {
    answers: {
      preview_loses_diagnostic_evidence: { noul: lossProbability },
    },
    elapsedMs: 7,
    usage: { inputTokens: 31, outputTokens: 3 },
  };
}

test('builds a bounded redacted TypeSafe-compatible request', () => {
  const request = buildSemanticJudgeRequest({
    provider: 'openai-responses',
    model: 'fixture',
    toolName: 'Bash',
    originalText: longText,
    previewText: 'READ_HEAD_FACT /workspace/src/app.mjs\nREAD_TAIL_FACT error: exit 1',
    recoverable: true,
    maxTextChars: 80,
  });

  assert.equal(request.state.provider, 'openai-responses');
  assert.equal(request.state.tool, 'Bash');
  assert.equal(request.state.recoverable, true);
  assert.deepEqual(Object.keys(request).sort(), ['questions', 'state']);
  assert.equal(request.questions.preview_loses_diagnostic_evidence.type, 'noul');
  assert.ok(request.state.original.length <= 80);
  assert.ok(request.state.preview.length <= 80);
  assert.doesNotMatch(JSON.stringify(request), /api[_-]?key|password|secret/i);
});

test('redacts complete quoted secrets in the final judge request', () => {
  const request = buildSemanticJudgeRequest({
    provider: 'openai-responses',
    model: 'fixture',
    toolName: 'Bash',
    originalText: JSON.stringify({ password: 'alpha' + ' beta gamma' }),
    previewText: JSON.stringify({ password: 'alpha' + ' beta gamma' }),
    recoverable: true,
    maxTextChars: 200,
  });
  const serialized = JSON.stringify(request);
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(serialized, /alpha beta gamma/);
});

test('judges a redacted candidate, caches it, and returns no payload text', async () => {
  let calls = 0;
  let request;
  const judge = createSemanticJudge({
    evaluate: async (value) => {
      calls += 1;
      request = value;
      return verdict(0.81);
    },
    policy: { minInputTokens: 1, maxTextChars: 120 },
  });
  const candidate = {
    id: 'old', provider: 'openai-chat', model: 'fixture', toolName: 'Bash',
    originalText: `${longText}\napi_key=live-secret`,
    previewText: 'READ_HEAD_FACT /workspace/src/app.mjs',
    recoverable: false,
    historical: true,
    isError: false,
  };

  const first = await judge(candidate);
  const second = await judge(candidate);

  assert.equal(first.status, 'judged');
  assert.equal(first.lossProbability, 0.81);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(request), /live-secret/);
  assert.equal(first.originalText, undefined);
  assert.equal(first.previewText, undefined);
});

test('normalizes TypeSafe snake_case usage counters', async () => {
  const judge = createSemanticJudge({
    evaluate: async () => ({
      ...verdict(0.2),
      usage: { input_tokens: 17, output_tokens: 4 },
    }),
    policy: { minInputTokens: 1 },
  });

  const result = await judge({
    id: 'usage', provider: 'openai-chat', model: 'fixture', toolName: 'Bash',
    originalText: longText, previewText: 'short', historical: true, isError: false,
  });

  assert.deepEqual(result.usage, { inputTokens: 17, outputTokens: 4 });
});

test('whitelists cached judgment fields and never returns cached payload text', async () => {
  const candidate = {
    id: 'cached', provider: 'openai-chat', model: 'fixture', toolName: 'Bash',
    originalText: longText, previewText: 'short', historical: true, isError: false,
  };
  const judge = createSemanticJudge({
    evaluate: async () => { throw new Error('cache should satisfy this request'); },
    cache: {
      get: () => ({
        status: 'judged', lossProbability: 0.91, verdict: 'loss',
        originalText: 'cached secret', previewText: 'cached preview', request: { state: 'payload' },
        usage: { inputTokens: 10, outputTokens: 2 }, latencyMs: 4, redactions: 1,
      }),
      set: () => {},
    },
    policy: { minInputTokens: 1 },
  });

  const result = await judge(candidate);

  assert.equal(result.status, 'judged');
  assert.equal(result.lossProbability, 0.91);
  assert.equal(result.verdict, 'loss');
  assert.equal(result.cacheHit, true);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 2 });
  assert.equal(result.originalText, undefined);
  assert.equal(result.previewText, undefined);
  assert.equal(result.request, undefined);
});

test('fails open on timeout and skips current, error, and budget-exhausted candidates', async () => {
  const judge = createSemanticJudge({
    evaluate: async (_request, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'aborted' })), { once: true });
    }),
    policy: { minInputTokens: 1, timeoutMs: 5, maxRequests: 1 },
  });
  const candidate = {
    id: 'old', provider: 'openai-chat', model: 'fixture', toolName: 'Bash',
    originalText: longText, previewText: 'short', historical: true, isError: false,
  };

  const timed = await judge(candidate);
  const current = await judge({ ...candidate, historical: false });
  const error = await judge({ ...candidate, isError: true });
  const budget = await judge({ ...candidate, id: 'other' });

  assert.equal(timed.status, 'fallback');
  assert.equal(timed.reason, 'timeout');
  assert.equal(current.reason, 'current-result');
  assert.equal(error.reason, 'error-result');
  assert.equal(budget.reason, 'budget');
});
