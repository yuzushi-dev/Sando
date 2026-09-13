import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { persistArtifact } from '../lib/artifacts.mjs';
import { callMcpTool } from '../lib/mcp-tools.mjs';

function artifact(content) {
  const digest = createHash('sha256').update(content).digest('hex');
  return {
    content,
    sourceDigest: `sha256:${digest}`,
    ref: `sando:sha256:${digest}`,
    bytes: Buffer.byteLength(content),
  };
}

function artifactFile(cwd, value) {
  return path.join(cwd, '.sando', 'sando', 'artifacts', `${value.sourceDigest.slice('sha256:'.length)}.txt`);
}

test('persistArtifact cleans after a write and keeps the returned artifact', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-artifacts-write-'));
  try {
    const first = artifact('old');
    const second = artifact('new');
    persistArtifact(cwd, first, { cleanup: { maxBytes: 3 } });
    const firstPath = artifactFile(cwd, first);
    fs.utimesSync(firstPath, new Date(1_000), new Date(1_000));
    const ref = persistArtifact(cwd, second, { cleanup: { maxBytes: 3 } });

    assert.equal(ref, '.sando/sando/artifacts/' + second.sourceDigest.slice('sha256:'.length) + '.txt');
    assert.equal(fs.existsSync(artifactFile(cwd, first)), false);
    assert.equal(fs.readFileSync(artifactFile(cwd, second), 'utf8'), 'new');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('persistArtifact fails closed when the new artifact alone exceeds the cap', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-artifacts-oversize-'));
  try {
    const value = artifact('too-large');
    assert.throws(
      () => persistArtifact(cwd, value, { cleanup: { maxBytes: 3 } }),
      /artifact storage limit/i,
    );
    assert.equal(fs.existsSync(artifactFile(cwd, value)), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('MCP artifact recovery keeps the session handle contract', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-mcp-artifact-contract-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), `first\nsecond\nthird\n${'x'.repeat(300)}`);
  const prepared = callMcpTool('sando_read', {
    path: 'fixture.txt', cwd, policy: { maxInlineBytes: 64, maxArtifactBytes: 256 },
  });
  const ref = prepared.artifact.ref;
  assert.equal(callMcpTool('sando_artifact_get', { ref, startByte: 0, endByte: 5 }).content, 'first');
  assert.equal(callMcpTool('sando_artifact_get', { ref, startLine: 2, endLine: 2 }).content, 'second');
  assert.throws(() => callMcpTool('sando_artifact_get', { ref, startByte: 0, startLine: 1 }), /ambiguous/i);
  assert.throws(() => callMcpTool('sando_artifact_get', { ref, maxBytes: 0 }), /maxBytes/i);
  assert.throws(() => callMcpTool('sando_artifact_get', { ref: '/tmp/.sando/sando/artifacts/file.txt' }), /invalid/i);
  assert.throws(() => callMcpTool('sando_artifact_get', { ref: 'sando:sha256:0123456789abcdef' }), /unavailable in this MCP session/i);
});

test('G5: sando_read routes by source class, not by the default budget', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-source-class-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const line = `${'x'.repeat(120)}\n`;
  const bulk = line.repeat(600);
  fs.writeFileSync(path.join(cwd, 'sample.log'), bulk);
  fs.writeFileSync(path.join(cwd, 'sample.mjs'), bulk.slice(0, 20_000));

  // A .log is `bulk` (4 KB), not the 32 KB `source` fallback: the routing gates exercise
  // optimizeToolOutput directly, so only an end-to-end read catches a tool that forgets to
  // forward the path to the classifier.
  const log = callMcpTool('sando_read', { path: 'sample.log', cwd });
  assert.ok(log.inline.length <= 4 * 1024, `bulk inline ${log.inline.length} exceeds the 4 KB cap`);
  assert.match(log.inline, /\[middle elided\]/);

  // ...and a source file under 32 KB still arrives whole.
  const source = callMcpTool('sando_read', { path: 'sample.mjs', cwd });
  assert.equal(source.inline.includes('[middle elided]'), false);
  assert.ok(source.inline.length > 4 * 1024);
});
