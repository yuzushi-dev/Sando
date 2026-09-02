import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RUNNER = path.join(ROOT, 'benchmarks/live/e2e-run.mjs');

test('provides the truthful E2E probe runner', () => {
  assert.equal(fs.existsSync(RUNNER), true, 'E2E probe runner is missing');
});

test('capture input reader consumes stdin as a stream', async () => {
  const { readStdin } = await import('../live/e2e-run.mjs');
  const input = JSON.stringify({ hook_event_name: 'PostToolUse', tool_response: 'captured output' });

  assert.equal(await readStdin(Readable.from([input.slice(0, 12), input.slice(12)])), input);
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
    mode: 'apply', maxInlineBytes: 768, maxArtifactBytes: 16384, maxColumns: 768, redact: true,
  });
  assert.ok(JSON.parse(env.SANDO_POLICY).maxArtifactBytes >= 16384);
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

test('Codex live runner resolves an explicit executable without changing the default', async () => {
  const { resolveCodexExecutable } = await import('../live/codex-e2e-run.mjs');

  assert.equal(resolveCodexExecutable({ executable: '/opt/codex/bin/codex', env: {} }), '/opt/codex/bin/codex');
  assert.equal(resolveCodexExecutable({ env: { SANDO_CODEX_BIN: '/opt/codex/bin/codex' } }), '/opt/codex/bin/codex');
  assert.equal(resolveCodexExecutable({ env: {} }), 'codex');
  assert.throws(() => resolveCodexExecutable({ executable: '', env: {} }), /non-empty executable/);
});

test('Codex live runner uses the explicit executable for version and both paired arms', async () => {
  const { FIXTURE_COMMAND, runCodexToolBenchmark } = await import('../live/codex-e2e-run.mjs');
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sando-codex-runner-'));
  const executable = path.join(directory, 'fake-codex.mjs');
  await fs.promises.writeFile(executable, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const facts = ['SANDO_AB_HEAD_FACT', 'SANDO_AB_TAIL_FACT'];
if (process.argv.includes('--version')) {
  process.stdout.write('codex-test 0.0.0\\n');
  process.exit(0);
}
const optimized = process.argv.join(' ').includes('Sando MCP tool');
const receiptConfig = process.argv.find((arg) => arg.startsWith('mcp_servers.sando.env.SANDO_EXEC_RECEIPT_DIR='));
const receiptDirectory = receiptConfig
  ? JSON.parse(receiptConfig.slice('mcp_servers.sando.env.SANDO_EXEC_RECEIPT_DIR='.length))
  : undefined;
if (optimized) {
  if (!receiptDirectory) throw new Error('receipt directory was not configured for the MCP server');
  const stdout = facts.join('\\n');
  const stderr = '';
  const receipt = {
    schema: 'sando-exec-receipt/v1',
    run_id: crypto.randomUUID(),
    command: ${JSON.stringify(FIXTURE_COMMAND)},
    workdir: '.',
    stdout,
    stderr,
    stdout_sha256: crypto.createHash('sha256').update(stdout, 'utf8').digest('hex'),
    stderr_sha256: crypto.createHash('sha256').update(stderr, 'utf8').digest('hex'),
    stdout_bytes: Buffer.byteLength(stdout, 'utf8'),
    stderr_bytes: Buffer.byteLength(stderr, 'utf8'),
    exit_code: 0,
    signal: null,
    timed_out: false,
    cancelled: false,
    stdout_truncated: false,
    stderr_truncated: false,
    truncated: false,
  };
  fs.writeFileSync(path.join(receiptDirectory, 'receipt.json'), JSON.stringify(receipt));
}
const tool = optimized
  ? { type: 'mcp_tool_call', name: 'sando_exec', result: facts.join('\\n') }
  : { type: 'command_execution', aggregated_output: facts.join('\\n') };
const events = [
  { type: 'item.completed', item: tool },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'ok', facts }) } },
  { type: 'turn.completed', model: 'fake-model', usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 0 } },
];
for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
`);
  await fs.promises.chmod(executable, 0o755);
  try {
    const report = await runCodexToolBenchmark({
      outputPath: path.join(directory, 'report.json'),
      model: 'fake-model',
      repetitions: 1,
      timeoutMs: 5_000,
      route: 'mcp',
      codexExecutable: executable,
    });
    assert.equal(report.status, 'passed');
    assert.equal(report.clientVersion, 'codex-test 0.0.0');
    assert.equal(report.runs.length, 2);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('Codex live runner fails closed when the optimized sando_exec receipt is missing', async () => {
  const { runCodexToolBenchmark } = await import('../live/codex-e2e-run.mjs');
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sando-codex-missing-receipt-'));
  const executable = path.join(directory, 'fake-codex.mjs');
  await fs.promises.writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('codex-test 0.0.0\\n');
  process.exit(0);
}
const facts = ['SANDO_AB_HEAD_FACT', 'SANDO_AB_TAIL_FACT'];
const optimized = process.argv.join(' ').includes('Sando MCP tool');
const tool = optimized
  ? { type: 'mcp_tool_call', name: 'sando_exec', result: facts.join('\\n') }
  : { type: 'command_execution', aggregated_output: facts.join('\\n') };
for (const event of [
  { type: 'item.completed', item: tool },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'ok', facts }) } },
  { type: 'turn.completed', model: 'fake-model', usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, cached_input_tokens: 0 } },
]) process.stdout.write(JSON.stringify(event) + '\\n');
`);
  await fs.promises.chmod(executable, 0o755);
  try {
    const report = await runCodexToolBenchmark({
      outputPath: path.join(directory, 'report.json'), model: 'fake-model', repetitions: 2,
      timeoutMs: 5_000, route: 'mcp', codexExecutable: executable,
    });
    assert.equal(report.status, 'blocked');
    assert.equal(report.runs.length, 2);
    assert.equal(report.runs[1].quality, 'fail');
    assert.match(report.runs[1].error, /receipt/i);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
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
