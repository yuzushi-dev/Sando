import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '..', 'cli.mjs');

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sando-cli-stdout-')));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, SANDO_MODE: 'apply' } });
}

// `cat f` is rewritten to `sando read -- f` on Codex, so stdout is read as the file's own
// content: the artifact disclosure must not occupy the first line. It still has to be on
// stdout, though, or the handle for recovering the elided middle never reaches the model.
test('read keeps the artifact disclosure off the first line and on the last', () => {
  const root = workspace();
  const lines = Array.from({ length: 4000 }, (_, index) => `line-${index}`);
  fs.writeFileSync(path.join(root, 'big.txt'), `${lines.join('\n')}\n`);

  const result = runCli(['read', '--', 'big.txt'], root);
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.split('\n');
  assert.equal(out[0], 'line-0');
  assert.equal(out.at(-1), '');
  // The line carries the recovery command as well as the handle: on this surface the structured
  // disclosure is never rendered, so the elided range has to travel on the line the model reads.
  // The command names the binary by absolute path -- `sando` is not on the model's PATH.
  assert.match(out.at(-2), /^\[sando\] artifact \.sando\/sando\/artifacts\/[0-9a-f]+\.txt \d+B recover: \S*\/bin\/sando artifact get --ref sando:sha256:[0-9a-f]+ --start-line \d+ --end-line \d+$/);
  assert.equal(out.filter((line) => line.startsWith('[sando] artifact ')).length, 1);
});

test('read without an artifact leaves stdout free of disclosure', () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'small.txt'), 'only-line\n');

  const result = runCli(['read', '--', 'small.txt'], root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('\n')[0], 'only-line');
  assert.doesNotMatch(result.stdout, /\[sando\] artifact /);
});
