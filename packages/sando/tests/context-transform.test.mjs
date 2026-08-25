import assert from 'node:assert/strict';
import test from 'node:test';

import { detectProviderBody, listSemanticCandidates, transformProviderRequest } from '../index.mjs';

const SUPERSEDED = '[sando superseded by newer read]';
const USELESS = '[sando elided useless success]';

test('supersedes an older Anthropic Read covered by a newer Read', () => {
  const body = {
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Read', input: { file_path: 'src/app.mjs', offset: 1, limit: 20 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'old body '.repeat(20) }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'new', name: 'Read', input: { file_path: 'src/app.mjs' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new', content: 'current body' }] },
    ],
  };

  const result = transformProviderRequest({ provider: 'anthropic', body });

  assert.equal(result.body.messages[1].content[0].content, SUPERSEDED);
  assert.equal(result.body.messages[1].content[0].tool_use_id, 'old');
  assert.equal(result.body.messages[3].content[0].content, 'current body');
  assert.equal(result.changed, true);
  assert.deepEqual(result.reasons, ['superseded-read']);
  assert.equal(result.stats.supersededReads, 1);
  assert.ok(result.stats.estimatedOutputTokens < result.stats.estimatedInputTokens);
  assert.notEqual(result.body, body);
  assert.notEqual(result.body.messages, body.messages);
  assert.equal(body.messages[1].content[0].content, 'old body '.repeat(20));
});

test('keeps Anthropic errors, current results, unknown blocks, and disjoint selectors', () => {
  const body = {
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a', offset: 1, limit: 5 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'first', is_error: true }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'a', offset: 20, limit: 5 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }] }] },
    ],
  };

  const result = transformProviderRequest({ provider: 'anthropic', body });

  assert.deepEqual(result.body, body);
  assert.equal(result.changed, false);
  assert.deepEqual(result.reasons, []);
});

test('supports Anthropic text-block tool results without flattening their shape', () => {
  const body = {
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Read', input: { file_path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: [{ type: 'text', text: 'old body' }] }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'new', name: 'Read', input: { file_path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new', content: [{ type: 'text', text: 'new body' }] }] },
    ],
  };

  const result = transformProviderRequest({ provider: 'anthropic', body });

  assert.deepEqual(result.body.messages[1].content[0].content, [{ type: 'text', text: SUPERSEDED }]);
  assert.deepEqual(result.body.messages[3].content[0].content, [{ type: 'text', text: 'new body' }]);
});

test('does not prune parallel Reads from the current Anthropic tool batch', () => {
  const body = {
    messages: [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'same' } },
        { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'same' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'first current result' },
        { type: 'tool_result', tool_use_id: 'b', content: 'second current result' },
      ] },
    ],
  };

  const result = transformProviderRequest({ provider: 'anthropic', body });

  assert.deepEqual(result.body, body);
  assert.equal(result.changed, false);
});

test('supersedes OpenAI Chat Completions Reads and preserves malformed arguments', () => {
  const body = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'Read', arguments: '{"file_path":"same"}' } }] },
      { role: 'tool', tool_call_id: 'old', content: 'old body' },
      { role: 'assistant', tool_calls: [
        { id: 'bad', type: 'function', function: { name: 'Read', arguments: '{bad json' } },
        { id: 'new', type: 'function', function: { name: 'Read', arguments: '{"file_path":"same"}' } },
      ] },
      { role: 'tool', tool_call_id: 'bad', content: 'must stay' },
      { role: 'tool', tool_call_id: 'new', content: 'new body' },
    ],
  };

  const result = transformProviderRequest({ provider: 'openai-chat', body });

  assert.equal(result.body.messages[1].content, SUPERSEDED);
  assert.equal(result.body.messages[3].content, 'must stay');
  assert.equal(result.body.messages[4].content, 'new body');
});

test('supports OpenAI Responses function_call and function_call_output items', () => {
  const body = {
    model: 'gpt-5.6-luna',
    input: [
      { type: 'function_call', call_id: 'old', name: 'Read', arguments: '{"file_path":"same"}' },
      { type: 'function_call_output', call_id: 'old', output: 'old body' },
      { type: 'message', role: 'user', content: 'continue' },
      { type: 'function_call', call_id: 'new', name: 'Read', arguments: '{"file_path":"same"}' },
      { type: 'function_call_output', call_id: 'new', output: 'new body' },
    ],
  };

  const result = transformProviderRequest({ provider: 'openai-responses', body });

  assert.equal(result.body.input[1].output, SUPERSEDED);
  assert.equal(result.body.input[1].call_id, 'old');
  assert.equal(result.body.input[4].output, 'new body');
  assert.deepEqual(result.body.input.map((item) => item.type), body.input.map((item) => item.type));
});

test('supports Codex custom_tool_call history in Responses requests', () => {
  const body = {
    input: [
      { type: 'custom_tool_call', call_id: 'old', name: 'exec', input: 'printf old' },
      { type: 'custom_tool_call_output', call_id: 'old', output: [{ type: 'input_text', text: `${'proxy-noise\n'.repeat(500)}SANDO_PROXY_HEAD_FACT` }] },
      { type: 'message', role: 'user', content: 'continue' },
      { type: 'custom_tool_call', call_id: 'new', name: 'exec', input: 'printf new' },
      { type: 'custom_tool_call_output', call_id: 'new', output: [{ type: 'input_text', text: 'SANDO_PROXY_FINAL_FACT' }] },
    ],
  };

  const result = transformProviderRequest({ provider: 'openai-responses', body, policy: { maxHistoryTokens: 1000 } });

  // Structural collapse now runs for `exec` (its allowlist was aligned with
  // history-shake's), and it wins on this input: it reaches the same repetitive
  // output first and produces a strictly better result than shake would — smaller,
  // and it preserves the trailing fact verbatim instead of eliding around it.
  const shaken = result.body.input[1].output[0].text;
  assert.match(shaken, /\[sando repeated x500\]/);
  assert.ok(shaken.includes('SANDO_PROXY_HEAD_FACT'), 'structural collapse keeps the tail fact');
  assert.equal(result.body.input[4].output[0].text, 'SANDO_PROXY_FINAL_FACT');
  assert.equal(result.stats.compactedStructures, 1);
  assert.deepEqual(result.reasons, ['repeated-lines']);
  assert.ok(result.stats.estimatedOutputTokens < result.stats.estimatedInputTokens / 10);
});

test('lists only historical successful provider results as semantic candidates', () => {
  const body = {
    model: 'gpt-5.6-luna',
    input: [
      { type: 'custom_tool_call', call_id: 'old', name: 'Bash', input: { command: 'npm test' } },
      { type: 'custom_tool_call_output', call_id: 'old', output: 'old successful output' },
      { type: 'custom_tool_call', call_id: 'error', name: 'Bash', input: { command: 'npm test' } },
      { type: 'custom_tool_call_output', call_id: 'error', output: 'error: network failed' },
      { type: 'message', role: 'user', content: 'continue' },
      { type: 'custom_tool_call', call_id: 'current', name: 'Bash', input: { command: 'git status' } },
      { type: 'custom_tool_call_output', call_id: 'current', output: 'current output' },
    ],
  };

  assert.deepEqual(listSemanticCandidates({ provider: 'openai-responses', body }), [{
    id: 'old',
    model: 'gpt-5.6-luna',
    toolName: 'Bash',
    text: 'old successful output',
    current: false,
    historical: true,
    isError: false,
    estimatedTokens: 6,
  }]);
});

test('elides only recognizable historical no-output successes', () => {
  const body = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'ok', type: 'function', function: { name: 'Bash', arguments: '{"command":"true"}' } }] },
      { role: 'tool', tool_call_id: 'ok', content: 'Command completed successfully with no output.' },
      { role: 'assistant', content: 'noted' },
      { role: 'tool', tool_call_id: 'unknown', content: 'Command completed successfully with no output.' },
    ],
  };

  const result = transformProviderRequest({ provider: 'openai-chat', body });

  assert.equal(result.body.messages[1].content, USELESS);
  assert.equal(result.body.messages[3].content, 'Command completed successfully with no output.');
  assert.deepEqual(result.reasons, ['useless-success']);
  assert.equal(result.stats.elidedUselessSuccesses, 1);
});

test('fails closed for duplicate IDs and ambiguous result shapes', () => {
  const duplicate = {
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'Read', input: { file_path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'same', content: 'one' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'Read', input: { file_path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'same', content: 'two' }] },
    ],
  };
  const ambiguous = {
    input: [
      { type: 'function_call', call_id: 'a', name: 'Read', arguments: '{"file_path":"a"}' },
      { type: 'function_call_output', call_id: 'a', output: { value: 'not a string' } },
      { type: 'function_call', call_id: 'b', name: 'Read', arguments: '{"file_path":"a"}' },
      { type: 'function_call_output', call_id: 'b', output: 'new' },
    ],
  };

  assert.deepEqual(transformProviderRequest({ provider: 'anthropic', body: duplicate }).body, duplicate);
  assert.deepEqual(transformProviderRequest({ provider: 'openai-responses', body: ambiguous }).body, ambiguous);
});

test('detects provider tool shapes conservatively and leaves no-op requests cloned', () => {
  const anthropic = { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] }] };
  const chat = { messages: [{ role: 'assistant', tool_calls: [] }] };
  const responses = { input: [{ type: 'function_call', call_id: 'a', name: 'Read', arguments: '{}' }] };
  const unknown = { messages: [{ role: 'user', content: 'hello' }] };

  assert.equal(detectProviderBody(anthropic, {}), 'anthropic');
  assert.equal(detectProviderBody(chat, {}), 'openai-chat');
  assert.equal(detectProviderBody(responses, {}), 'openai-responses');
  assert.equal(detectProviderBody(unknown, {}), null);

  const result = transformProviderRequest({ body: unknown, policy: { maxHistoryTokens: 10_000 } });
  assert.deepEqual(result.body, unknown);
  assert.notEqual(result.body, unknown);
  assert.equal(result.changed, false);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.stats, {
    estimatedInputTokens: 12,
    estimatedOutputTokens: 12,
    supersededReads: 0,
    elidedUselessSuccesses: 0,
    deduplicatedResults: 0,
    compactedStructures: 0,
    shakenResults: 0,
    budgetTriggered: false,
  });
});

test('deduplicates an older identical historical tool result', () => {
  const output = 'same matches '.repeat(20);
  const body = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"x"}' } }] },
      { role: 'tool', tool_call_id: 'old', content: output },
      { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"x"}' } }] },
      { role: 'tool', tool_call_id: 'new', content: output },
    ],
  };

  const result = transformProviderRequest({ provider: 'openai-chat', body });

  assert.equal(result.body.messages[1].content, '[sando duplicate historical result]');
  assert.equal(result.body.messages[3].content, output);
  assert.equal(result.stats.deduplicatedResults, 1);
  assert.ok(result.stats.estimatedOutputTokens < result.stats.estimatedInputTokens);
  assert.ok(result.reasons.includes('duplicate-history'));
});

test('compacts repeated lines only in an older historical Bash result', () => {
  const body = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'Bash', arguments: '{"command":"make"}' } }] },
      { role: 'tool', tool_call_id: 'old', content: 'warning\nwarning\nwarning\nwarning\n' },
      { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: { name: 'Bash', arguments: '{"command":"date"}' } }] },
      { role: 'tool', tool_call_id: 'new', content: 'current\n' },
    ],
  };

  const result = transformProviderRequest({ provider: 'openai-chat', body });

  assert.equal(result.body.messages[1].content, 'warning\n[sando repeated x4]\n');
  assert.equal(result.body.messages[3].content, 'current\n');
  assert.equal(result.stats.compactedStructures, 1);
  assert.ok(result.stats.estimatedOutputTokens < result.stats.estimatedInputTokens);
  assert.ok(result.reasons.includes('repeated-lines'));
});

test('gates the additional history reductions at 80% of maxHistoryTokens', () => {
  const body = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"x"}' } }] },
      { role: 'tool', tool_call_id: 'old', content: 'same matches '.repeat(40) },
      { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"x"}' } }] },
      { role: 'tool', tool_call_id: 'new', content: 'same matches '.repeat(40) },
    ],
  };

  const below = transformProviderRequest({ provider: 'openai-chat', body, policy: { maxHistoryTokens: 10_000 } });
  assert.equal(below.changed, false);
  assert.equal(below.stats.budgetTriggered, false);

  const above = transformProviderRequest({ provider: 'openai-chat', body, policy: { maxHistoryTokens: 100 } });
  assert.equal(above.changed, true);
  assert.equal(above.stats.budgetTriggered, true);
  assert.equal(above.body.messages[1].content, '[sando duplicate historical result]');
});

test('shakes large historical Bash output only after the history budget trigger', () => {
  const oldOutput = Array.from({ length: 100 }, (_, index) => `trace ${index} ${'x'.repeat(24)}`).join('\n');
  const body = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'Bash', arguments: '{"command":"build"}' } }] },
      { role: 'tool', tool_call_id: 'old', content: oldOutput },
      { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: { name: 'Bash', arguments: '{"command":"date"}' } }] },
      { role: 'tool', tool_call_id: 'new', content: 'current' },
    ],
  };

  const result = transformProviderRequest({ provider: 'openai-chat', body, policy: { maxHistoryTokens: 100 } });

  assert.equal(result.stats.shakenResults, 1);
  assert.ok(result.body.messages[1].content.includes('[sando history shake:'));
  assert.ok(result.stats.estimatedOutputTokens < result.stats.estimatedInputTokens);
  assert.equal(result.body.messages[3].content, 'current');
});

test('preserves a cache_control breakpoint when collapsing multi-block tool results', () => {
  // Claude Code places cache_control markers in the request body Sando's proxy
  // rewrites. Collapsing a text-block run into one block must not silently drop a
  // marker sitting on a later block — that would forfeit a cache read every turn.
  const marker = { type: 'ephemeral' };
  const read = (id, file) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: file } });
  const result = transformProviderRequest({
    provider: 'anthropic',
    body: {
      model: 'claude-sonnet-5',
      messages: [
        { role: 'assistant', content: [read('t1', '/a.ts')] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
          { type: 'text', text: 'OLD PART ONE' },
          { type: 'text', text: 'OLD PART TWO', cache_control: marker },
        ] }] },
        { role: 'assistant', content: [read('t2', '/a.ts')] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'NEW BODY' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
    },
  });

  assert.equal(result.stats.supersededReads, 1);
  const collapsed = result.body.messages[1].content[0].content;
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].text, SUPERSEDED);
  assert.deepEqual(collapsed[0].cache_control, marker);
});

test('leaves tool results carrying a non-text block untouched', () => {
  // resultText returns null for a mixed content array, so these are skipped
  // entirely rather than partially rewritten. Asserted so the behaviour is
  // deliberate rather than incidental.
  const read = (id, file) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: file } });
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const result = transformProviderRequest({
    provider: 'anthropic',
    body: {
      model: 'claude-sonnet-5',
      messages: [
        { role: 'assistant', content: [read('t1', '/c.png')] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
          { type: 'text', text: 'OLD BODY' },
          image,
        ] }] },
        { role: 'assistant', content: [read('t2', '/c.png')] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'NEW BODY' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
    },
  });

  assert.equal(result.stats.supersededReads, 0);
  assert.equal(result.changed, false);
  assert.deepEqual(result.body.messages[1].content[0].content[1], image);
});
