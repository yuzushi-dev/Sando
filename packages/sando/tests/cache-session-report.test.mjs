import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cacheRequiredSourceFiles } from '../../../scripts/run-sando-cache-benchmark.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const script = path.join(repoRoot, 'scripts/summarize-cache-native-benchmark.mjs');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
  return JSON.stringify(value);
};
const writePrivate = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};

function counters(inputTokens, overrides = {}) {
  return {
    totalTokens: inputTokens + 10,
    inputTokens,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 10,
    outputTokens: 10,
    reasoningOutputTokens: 2,
    ...overrides,
  };
}

function plan(manifest) {
  return manifest.schedule.flatMap(({ repetition, task, arms }) => arms.map((arm, orderIndex) => ({
    benchmarkId: manifest.id, taskId: task, scenarioId: task, arm, repetition,
    orderPosition: orderIndex + 1, runKey: `${task}:${repetition}:${arm}`,
  })));
}

function sumCounters(values) {
  return Object.fromEntries(Object.keys(counters(0)).map((field) => [
    field, values.every((value) => value[field] !== null)
      ? values.reduce((sum, value) => sum + value[field], 0) : null,
  ]));
}

function fixture(t, { expectedSessions = 6, missingCacheWrite = false, requestMismatch = false,
  failedApplyScenario = null, noRequests = false, manifestName = 'sando-cache-v1.json' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const manifestPath = path.join(repoRoot, 'packages/sando/benchmarks', manifestName);
  const ledgerPath = path.join(root, 'events.jsonl');
  const outputPath = path.join(root, 'summary.json');
  const evidenceRoot = path.join(root, 'evidence');
  const receiptPath = path.join(root, 'source-receipt.json');
  const sourceRoot = fs.mkdtempSync(path.join(repoRoot, '.sando-cache-report-source-'));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  fs.chmodSync(sourceRoot, 0o700);
  const archivePath = path.join(sourceRoot, 'source.tar.gz');
  writePrivate(archivePath, 'synthetic source archive\n');
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);

  const sourceFiles = Object.fromEntries(cacheRequiredSourceFiles({ repoRoot, manifestPath }).map((relative) => [
    relative, sha256(fs.readFileSync(path.join(repoRoot, relative))),
  ]));
  const codex = {
    version: '0.159.2', launcherSha256: sha256('launcher'), binarySha256: sha256('binary'),
  };
  writePrivate(receiptPath, `${JSON.stringify({
    schemaVersion: 'sando.cache-benchmark-source-receipt.v1', benchmarkId: manifest.id,
    archivePath: path.relative(repoRoot, archivePath),
    archiveSha256: sha256(fs.readFileSync(archivePath)), files: sourceFiles,
    manifestSha256: sha256(manifestBytes), codex,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    quotaBefore: { ordinaryUsageAllowed: true, usedPercent: 1 },
    billing: { kind: 'chatgpt-subscription', usdCost: null, apiFallback: false },
  }, null, 2)}\n`);
  const source = {
    sourceReceiptSha256: sha256(fs.readFileSync(receiptPath)),
    archiveSha256: sha256(fs.readFileSync(archivePath)),
    manifestSha256: sha256(manifestBytes), codexBinarySha256: codex.binarySha256,
  };

  fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(evidenceRoot, 0o700);
  const selected = plan(manifest).slice(0, expectedSessions);
  const events = [{
    type: 'header', schemaVersion: 'sando.cache-benchmark-ledger.v1',
    benchmarkId: manifest.id, manifestSha256: sha256(manifestBytes),
    planSha256: sha256(canonicalJson(plan(manifest).map(({ runKey }) => runKey))),
    repetitionsPerArm: manifest.repetitionsPerArm, totalSessions: manifest.execution.totalSessions,
    evidenceRoot, sourceReceiptPath: receiptPath,
    sourceReceiptSha256: source.sourceReceiptSha256,
  }];

  for (const run of selected) {
    const perTurn = counters(run.arm === 'apply' ? 80 : 100);
    const turns = Array.from({ length: 6 }, (_, index) => {
      const requestUsage = { ...perTurn };
      if (missingCacheWrite && run === selected[0] && index === 0) requestUsage.cacheWriteInputTokens = null;
      const delta = { ...perTurn };
      if (missingCacheWrite && run === selected[0] && index === 0) delta.cacheWriteInputTokens = null;
      if (requestMismatch && run === selected[0] && index === 0) delta.cachedInputTokens += 1;
      return {
        index: index + 1,
        turnIdDigest: sha256(`${run.runKey}:turn:${index + 1}`),
        status: 'completed', durationMs: 100 + index,
        usage: { status: 'complete', delta,
          requests: noRequests ? [] : [{ usage: requestUsage, modelContextWindow: 400_000 }] },
        toolCalls: 2, artifactRetrievals: index === 2 ? 1 : 0, createdArtifacts: index === 1 ? 1 : 0,
        commands: [{ command: 'rg synthetic fixture', aggregatedOutput: {
          text: 'safe', truncated: index === 3, originalBytes: index === 3 ? 20 : 4,
        } }],
        finalMessages: [{ text: 'done', truncated: false, originalBytes: 4 }],
        hooks: { total: 2, byMode: { apply: run.arm === 'apply' ? 2 : 0, control: run.arm === 'control' ? 2 : 0 }, invalidLines: 0 },
        collabAgentToolCalls: 0,
      };
    });
    const qualityPassed = !(run.arm === 'apply' && run.scenarioId === failedApplyScenario);
    const directory = path.join(evidenceRoot, `${run.taskId}-r${run.repetition}-${run.arm}`);
    const outputs = path.join(directory, 'outputs');
    fs.mkdirSync(outputs, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    fs.chmodSync(outputs, 0o700);
    const retained = Buffer.from('safe retained output\n');
    const retainedPath = path.join(outputs, 'turn1.md');
    writePrivate(retainedPath, retained);
    const files = [{ path: 'turn1.md', storedAs: 'outputs/turn1.md', bytes: retained.length,
      sha256: sha256(retained), truncated: false, redacted: false, credentialRedactions: 0 }];
    const evidencePath = path.join(directory, 'evidence.json');
    const expectedCriteria = manifest.tasks.find(({ id }) => id === run.taskId).successCriteria;
    const verification = { protected: { passed: true, changed: [] },
      criteria: { passed: qualityPassed, checks: expectedCriteria.map(({ type }, index) => ({
        index, type, passed: qualityPassed,
      })) } };
    writePrivate(evidencePath, `${JSON.stringify({
      schemaVersion: 'sando.benchmark-evidence.v1', benchmarkId: run.benchmarkId,
      taskId: run.taskId, arm: run.arm, repetition: run.repetition,
      orderPosition: run.orderPosition, verification,
      provenance: { fixtureCommit: sha256(`fixture:${run.taskId}`), source }, files, overflow: false,
      limits: { perFileBytes: 65536, perAttemptBytes: 262144, totalBytes: 33554432 },
    }, null, 2)}\n`);
    const attempt = {
      schemaVersion: 'sando.cache-session-attempt.v1', ...run,
      outcome: qualityPassed ? 'passed' : 'failed', qualityPassed,
      failure: qualityPassed ? null : 'quality-verification-failed', durationMs: 1_000,
      startedAt: '2026-09-30T00:00:00.000Z', finishedAt: '2026-09-30T00:00:01.000Z',
      threadIdDigest: sha256(`thread:${run.runKey}`),
      observedExecution: { model: manifest.execution.model, reasoningEffort: 'low', sandbox: 'workspace-write',
        approvalPolicy: 'never', modelProvider: 'openai', serviceTier: null },
      turns,
      usage: { status: 'complete', total: sumCounters(turns.map(({ usage }) => usage.delta)) },
      verification,
      hooks: { total: 12, byMode: { apply: run.arm === 'apply' ? 12 : 0, control: run.arm === 'control' ? 12 : 0 }, invalidLines: 0 },
      collabAgentToolCalls: 0,
      billing: { kind: 'chatgpt-subscription', apiCostUsd: null, status: 'unpriced' },
      provenance: { fixtureCommit: sha256(`fixture:${run.taskId}`), source },
      evidence: { status: 'available', metadataPath: evidencePath, files, overflow: false },
    };
    delete attempt.runKey;
    events.push({ type: 'started', runKey: run.runKey, startedAt: attempt.startedAt });
    events.push({ type: 'completed', runKey: run.runKey, attempt });
  }
  writePrivate(ledgerPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return { root, manifestPath, ledgerPath, outputPath, receiptPath, events };
}

function runReport(paths, extra = []) {
  return spawnSync(process.execPath, [script,
    '--manifest', paths.manifestPath, '--ledger', paths.ledgerPath,
    '--source-receipt', paths.receiptPath, '--output', paths.outputPath,
    '--expected-sessions', String(paths.events.filter(({ type }) => type === 'completed').length), ...extra], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env },
  });
}

test('six-session pilot reports cumulative native metrics and labels API pricing as counterfactual', (t) => {
  const paths = fixture(t);
  const result = runReport(paths);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(paths.outputPath, 'utf8'));
  assert.equal(fs.statSync(paths.outputPath).mode & 0o777, 0o600);
  assert.equal(report.scope, 'pilot');
  assert.deepEqual(report.sessions, { expected: 6, completed: 6, turns: 36 });
  assert.equal(report.nativeBilling.usdCost, null);
  assert.equal(report.nativeBilling.subscriptionQuotaCost, null);
  assert.deepEqual(report.nativeExecution, {
    models: ['gpt-6.1-sol'], modelProviders: ['openai'], reasoningEfforts: ['low'],
    sandboxes: ['workspace-write'], approvalPolicies: ['never'], serviceTiers: [null],
  });
  assert.equal(report.counterfactualApi.label, 'COUNTERFACTUAL_API');
  assert.equal(report.counterfactualApi.serviceTierAssumption, 'standard');
  assert.equal(report.counterfactualApi.status, 'complete');
  assert.ok(report.counterfactualApi.byArm.apply.estimatedApiCostUsd
    < report.counterfactualApi.byArm.control.estimatedApiCostUsd);
  assert.equal(report.metrics.overall.toolCalls, 72);
  assert.equal(report.metrics.overall.artifactCreations, 6);
  assert.equal(report.metrics.overall.artifactRetrievals, 6);
  assert.equal(report.metrics.overall.truncatedOutputs, 6);
  assert.equal(report.metrics.overall.hooks, 72);
  assert.equal(report.decision.status, 'inconclusive-pilot');
  assert.equal(report.decision.statisticalProof, false);
  assert.equal(report.integrity.evidence.hashesAndPermissionsVerified, true);
  assert.ok(report.integrity.evidence.retainedBytes > 6 * Buffer.byteLength('safe retained output\n'));
});

test('missing cache-write usage and request/delta disagreement stay unpriced instead of becoming zero', async (t) => {
  for (const options of [{ missingCacheWrite: true }, { requestMismatch: true }]) {
    await t.test(JSON.stringify(options), (subtest) => {
      const paths = fixture(subtest, options);
      const result = runReport(paths);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(fs.readFileSync(paths.outputPath, 'utf8'));
      assert.equal(report.counterfactualApi.status, 'incomplete');
      assert.equal(report.counterfactualApi.estimatedApiCostUsd, null);
      assert.ok(report.counterfactualApi.unpricedRequests > 0);
      assert.equal(report.counterfactualApi.cacheWriteInputTokens,
        options.missingCacheWrite ? null : 360);
      if (options.missingCacheWrite) assert.equal(report.nativeUsage.overall.cacheWriteInputTokens, null);
    });
  }
});

test('duplicate ledger events and changed retained evidence fail closed without a report', async (t) => {
  await t.test('duplicate', (subtest) => {
    const paths = fixture(subtest);
    const duplicate = paths.events.find(({ type }) => type === 'completed');
    fs.appendFileSync(paths.ledgerPath, `${JSON.stringify(duplicate)}\n`);
    const result = runReport(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate completed/i);
    assert.equal(fs.existsSync(paths.outputPath), false);
  });
  await t.test('completion precedes start', (subtest) => {
    const paths = fixture(subtest);
    [paths.events[1], paths.events[2]] = [paths.events[2], paths.events[1]];
    fs.writeFileSync(paths.ledgerPath, `${paths.events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const result = runReport(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /completed.*matching started/i);
    assert.equal(fs.existsSync(paths.outputPath), false);
  });
  await t.test('evidence hash', (subtest) => {
    const paths = fixture(subtest);
    const attempt = paths.events.find(({ type }) => type === 'completed').attempt;
    fs.writeFileSync(attempt.evidence.files[0].storedAs.startsWith('/')
      ? attempt.evidence.files[0].storedAs
      : path.join(path.dirname(attempt.evidence.metadataPath), attempt.evidence.files[0].storedAs), 'changed');
    const result = runReport(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /evidence.*(?:hash|byte)/i);
    assert.equal(fs.existsSync(paths.outputPath), false);
  });
  await t.test('quality contradicts verification', (subtest) => {
    const paths = fixture(subtest);
    const completed = paths.events.find(({ type }) => type === 'completed');
    completed.attempt.verification.protected = { passed: false, changed: ['fixture.txt'] };
    const metadata = JSON.parse(fs.readFileSync(completed.attempt.evidence.metadataPath, 'utf8'));
    metadata.verification = completed.attempt.verification;
    fs.writeFileSync(completed.attempt.evidence.metadataPath, `${JSON.stringify(metadata)}\n`);
    fs.writeFileSync(paths.ledgerPath, `${paths.events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const result = runReport(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /quality.*verification/i);
    assert.equal(fs.existsSync(paths.outputPath), false);
  });
  await t.test('quality omits a declared criterion', (subtest) => {
    const paths = fixture(subtest);
    const completed = paths.events.find(({ type }) => type === 'completed');
    completed.attempt.verification.criteria.checks.pop();
    const metadata = JSON.parse(fs.readFileSync(completed.attempt.evidence.metadataPath, 'utf8'));
    metadata.verification = completed.attempt.verification;
    fs.writeFileSync(completed.attempt.evidence.metadataPath, `${JSON.stringify(metadata)}\n`);
    fs.writeFileSync(paths.ledgerPath, `${paths.events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const result = runReport(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /criteria.*coverage/i);
    assert.equal(fs.existsSync(paths.outputPath), false);
  });
  await t.test('source receipt omits a required file', (subtest) => {
    const paths = fixture(subtest);
    const receipt = JSON.parse(fs.readFileSync(paths.receiptPath, 'utf8'));
    delete receipt.files['scripts/summarize-cache-native-benchmark.mjs'];
    fs.writeFileSync(paths.receiptPath, `${JSON.stringify(receipt)}\n`);
    const receiptHash = sha256(fs.readFileSync(paths.receiptPath));
    paths.events[0].sourceReceiptSha256 = receiptHash;
    for (const { attempt } of paths.events.filter(({ type }) => type === 'completed')) {
      attempt.provenance.source.sourceReceiptSha256 = receiptHash;
      const metadata = JSON.parse(fs.readFileSync(attempt.evidence.metadataPath, 'utf8'));
      metadata.provenance = attempt.provenance;
      fs.writeFileSync(attempt.evidence.metadataPath, `${JSON.stringify(metadata)}\n`);
    }
    fs.writeFileSync(paths.ledgerPath, `${paths.events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const result = runReport(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required files/i);
    assert.equal(fs.existsSync(paths.outputPath), false);
  });
  await t.test('unexpected evidence directory', (subtest) => {
    const paths = fixture(subtest);
    const attempt = paths.events.find(({ type }) => type === 'completed').attempt;
    const extra = path.join(path.dirname(attempt.evidence.metadataPath), 'outputs', 'unexpected');
    fs.mkdirSync(extra, { mode: 0o777 });
    const result = runReport(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /evidence.*(?:directory|coverage|mode)/i);
    assert.equal(fs.existsSync(paths.outputPath), false);
  });
  await t.test('collection evidence cap', (subtest) => {
    const paths = fixture(subtest);
    for (const { attempt } of paths.events.filter(({ type }) => type === 'completed')) {
      const metadata = JSON.parse(fs.readFileSync(attempt.evidence.metadataPath, 'utf8'));
      metadata.limits.totalBytes = 127;
      fs.writeFileSync(attempt.evidence.metadataPath, `${JSON.stringify(metadata)}\n`);
    }
    const result = runReport(paths);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /total evidence limit/i);
    assert.equal(fs.existsSync(paths.outputPath), false);
  });
});

test('missing provider-request coverage is unpriced and never becomes zero usage', (t) => {
  const paths = fixture(t, { noRequests: true });
  const result = runReport(paths);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(paths.outputPath, 'utf8'));
  assert.equal(report.counterfactualApi.status, 'incomplete');
  assert.equal(report.counterfactualApi.estimatedApiCostUsd, null);
  assert.equal(report.counterfactualApi.inputTokens, null);
  assert.equal(report.counterfactualApi.missingRequestCoverageTurns, 36);
  assert.equal(report.counterfactualApi.unpricedRequests, 0);
  assert.equal(report.counterfactualApi.missingRequestCount, null);
});

test('a complete thirty-session cohort applies the screening gate and refuses overwrite', (t) => {
  const paths = fixture(t, { expectedSessions: 30 });
  let result = runReport(paths);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(paths.outputPath, 'utf8'));
  assert.equal(report.scope, 'complete');
  assert.equal(report.decision.status, 'passed');
  assert.equal(report.decision.descriptiveRepetitionsPerArm, 5);
  assert.match(report.decision.limitation, /screening|statistical/i);
  result = runReport(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to overwrite/i);
});

test('a complete twenty-session recovery cohort evaluates ten paired repetitions', (t) => {
  const paths = fixture(t, {
    expectedSessions: 20,
    manifestName: 'sando-recovery-v1.json',
  });
  const result = runReport(paths);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(paths.outputPath, 'utf8'));
  assert.equal(report.scope, 'complete');
  assert.deepEqual(report.sessions, { expected: 20, completed: 20, turns: 120 });
  assert.equal(report.decision.status, 'passed');
  assert.equal(report.decision.descriptiveRepetitionsPerArm, 10);
  assert.equal(report.decision.paired.length, 1);
  assert.equal(report.decision.paired[0].pairs, 10);
  assert.match(report.decision.limitation, /ten repetitions|10 repetitions/i);
});

test('the recovery cohort rejects partial coverage', (t) => {
  const paths = fixture(t, {
    expectedSessions: 6,
    manifestName: 'sando-recovery-v1.json',
  });
  const result = runReport(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected-sessions must be 20/i);
  assert.equal(fs.existsSync(paths.outputPath), false);
});

test('a Luna recovery cohort uses Luna pricing and never claims Sol pricing', (t) => {
  const paths = fixture(t, {
    expectedSessions: 20,
    manifestName: 'sando-recovery-luna-v1.json',
  });
  const result = runReport(paths);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(paths.outputPath, 'utf8'));
  assert.deepEqual(report.nativeExecution.models, ['gpt-6-luna']);
  assert.equal(report.counterfactualApi.modelAssumption, 'gpt-6-luna');
  assert.equal(report.counterfactualApi.profileId, 'openai-gpt-6-luna-standard-2026-10-01');
  assert.equal(report.counterfactualApi.status, 'complete');
  assert.ok(report.counterfactualApi.estimatedApiCostUsd > 0);
  assert.doesNotMatch(JSON.stringify(report.counterfactualApi), /gpt-6\.1-sol|openai-gpt-6\.1-sol/);
  assert.equal(report.decision.descriptiveRepetitionsPerArm, 10);
});
