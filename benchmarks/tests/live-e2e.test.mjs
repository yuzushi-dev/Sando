import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RUNNER = path.join(ROOT, 'benchmarks/live/e2e-run.mjs');

test('provides the truthful E2E probe runner', () => {
  assert.equal(fs.existsSync(RUNNER), true, 'E2E probe runner is missing');
});

test('deterministic probe records paired hook evidence and fail-closed live status', async () => {
  const { runDeterministicProbe } = await import('../live/e2e-run.mjs');
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sando-e2e-'));
  try {
    const evidence = await runDeterministicProbe({
      outputPath: path.join(directory, 'evidence.json'),
      cwd: directory,
    });

    assert.equal(evidence.schema, 'sando-live-e2e/v1');
    assert.equal(evidence.status, 'blocked');
    assert.equal(evidence.measurement.label, 'not-end-to-end');
    assert.equal(evidence.pair.baseline.variant, 'baseline');
    assert.equal(evidence.pair.optimized.variant, 'optimized');
    assert.equal(evidence.pair.optimized.replacementCaptured, true);
    assert.equal(evidence.pair.optimized.probeVisibleQuality, 'pass');
    assert.equal(evidence.pair.optimized.modelVisibleQuality, 'unverified');
    assert.equal(evidence.pair.optimized.artifactResolvable, true);
    assert.equal(evidence.pair.optimized.secretLeak, false);
    assert.equal(evidence.pair.baseline.secretLeak, true);
    assert.deepEqual(evidence.pair.baseline.artifactReferences, []);
    assert.deepEqual(evidence.pair.baseline.resolvedArtifacts, []);
    assert.ok(evidence.pair.optimized.artifactReferences.length > 0);
    assert.match(evidence.blocker, /no-cost end-to-end fixture/i);
    assert.deepEqual(evidence.comparison.localEvidence, { configured: false, verified: false });
    assert.deepEqual(evidence.comparison.installed, { configured: false, version: null, verified: false });
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('Claude probe enables an executable Bash tool and captures hook events', async () => {
  const { buildClaudeE2EArgs } = await import('../live/e2e-run.mjs');
  const args = buildClaudeE2EArgs({ prompt: 'probe', pluginDir: '/tmp/plugin', settingSources: '', maxBudgetUsd: '0.01' });

  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--tools') + 1], 'Bash');
  assert.ok(args.includes('--allowed-tools'));
  assert.ok(args.includes('--include-hook-events'));
  assert.ok(args.includes('--verbose'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
});

test('Claude optimized lane passes the declared 768-byte Sando policy', async () => {
  const { buildClaudeE2EEnv } = await import('../live/e2e-run.mjs');
  const baseEnv = { SANDO_POLICY: '{"mode":"apply","maxInlineBytes":9999}' };
  const env = buildClaudeE2EEnv({ variant: 'optimized', workspace: '/tmp/probe', baseEnv });

  assert.deepEqual(JSON.parse(env.SANDO_POLICY), {
    mode: 'apply', maxInlineBytes: 768, maxArtifactBytes: 4096, maxColumns: 768, redact: true,
  });
  assert.equal(Object.hasOwn(buildClaudeE2EEnv({ variant: 'baseline', workspace: '/tmp/probe', baseEnv }), 'SANDO_POLICY'), false);
});

test('Codex baseline lane cannot inherit the optimized Sando policy', async () => {
  const { buildCodexE2EEnv } = await import('../live/codex-e2e-run.mjs');
  const baseEnv = { SANDO_POLICY: '{"mode":"apply","maxInlineBytes":9999}' };
  const optimized = buildCodexE2EEnv({ variant: 'optimized', route: 'cli', baseEnv });
  const baseline = buildCodexE2EEnv({ variant: 'baseline', route: 'cli', baseEnv });
  assert.equal(JSON.parse(optimized.SANDO_POLICY).maxInlineBytes, 1024);
  assert.equal(Object.hasOwn(baseline, 'SANDO_POLICY'), false);
});

test('probe analysis requires model facts, resolves artifacts, and rejects leaked secrets', async () => {
  const { analyzeProbeEvidence } = await import('../live/e2e-run.mjs');
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sando-e2e-artifact-'));
  try {
    const artifact = path.join(directory, '.sando/sando/artifacts/result.txt');
    await fs.promises.mkdir(path.dirname(artifact), { recursive: true });
    await fs.promises.writeFile(artifact, 'SANDO_E2E_MIDDLE_FACT\nAPI_KEY=[REDACTED]\n');
    const evidence = await analyzeProbeEvidence({
      replacement: 'artifact .sando/sando/artifacts/result.txt 42B\nSANDO_E2E_HEAD_FACT\nSANDO_E2E_TAIL_FACT',
      modelResult: { status: 'ok', facts: ['SANDO_E2E_HEAD_FACT', 'SANDO_E2E_TAIL_FACT'] },
      requiredFacts: ['SANDO_E2E_HEAD_FACT', 'SANDO_E2E_TAIL_FACT'],
      artifactFacts: ['SANDO_E2E_MIDDLE_FACT'],
      cwd: directory,
    });
    assert.equal(evidence.modelVisibleQuality, 'pass');
    assert.equal(evidence.artifactResolvable, true);
    assert.equal(evidence.secretLeak, false);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
