import assert from 'node:assert/strict';
import test from 'node:test';

import { SEMANTIC_SUMMARY_SCHEMA } from '../../packages/sando/index.mjs';
import { runSemanticShadow } from '../lib/semantic-shadow.mjs';

test('semantic shadow compares deterministic context with compactor cost and cache hits', async () => {
  const scenario = {
    id: 'shadow-fixture',
    events: [
      {
        id: 'long-success',
        toolName: 'Bash',
        output: ['PATH_FACT /workspace/src/app.mjs', ...Array.from({ length: 80 }, () => 'noise')].join('\n'),
        requiredFacts: ['PATH_FACT', { value: '/workspace/src/app.mjs', location: 'head' }],
      },
      {
        id: 'current',
        toolName: 'Bash',
        output: 'current output',
        current: true,
        requiredFacts: ['current output'],
      },
      {
        id: 'error',
        toolName: 'Bash',
        output: 'error: failed to compile',
        isError: true,
        requiredFacts: ['error: failed to compile'],
      },
    ],
  };
  const result = await runSemanticShadow({
    scenarios: [scenario],
    repetitions: 2,
    policy: { minInputTokens: 1 },
    complete: async ({ text, requiredFacts }) => ({
      schema: SEMANTIC_SUMMARY_SCHEMA,
      summary: requiredFacts.filter((fact) => text.includes(fact)).join('\n'),
      preservedFacts: requiredFacts.filter((fact) => text.includes(fact)),
    }),
  });

  assert.equal(result.schema, 'sando-semantic-shadow/v1');
  assert.equal(result.mode, 'provider-free-oracle');
  assert.equal(result.runs.length, 6);
  assert.equal(result.summary.candidates, 2);
  assert.equal(result.summary.cacheHits, 1);
  assert.equal(result.summary.fallbacks, 0);
  assert.equal(result.summary.factRecall, 1);
  assert.ok(result.summary.compactorTokens > 0);
  assert.ok(Number.isFinite(result.summary.latencyP95Ms));
});

test('semantic fact recall does not count skipped or rejected fallbacks', async () => {
  const result = await runSemanticShadow({
    scenarios: [{
      id: 'rejected',
      events: [{ id: 'one', toolName: 'Bash', output: 'FACT '.repeat(100), requiredFacts: ['FACT'] }],
    }],
    policy: { minInputTokens: 1 },
    complete: async () => ({
      schema: SEMANTIC_SUMMARY_SCHEMA,
      summary: 'not the fact',
      preservedFacts: [],
    }),
  });

  assert.equal(result.summary.candidates, 0);
  assert.equal(result.summary.fallbacks, 1);
  assert.equal(result.summary.factRecall, null);
});

test('semantic shadow passes the selected provider and model to the compactor', async () => {
  const requests = [];
  await runSemanticShadow({
    provider: 'claude',
    model: 'haiku',
    scenarios: [{
      id: 'provider-metadata',
      events: [{ id: 'one', toolName: 'Bash', output: 'FACT '.repeat(100), requiredFacts: ['FACT'] }],
    }],
    policy: { minInputTokens: 1 },
    complete: async (request) => {
      requests.push(request);
      return {
        schema: SEMANTIC_SUMMARY_SCHEMA,
        summary: 'FACT',
        preservedFacts: ['FACT'],
      };
    },
  });

  assert.equal(requests[0].provider, 'claude');
  assert.equal(requests[0].model, 'haiku');
});
