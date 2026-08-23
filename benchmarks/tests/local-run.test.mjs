import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

test('local report hashes the paired prompts and declares estimate accounting', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-benchmark-'));
  const output = path.join(directory, 'local.json');
  try {
    const result = spawnSync(process.execPath, [
      'benchmarks/run-local.mjs', '--scenario', 'tool-suite', '--repetitions', '1', '--out', output,
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    const runs = report.runs.filter((run) => run.repetition === 0);
    assert.notEqual(
      runs.find((run) => run.variant === 'baseline').promptDigest,
      runs.find((run) => run.variant === 'optimized').promptDigest,
    );
    assert.deepEqual(report.audit.tokenAccounting, {
      source: 'estimate',
      formula: 'ceil(UTF-8 bytes / 4)',
      providerObserved: false,
    });
    assert.match(report.inputs.scenarios[0].digest, /^sha256:/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
