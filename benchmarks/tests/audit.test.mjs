import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { auditMetadata, digestPrompt, redactStream } from '../lib/audit.mjs';

test('audit metadata is reproducible, redacts streams, and declares measurement mode', () => {
  const prompt = 'benchmark prompt';
  const audit = auditMetadata({
    host: 'codex', variant: 'optimized', prompt, args: ['exec', prompt],
    result: { stdout: 'status=ok\\nAPI_KEY=sk-test-01234567890123456789', stderr: 'password=hunter2' },
    commit: 'abc123', resolvedModel: 'codex-test',
    now: '2026-08-23T12:00:00.000Z',
    environment: { node: 'v22-test' },
    cwd: '/tmp',
  });
  assert.equal(audit.promptDigest, digestPrompt(prompt));
  assert.equal(audit.timestamp, '2026-08-23T12:00:00.000Z');
  assert.equal(audit.commit, 'abc123');
  assert.equal(audit.workingTreeDirty, null);
  assert.equal(audit.diffDigest, null);
  assert.equal(audit.workingTreeProvenance, 'unknown');
  assert.equal(audit.resolvedModel, 'codex-test');
  assert.deepEqual(audit.args, ['exec', `<prompt:${audit.promptDigest}>`]);
  assert.equal(audit.raw.stdout.includes('sk-test'), false);
  assert.equal(audit.raw.stderr.includes('hunter2'), false);
  assert.equal(audit.measurement.mode, 'prompt-level');
  assert.equal(audit.measurement.hookEndToEnd, false);
  assert.equal(redactStream('x'.repeat(10), 5).truncated, true);
});

test('dirty audit provenance has a reproducible diff digest', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-audit-'));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(cwd, 'implementation.mjs'), 'export const version = 1;\n');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', 'implementation.mjs');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
    fs.writeFileSync(path.join(cwd, 'implementation.mjs'), 'export const version = 2;\n');

    const first = auditMetadata({ host: 'local', variant: 'optimized', prompt: 'prompt', cwd });
    const second = auditMetadata({ host: 'local', variant: 'optimized', prompt: 'prompt', cwd });
    assert.equal(first.workingTreeDirty, true);
    assert.match(first.diffDigest, /^sha256:/);
    assert.equal(first.diffDigest, second.diffDigest);
    assert.equal(first.workingTreeProvenance, 'dirty-digest');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('nested repository cwd uses the top-level root for dirty provenance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-audit-'));
  const cwd = path.join(root, 'benchmarks');
  fs.mkdirSync(cwd);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(root, 'implementation.mjs'), 'export const version = 1;\n');
    fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'fixture\n');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
    fs.writeFileSync(path.join(root, 'implementation.mjs'), 'export const version = 2;\n');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'untracked\n', { mode: 0o600 });
    fs.symlinkSync('missing-target', path.join(root, 'link'));

    const fromRoot = auditMetadata({ host: 'local', variant: 'optimized', prompt: 'prompt', cwd: root });
    const fromNested = auditMetadata({ host: 'local', variant: 'optimized', prompt: 'prompt', cwd });
    assert.equal(fromNested.commit, fromRoot.commit);
    assert.equal(fromNested.workingTreeDirty, true);
    assert.equal(fromNested.diffDigest, fromRoot.diffDigest);
    assert.equal(fromNested.workingTreeProvenance, 'dirty-digest');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('measurement metadata cannot claim end-to-end without a hook lifecycle', () => {
  assert.throws(() => auditMetadata({
    host: 'claude', variant: 'optimized', prompt: 'prompt',
    measurement: { mode: 'end-to-end', hookEndToEnd: false },
  }), /measurement/);
  assert.doesNotThrow(() => auditMetadata({
    host: 'claude', variant: 'optimized', prompt: 'prompt',
    measurement: { mode: 'end-to-end', hookEndToEnd: true },
  }));
});

test('accepts end-to-end-tools provenance for MCP-mediated runs', () => {
  assert.doesNotThrow(() => auditMetadata({
    host: 'codex', variant: 'optimized', prompt: 'prompt',
    measurement: { mode: 'end-to-end-tools', hookEndToEnd: true },
  }));
});

test('accepts provider-proxy provenance without claiming a hook lifecycle', () => {
  assert.doesNotThrow(() => auditMetadata({
    host: 'claude', variant: 'optimized', prompt: 'prompt',
    measurement: { mode: 'end-to-end-proxy', hookEndToEnd: false, providerProxy: true },
  }));
});

test('dirty provenance hashes a dangling symlink target, not its resolved bytes', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-audit-'));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'tracked\n');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', 'tracked.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
    fs.symlinkSync('missing-target', path.join(cwd, 'link'));

    const first = auditMetadata({ host: 'local', variant: 'optimized', prompt: 'prompt', cwd });
    const second = auditMetadata({ host: 'local', variant: 'optimized', prompt: 'prompt', cwd });
    assert.equal(first.workingTreeProvenance, 'dirty-digest');
    assert.match(first.diffDigest, /^sha256:/);
    assert.equal(first.diffDigest, second.diffDigest);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('dirty provenance changes when an untracked file mode changes', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-audit-'));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'tracked\n');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', 'tracked.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
    const file = path.join(cwd, 'untracked.txt');
    fs.writeFileSync(file, 'same bytes\n', { mode: 0o600 });

    const first = auditMetadata({ host: 'local', variant: 'optimized', prompt: 'prompt', cwd });
    fs.chmodSync(file, 0o700);
    const second = auditMetadata({ host: 'local', variant: 'optimized', prompt: 'prompt', cwd });
    assert.notEqual(first.diffDigest, second.diffDigest);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('dirty provenance marks unsupported working-tree entries unknown', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-audit-'));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(cwd, 'entry'), 'file\n');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', 'entry');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
    fs.rmSync(path.join(cwd, 'entry'));
    fs.mkdirSync(path.join(cwd, 'entry'));

    const audit = auditMetadata({ host: 'local', variant: 'optimized', prompt: 'prompt', cwd });
    assert.equal(audit.workingTreeDirty, true);
    assert.equal(audit.diffDigest, null);
    assert.equal(audit.workingTreeProvenance, 'unknown');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('dirty provenance includes staged deletions without reading a missing path', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-audit-'));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(cwd, 'entry'), 'file\n');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', 'entry');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
    git('rm', '-q', 'entry');

    const audit = auditMetadata({ host: 'local', variant: 'optimized', prompt: 'prompt', cwd });
    assert.equal(audit.workingTreeProvenance, 'dirty-digest');
    assert.match(audit.diffDigest, /^sha256:/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
