import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { renderStatusLine } from '../src/statusline.mjs';

const current = '2026-08-24T10:00:00.000Z';
const root = path.resolve(import.meta.dirname, '../../..');

function providerState(sessionId, inputTokens = 1100) {
  return {
    schema: 'sando-provider-usage/v1', version: 1, timezone: 'UTC', records: [{
      eventKey: `usage:${sessionId}`, schema: 'sando-provider-usage/v1', version: 1,
      host: 'codex', source: 'test', sessionId, turnId: 't1', at: current,
      inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      outputTokens: 0, reasoningOutputTokens: 0, totalTokens: inputTokens,
    }],
  };
}

test('Codex statusline scopes provider usage to the selected session', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-statusline-codex-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const metricsPath = path.join(directory, 'metrics.json');
  fs.writeFileSync(metricsPath, JSON.stringify({
    schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records: [
      {
        eventKey: 'event:s1', receiptDigest: 'sha256:s1', at: current, host: 'codex', sessionId: 's1',
        client: null, clientVersion: null, model: 'fixture', estimatedInputTokens: 1100,
        estimatedInlineTokens: 100, estimatedTransformSavingsTokens: 1000, providerReportedSavingsTokens: null,
      },
      {
        eventKey: 'event:s2', receiptDigest: 'sha256:s2', at: current, host: 'codex', sessionId: 's2',
        client: null, clientVersion: null, model: 'fixture', estimatedInputTokens: 2200,
        estimatedInlineTokens: 200, estimatedTransformSavingsTokens: 2000, providerReportedSavingsTokens: null,
      },
    ],
  }));
  const providerUsagePath = path.join(directory, 'provider-usage.json');
  fs.writeFileSync(providerUsagePath, JSON.stringify(providerState('s1')));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/sando-statusline.mjs')], {
    encoding: 'utf8', env: {
      ...process.env, SANDO_METRICS_PATH: metricsPath,
      SANDO_PROVIDER_USAGE_PATH: providerUsagePath,
      SANDO_CODEX_SESSION_ID: 's1',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '🥪 saved ~1k ctx tok (91%)');
});

test('Codex statusline resolves provider usage from the tmux pane marker', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-statusline-codex-pane-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const metricsPath = path.join(directory, 'metrics.json');
  const activePath = path.join(directory, 'active-sessions.json');
  fs.writeFileSync(metricsPath, JSON.stringify({
    schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records: [
      {
        eventKey: 'event:s1', receiptDigest: 'sha256:s1', at: current, host: 'codex', sessionId: 's1',
        client: null, clientVersion: null, model: 'fixture', estimatedInputTokens: 1100,
        estimatedInlineTokens: 100, estimatedTransformSavingsTokens: 1000, providerReportedSavingsTokens: null,
      },
      {
        eventKey: 'event:s2', receiptDigest: 'sha256:s2', at: current, host: 'codex', sessionId: 's2',
        client: null, clientVersion: null, model: 'fixture', estimatedInputTokens: 2200,
        estimatedInlineTokens: 200, estimatedTransformSavingsTokens: 2000, providerReportedSavingsTokens: null,
      },
    ],
  }));
  fs.writeFileSync(activePath, JSON.stringify({
    schema: 'sando-active-session/v1', version: 1,
    entries: [{ paneId: '%1', panePid: 42, sessionId: 's1', updatedAt: current }],
  }));
  const providerUsagePath = path.join(directory, 'provider-usage.json');
  fs.writeFileSync(providerUsagePath, JSON.stringify(providerState('s1')));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/sando-statusline.mjs'), '--pane', '%1'], {
    encoding: 'utf8', env: {
      ...process.env, SANDO_METRICS_PATH: metricsPath,
      SANDO_PROVIDER_USAGE_PATH: providerUsagePath,
      SANDO_ACTIVE_SESSION_PATH: activePath, SANDO_CODEX_PANE_PID: '42',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '🥪 saved ~1k ctx tok (91%)');
});

test('Codex statusline hides historical savings without a current session marker', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-statusline-codex-empty-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const metricsPath = path.join(directory, 'metrics.json');
  fs.writeFileSync(metricsPath, JSON.stringify({
    schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records: [{
      eventKey: 'event:s1', receiptDigest: 'sha256:s1', at: current, host: 'codex', sessionId: 's1',
      client: null, clientVersion: null, model: 'fixture', estimatedInputTokens: 1100,
      estimatedInlineTokens: 100, estimatedTransformSavingsTokens: 1000, providerReportedSavingsTokens: null,
    }],
  }));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/sando-statusline.mjs'), '--pane', '%2'], {
    encoding: 'utf8', env: {
      ...process.env, SANDO_METRICS_PATH: metricsPath,
      SANDO_PROVIDER_USAGE_PATH: path.join(directory, 'provider-usage.json'),
      SANDO_ACTIVE_SESSION_PATH: path.join(directory, 'missing-active-sessions.json'),
      SANDO_CODEX_PANE_PID: '99',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '🥪 —');
});

test('renders estimated context savings without provider usage', () => {
  assert.equal(renderStatusLine({
    metrics: {
      updatedAt: current, source: 'estimate', savedTokens: 2_510_000, estimatedInputTokens: 6_605_263,
    },
  }, Date.parse(current)), '🥪 saved ~2.51M ctx tok (38%)');
});

test('does not turn an estimate into a cost claim', () => {
  assert.equal(renderStatusLine({
    metrics: {
      updatedAt: current, source: 'estimate', savedTokens: 2_510_000, estimatedInputTokens: 6_605_263,
    },
    providerUsage: { totalTokens: 5_000_000 },
    totalCostUsd: 10,
  }, Date.parse(current)), '🥪 saved ~2.51M ctx tok (38%)');
});

test('renders provider-reported context savings without a tilde', () => {
  assert.equal(renderStatusLine({
    metrics: {
      updatedAt: current, source: 'provider-reported', savedTokens: 2_500_000, estimatedInputTokens: 5_000_000,
    },
    providerUsage: { totalTokens: 5_000_000, turnCount: 4, weightedCostUnits: 2_000_000 },
    totalCostUsd: 10,
  }, Date.parse(current)), '🥪 saved 2.5M ctx tok (50%)');
});

test('renders estimated savings with compact tokens and percentage', () => {
  assert.equal(renderStatusLine({
    metrics: { updatedAt: current, source: 'estimate', savedTokens: 2_510, estimatedInputTokens: 6_605 },
  }, Date.parse(current)), '🥪 saved ~2.5k ctx tok (38%)');
});

test('renders no data when metrics are unavailable', () => {
  assert.equal(renderStatusLine({
    providerUsage: { totalTokens: 5_000_000, turnCount: 4, weightedCostUnits: 2_000_000 },
    totalCostUsd: 10,
  }, Date.parse(current)), '🥪 —');
});

test('does not mark old savings stale', () => {
  assert.equal(renderStatusLine({
    metrics: { updatedAt: current, source: 'estimate', savedTokens: 40, estimatedInputTokens: 100 },
  }, Date.parse(current) + 5 * 60 * 1000 + 1), '🥪 saved ~40 ctx tok (40%)');
  assert.equal(renderStatusLine({}, Date.parse(current)), '🥪 —');
});
