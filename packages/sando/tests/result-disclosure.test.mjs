import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RESULT_DISCLOSURE_SCHEMA,
  buildResultDisclosure,
  optimizeToolOutput,
  recoverArtifactContent,
  recoverArtifactFromWorkspace,
} from '../index.mjs';
import { cleanupArtifacts } from '../src/artifact-lifecycle.mjs';
import { rememberArtifact, recoverStoredArtifact } from '../src/artifact-store.mjs';
import { finalizeResultDelivery } from '../src/result-disclosure.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');

function digest(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

test('final delivery recomputes visible bytes, token estimate, markers, and recovery range', () => {
  const content = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join('\n');
  const artifact = {
    content,
    bytes: Buffer.byteLength(content),
    ref: 'sando:sha256:0123456789abcdef',
    sourceDigest: `sha256:${'a'.repeat(64)}`,
  };
  const initial = {
    inline: `[sando] artifact ${artifact.ref} ${artifact.bytes}B\n${content}`,
    artifact,
    stats: { inlineBytes: 999, estimatedInlineTokens: 999 },
    disclosure: {
      bytes: { original: artifact.bytes, redacted: artifact.bytes, visible: 999 },
      markers: ['artifact-handle'],
      artifact: { digest: artifact.sourceDigest },
    },
  };
  const artifactPath = `.sando/sando/artifacts/${'a'.repeat(64)}.txt`;
  const delivered = finalizeResultDelivery(initial, {
    inline: initial.inline.replace(artifact.ref, artifactPath),
    maxInlineBytes: 256,
  });

  assert.ok(Buffer.byteLength(delivered.inline) <= 256);
  assert.equal(delivered.stats.inlineBytes, Buffer.byteLength(delivered.inline));
  assert.equal(delivered.stats.estimatedInlineTokens, Math.ceil(Buffer.byteLength(delivered.inline) / 4));
  assert.equal(delivered.disclosure.bytes.visible, Buffer.byteLength(delivered.inline));
  assert.ok(delivered.disclosure.markers.includes('middle-elision'));
  assert.match(delivered.inline, /\[middle elided\]/);
  assert.ok(delivered.disclosure.artifact.elidedRange.startLine >= 1);
  assert.ok(delivered.disclosure.artifact.elidedRange.endLine <= 80);
  assert.equal(delivered.disclosure.artifact.digest, artifact.sourceDigest);
});

test('final delivery rejects a cap that cannot hold mandatory artifact metadata', () => {
  const sourceDigest = `sha256:${'b'.repeat(64)}`;
  const result = {
    inline: '[sando] artifact sando:sha256:bbbbbbbbbbbbbbbb 100B\npayload',
    artifact: { content: 'payload', bytes: 7, ref: 'sando:sha256:bbbbbbbbbbbbbbbb', sourceDigest },
    stats: { inlineBytes: 7, estimatedInlineTokens: 2 },
    disclosure: { bytes: { original: 7, redacted: 7, visible: 7 }, markers: [], artifact: { digest: sourceDigest } },
  };

  assert.throws(
    () => finalizeResultDelivery(result, {
      inline: `[sando] artifact .sando/sando/artifacts/${'b'.repeat(64)}.txt 100B\npayload`,
      maxInlineBytes: 64,
    }),
    (error) => error?.code === 'SANDO_OUTPUT_BUDGET' && /cannot fit mandatory metadata/.test(error.message),
  );
});

test('final compaction keeps recovery ranges conservative and rewrites the rendered command', () => {
  const content = Array.from({ length: 100 }, (_, index) => `L${String(index + 1).padStart(3, '0')} ${'x'.repeat(8)}`).join('\n');
  const sourceDigest = digest(content);
  const artifact = {
    content, bytes: Buffer.byteLength(content), sourceDigest,
    ref: `sando:${sourceDigest.slice(0, 'sha256:'.length + 16)}`,
  };
  const header = `[sando] artifact .sando/sando/artifacts/${sourceDigest.slice('sha256:'.length)}.txt ${artifact.bytes}B recover: /long/host/path/bin/sando artifact get --ref ${artifact.ref} --start-line 11 --end-line 90`;
  const body = `${content.split('\n').slice(0, 10).join('\n')}\n[middle elided]\n${content.split('\n').slice(90).join('\n')}`;
  const result = {
    inline: `${header}\n${body}`, artifact,
    stats: { inlineBytes: 999, estimatedInlineTokens: 999 },
    disclosure: {
      bytes: { original: artifact.bytes, redacted: artifact.bytes, visible: 999 },
      markers: ['artifact-handle', 'middle-elision'],
      artifact: { digest: sourceDigest, elidedRange: { startLine: 11, endLine: 90 } },
    },
  };
  const delivered = finalizeResultDelivery(result, { inline: result.inline, maxInlineBytes: 300 });
  const range = delivered.disclosure.artifact.elidedRange;

  assert.ok(range.startLine <= 11);
  assert.ok(range.endLine >= 90);
  assert.match(delivered.inline, new RegExp(`--start-line ${range.startLine} --end-line ${range.endLine}`));
  assert.ok(Buffer.byteLength(delivered.inline) <= 300);
});

test('final compaction preserves UTF-8 boundaries at both sides of the elision', () => {
  const content = `${'🙂'.repeat(100)}\n${'界'.repeat(100)}`;
  const sourceDigest = digest(content);
  const artifact = {
    content, bytes: Buffer.byteLength(content), sourceDigest,
    ref: `sando:${sourceDigest.slice(0, 'sha256:'.length + 16)}`,
  };
  const inline = `[sando] artifact .sando/sando/artifacts/${sourceDigest.slice('sha256:'.length)}.txt ${artifact.bytes}B\n${content}`;
  const delivered = finalizeResultDelivery({
    inline, artifact, stats: {},
    disclosure: { bytes: { visible: Buffer.byteLength(inline) }, markers: [], artifact: { digest: sourceDigest } },
  }, { inline, maxInlineBytes: 256 });

  assert.ok(Buffer.byteLength(delivered.inline) <= 256);
  assert.equal(delivered.inline.includes('\uFFFD'), false);
  assert.match(delivered.inline, /\[middle elided\]/);
});

test('artifact disclosure validates handle and complete redacted byte metadata', () => {
  const redactedText = 'safe output';
  const sourceDigest = digest(redactedText);
  assert.throws(() => buildResultDisclosure({
    toolName: 'Bash', route: 'artifact', reason: 'test', inline: 'preview', redactedText,
    artifact: { ref: 'sando:not-a-digest', sourceDigest, bytes: Buffer.byteLength(redactedText) },
  }), /artifact/i);
  assert.throws(() => buildResultDisclosure({
    toolName: 'Bash', route: 'artifact', reason: 'test', inline: 'preview', redactedText,
    artifact: { ref: `sando:${sourceDigest}`, sourceDigest, bytes: Buffer.byteLength(redactedText), content: 'different' },
  }), /artifact/i);
});

test('result disclosure exposes a bounded preview contract and recovers the redacted artifact', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-result-disclosure-'));
  try {
    const output = `Authorization: Bearer fixture-secret\n${'noise\n'.repeat(80)}TAIL-FACT`;
    const result = optimizeToolOutput({
      toolName: 'Bash', output, cwd,
      policy: { maxInlineBytes: 128, maxArtifactBytes: 8_192, redact: true },
    });
    const redacted = `Authorization: Bearer [REDACTED]\n${'noise\n'.repeat(80)}TAIL-FACT`;
    const disclosure = result.disclosure;

    assert.equal(disclosure.schema, RESULT_DISCLOSURE_SCHEMA);
    assert.equal(disclosure.type, 'bash');
    assert.deepEqual(disclosure.bytes, {
      original: Buffer.byteLength(output),
      redacted: Buffer.byteLength(redacted),
      visible: Buffer.byteLength(result.inline),
    });
    assert.equal(disclosure.provenanceDigest, digest(redacted));
    assert.deepEqual(disclosure.redaction, {
      count: 1, scope: 'display', sourceModifiedBySando: false,
    });
    assert.equal(disclosure.artifact.handle, result.artifact.ref);
    assert.ok(disclosure.markers.includes('artifact-handle'));
    assert.doesNotMatch(JSON.stringify(disclosure), /fixture-secret|TAIL-FACT/);

    const artifactPath = path.join(cwd, '.sando', 'sando', 'artifacts', `${digest(redacted).slice('sha256:'.length)}.txt`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, redacted);
    const full = recoverArtifactFromWorkspace({ cwd, ref: result.artifact.ref, maxBytes: 8_192 });
    assert.equal(full.digest, result.artifact.digest);
    assert.equal(full.content, redacted);
    const line = recoverArtifactFromWorkspace({ cwd, ref: result.artifact.ref, startLine: 2, endLine: 2, maxBytes: 64 });
    assert.equal(line.content, 'noise');
    assert.equal(line.truncated, false);
    const cli = spawnSync(process.execPath, [
      path.resolve(import.meta.dirname, '../src/artifact-cli.mjs'), 'artifact', 'get',
      '--root', cwd, '--ref', result.artifact.ref, '--start-line', '2', '--end-line', '2', '--json',
    ], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).content, 'noise');
    assert.deepEqual(JSON.parse(cli.stdout).disclosure, {
      scope: 'artifact-view', sourceSanitization: 'not-certified',
    });
    for (const launcher of [
      'plugins/sando/bin/sando',
      'adapters/codex/sando/bin/sando',
      'adapters/claude/sando/artifact.mjs',
    ]) {
      const moduleLauncher = launcher.endsWith('.mjs');
      const command = moduleLauncher ? process.execPath : path.join(REPOSITORY_ROOT, launcher);
      const args = moduleLauncher
        ? [path.join(REPOSITORY_ROOT, launcher), 'artifact', 'get']
        : ['artifact', 'get'];
      args.push('--root', cwd, '--ref', result.artifact.ref, '--start-line', '2', '--end-line', '2', '--json');
      const launched = spawnSync(command, args, {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: { ...process.env, SANDO_POLICY: '{invalid' },
      });
      assert.equal(launched.status, 0, `${launcher}: ${launched.stderr}`);
      const launchedReport = JSON.parse(launched.stdout);
      assert.equal(launchedReport.content, 'noise');
      assert.deepEqual(launchedReport.disclosure, {
        scope: 'artifact-view', sourceSanitization: 'not-certified',
      });
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('standalone artifact recovery keeps content exact and discloses source uncertainty', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-artifact-view-'));
  try {
    const content = 'historical [REDACTED] artifact';
    const sourceDigest = digest(content);
    const ref = `sando:${sourceDigest}`;
    const artifactPath = path.join(cwd, '.sando', 'sando', 'artifacts', `${sourceDigest.slice('sha256:'.length)}.txt`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, content);

    const json = spawnSync(process.execPath, [
      path.resolve(import.meta.dirname, '../src/artifact-cli.mjs'), 'artifact', 'get',
      '--root', cwd, '--ref', ref, '--json',
    ], { encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout).disclosure, {
      scope: 'artifact-view', sourceSanitization: 'not-certified',
    });
    assert.equal(JSON.parse(json.stdout).content, content);

    const text = spawnSync(process.execPath, [
      path.resolve(import.meta.dirname, '../src/artifact-cli.mjs'), 'artifact', 'get',
      '--root', cwd, '--ref', ref,
    ], { encoding: 'utf8' });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /\[sando\] artifact view; source-file sanitization is not certified\n$/);
    assert.equal((text.stdout.match(/source-file sanitization is not certified/g) ?? []).length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('artifact recovery rejects inconsistent source byte metadata', () => {
  const content = 'recoverable output';
  const ref = `sando:${digest(content)}`;
  assert.throws(() => recoverArtifactContent({
    ref, content, digest: digest(content), sourceBytes: 1,
  }), /sourceBytes|artifact/i);
});

test('artifact line recovery rejects ranges beyond EOF', () => {
  const content = 'first\nsecond';
  const ref = `sando:${digest(content)}`;
  assert.throws(() => recoverArtifactContent({ ref, content, startLine: 3, endLine: 3 }), /line range/i);
  assert.throws(() => recoverArtifactContent({ ref, content, startLine: 2, endLine: 3 }), /line range/i);
});

test('MCP artifact recovery validates handles and keeps byte and line modes separate', () => {
  const content = 'first\nsecond\nthird';
  const sourceDigest = digest(content);
  const ref = `sando:${sourceDigest}`;
  rememberArtifact({ ref, content, sourceDigest, sourceBytes: Buffer.byteLength(content) });

  assert.equal(recoverStoredArtifact({ ref, startByte: 0, endByte: 5 }).content, 'first');
  assert.equal(recoverStoredArtifact({ ref, startLine: 2, endLine: 2 }).content, 'second');
  assert.throws(() => recoverStoredArtifact({ ref, startByte: 0, startLine: 1 }), /ambiguous/i);
  assert.throws(() => recoverStoredArtifact({ ref, maxBytes: 0 }), /maxBytes/i);
  assert.throws(() => recoverStoredArtifact({ ref: '/tmp/.sando/sando/artifacts/file.txt' }), /invalid/i);
  assert.throws(() => recoverStoredArtifact({ ref: 'sando:sha256:0123456789abcdef' }), /unavailable in this MCP session/i);
});

test('artifact recovery rejects a tampered handle and bounds byte ranges', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-result-recovery-'));
  try {
    const content = '0123456789'.repeat(20);
    const ref = digest(content);
    const artifactPath = path.join(cwd, '.sando', 'sando', 'artifacts', `${ref.slice('sha256:'.length)}.txt`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, content);
    const bounded = recoverArtifactFromWorkspace({ cwd, ref: `sando:${ref}`, startByte: 10, endByte: 30, maxBytes: 8 });
    assert.equal(bounded.content, '01234567');
    assert.equal(bounded.truncated, true);
    fs.writeFileSync(artifactPath, 'tampered');
    assert.throws(() => recoverArtifactFromWorkspace({ cwd, ref: `sando:${ref}` }), /digest|integrity/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('artifact cleanup expires safe artifacts and respects a byte bound', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-artifact-cleanup-'));
  const directory = path.join(cwd, 'artifacts');
  fs.mkdirSync(directory);
  const old = path.join(directory, `${'a'.repeat(64)}.txt`);
  const fresh = path.join(directory, `${'b'.repeat(64)}.txt`);
  const overflow = path.join(directory, `${'c'.repeat(64)}.txt`);
  fs.writeFileSync(old, 'old');
  fs.writeFileSync(fresh, 'fresh');
  fs.writeFileSync(overflow, 'keep');
  const now = 2_000_000;
  fs.utimesSync(old, 1_000, 1_000);
  fs.utimesSync(fresh, 1_999_000, 1_999_000);
  fs.utimesSync(overflow, 1_998_000, 1_998_000);
  const report = cleanupArtifacts(directory, { now, ttlMs: 100_000, maxBytes: 5 });
  assert.equal(report.removed, 2);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(overflow), false);
});

test('artifact cleanup never removes unresolved or symlink targets', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-artifact-cleanup-safe-'));
  const directory = path.join(cwd, 'artifacts');
  fs.mkdirSync(directory);
  const target = path.join(cwd, 'outside.txt');
  const link = path.join(directory, `${'c'.repeat(64)}.txt`);
  fs.writeFileSync(target, 'outside');
  fs.symlinkSync(target, link);
  const report = cleanupArtifacts(directory, { now: 2_000_000, ttlMs: 0, maxBytes: 0 });
  assert.equal(report.removed, 0);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('artifact cleanup preserves the new artifact when timestamps tie', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-artifact-preserve-'));
  const directory = path.join(cwd, 'artifacts');
  fs.mkdirSync(directory);
  const old = `${'f'.repeat(64)}.txt`;
  const fresh = `${'0'.repeat(64)}.txt`;
  fs.writeFileSync(path.join(directory, old), 'old');
  fs.writeFileSync(path.join(directory, fresh), 'new');
  fs.utimesSync(path.join(directory, old), 1000, 1000);
  fs.utimesSync(path.join(directory, fresh), 1000, 1000);

  cleanupArtifacts(directory, { now: 1000, ttlMs: 10_000, maxBytes: 3, preserveName: fresh });

  assert.equal(fs.existsSync(path.join(directory, old)), false);
  assert.equal(fs.readFileSync(path.join(directory, fresh), 'utf8'), 'new');
});

test('artifact range exclusivity is enforced by the handler, not only by the schema', () => {
  const content = 'alpha\nbeta\ngamma';
  const ref = `sando:${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
  const handle = `sando:sha256:${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;

  assert.throws(
    () => recoverArtifactContent({ ref: handle, content, startByte: 0, startLine: 1 }),
    /artifact range is ambiguous/,
  );
  assert.equal(recoverArtifactContent({ ref: handle, content, startLine: 2, endLine: 2 }).content, 'beta');
  assert.equal(recoverArtifactContent({ ref: handle, content, startByte: 0, endByte: 5 }).content, 'alpha');
  assert.ok(ref);
});
