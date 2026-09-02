import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTEXT_CATEGORIES } from '../src/context-footprint.mjs';
import { classifyContextRequest } from '../src/context-classifier.mjs';

function totals(result) {
  return Object.fromEntries(CONTEXT_CATEGORIES.map((category) => [category,
    result.segments.filter((segment) => segment.category === category)
      .reduce((total, segment) => total + segment.bytes, 0),
  ]));
}

test('classifies only structurally proven Claude request sections', () => {
  const body = {
    model: 'claude-fixture',
    max_tokens: 16,
    system: [{ type: 'text', text: 'host instructions' }],
    tools: [
      { name: 'Read', description: 'builtin', input_schema: {} },
      { name: 'mcp__sando__audit', description: 'sando', input_schema: {} },
    ],
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'old history' }] },
      { role: 'user', content: [{ type: 'text', text: 'current prompt' }] },
    ],
  };
  const result = classifyContextRequest({ provider: 'anthropic', body });
  const categories = totals(result);
  const bodyBytes = Buffer.byteLength(JSON.stringify(body));

  assert.ok(categories['host-instructions'] > 0);
  assert.ok(categories['builtin-tools'] > 0);
  assert.ok(categories.sando > 0);
  assert.ok(categories.history > 0);
  assert.ok(categories['user-prompt'] > 0);
  assert.ok(result.segments.every((segment) => !Object.hasOwn(segment, 'content')));
  assert.ok(result.segments.reduce((total, segment) => total + segment.bytes, 0) <= bodyBytes);
});

test('classifies Codex Responses input, tool definitions, and provider envelope', () => {
  const body = {
    model: 'gpt-fixture',
    prompt_cache_key: 'session-key',
    client_metadata: { thread_id: 'thread-id' },
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'host instructions' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old history' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'current prompt' }] },
      { type: 'message', role: 'developer', tools: [{ type: 'namespace', name: 'mcp__sando', tools: [] }] },
    ],
    stream: true,
  };
  const result = classifyContextRequest({ provider: 'openai-responses', body });
  const categories = totals(result);
  const bodyBytes = Buffer.byteLength(JSON.stringify(body));

  assert.ok(categories['host-instructions'] > 0);
  assert.ok(categories.history > 0);
  assert.ok(categories['user-prompt'] > 0);
  assert.ok(categories.sando > 0);
  assert.ok(categories['provider-overhead'] > 0);
  assert.ok(result.segments.reduce((total, segment) => total + segment.bytes, 0) <= bodyBytes);
});
