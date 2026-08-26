import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const wrapper = path.join(root, 'statusline.mjs');
const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };

test('Claude statusline preserves Honey and appends real Sando usage', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-statusline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const honey = path.join(directory, 'honey.mjs');
  const metrics = path.join(directory, 'metrics.json');
  const providerUsage = path.join(directory, 'provider-usage.json');
  fs.writeFileSync(honey, "process.stdout.write('🍯 honey:full')\n");
  fs.writeFileSync(metrics, JSON.stringify({
    schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records: [{
      eventKey: 'event:statusline', receiptDigest: 'sha256:statusline',
      at: new Date().toISOString(), host: 'claude', sessionId: 's1', client: null,
      clientVersion: null, model: null, estimatedInputTokens: 100,
      estimatedInlineTokens: 60, estimatedTransformSavingsTokens: 40,
      providerReportedSavingsTokens: null,
    }],
  }));
  fs.writeFileSync(providerUsage, JSON.stringify({
    schema: 'sando-provider-usage/v1', version: 1, timezone: 'UTC', records: [{
      eventKey: 'usage:claude:fixture', schema: 'sando-provider-usage/v1', version: 1,
      host: 'claude', source: 'claude-transcript', sessionId: 's1', turnId: 't1',
      at: new Date().toISOString(), inputTokens: 150, cachedInputTokens: 30,
      cacheWriteInputTokens: 20, outputTokens: 7, reasoningOutputTokens: 0, totalTokens: 157,
    }],
  }));
  const result = spawnSync(process.execPath, [wrapper], {
    input: JSON.stringify({
      transcript_path: '/tmp/fixture.jsonl', session_id: 's1', model: { id: 'claude-sonnet-5' },
      cost: { total_cost_usd: 0.05 },
    }),
    encoding: 'utf8', timeout: 3000,
    env: {
      ...childEnv, SANDO_WRAPPED_STATUSLINE: honey,
      SANDO_METRICS_PATH: metrics, SANDO_PROVIDER_USAGE_PATH: providerUsage,
    },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout.trim(), '🍯 honey:full · 🥪 ~40 token saved');
});

test('Claude statusline never displays cost even with a real cost figure', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-statusline-cost-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const metrics = path.join(directory, 'metrics.json');
  const providerUsage = path.join(directory, 'provider-usage.json');
  fs.writeFileSync(metrics, JSON.stringify({
    schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records: [{
      eventKey: 'event:statusline-cost', receiptDigest: 'sha256:statusline-cost',
      at: new Date().toISOString(), host: 'claude', sessionId: 's1', client: null,
      clientVersion: null, model: null, estimatedInputTokens: 100,
      estimatedInlineTokens: 75, estimatedTransformSavingsTokens: 25,
      providerReportedSavingsTokens: 25,
    }],
  }));
  fs.writeFileSync(providerUsage, JSON.stringify({
    schema: 'sando-provider-usage/v1', version: 1, timezone: 'UTC', records: [{
      eventKey: 'usage:claude:fixture-cost', schema: 'sando-provider-usage/v1', version: 1,
      host: 'claude', source: 'claude-transcript', sessionId: 's1', turnId: 't1',
      at: new Date().toISOString(), inputTokens: 150, cachedInputTokens: 30,
      cacheWriteInputTokens: 20, outputTokens: 7, reasoningOutputTokens: 0, totalTokens: 157,
    }],
  }));
  const result = spawnSync(process.execPath, [wrapper], {
    input: JSON.stringify({
      transcript_path: '/tmp/fixture.jsonl', session_id: 's1', model: { id: 'claude-sonnet-5' },
      cost: { total_cost_usd: 0.5 },
    }),
    encoding: 'utf8', timeout: 3000,
    env: {
      ...childEnv, SANDO_METRICS_PATH: metrics, SANDO_PROVIDER_USAGE_PATH: providerUsage,
    },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout.trim(), '🥪 25 token saved');
});

test('Claude statusline accepts a shell-backed existing statusline', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-shell-statusline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const honey = path.join(directory, 'honey.sh');
  fs.writeFileSync(honey, '#!/bin/sh\nprintf \'🪨 caveman\'\n', { mode: 0o700 });
  const result = spawnSync(process.execPath, [wrapper], {
    input: '{}', encoding: 'utf8', timeout: 3000,
    env: {
      ...childEnv, SANDO_WRAPPED_STATUSLINE: `sh ${honey}`,
      SANDO_METRICS_PATH: path.join(directory, 'missing-metrics.json'),
      SANDO_PROVIDER_USAGE_PATH: path.join(directory, 'missing-provider-usage.json'),
    },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout.trim(), '🪨 caveman · 🥪 —');
});

test('Claude statusline runs from a copied standalone bundle', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-copied-statusline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, 'bundle');
  fs.cpSync(root, bundle, { recursive: true });
  const providerUsage = path.join(directory, 'provider-usage.json');
  fs.writeFileSync(providerUsage, JSON.stringify({
    schema: 'sando-provider-usage/v1', version: 1, timezone: 'UTC', records: [{
      eventKey: 'usage:claude:standalone', schema: 'sando-provider-usage/v1', version: 1,
      host: 'claude', source: 'claude-transcript', sessionId: 's1', turnId: 't1',
      at: new Date().toISOString(), inputTokens: 10, cachedInputTokens: 2,
      cacheWriteInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 13,
    }],
  }));
  const result = spawnSync(process.execPath, [path.join(bundle, 'statusline.mjs')], {
    input: '{}', encoding: 'utf8', timeout: 3000,
    env: {
      ...childEnv, SANDO_METRICS_PATH: path.join(directory, 'missing-metrics.json'),
      SANDO_PROVIDER_USAGE_PATH: providerUsage,
    },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout.trim(), '🥪 —');
});
