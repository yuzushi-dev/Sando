import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { persistHistoryArtifact } from '../src/history-archive.mjs';

function artifact(root, content) {
  const digest = createHash('sha256').update(content).digest('hex');
  return { root, content, bytes: Buffer.byteLength(content), digest: `sha256:${digest}`, ref: `sando:sha256:${digest}` };
}

test('persistHistoryArtifact rejects an existing symlink before reading or chmodding it', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-history-symlink-'));
  const root = path.join(fixture, 'workspace');
  const outside = path.join(fixture, 'outside.txt');
  try {
    fs.mkdirSync(root, { mode: 0o700 });
    const value = artifact(root, 'history fixture');
    const destination = path.join(root, '.sando', 'sando', 'artifacts', `${value.digest.slice('sha256:'.length)}.txt`);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outside, value.content, { mode: 0o644 });
    fs.chmodSync(outside, 0o644);
    fs.symlinkSync(outside, destination);

    assert.throws(() => persistHistoryArtifact(value), /unsafe|ELOOP|symbolic/i);
    assert.equal(fs.readFileSync(outside, 'utf8'), value.content);
    assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
