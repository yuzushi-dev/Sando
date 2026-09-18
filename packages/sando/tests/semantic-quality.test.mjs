import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSemanticGate,
  transformProviderRequest,
} from '../index.mjs';

const requiredFacts = [
  'ERROR: build failed',
  'exit code: 1',
  'src/app.mjs:42',
];

function factLoss(body) {
  const text = body.messages[1].content;
  return requiredFacts.filter((fact) => !text.includes(fact)).length;
}

function bytes(body) {
  return Buffer.byteLength(JSON.stringify(body));
}

function originalBody() {
  return {
    model: 'fixture',
    messages: [
      { role: 'assistant', tool_calls: [{
        id: 'old', type: 'function', function: {
          name: 'Read', arguments: JSON.stringify({ file_path: 'src/app.mjs:1-80' }),
        },
      }] },
      { role: 'tool', tool_call_id: 'old', content: [
        'Build output',
        'ERROR: build failed',
        'exit code: 1',
        'src/app.mjs:42',
        ...Array.from({ length: 40 }, (_, index) => `detail ${index}`),
      ].join('\n'), status: 'completed', ok: true },
      { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: {
        name: 'Read', arguments: JSON.stringify({ file_path: 'src/app.mjs' }),
      } }] },
      { role: 'tool', tool_call_id: 'new', content: 'current result', status: 'completed', ok: true },
      { role: 'user', content: 'continue' },
    ],
  };
}

const lossyPreview = 'Build output\n[preview omitted]';
const fullOutput = [
  'Build output',
  ...requiredFacts,
  ...Array.from({ length: 8 }, (_, index) => `detail ${index}`),
].join('\n');

function offlineProviderFixtures() {
  const anthropicOriginal = {
    messages: [
      { role: 'assistant', content: [{
        type: 'tool_use', id: 'old', name: 'Read', input: { file_path: 'src/app.mjs:1-80' },
      }] },
      { role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'old', content: fullOutput,
      }] },
      { role: 'assistant', content: [{
        type: 'tool_use', id: 'new', name: 'Read', input: { file_path: 'src/app.mjs' },
      }] },
      { role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'new', content: 'current result',
      }] },
    ],
  };

  const chatOriginal = {
    messages: [
      { role: 'assistant', tool_calls: [{
        id: 'old', type: 'function', function: {
          name: 'Read', arguments: JSON.stringify({ file_path: 'src/app.mjs:1-80' }),
        },
      }] },
      { role: 'tool', tool_call_id: 'old', content: fullOutput, status: 'completed' },
      { role: 'assistant', tool_calls: [{
        id: 'new', type: 'function', function: {
          name: 'Read', arguments: JSON.stringify({ file_path: 'src/app.mjs' }),
        },
      }] },
      { role: 'tool', tool_call_id: 'new', content: 'current result', status: 'completed' },
    ],
  };

  const responsesOriginal = {
    input: [
      {
        type: 'function_call', call_id: 'old', name: 'Read',
        arguments: JSON.stringify({ file_path: 'src/app.mjs:1-80' }),
      },
      { type: 'function_call_output', call_id: 'old', output: fullOutput, status: 'completed' },
      {
        type: 'function_call', call_id: 'new', name: 'Read',
        arguments: JSON.stringify({ file_path: 'src/app.mjs' }),
      },
      { type: 'function_call_output', call_id: 'new', output: 'current result', status: 'completed' },
    ],
  };

  return [
    {
      provider: 'anthropic',
      originalBody: anthropicOriginal,
      transformedBody: (() => {
        const body = structuredClone(anthropicOriginal);
        body.messages[1].content[0].content = lossyPreview;
        return body;
      })(),
      read: (body) => body.messages[1].content[0].content,
    },
    {
      provider: 'openai-chat',
      originalBody: chatOriginal,
      transformedBody: (() => {
        const body = structuredClone(chatOriginal);
        body.messages[1].content = lossyPreview;
        return body;
      })(),
      read: (body) => body.messages[1].content,
    },
    {
      provider: 'openai-responses',
      originalBody: responsesOriginal,
      transformedBody: (() => {
        const body = structuredClone(responsesOriginal);
        body.input[1].output = lossyPreview;
        return body;
      })(),
      read: (body) => body.input[1].output,
    },
  ];
}

test('semantic gate reduces labeled fact loss when the judge flags a lossy preview', async () => {
  const original = originalBody();
  const transformed = transformProviderRequest({
    provider: 'openai-chat',
    body: original,
    policy: { maxHistoryTokens: 10_000 },
  }).body;
  const baselineLoss = factLoss(transformed);
  const baselineBytes = bytes(transformed);
  const gate = createSemanticGate({
    judge: async (candidate) => {
      const loss = requiredFacts.some((fact) => !candidate.previewText.includes(fact));
      return {
        status: 'judged',
        verdict: loss ? 'loss' : 'preserved',
        lossProbability: loss ? 0.98 : 0.02,
      };
    },
    lossThreshold: 0.7,
  });

  const result = await gate({
    provider: 'openai-chat', originalBody: original, transformedBody: transformed, model: 'fixture',
  });

  assert.equal(baselineLoss, requiredFacts.length);
  assert.equal(factLoss(result.body), 0);
  assert.equal(result.stats.restored, 1);
  assert.equal(result.stats.losses, 1);
  assert.ok(baselineBytes < bytes(result.body));
});

test('semantic gate keeps a smaller preview when the judge says facts were preserved', async () => {
  const original = originalBody();
  const transformed = structuredClone(original);
  transformed.messages[1].content = 'Build output\nERROR: build failed\nexit code: 1\nsrc/app.mjs:42';
  const gate = createSemanticGate({
    judge: async () => ({ status: 'judged', verdict: 'preserved', lossProbability: 0.01 }),
  });

  const result = await gate({
    provider: 'openai-chat', originalBody: original, transformedBody: transformed, model: 'fixture',
  });

  assert.equal(factLoss(result.body), 0);
  assert.equal(result.body.messages[1].content, transformed.messages[1].content);
  assert.equal(result.stats.restored, 0);
  assert.equal(result.stats.preserved, 1);
  assert.ok(bytes(result.body) < bytes(original));
});

test('semantic gate restores a judged loss in all provider envelopes', async () => {
  for (const fixture of offlineProviderFixtures()) {
    const gate = createSemanticGate({
      judge: async (candidate) => {
        assert.equal(candidate.previewText, lossyPreview);
        return { status: 'judged', verdict: 'loss', lossProbability: 0.98 };
      },
    });

    const result = await gate({
      provider: fixture.provider,
      originalBody: fixture.originalBody,
      transformedBody: fixture.transformedBody,
      model: 'fixture',
    });

    assert.equal(result.stats.candidates, 1, fixture.provider);
    assert.equal(result.stats.judged, 1, fixture.provider);
    assert.equal(result.stats.losses, 1, fixture.provider);
    assert.equal(result.stats.restored, 1, fixture.provider);
    assert.equal(fixture.read(result.body), fixture.read(fixture.originalBody), fixture.provider);
  }
});

test('semantic gate fails open and honors the loss threshold', async () => {
  const fixture = offlineProviderFixtures()[1];
  const rejected = createSemanticGate({
    judge: async () => {
      throw new Error('offline judge unavailable');
    },
  });
  const rejectedResult = await rejected({
    provider: fixture.provider,
    originalBody: fixture.originalBody,
    transformedBody: fixture.transformedBody,
  });

  assert.deepEqual(rejectedResult.body, fixture.transformedBody);
  assert.equal(rejectedResult.stats.fallbacks, 1);
  assert.equal(rejectedResult.stats.restored, 0);

  const belowThreshold = createSemanticGate({
    judge: async () => ({ status: 'judged', verdict: 'loss', lossProbability: 0.69 }),
    lossThreshold: 0.7,
  });
  const thresholdResult = await belowThreshold({
    provider: fixture.provider,
    originalBody: fixture.originalBody,
    transformedBody: fixture.transformedBody,
  });

  assert.deepEqual(thresholdResult.body, fixture.transformedBody);
  assert.equal(thresholdResult.stats.losses, 1);
  assert.equal(thresholdResult.stats.restored, 0);
});
