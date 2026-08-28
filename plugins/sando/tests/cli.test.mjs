import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const launcher = path.join(root, 'bin/sando');
const policy = JSON.stringify({ mode: 'apply', maxInlineBytes: 128, maxArtifactBytes: 4096, redact: true });

function run(cwd, args, extraEnv = {}) {
  return spawnSync(launcher, args, {
    cwd, encoding: 'utf8', env: { ...process.env, SANDO_POLICY: policy, ...extraEnv },
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

test('plugin ships an explicit-upstream provider proxy launcher', () => {
  const launcher = path.join(root, 'bin/sando-proxy');
  const help = spawnSync(launcher, ['--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /SANDO_UPSTREAM_URL/);

  const missing = spawnSync(launcher, [], { encoding: 'utf8', env: { ...process.env, SANDO_UPSTREAM_URL: '' } });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /SANDO_UPSTREAM_URL/);
});

test('CLI exec stops capture at the configured artifact limit', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cli-cap-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const boundedPolicy = JSON.stringify({ mode: 'apply', maxInlineBytes: 128, maxArtifactBytes: 256, redact: true });
  const result = spawnSync(path.join(root, 'bin/sando'), ['exec', '--', 'sh', '-c', "head -c 100000 /dev/zero | tr '\\0' x; printf ok > after.txt"], {
    cwd, encoding: 'utf8', env: { ...process.env, SANDO_POLICY: boundedPolicy },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sando exec output bounded at 256 bytes/);
  assert.equal(fs.readFileSync(path.join(cwd, 'after.txt'), 'utf8'), 'ok');
});

test('CLI exposes the adaptive decision from provider ledger evidence', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cli-adaptive-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const records = [
    ['control-1', 'control', 100], ['control-2', 'control', 100], ['control-3', 'control', 100],
    ['apply-1', 'apply', 160], ['apply-2', 'apply', 160], ['apply-3', 'apply', 160],
  ].map(([sessionId, arm, inputTokens]) => ({
    eventKey: `usage:${sessionId}`, schema: 'sando-provider-usage/v1', version: 1,
    host: 'codex', source: 'test', sessionId, turnId: 'turn-1', at: '2026-08-28T10:00:00.000Z',
    inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0,
    reasoningOutputTokens: 0, totalTokens: inputTokens, arm, experimentId: 'fixture',
  }));
  const providerPath = path.join(cwd, 'provider-usage.json');
  fs.writeFileSync(providerPath, JSON.stringify({ schema: 'sando-provider-usage/v1', version: 1, timezone: 'UTC', records }));

  const result = run(cwd, ['adaptive', '--json'], {
    SANDO_PROVIDER_USAGE_PATH: providerPath,
    SANDO_ADAPTIVE_EXPERIMENT: 'fixture',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).enabled, false);
  assert.equal(JSON.parse(result.stdout).reason, 'cost-backoff');
});
