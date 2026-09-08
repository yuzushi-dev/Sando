import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { persistArtifact } from '../lib/artifacts.mjs';

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
