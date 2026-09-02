import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { modelArguments } from '../../../scripts/sando-canary-codex.mjs';
import { buildCanaryReport, runCanaryCli } from '../src/canary.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');

function provider({ eventKey, host = 'codex', sessionId = 'session-a', turnId = 'turn-1', at = '2026-08-30T10:00:00.000Z',
  arm = 'apply', experimentId = 'personal-canary', workloadId = 'workload-1', inputTokens = 100, outputTokens = 10 }) {
  const result = {
    eventKey, schema: 'sando-provider-usage/v1', version: 1, host, source: `${host}-transcript`,
    sessionId, turnId, at, inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens,
    reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens,
  };
  if (arm !== null) result.arm = arm;
  if (experimentId !== null) result.experimentId = experimentId;
  if (workloadId !== null) result.workloadId = workloadId;
  return result;
}

function metrics(records) {
  return { schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records };
}

function metric({ eventKey, receiptDigest, sessionId, at = '2026-08-30T10:00:00.000Z', host = 'codex', model = 'gpt-5.6-luna' }) {
  return {
    eventKey, receiptDigest, at, host, sessionId, client: 'codex', clientVersion: 'test', model,
    estimatedInputTokens: 100, estimatedInlineTokens: 60, estimatedTransformSavingsTokens: 40,
    providerReportedSavingsTokens: null,
  };
}

function streams() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; },
  };
}

test('Codex canary leaves model selection to the client unless explicitly configured', () => {
  assert.deepEqual(modelArguments([], {}), []);
  assert.deepEqual(modelArguments([], { SANDO_CODEX_MODEL: 'gpt-test' }), ['--model', 'gpt-test']);
  assert.deepEqual(modelArguments([], { SANDO_CODEX_MODEL: '  gpt-test  ' }), ['--model', 'gpt-test']);
  assert.deepEqual(modelArguments(['--model', 'cli-model'], { SANDO_CODEX_MODEL: 'env-model' }), []);
  assert.deepEqual(modelArguments(['-m', 'cli-model'], { SANDO_CODEX_MODEL: 'env-model' }), []);
});

test('canary report filters the active experiment and joins aggregate metrics without exposing session ids', () => {
  const report = buildCanaryReport({
    providerState: {
      schema: 'sando-provider-usage/v1', version: 1, records: [
        provider({ eventKey: 'apply-1' }),
        provider({ eventKey: 'apply-2', turnId: 'turn-2', inputTokens: 50, outputTokens: 5 }),
        provider({ eventKey: 'control-1', sessionId: 'session-b', arm: 'control', inputTokens: 80, outputTokens: 8 }),
        provider({ eventKey: 'other-exp', experimentId: 'other' }),
        provider({ eventKey: 'other-host', host: 'claude' }),
        provider({ eventKey: 'untagged', arm: null, experimentId: null, workloadId: null }),
      ],
    },
    metricsState: metrics([
      metric({ eventKey: 'metric-a', receiptDigest: 'sha256:1', sessionId: 'session-a' }),
      metric({ eventKey: 'metric-b', receiptDigest: 'sha256:2', sessionId: 'session-b' }),
      metric({ eventKey: 'metric-unrelated', receiptDigest: 'sha256:3', sessionId: 'session-c' }),
    ]),
    host: 'codex',
    experimentId: 'personal-canary',
    now: '2026-08-31T00:00:00.000Z',
    providerSnapshotDigest: 'sha256:provider',
    metricsSnapshotDigest: 'sha256:metrics',
  });

  assert.equal(report.schema, 'sando-canary-report/v1');
  assert.equal(report.snapshot.providerUsageDigest, 'sha256:provider');
  assert.equal(report.byArm.apply.provider.eventCount, 2);
  assert.equal(report.byArm.apply.provider.inputTokens, 150);
  assert.equal(report.byArm.control.provider.outputTokens, 8);
  assert.equal(report.byArm.apply.metrics.matchedSessionCount, 1);
  assert.equal(report.byArm.control.metrics.matchedSessionCount, 1);
  assert.equal(report.dataQuality.totalProviderRecords, 6);
  assert.equal(report.dataQuality.selectedProviderRecords, 3);
  assert.equal(report.dataQuality.untaggedProviderRecords, 1);
  assert.equal(report.dataQuality.selectedUntaggedProviderRecords, 0);
  assert.equal(report.dataQuality.status, 'ready');
  assert.equal(report.dataQuality.providerModelCoverage, 'unavailable');
  assert.equal(report.comparison.status, 'descriptive-only');
  assert.doesNotMatch(JSON.stringify(report), /session-a|session-b/);
});

test('canary CLI emits a local snapshot report with explicit date and arm filters', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-canary-cli-'));
  try {
    const providerPath = path.join(directory, 'provider-usage.json');
    const metricsPath = path.join(directory, 'metrics.json');
    fs.writeFileSync(providerPath, JSON.stringify({
      schema: 'sando-provider-usage/v1', version: 1, records: [
        provider({ eventKey: 'in-range', at: '2026-08-30T10:00:00.000Z' }),
        provider({ eventKey: 'out-of-range', at: '2026-08-31T10:00:00.000Z', sessionId: 'session-b' }),
      ],
    }));
    fs.writeFileSync(metricsPath, JSON.stringify(metrics([
      metric({ eventKey: 'metric-in-range', receiptDigest: 'sha256:4', sessionId: 'session-a' }),
    ])));
    const output = streams();
    const report = runCanaryCli({
      argv: ['--json', '--path', providerPath, '--metrics-path', metricsPath, '--host', 'codex',
        '--experiment', 'personal-canary', '--arm', 'apply', '--from', '2026-08-30T00:00:00.000Z',
        '--to', '2026-08-30T23:59:59.999Z'],
      stdout: output.stdout,
      stderr: output.stderr,
      now: '2026-08-31T00:00:00.000Z',
    });
    assert.equal(output.stderrText, '');
    assert.equal(JSON.parse(output.stdoutText).byArm.apply.provider.eventCount, 1);
    assert.equal(report.scope.arm, 'apply');
    assert.match(report.snapshot.providerUsageDigest, /^sha256:[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('installed canary launchers expose the same aggregate report', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-canary-bundle-'));
  try {
    const providerPath = path.join(directory, 'provider-usage.json');
    const metricsPath = path.join(directory, 'metrics.json');
    fs.writeFileSync(providerPath, JSON.stringify({
      schema: 'sando-provider-usage/v1', version: 1, records: [provider({ eventKey: 'bundle-1' })],
    }));
    fs.writeFileSync(metricsPath, JSON.stringify(metrics([])));
    for (const launcher of [
      'plugins/sando/bin/sando', 'adapters/codex/sando/bin/sando',
      'plugins/sando/canary.mjs', 'adapters/codex/sando/canary.mjs', 'adapters/claude/sando/canary.mjs',
    ]) {
      const isStandalone = launcher.endsWith('.mjs');
      const command = isStandalone ? process.execPath : path.join(REPOSITORY_ROOT, launcher);
      const args = isStandalone ? [path.join(REPOSITORY_ROOT, launcher)] : ['canary'];
      args.push('--json', '--path', providerPath, '--metrics-path', metricsPath, '--experiment', 'personal-canary');
      const result = spawnSync(command, args, { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
      assert.equal(result.status, 0, `${launcher}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).schema, 'sando-canary-report/v1');
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
