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

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');

function digest(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

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
      assert.equal(JSON.parse(launched.stdout).content, 'noise');
    }
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
