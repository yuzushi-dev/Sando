import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runAccountingCli } from '../src/accounting-cli.mjs';
import { buildProviderUsageReport } from '../src/provider-usage.mjs';

function record({ eventKey, turnId, inputTokens, cachedInputTokens = 0, cacheWriteInputTokens = 0,
  outputTokens, reasoningOutputTokens = 0, totalCostUsd }) {
  return {
    eventKey, schema: 'sando-provider-usage/v1', version: 1, host: 'codex', source: 'test',
    sessionId: 'session-1', turnId, at: '2026-08-28T10:00:00.000Z', inputTokens,
    cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
  };
}

function state(records) {
  return { schema: 'sando-provider-usage/v1', version: 1, timezone: 'UTC', records };
}

test('provider accounting reports cache classes, reasoning, turns, and blended provider rate', () => {
  const report = buildProviderUsageReport(state([
    record({ eventKey: 'usage:1', turnId: 'turn-1', inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 10, outputTokens: 8, reasoningOutputTokens: 3, totalCostUsd: 0.2 }),
    record({ eventKey: 'usage:2', turnId: 'turn-2', inputTokens: 50, cachedInputTokens: 5, outputTokens: 2, reasoningOutputTokens: 1, totalCostUsd: 0.1 }),
  ]), { sessionId: 'session-1' });

  assert.deepEqual({
    inputTokens: report.inputTokens,
    freshInputTokens: report.freshInputTokens,
    cachedInputTokens: report.cachedInputTokens,
    cacheWriteInputTokens: report.cacheWriteInputTokens,
    outputTokens: report.outputTokens,
    reasoningOutputTokens: report.reasoningOutputTokens,
    turnCount: report.turnCount,
  }, {
    inputTokens: 150, freshInputTokens: 115, cachedInputTokens: 25, cacheWriteInputTokens: 10,
    outputTokens: 10, reasoningOutputTokens: 4, turnCount: 2,
  });
  assert.equal(report.cost.status, 'provider-reported');
  assert.equal(report.cost.totalCostUsd, 0.3);
  assert.equal(report.cost.effectiveRateUsdPerMillionTokens, 1875);
  assert.equal(report.totalCostUsd, 0.3);
  assert.equal(report.sessionBlendedEffectiveRateUsdPerMillionTokens, 1875);
  assert.equal(report.weightedCost.source, 'weighted-estimate');
});

test('provider accounting labels missing billing data unavailable while retaining weighted estimate', () => {
  const report = buildProviderUsageReport(state([
    record({ eventKey: 'usage:1', turnId: 'turn-1', inputTokens: 100, outputTokens: 8 }),
  ]), { sessionId: 'session-1' });

  assert.equal(report.cost.status, 'unavailable');
  assert.equal(report.cost.totalCostUsd, null);
  assert.equal(report.totalCostUsd, null);
  assert.equal(report.weightedCost.source, 'weighted-estimate');
  assert.equal(typeof report.weightedCost.costUnits, 'number');
});

test('accounting CLI emits the provider report as JSON', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-accounting-cli-'));
  try {
    const storagePath = path.join(directory, 'provider-usage.json');
    fs.writeFileSync(storagePath, JSON.stringify(state([
      record({ eventKey: 'usage:1', turnId: 'turn-1', inputTokens: 12, outputTokens: 3, totalCostUsd: 0.01 }),
    ])));
    let output = '';
    let errors = '';
    const report = runAccountingCli({
      argv: ['--json', '--path', storagePath, '--session', 'session-1'],
      stdout: { write(value) { output += value; } },
      stderr: { write(value) { errors += value; } },
    });
    assert.equal(errors, '');
    assert.equal(JSON.parse(output).cost.status, 'provider-reported');
    assert.equal(report.turnCount, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
