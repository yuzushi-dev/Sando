import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateSuccessCriteria,
  snapshotProtectedFiles,
  verifyProtectedFiles,
} from '../../../scripts/run-sando-benchmark.mjs';

const originalPath = new URL('../benchmarks/sando-cache-v1.json', import.meta.url);
const correctedPath = new URL('../benchmarks/sando-cache-v1-corrected.json', import.meta.url);
const load = (url) => JSON.parse(fs.readFileSync(url, 'utf8'));

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function materialize(root, task) {
  for (const [relativePath, contents] of Object.entries(task.fixture.files)) {
    write(root, relativePath, contents);
  }
}

const reference = {
  'noisy-log-incident': {
    files: {
      'turn1.md': 'lines=720\nfirst=0001\nlast=0720\n',
      'turn2.md': '0358 FATAL ts=2026-09-30T09:41:19.006Z service=payments request=req-7f31 attempt=3 code=E_LEASE_STALE action=halt lease=pay-eu-04\n',
      'turn3.md': '0357 WARN ts=2026-09-30T09:41:17.357Z service=payments request=req-7f31 attempt=3 max=3 code=E_UPSTREAM_TIMEOUT action=retry elapsedMs=1842\n',
      'turn4.md': "attempt < maxRetries && code === 'E_UPSTREAM_TIMEOUT'\n",
      'turn5.md': 'Implemented lib/retry-policy.mjs.\n',
      'turn6.md': 'verification=passed\nincident=halt\n',
      'lib/retry-policy.mjs': "export const shouldRetry = (attempt, maxRetries, code) => attempt < maxRetries && code === 'E_UPSTREAM_TIMEOUT';\n",
    },
  },
  'broad-repository-search': {
    files: {
      'turn1.md': 'matches=687\ncommand=rg -n\n',
      'turn2.md': '  return `${workspace.trim()}:${tenant.trim().toLowerCase()}`;\n',
      'turn3.md': 'Canonical rule: lowercase and trim both components; use a forward slash.\n',
      'turn4.md': 'src/api/load-session.mjs:2:export const loadSession = (row) => makeTenantKey(row.workspace, row.tenant);\nsrc/jobs/refresh-cache.mjs:2:export const refreshCache = (job) => makeTenantKey(job.workspace, job.tenant);\n',
      'turn5.md': 'Implemented lib/tenant-key.mjs.\n',
      'turn6.md': 'verification=passed\ncanonical=acme/shop-eu\n',
      'lib/tenant-key.mjs': "export const makeTenantKey = (workspace, tenant) => `${workspace.trim().toLowerCase()}/${tenant.trim().toLowerCase()}`;\n",
    },
  },
  'tabular-test-reconciliation': {
    files: {
      'turn1.md': 'lines=760\nfailures=1\n',
      'turn2.md': 'not ok 431 - checkout applies regional tax\n  expected: 1299\n  actual: 1199\n',
      'turn3.md': 'case-0431,"checkout applies regional tax",failed,83,eu-west-3\n',
      'turn4.md': 'eu-west-3 rate=0.0834\n',
      'turn5.md': 'Implemented lib/regional-tax.mjs.\n',
      'turn6.md': 'verification=passed\n',
      'lib/regional-tax.mjs': "export const applyRegionalTax = (subtotalCents, region) => region === 'eu-west-3' ? Math.round(subtotalCents * 1.0834) : subtotalCents;\n",
      'summary.json': JSON.stringify({ failedTest: 'checkout applies regional tax', expectedCents: 1299,
        actualCents: 1199, region: 'eu-west-3', fixedCents: 1299 }),
    },
  },
};

test('corrected cache manifest changes only prompt wording', () => {
  const original = load(originalPath);
  const corrected = load(correctedPath);
  assert.equal(corrected.id, 'sando-cache-v1');
  assert.deepEqual(corrected.execution, original.execution);
  assert.deepEqual(corrected.schedule, original.schedule);
  assert.deepEqual(corrected.tasks.map(({ fixture }) => fixture), original.tasks.map(({ fixture }) => fixture));
  assert.deepEqual(corrected.tasks.map(({ successCriteria }) => successCriteria),
    original.tasks.map(({ successCriteria }) => successCriteria));
  assert.notDeepEqual(corrected.tasks.map(({ turns }) => turns), original.tasks.map(({ turns }) => turns));
});

test('every corrected oracle accepts its deterministic reference and rejects a wrong output', (t) => {
  const manifest = load(correctedPath);
  for (const task of manifest.tasks) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `sando-cache-oracle-${task.id}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    materialize(root, task);
    const snapshot = snapshotProtectedFiles(root, task.protectedPaths);
    for (const [relativePath, contents] of Object.entries(reference[task.id].files)) write(root, relativePath, contents);
    assert.deepEqual(verifyProtectedFiles(root, snapshot), { passed: true, changed: [] }, task.id);
    assert.equal(evaluateSuccessCriteria(root, task.successCriteria, {
      protectedPaths: task.protectedPaths,
    }).passed, true, task.id);

    write(root, 'turn1.md', 'intentionally wrong\n');
    assert.equal(evaluateSuccessCriteria(root, task.successCriteria, {
      protectedPaths: task.protectedPaths,
    }).passed, false, `${task.id} accepted wrong output`);
  }
});

test('protected source mutation invalidates the oracle', (t) => {
  const task = load(correctedPath).tasks[0];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cache-oracle-protected-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  materialize(root, task);
  const snapshot = snapshotProtectedFiles(root, task.protectedPaths);
  fs.appendFileSync(path.join(root, task.protectedPaths[0]), 'tampered\n');
  assert.deepEqual(verifyProtectedFiles(root, snapshot), {
    passed: false, changed: [task.protectedPaths[0]],
  });
});
