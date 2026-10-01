import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { optimizeToolOutput } from '../index.mjs';
import { recoverArtifactContent } from '../src/artifact-recovery.mjs';
import {
  SOL_STANDARD_PROFILE_ID,
  aggregateApiRequestCosts,
  buildApiUsageRequest,
  loadPricingProfile,
} from '../src/pricing.mjs';

const manifestPath = path.resolve(import.meta.dirname, '../benchmarks/sando-cache-v1.json');
const readManifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function usageRequest(id, usage) {
  return buildApiUsageRequest({
    response: {
      object: 'response', status: 'completed', id, model: 'gpt-6.1-sol', service_tier: 'default', usage,
    },
    provenance: 'synthetic', sessionId: 'cache-proof', regionalSurcharge: false,
  });
}

test('cache benchmark freezes thirty six-turn sessions in alternating paired order', () => {
  const manifest = readManifest();
  assert.equal(manifest.schemaVersion, 'sando.benchmark-manifest.v1');
  assert.equal(manifest.id, 'sando-cache-v1');
  assert.deepEqual(manifest.arms, {
    control: { sandoCliRouting: '0' }, apply: { sandoCliRouting: '1' },
  });
  assert.deepEqual({
    model: manifest.execution.model,
    reasoningEffort: manifest.execution.reasoningEffort,
    turnsPerSession: manifest.execution.turnsPerSession,
    wallTimeoutMsPerTurn: manifest.execution.wallTimeoutMsPerTurn,
    totalSessions: manifest.execution.totalSessions,
    pairConcurrency: manifest.execution.pairConcurrency,
  }, {
    model: 'gpt-6.1-sol', reasoningEffort: 'low', turnsPerSession: 6,
    wallTimeoutMsPerTurn: 180_000, totalSessions: 30, pairConcurrency: 1,
  });
  assert.equal(manifest.repetitionsPerArm, 5);
  assert.equal(manifest.tasks.length, 3);
  for (const task of manifest.tasks) {
    assert.equal(task.turns.length, 6, task.id);
    const outputCriteria = task.successCriteria.filter(({ type }) => type.startsWith('file_'));
    assert.equal(outputCriteria.length, 6, task.id);
    assert.deepEqual(outputCriteria.map((criterion) => criterion.path),
      ['turn1.md', 'turn2.md', 'turn3.md', 'turn4.md', 'turn5.md', 'turn6.md']);
    assert.ok(task.successCriteria.some(({ type }) => type === 'command'), task.id);
    assert.ok(task.turns.every((turn) => !/SANDO_GOLDEN_|golden answer/i.test(turn)), task.id);
  }
  assert.deepEqual(manifest.schedule, [
    { repetition: 1, task: 'noisy-log-incident', arms: ['control', 'apply'] },
    { repetition: 1, task: 'broad-repository-search', arms: ['apply', 'control'] },
    { repetition: 1, task: 'tabular-test-reconciliation', arms: ['control', 'apply'] },
    { repetition: 2, task: 'noisy-log-incident', arms: ['apply', 'control'] },
    { repetition: 2, task: 'broad-repository-search', arms: ['control', 'apply'] },
    { repetition: 2, task: 'tabular-test-reconciliation', arms: ['apply', 'control'] },
    { repetition: 3, task: 'noisy-log-incident', arms: ['control', 'apply'] },
    { repetition: 3, task: 'broad-repository-search', arms: ['apply', 'control'] },
    { repetition: 3, task: 'tabular-test-reconciliation', arms: ['control', 'apply'] },
    { repetition: 4, task: 'noisy-log-incident', arms: ['apply', 'control'] },
    { repetition: 4, task: 'broad-repository-search', arms: ['control', 'apply'] },
    { repetition: 4, task: 'tabular-test-reconciliation', arms: ['apply', 'control'] },
    { repetition: 5, task: 'noisy-log-incident', arms: ['control', 'apply'] },
    { repetition: 5, task: 'broad-repository-search', arms: ['apply', 'control'] },
    { repetition: 5, task: 'tabular-test-reconciliation', arms: ['control', 'apply'] },
  ]);
});

test('each first-turn payload naturally exceeds the artifact threshold and protects its sources', () => {
  const manifest = readManifest();
  for (const task of manifest.tasks) {
    const sourcePath = task.firstTurnSourcePath;
    const output = task.fixture.files[sourcePath];
    assert.equal(typeof output, 'string', task.id);
    assert.ok(Buffer.byteLength(output) > 50 * 1024, `${task.id} payload is too small`);
    assert.ok(task.turns[0].includes(sourcePath.split('/')[0]), task.id);
    assert.ok(task.protectedPaths.includes(sourcePath), task.id);
  }
  assert.ok(fs.statSync(manifestPath).size < 1024 * 1024);
});

test('offline optimization retains diagnostics and recovers elided context byte-for-byte', () => {
  const task = readManifest().tasks[0];
  const output = task.fixture.files[task.firstTurnSourcePath];
  const decisive = output.split('\n').find((line) => line.includes('code=E_LEASE_STALE action=halt'));
  const deepContext = output.split('\n')[359];
  assert.ok(decisive);
  assert.ok(deepContext);
  const optimized = optimizeToolOutput({ toolName: 'Bash', toolInput: { command: `cat ${task.firstTurnSourcePath}` },
    output, cwd: '/work' });
  assert.ok(optimized.artifact);
  assert.ok(Buffer.byteLength(optimized.inline) < Buffer.byteLength(output));
  assert.equal(optimized.inline.includes(decisive), true);
  assert.equal(optimized.inline.includes(deepContext), false);
  const recovered = recoverArtifactContent({
    ref: optimized.artifact.ref, content: optimized.artifact.content,
    digest: optimized.artifact.sourceDigest, sourceBytes: optimized.artifact.sourceBytes,
    maxBytes: Buffer.byteLength(output),
  });
  assert.equal(recovered.content, output);
  assert.ok(recovered.content.includes(decisive));
  assert.ok(recovered.content.includes(deepContext));
});

test('cheaper cache reads do not hide a fresh-input increase', () => {
  const profile = loadPricingProfile(SOL_STANDARD_PROFILE_ID);
  const control = aggregateApiRequestCosts([usageRequest('control', {
    input_tokens: 100_000, output_tokens: 1_000,
    input_tokens_details: { cached_tokens: 90_000, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  })], profile);
  const apply = aggregateApiRequestCosts([usageRequest('apply', {
    input_tokens: 95_000, output_tokens: 1_000,
    input_tokens_details: { cached_tokens: 75_000, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  })], profile);
  assert.ok(apply.tokenTotals.inputTokens < control.tokenTotals.inputTokens);
  assert.ok(apply.tokenTotals.cachedInputTokens < control.tokenTotals.cachedInputTokens);
  assert.ok(apply.estimatedApiCostUsd > control.estimatedApiCostUsd);
});

test('missing cache usage keeps the API estimate unknown', () => {
  const report = aggregateApiRequestCosts([usageRequest('unknown-cache', {
    input_tokens: 10_000, output_tokens: 100,
  })], loadPricingProfile(SOL_STANDARD_PROFILE_ID));
  assert.equal(report.status, 'indeterminate');
  assert.equal(report.estimatedApiCostUsd, null);
  assert.equal(report.unpricedRequestCount, 1);
});
