import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { detectProviderBody, listSemanticCandidates, transformProviderRequest } from '../index.mjs';

const SUPERSEDED = '[sando superseded by newer read]';
const USELESS = '[sando elided useless success]';

const archiveOnly = {
  strategies: {
    supersededRead: false,
    producerUseless: false,
    exactDuplicate: false,
    repeatedLines: false,
    historyShake: false,
    recoverableArchive: true,
  },
  historyArchiveRetainResults: 1,
  cacheRewriteRatio: 0,
};

test('archives eligible old results in all provider formats while preserving IDs and shapes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sando-history-'quote-"));
  const old = `historical unicode π\n${'detail '.repeat(800)}`;
  const fixtures = [
    {
      provider: 'anthropic',
      body: { messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'old-a', name: 'Bash', input: { command: 'build' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-a', content: [{ type: 'text', text: old }], custom: 'keep' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'new-a', name: 'Bash', input: { command: 'status' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new-a', content: 'current', custom: 'keep' }] },
      ] },
      archived(result) { return result.body.messages[1].content[0]; },
      current(result) { return result.body.messages[3].content[0].content; },
    },
    {
      provider: 'openai-chat',
      body: { messages: [
        { role: 'assistant', tool_calls: [{ id: 'old-c', type: 'function', function: { name: 'Bash', arguments: '{"command":"build"}' } }] },
        { role: 'tool', tool_call_id: 'old-c', content: old, status: 'completed', ok: true, custom: 'keep' },
        { role: 'assistant', tool_calls: [{ id: 'new-c', type: 'function', function: { name: 'Bash', arguments: '{"command":"status"}' } }] },
        { role: 'tool', tool_call_id: 'new-c', content: 'current', status: 'completed', ok: true },
      ] },
      archived(result) { return result.body.messages[1]; },
      current(result) { return result.body.messages[3].content; },
    },
    {
      provider: 'openai-responses',
      body: { input: [
        { type: 'function_call', call_id: 'old-r', name: 'Bash', arguments: '{"command":"build"}' },
        { type: 'function_call_output', call_id: 'old-r', output: old, status: 'completed', ok: true, custom: 'keep' },
        { type: 'function_call', call_id: 'new-r', name: 'Bash', arguments: '{"command":"status"}' },
        { type: 'function_call_output', call_id: 'new-r', output: 'current', status: 'completed', ok: true },
      ] },
      archived(result) { return result.body.input[1]; },
      current(result) { return result.body.input[3].output; },
    },
  ];

  for (const fixture of fixtures) {
    const result = transformProviderRequest({
      provider: fixture.provider, body: fixture.body, policy: archiveOnly, historyArchiveRoot: root,
    });
    const archived = fixture.archived(result);
    const value = archived.text ?? archived.content ?? archived.output;
    const marker = Array.isArray(value) ? value[0].text : value;
    assert.match(marker, /^\[sando archived result sando:sha256:[a-f0-9]{64}; \d+B, \d+ lines; use rtk grep -n on archive /);
    assert.match(marker, /first page: sando artifact get --root '.*'"'"'.*' --ref sando:sha256:[a-f0-9]{64} --start-line 1 --end-line \d+ --max-bytes 8192; bounded, continue with valid line ranges up to \d+\]$/);
    assert.equal(archived.custom, 'keep');
    assert.equal(fixture.current(result), 'current');
    assert.equal(result.stats.archivedResults, 1);
    assert.deepEqual(result.reasons, ['recoverable-archive']);
  }
});

test('keeps small historical results inline instead of paying marker overhead', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-history-size-'));
  const output = 'small result\n'.repeat(120);
  const body = { messages: [
    { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old', content: output, status: 'completed', ok: true },
    { role: 'user', content: 'continue' },
  ] };

  const result = transformProviderRequest({
    provider: 'openai-chat', body,
    policy: { ...archiveOnly, historyArchiveRetainResults: 0 }, historyArchiveRoot: root,
  });

  assert.deepEqual(result.body, body);
  assert.equal(result.stats.archivedResults, 0);
  assert.equal(result.stats.archiveSizeSkips, 1);
  assert.equal(fs.existsSync(path.join(root, '.sando')), false);
});

test('recoverable archive keeps recent, error, secret-bearing, opaque, and duplicate-ID results unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-history-safe-'));
  const old = `${'eligible '.repeat(700)}tail`;
  const body = { messages: [
    { role: 'assistant', tool_calls: [{ id: 'eligible', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'eligible', content: old, status: 'completed', ok: true },
    { role: 'assistant', tool_calls: [{ id: 'secret', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'secret', content: `api_key=${'x'.repeat(24)} ${old}`, status: 'completed', ok: true },
    { role: 'assistant', tool_calls: [{ id: 'error', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'error', content: `error: ${old}`, status: 'failed', ok: false },
    { role: 'assistant', tool_calls: [{ id: 'dup', type: 'function', function: { name: 'Bash', arguments: '{}' } }, { id: 'dup', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'dup', content: old, status: 'completed', ok: true },
    { role: 'assistant', tool_calls: [{ id: 'opaque', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'opaque', content: { unknown: old }, status: 'completed', ok: true },
    { role: 'assistant', tool_calls: [{ id: 'current', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'current', content: old, status: 'completed', ok: true },
  ] };

  const result = transformProviderRequest({ provider: 'openai-chat', body, policy: archiveOnly, historyArchiveRoot: root });
  assert.match(result.body.messages[1].content, /^\[sando archived result /);
  for (const position of [3, 5, 7, 9, 11]) assert.deepEqual(result.body.messages[position], body.messages[position]);
  assert.equal(result.stats.archivedResults, 1);
  assert.equal(result.stats.archiveRedactionSkips, 1);
});

test('recoverable archive accepts a zero-length recent window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-history-zero-window-'));
  const body = { messages: [
    { role: 'assistant', tool_calls: [{ id: 'only', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'only', content: 'old '.repeat(1200), status: 'completed', ok: true },
    { role: 'assistant', content: 'continue' },
  ] };
  const policy = { ...archiveOnly, historyArchiveRetainResults: 0 };

  const result = transformProviderRequest({ provider: 'openai-chat', body, policy, historyArchiveRoot: root });

  assert.match(result.body.messages[1].content, /^\[sando archived result /);
  assert.equal(result.stats.archivedResults, 1);
});

test('recoverable archive retains the latest three tool results by default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-history-default-window-'));
  const messages = [];
  for (let index = 0; index < 5; index += 1) {
    messages.push(
      { role: 'assistant', tool_calls: [{ id: `result-${index}`, type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `result-${index}`, content: `${index} ${'history '.repeat(600)}`, status: 'completed', ok: true },
    );
  }
  messages.push({ role: 'user', content: 'continue' });
  const { historyArchiveRetainResults: _override, ...policy } = archiveOnly;

  const result = transformProviderRequest({ provider: 'openai-chat', body: { messages }, policy, historyArchiveRoot: root });

  assert.match(result.body.messages[1].content, /^\[sando archived result /);
  assert.match(result.body.messages[3].content, /^\[sando archived result /);
  for (const position of [5, 7, 9]) assert.equal(result.body.messages[position].content, messages[position].content);
  assert.equal(result.stats.archivedResults, 2);
});

test('cache guard evaluates the final archive marker before anything is persisted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-history-cache-'));
  const body = { messages: [
    { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old', content: 'old '.repeat(1200), status: 'completed', ok: true },
    { role: 'user', content: [{ type: 'text', text: 'suffix '.repeat(10_000), cache_control: { type: 'ephemeral' } }] },
  ] };
  const policy = { ...archiveOnly, historyArchiveRetainResults: 0, cacheRewriteRatio: 0.51 };

  const result = transformProviderRequest({ provider: 'openai-chat', body, policy, historyArchiveRoot: root });

  assert.deepEqual(result.body, body);
  assert.equal(result.stats.cacheProtectedSkips, 1);
  assert.equal(fs.existsSync(path.join(root, '.sando')), false);
});

test('recoverable archive does not archive an existing archive marker again', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-history-idempotent-'));
  const ref = `sando:sha256:${'a'.repeat(64)}`;
  const marker = `[sando archived result ${ref}; recover: sando artifact get --root '${'/long'.repeat(100)}' --ref ${ref} --max-bytes 65536]`;
  const body = { messages: [
    { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old', content: marker, status: 'completed', ok: true },
    { role: 'user', content: 'continue' },
  ] };
  const policy = { ...archiveOnly, historyArchiveRetainResults: 0 };

  const result = transformProviderRequest({ provider: 'openai-chat', body, policy, historyArchiveRoot: root });

  assert.deepEqual(result.body, body);
  assert.equal(result.stats.archivedResults, 0);
});

test('archive strategy disabled preserves superseded-read precedence over duplicate reduction', () => {
  const output = 'same body '.repeat(100);
  const body = { messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Read', input: { file_path: 'same' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: output }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'new', name: 'Read', input: { file_path: 'same' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new', content: output }] },
  ] };

  const result = transformProviderRequest({ provider: 'anthropic', body });

  assert.equal(result.body.messages[1].content[0].content, SUPERSEDED);
  assert.deepEqual(result.reasons, ['superseded-read']);
});

test('recoverable archive recognizes only a completed native Codex exec envelope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-history-codex-exec-'));
  const success = [
    'Chunk ID: sanitized',
    'Wall time: 0.012 seconds',
    'Process exited with code 0',
    'Original token count: 2000',
    'Output:',
    ...Array.from({ length: 200 }, (_, index) => `record ${index}: ${'detail '.repeat(10)}`),
  ].join('\n');
  const current = [
    'Chunk ID: current',
    'Wall time: 0.001 seconds',
    'Process exited with code 0',
    'Original token count: 2',
    'Output:',
    'current result',
  ].join('\n');
  const body = { input: [
    { type: 'function_call', id: 'fc-old', call_id: 'old', name: 'exec_command', arguments: '{"cmd":"read fixture"}' },
    { type: 'function_call_output', id: 'fco-old', call_id: 'old', output: success },
    { type: 'function_call', id: 'fc-current', call_id: 'current', name: 'exec_command', arguments: '{"cmd":"status"}' },
    { type: 'function_call_output', id: 'fco-current', call_id: 'current', output: current },
  ] };

  const result = transformProviderRequest({
    provider: 'openai-responses', body, policy: archiveOnly, historyArchiveRoot: root,
  });

  assert.match(result.body.input[1].output, /^\[sando archived result /);
  assert.equal(result.body.input[1].id, 'fco-old');
  assert.equal(result.body.input[3].output, current);
  assert.equal(result.stats.archivedResults, 1);
  assert.deepEqual(listSemanticCandidates({ provider: 'openai-responses', body }), []);
});

test('recoverable archive rejects spoofed, nonzero, running, negative, and opaque Codex exec results', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-history-codex-exec-negative-'));
  const outputs = [
    [
      'Chunk ID: nonzero', 'Wall time: 0.01 seconds', 'Process exited with code 7',
      'Original token count: 1000', 'Output:', 'Process exited with code 0', 'detail '.repeat(500),
    ].join('\n'),
    ['Chunk ID: running', 'Wall time: 10 seconds', 'Process running with session ID 42', 'Live output:', 'detail '.repeat(500)].join('\n'),
    ['Chunk ID: unknown', 'Wall time: 0.01 seconds', 'Output:', 'detail '.repeat(500)].join('\n'),
    ['Chunk ID: negative', 'Wall time: 0.01 seconds', 'Process exited with code 0', 'Original token count: 1000', 'Output:', 'detail '.repeat(500)].join('\n'),
    ['Chunk ID: status-running', 'Wall time: 0.01 seconds', 'Process exited with code 0', 'Original token count: 1000', 'Output:', 'detail '.repeat(500)].join('\n'),
    ['Chunk ID: wrong-tool', 'Wall time: 0.01 seconds', 'Process exited with code 0', 'Original token count: 1000', 'Output:', 'detail '.repeat(500)].join('\n'),
  ];
  const input = [];
  for (let index = 0; index < outputs.length; index += 1) {
    input.push(
      { type: 'function_call', id: `fc-${index}`, call_id: `call-${index}`, name: index === 5 ? 'other_tool' : 'exec_command', arguments: '{}' },
      {
        type: 'function_call_output', id: `fco-${index}`, call_id: `call-${index}`, output: outputs[index],
        ...([0, 1].includes(index) ? { status: 'completed', ok: true } : {}),
        ...(index === 3 ? { ok: false } : {}),
        ...(index === 4 ? { status: 'running' } : {}),
      },
    );
  }
  input.push(
    { type: 'function_call', id: 'fc-opaque', call_id: 'opaque', name: 'exec_command', arguments: '{}' },
    { type: 'function_call_output', id: 'fco-opaque', call_id: 'opaque', output: [{ type: 'input_text', text: outputs[3] }] },
    { type: 'custom_tool_call', id: 'fc-custom', call_id: 'custom', name: 'exec_command', input: '{}' },
    { type: 'custom_tool_call_output', id: 'fco-custom', call_id: 'custom', output: outputs[3] },
    { type: 'message', role: 'user', content: 'continue' },
  );
  const body = { input };
  const policy = { ...archiveOnly, historyArchiveRetainResults: 0 };

  const result = transformProviderRequest({ provider: 'openai-responses', body, policy, historyArchiveRoot: root });

  assert.deepEqual(result.body, body);
  assert.equal(result.stats.archivedResults, 0);
});

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
      { role: 'tool', tool_call_id: 'old', content: 'old body', status: 'completed', ok: true },
      { role: 'assistant', tool_calls: [
        { id: 'bad', type: 'function', function: { name: 'Read', arguments: '{bad json' } },
        { id: 'new', type: 'function', function: { name: 'Read', arguments: '{"file_path":"same"}' } },
      ] },
      { role: 'tool', tool_call_id: 'bad', content: 'must stay' },
      { role: 'tool', tool_call_id: 'new', content: 'new body', status: 'completed', ok: true },
    ],
  };

  const result = transformProviderRequest({ provider: 'openai-chat', body });

  assert.equal(result.body.messages[1].content, SUPERSEDED);
  assert.equal(result.body.messages[3].content, 'must stay');
  assert.equal(result.body.messages[4].content, 'new body');
});

test('supports OpenAI Responses function_call and function_call_output items', () => {
  const body = {
    model: 'codex-fixture-model',
    input: [
      { type: 'function_call', call_id: 'old', name: 'Read', arguments: '{"file_path":"same"}' },
      { type: 'function_call_output', call_id: 'old', output: 'old body', status: 'completed', ok: true },
      { type: 'message', role: 'user', content: 'continue' },
      { type: 'function_call', call_id: 'new', name: 'Read', arguments: '{"file_path":"same"}' },
      { type: 'function_call_output', call_id: 'new', output: 'new body', status: 'completed', ok: true },
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
      { type: 'custom_tool_call_output', call_id: 'old', output: [{ type: 'input_text', text: `${'proxy-noise\n'.repeat(500)}SANDO_PROXY_HEAD_FACT` }], status: 'completed', ok: true },
      { type: 'message', role: 'user', content: 'continue' },
      { type: 'custom_tool_call', call_id: 'new', name: 'exec', input: 'printf new' },
      { type: 'custom_tool_call_output', call_id: 'new', output: [{ type: 'input_text', text: 'SANDO_PROXY_FINAL_FACT' }], status: 'completed', ok: true },
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
    model: 'codex-fixture-model',
    input: [
      { type: 'custom_tool_call', call_id: 'old', name: 'Bash', input: { command: 'npm test' } },
      { type: 'custom_tool_call_output', call_id: 'old', output: 'old successful output', status: 'completed', ok: true },
      { type: 'custom_tool_call', call_id: 'error', name: 'Bash', input: { command: 'npm test' } },
      { type: 'custom_tool_call_output', call_id: 'error', output: 'error: network failed', status: 'completed' },
      { type: 'message', role: 'user', content: 'continue' },
      { type: 'custom_tool_call', call_id: 'current', name: 'Bash', input: { command: 'git status' } },
      { type: 'custom_tool_call_output', call_id: 'current', output: 'current output', status: 'completed', ok: true },
    ],
  };

  assert.deepEqual(listSemanticCandidates({ provider: 'openai-responses', body }), [{
    id: 'old',
    model: 'codex-fixture-model',
    toolName: 'Bash',
    text: 'old successful output',
    current: false,
    historical: true,
    isError: false,
    estimatedTokens: 6,
  }]);
});

test('keeps opaque OpenAI results lossless without explicit success evidence', () => {
  const output = 'permission denied\n'.repeat(20);
  const body = { messages: [
    { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old', content: output },
    { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'new', content: output },
  ] };

  assert.deepEqual(transformProviderRequest({ provider: 'openai-chat', body }).body, body);

  const noOutput = structuredClone(body);
  noOutput.messages[1].content = 'Command completed successfully with no output.';
  assert.deepEqual(transformProviderRequest({ provider: 'openai-chat', body: noOutput }).body, noOutput);
});

test('allows each historical transform family to be disabled independently', () => {
  const output = 'same matches '.repeat(20);
  const body = { messages: [
    { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'Grep', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old', content: output, status: 'completed', ok: true },
    { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: { name: 'Grep', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'new', content: output, status: 'completed', ok: true },
  ] };
  const result = transformProviderRequest({ provider: 'openai-chat', body, policy: {
    strategies: { exactDuplicate: false, repeatedLines: false },
  } });

  assert.deepEqual(result.body, body);
  assert.equal(result.changed, false);
  assert.throws(
    () => transformProviderRequest({ provider: 'openai-chat', body, policy: { strategies: [] } }),
    /strategies must be an object/,
  );
});

test('elides only recognizable historical no-output successes', () => {
  const body = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'ok', type: 'function', function: { name: 'Bash', arguments: '{"command":"true"}' } }] },
      { role: 'tool', tool_call_id: 'ok', content: 'Command completed successfully with no output.', status: 'completed', ok: true },
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
    archivedResults: 0,
    archiveRedactionSkips: 0,
    archiveNoSavingsSkips: 0,
    archiveSizeSkips: 0,
    historyDisclosureCount: 0,
    historyDisclosureOriginalBytes: 0,
    historyDisclosureVisibleBytes: 0,
    budgetTriggered: false,
    cacheProtectedSkips: 0,
    cacheRewriteRatio: null,
    cacheIdleFlushed: false,
  });
});

test('deduplicates an older identical historical tool result', () => {
  const output = 'same matches '.repeat(20);
  const body = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"x"}' } }] },
      { role: 'tool', tool_call_id: 'old', content: output, status: 'completed', ok: true },
      { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"x"}' } }] },
      { role: 'tool', tool_call_id: 'new', content: output, status: 'completed', ok: true },
    ],
  };

  const result = transformProviderRequest({ provider: 'openai-chat', body });

  assert.equal(result.body.messages[1].content, '[sando duplicate historical result]');
  assert.equal(result.body.messages[3].content, output);
  assert.equal(result.stats.deduplicatedResults, 1);
  assert.equal(result.stats.historyDisclosureCount, 1);
  assert.equal(result.stats.historyDisclosureOriginalBytes, Buffer.byteLength(output));
  assert.equal(result.stats.historyDisclosureVisibleBytes, Buffer.byteLength('[sando duplicate historical result]'));
  assert.ok(result.stats.estimatedOutputTokens < result.stats.estimatedInputTokens);
  assert.ok(result.reasons.includes('duplicate-history'));
});

test('compacts repeated lines only in an older historical Bash result', () => {
  const body = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'old', type: 'function', function: { name: 'Bash', arguments: '{"command":"make"}' } }] },
      { role: 'tool', tool_call_id: 'old', content: 'warning\nwarning\nwarning\nwarning\n', status: 'completed', ok: true },
      { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: { name: 'Bash', arguments: '{"command":"date"}' } }] },
      { role: 'tool', tool_call_id: 'new', content: 'current\n', status: 'completed', ok: true },
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
      { role: 'tool', tool_call_id: 'old', content: 'same matches '.repeat(40), status: 'completed', ok: true },
      { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"x"}' } }] },
      { role: 'tool', tool_call_id: 'new', content: 'same matches '.repeat(40), status: 'completed', ok: true },
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
      { role: 'tool', tool_call_id: 'old', content: oldOutput, status: 'completed', ok: true },
      { role: 'assistant', tool_calls: [{ id: 'new', type: 'function', function: { name: 'Bash', arguments: '{"command":"date"}' } }] },
      { role: 'tool', tool_call_id: 'new', content: 'current', status: 'completed', ok: true },
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
  // The cache guard would normally refuse to touch this message at all — that is the
  // safer outer behaviour, covered separately. Opt out here to exercise the collapse
  // path itself, which must still carry the marker forward when it does run (e.g. on
  // a body whose only marker sits behind the rewrite point).
  const result = transformProviderRequest({
    provider: 'anthropic',
    policy: { cacheRewriteRatio: 0 },
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

test('never rewrites history behind a cache_control breakpoint the host placed', () => {
  // Measured against a real Claude Code request: it places 3 of Anthropic's 4
  // breakpoints (2 on system, 1 on the last message, ttl 1h). Anthropic hashes
  // cumulatively up to each breakpoint, so rewriting anything at or before the last
  // marked message forces a full re-prefill of everything after it.
  const MARK = { type: 'ephemeral', ttl: '1h' };
  const read = (id, file) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: file } });
  const build = () => ({
    model: 'claude-sonnet-5',
    system: [
      { type: 'text', text: 'base' },
      { type: 'text', text: 's2', cache_control: MARK },
    ],
    messages: [
      { role: 'assistant', content: [read('t1', '/a.ts')] },
      // Small reclaim (a few hundred tokens) sitting behind a large suffix: the
      // rewrite would invalidate far more than it recovers.
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `OLD ${'x'.repeat(800)}` }] },
      { role: 'assistant', content: [read('t2', '/a.ts')] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'NEW' }] },
      { role: 'user', content: [{ type: 'text', text: 'filler '.repeat(20_000) }] },
      { role: 'user', content: [{ type: 'text', text: 'tail', cache_control: MARK }] },
    ],
  });

  const guarded = transformProviderRequest({ provider: 'anthropic', body: build(), policy: {} });
  assert.equal(guarded.changed, false);
  assert.equal(guarded.stats.supersededReads, 0);
  assert.equal(guarded.stats.cacheProtectedSkips, 1);
  assert.equal(guarded.stats.cacheRewriteRatio, 0.51);

  // The guard is opt-out, so the prior behaviour stays reachable and testable.
  const unguarded = transformProviderRequest({
    provider: 'anthropic', body: build(), policy: { cacheRewriteRatio: 0 },
  });
  assert.equal(unguarded.stats.supersededReads, 1);
  assert.equal(unguarded.stats.cacheProtectedSkips, 0);
  assert.equal(unguarded.stats.cacheRewriteRatio, null);
});

test('idle-flush bypasses the ratio guard once the host cache has expired on its own', () => {
  // Same fixture as the breakpoint test: a small reclaim behind a large suffix, which
  // the ratio guard normally protects. Past the idle-flush threshold, the host's own
  // 1h ephemeral TTL has already lapsed, so the rewrite costs nothing extra.
  const MARK = { type: 'ephemeral', ttl: '1h' };
  const read = (id, file) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: file } });
  const build = () => ({
    model: 'claude-sonnet-5',
    system: [
      { type: 'text', text: 'base' },
      { type: 'text', text: 's2', cache_control: MARK },
    ],
    messages: [
      { role: 'assistant', content: [read('t1', '/a.ts')] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `OLD ${'x'.repeat(800)}` }] },
      { role: 'assistant', content: [read('t2', '/a.ts')] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'NEW' }] },
      { role: 'user', content: [{ type: 'text', text: 'filler '.repeat(20_000) }] },
      { role: 'user', content: [{ type: 'text', text: 'tail', cache_control: MARK }] },
    ],
  });

  const stillWarm = transformProviderRequest({
    provider: 'anthropic', body: build(), policy: {}, idleMs: 10 * 60_000,
  });
  assert.equal(stillWarm.stats.cacheProtectedSkips, 1);
  assert.equal(stillWarm.stats.cacheIdleFlushed, false);

  const flushed = transformProviderRequest({
    provider: 'anthropic', body: build(), policy: {}, idleMs: 65 * 60_000,
  });
  assert.equal(flushed.changed, true);
  assert.equal(flushed.stats.supersededReads, 1);
  assert.equal(flushed.stats.cacheProtectedSkips, 0);
  assert.equal(flushed.stats.cacheIdleFlushed, true);

  // policy.cacheIdleFlushMs: null disables idle-flush; the ratio guard governs alone.
  const disabled = transformProviderRequest({
    provider: 'anthropic', body: build(), policy: { cacheIdleFlushMs: null }, idleMs: 65 * 60_000,
  });
  assert.equal(disabled.stats.cacheProtectedSkips, 1);
  assert.equal(disabled.stats.cacheIdleFlushed, false);
});

test('a rewrite that reclaims most of its suffix is allowed through', () => {
  // The guard is economic, not positional: a rewrite clearing more than
  // 1.15/(1.25+0.10K) of the suffix it invalidates pays for the cache write. Here the
  // superseded read is nearly the whole prompt, so its ratio is high and it proceeds.
  const MARK = { type: 'ephemeral', ttl: '1h' };
  const read = (id, file) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: file } });
  const result = transformProviderRequest({
    provider: 'anthropic',
    policy: {},
    body: {
      model: 'claude-sonnet-5',
      messages: [
        { role: 'assistant', content: [read('t1', '/a.ts')] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'OLD '.repeat(5_000) }] },
        { role: 'assistant', content: [read('t2', '/a.ts')] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'NEW', cache_control: MARK }] },
      ],
    },
  });
  assert.equal(result.stats.supersededReads, 1);
  assert.equal(result.stats.cacheProtectedSkips, 0);
});

test('protects nothing when the host places no breakpoints', () => {
  // Codex/Responses bodies carry no cache_control at all, so the guard must be inert
  // rather than silently disabling the transform.
  const read = (id, file) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: file } });
  const result = transformProviderRequest({
    provider: 'anthropic',
    body: {
      model: 'claude-sonnet-5',
      messages: [
        { role: 'assistant', content: [read('t1', '/a.ts')] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `OLD ${'x'.repeat(200)}` }] },
        { role: 'assistant', content: [read('t2', '/a.ts')] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'NEW' }] },
      ],
    },
    policy: {},
  });
  assert.equal(result.stats.cacheRewriteRatio, null);
  assert.equal(result.stats.cacheProtectedSkips, 0);
  assert.equal(result.stats.supersededReads, 1);
});
