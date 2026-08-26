import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { renderStatusLine } from '../src/statusline.mjs';

const current = '2026-08-24T10:00:00.000Z';
const root = path.resolve(import.meta.dirname, '../../..');

test('Codex statusline scopes savings to the selected session', (t) => {
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
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/sando-statusline.mjs')], {
    encoding: 'utf8', env: {
      ...process.env, SANDO_METRICS_PATH: metricsPath,
      SANDO_PROVIDER_USAGE_PATH: path.join(directory, 'provider-usage.json'),
      SANDO_CODEX_SESSION_ID: 's1',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '🥪 ~1k token saved');
});

test('Codex statusline resolves the session from the tmux pane marker', (t) => {
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
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/sando-statusline.mjs'), '--pane', '%1'], {
    encoding: 'utf8', env: {
      ...process.env, SANDO_METRICS_PATH: metricsPath,
      SANDO_PROVIDER_USAGE_PATH: path.join(directory, 'provider-usage.json'),
      SANDO_ACTIVE_SESSION_PATH: activePath, SANDO_CODEX_PANE_PID: '42',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '🥪 ~1k token saved');
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

test('omits cost without a real session cost figure, estimate or not', () => {
  // No totalCostUsd/providerUsage.totalTokens means there's no blended rate to price with.
  assert.equal(renderStatusLine({
    metrics: { updatedAt: current, source: 'estimate', savedTokens: 2_510_000 },
  }, Date.parse(current)), '🥪 ~2.51M token saved');
});

test('never renders cost even with a real cost figure available (estimate)', () => {
  assert.equal(renderStatusLine({
    metrics: { updatedAt: current, source: 'estimate', savedTokens: 2_510_000 },
    providerUsage: { totalTokens: 5_000_000 },
    totalCostUsd: 10,
  }, Date.parse(current)), '🥪 ~2.51M token saved');
});

test('never renders cost even with a real cost figure available (provider-reported)', () => {
  assert.equal(renderStatusLine({
    metrics: { updatedAt: current, source: 'provider-reported', savedTokens: 2_510_000 },
    providerUsage: { totalTokens: 5_000_000 },
    totalCostUsd: 10,
  }, Date.parse(current)), '🥪 2.51M token saved');
});

test('omits cost when providerUsage.totalTokens is unavailable', () => {
  assert.equal(renderStatusLine({
    metrics: { updatedAt: current, source: 'provider-reported', savedTokens: 42_600 },
    totalCostUsd: 10,
  }, Date.parse(current)), '🥪 42.6k token saved');
});

test('does not mark old data stale', () => {
  assert.equal(renderStatusLine({
    metrics: { updatedAt: current, source: 'estimate', savedTokens: 40 },
  }, Date.parse(current) + 5 * 60 * 1000 + 1), '🥪 ~40 token saved');
  assert.equal(renderStatusLine({}, Date.parse(current)), '🥪 —');
});
