import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SCRIPT = path.join(ROOT, 'scripts/bench-reduction.mjs');

function runBench(cwd, args = []) {
  return JSON.parse(execFileSync(process.execPath, [SCRIPT, cwd, '--json', ...args], { encoding: 'utf8' }));
}

// The numbers this script prints are published, so the corpus it measures has to be the one it
// claims: a fixed set of tracked files, not whatever the working tree happens to hold.
test('bench-reduction measures the tracked corpus and reports reduction honestly', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-bench-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['-C', cwd, 'init', '-q']);

  const bulk = `${'x'.repeat(120)}\n`.repeat(600);
  fs.writeFileSync(path.join(cwd, 'tracked.log'), bulk);
  fs.writeFileSync(path.join(cwd, 'small.txt'), 'tiny\n');
  execFileSync('git', ['-C', cwd, 'add', 'tracked.log', 'small.txt']);
  fs.writeFileSync(path.join(cwd, 'untracked.log'), bulk);

  const tracked = runBench(cwd);
  assert.equal(tracked.corpusSource, 'git ls-files');
  assert.equal(tracked.files, 1, 'small.txt is below the byte floor and untracked.log is not in the corpus');
  assert.equal(tracked.reducedFiles, 1);
  assert.ok(tracked.weightedRho > 0.9, `expected a repetitive log to reduce sharply, got ${tracked.weightedRho}`);
  assert.ok(tracked.inlineTokens < tracked.inputTokens);

  const everything = runBench(cwd, ['--all-files']);
  assert.equal(everything.corpusSource, 'directory walk');
  assert.equal(everything.files, 2, '--all-files picks up the untracked log too');
});

test('bench-reduction credits no reduction to content that passes through whole', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-bench-passthrough-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['-C', cwd, 'init', '-q']);

  // Comfortably inside the 32 KB source budget: nothing is elided, so rho must be 0 rather than
  // a small positive number harvested from the disclosure envelope.
  fs.writeFileSync(path.join(cwd, 'small.mjs'), `export const value = 1;\n`.repeat(200));
  execFileSync('git', ['-C', cwd, 'add', 'small.mjs']);

  const measured = runBench(cwd);
  assert.equal(measured.files, 1);
  assert.equal(measured.reducedFiles, 0);
  assert.equal(measured.weightedRho, 0);
  assert.equal(measured.medianRho, 0);
});
