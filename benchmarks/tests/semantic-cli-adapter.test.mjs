import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSemanticCliArgs,
  buildSemanticEnv,
  parseSemanticCliOutput,
  selectSemanticProvider,
} from '../live/semantic-cli-adapter.mjs';

test('auto selects Codex first and falls back to Claude only when unavailable', () => {
  assert.equal(selectSemanticProvider({ requested: 'auto', codexAvailable: true, claudeAvailable: true }).provider, 'codex');
  assert.equal(selectSemanticProvider({ requested: 'auto', codexAvailable: false, claudeAvailable: true }).provider, 'claude');
  assert.throws(
    () => selectSemanticProvider({ requested: 'codex', codexAvailable: false, claudeAvailable: true }),
    /codex.*unavailable/i,
  );
  assert.throws(
    () => selectSemanticProvider({ requested: 'auto', codexAvailable: false, claudeAvailable: false }),
    /no semantic provider available/i,
  );
});

test('semantic CLI args isolate both providers and read the prompt from stdin', () => {
  const codex = buildSemanticCliArgs({ provider: 'codex', model: 'gpt-5.6-luna' });
  assert.ok(codex.includes('exec'));
  assert.ok(codex.includes('--ephemeral'));
  assert.ok(codex.includes('--ignore-user-config'));
  assert.ok(codex.includes('--sandbox'));
  assert.ok(codex.includes('read-only'));
  assert.ok(codex.includes('--ask-for-approval'));
  assert.ok(codex.includes('never'));
  assert.equal(codex.at(-1), '-');
  assert.ok(!codex.some((value) => value.includes('raw tool output')));

  const claude = buildSemanticCliArgs({ provider: 'claude', model: 'claude-haiku-4-5' });
  assert.ok(claude.includes('--print'));
  assert.ok(claude.includes('--no-session-persistence'));
  assert.ok(claude.includes('--setting-sources'));
  assert.ok(claude.includes('--tools'));
  assert.ok(claude.includes('dontAsk'));
  assert.ok(claude.includes('--output-format'));
  assert.ok(claude.includes('json'));
  assert.ok(!claude.includes('raw tool output'));
});

test('parses a Codex semantic response and provider usage', () => {
  const response = {
    schema: 'sando-semantic-summary/v1',
    summary: 'FACT /workspace/app.mjs',
    preservedFacts: ['FACT /workspace/app.mjs'],
  };
  const stdout = [
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(response) } },
    { type: 'turn.completed', model: 'gpt-5.6-luna', usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } },
  ].map((document) => JSON.stringify(document)).join('\n');
  assert.deepEqual(parseSemanticCliOutput({ provider: 'codex', stdout }), {
    ...response,
    usage: { inputTokens: 100, cacheReadInputTokens: 0, outputTokens: 20, totalTokens: 120, resolvedModel: 'gpt-5.6-luna' },
  });
});

test('parses a Claude semantic response and provider usage', () => {
  const response = {
    schema: 'sando-semantic-summary/v1',
    summary: 'FACT /workspace/app.mjs',
    preservedFacts: ['FACT /workspace/app.mjs'],
  };
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    model: 'claude-haiku-5',
    result: JSON.stringify(response),
    usage: { input_tokens: 100, output_tokens: 20 },
  });
  assert.deepEqual(parseSemanticCliOutput({ provider: 'claude', stdout }), {
    ...response,
    usage: { inputTokens: 100, uncachedInputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 20, totalTokens: 120, resolvedModel: 'claude-haiku-5' },
  });
});

test('removes Sando proxy routing from child CLI environments but preserves auth', () => {
  const env = buildSemanticEnv({
    PATH: '/bin',
    CODEX_HOME: '/tmp/codex',
    OPENAI_API_KEY: 'kept',
    ANTHROPIC_API_KEY: 'kept',
    SANDO_POLICY: 'proxy',
    SANDO_CLI_ROUTING: 'proxy',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    OPENAI_BASE_URL: 'http://127.0.0.1:1',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CODEX_HOME, '/tmp/codex');
  assert.equal(env.OPENAI_API_KEY, 'kept');
  assert.equal(env.ANTHROPIC_API_KEY, 'kept');
  assert.equal(env.SANDO_POLICY, undefined);
  assert.equal(env.SANDO_CLI_ROUTING, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
});
