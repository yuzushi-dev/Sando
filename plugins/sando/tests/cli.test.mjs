import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const launcher = path.join(root, 'bin/sando');
const policy = JSON.stringify({ mode: 'apply', maxInlineBytes: 128, maxArtifactBytes: 4096, redact: true });

function run(cwd, args) {
  return spawnSync(launcher, args, {
    cwd, encoding: 'utf8', env: { ...process.env, SANDO_POLICY: policy },
  });
}

test('CLI read bounds, redacts, and persists a recoverable artifact', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cli-read-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), `secret=hidden\n${'middle\n'.repeat(80)}tail-fact\n`);

  const result = run(cwd, ['read', '--', 'fixture.txt']);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /hidden/);
  const artifact = result.stdout.match(/\.sando\/sando\/artifacts\/[^\s]+\.txt/)?.[0];
  assert.ok(artifact);
  assert.equal(fs.readFileSync(path.join(cwd, artifact), 'utf8').includes('secret=[REDACTED]'), true);
  assert.equal(fs.statSync(path.join(cwd, artifact)).mode & 0o777, 0o600);
});

test('CLI grep returns bounded literal matches', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cli-grep-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle\nother\n');

  const result = run(cwd, ['grep', '-F', '--', 'needle', 'fixture.txt']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture\.txt:1:needle/);
});

test('CLI exec keeps the inherited sandbox path and redacts output', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cli-exec-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const script = "require('fs').writeFileSync('marker.txt', 'ok'); process.stdout.write('Authorization: Bearer hidden')";

  const result = run(cwd, ['exec', '--', process.execPath, '-e', script]);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /hidden/);
  assert.match(result.stdout, /exit_code=0/);
  assert.equal(fs.readFileSync(path.join(cwd, 'marker.txt'), 'utf8'), 'ok');
});
