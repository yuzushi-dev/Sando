import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeArgs,
  buildCodexArgs,
  formatChildFailure,
  hasOkStatus,
  parseClaudeUsage,
  parseCodexUsage,
} from '../live/adapters.mjs';

test('parses Claude reported usage including cache counters', () => {
  assert.deepEqual(parseClaudeUsage(JSON.stringify({
    model: 'claude-test',
    usage: { input_tokens: 120, cache_creation_input_tokens: 20, cache_read_input_tokens: 40, output_tokens: 8 },
  })), {
    inputTokens: 180,
    uncachedInputTokens: 120,
    cacheCreationInputTokens: 20,
    cacheReadInputTokens: 40,
    outputTokens: 8,
    totalTokens: 188,
    resolvedModel: 'claude-test',
  });
});

test('extracts Claude canonicalModel from modelUsage entries', () => {
  assert.equal(parseClaudeUsage(JSON.stringify({
    modelUsage: { 'claude-opus-5': { canonicalModel: 'claude-opus-5', inputTokens: 1 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  })).resolvedModel, 'claude-opus-5');
});

test('finds Codex usage in JSONL events', () => {
  assert.deepEqual(parseCodexUsage([
    JSON.stringify({ type: 'item.completed', item: { text: 'done' } }),
    JSON.stringify({ type: 'turn.completed', model: 'codex-test', usage: { input_tokens: 90, cached_input_tokens: 30, output_tokens: 7, total_tokens: 97 } }),
  ].join('\n')), {
    inputTokens: 90,
    cacheReadInputTokens: 30,
    outputTokens: 7,
    totalTokens: 97,
    resolvedModel: 'codex-test',
  });
});

test('recognizes a structured success nested in escaped JSONL text', () => {
  assert.equal(hasOkStatus(JSON.stringify({ result: JSON.stringify({ status: 'ok' }) })), true);
  assert.equal(hasOkStatus(JSON.stringify({ result: JSON.stringify({ status: 'error' }) })), false);
});

test('formats child failures from stderr and stdout without credential-shaped values', () => {
  assert.equal(
    formatChildFailure('claude', 'baseline', { code: 1, signal: null, stderr: '', stdout: 'API_KEY=sk-test-012345678901234567890' }),
    'claude baseline failed (1): API_KEY=[REDACTED]',
  );
});

test('builds isolated print commands without shell interpolation', () => {
  const claude = buildClaudeArgs({ prompt: 'a prompt', model: 'haiku' });
  assert.ok(claude.includes('--print'));
  assert.ok(claude.includes('--no-session-persistence'));
  assert.equal(claude.at(-1), 'a prompt');
  const codex = buildCodexArgs({ prompt: 'a prompt' });
  assert.deepEqual(codex.slice(0, 3), ['exec', '--ephemeral', '--ignore-user-config']);
  assert.equal(codex.at(-1), 'a prompt');
});

test('supports an explicit Codex model argument without implying output rewrite', () => {
  const codex = buildCodexArgs({ prompt: 'a prompt', model: 'codex-test' });
  assert.deepEqual(codex.slice(0, 2), ['exec', '--model']);
  assert.ok(codex.includes('--model'));
  assert.equal(codex.at(-1), 'a prompt');
});
