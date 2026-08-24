import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeProxyArgs,
  buildClaudeProxyEnv,
  buildCodexProxyArgs,
  buildCodexProxyEnv,
  buildProxyPrompt,
} from '../live/proxy-e2e-run.mjs';

test('builds a two-tool Claude proxy benchmark without loading persistent settings', () => {
  const args = buildClaudeProxyArgs({ prompt: 'probe', model: 'claude-opus-5', maxBudgetUsd: 0.25 });
  assert.equal(args[args.indexOf('--tools') + 1], 'Bash');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--include-hook-events'));
});

test('only the optimized Claude lane receives the proxy and history policy', () => {
  const baseline = buildClaudeProxyEnv({ variant: 'baseline', proxyUrl: 'http://127.0.0.1:1', policy: { maxHistoryTokens: 1000 }, baseEnv: { ANTHROPIC_BASE_URL: 'old' } });
  const optimized = buildClaudeProxyEnv({ variant: 'optimized', proxyUrl: 'http://127.0.0.1:1', policy: { maxHistoryTokens: 1000 }, baseEnv: {} });
  assert.equal(Object.hasOwn(baseline, 'ANTHROPIC_BASE_URL'), false);
  assert.equal(Object.hasOwn(baseline, 'SANDO_CONTEXT_POLICY'), false);
  assert.equal(optimized.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1');
  assert.deepEqual(JSON.parse(optimized.SANDO_CONTEXT_POLICY), { maxHistoryTokens: 1000 });
});

test('builds Codex proxy overrides without touching user config', () => {
  const baseline = buildCodexProxyArgs({ prompt: 'probe', model: 'gpt-test', optimized: false, proxyUrl: 'http://127.0.0.1:2' });
  const optimized = buildCodexProxyArgs({ prompt: 'probe', model: 'gpt-test', optimized: true, proxyUrl: 'http://127.0.0.1:2' });
  assert.equal(baseline.includes('model_provider="sando_proxy"'), false);
  assert.ok(optimized.includes('model_provider="sando_proxy"'));
  assert.ok(optimized.includes('model_providers.sando_proxy.base_url="http://127.0.0.1:2"'));
  assert.ok(optimized.includes('model_providers.sando_proxy.wire_api="responses"'));
  assert.ok(optimized.includes('model_providers.sando_proxy.requires_openai_auth=true'));
  assert.equal(optimized.some((value) => value.includes('model_providers.sando_proxy.env_key=')), false);
});

test('only optimized Codex receives proxy policy', () => {
  const baseline = buildCodexProxyEnv({ variant: 'baseline', policy: { maxHistoryTokens: 1000 }, baseEnv: { SANDO_CONTEXT_POLICY: 'old' } });
  const optimized = buildCodexProxyEnv({ variant: 'optimized', policy: { maxHistoryTokens: 1000 }, baseEnv: {} });
  assert.equal(Object.hasOwn(baseline, 'SANDO_CONTEXT_POLICY'), false);
  assert.deepEqual(JSON.parse(optimized.SANDO_CONTEXT_POLICY), { maxHistoryTokens: 1000 });
});

test('proxy prompt requires two sequential tool calls and a final fact', () => {
  const prompt = buildProxyPrompt({ host: 'claude', script: '/tmp/probe.mjs' });
  assert.match(prompt, /exactly twice/);
  assert.match(prompt, /SANDO_PROXY_FINAL_FACT/);
  assert.match(prompt, /probe\.mjs/);
});
