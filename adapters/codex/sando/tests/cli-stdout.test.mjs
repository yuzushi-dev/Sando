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

function runCli(args, cwd, policy) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, SANDO_MODE: 'apply', ...(policy ? { SANDO_POLICY: JSON.stringify(policy) } : {}) },
  });
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
  assert.match(out.at(-2), /^\[sando\] artifact \.sando\/sando\/artifacts\/[0-9a-f]+\.txt \d+B For omitted content, use this bounded recovery call before repeated small reads; recover: \S*\/bin\/sando artifact get --ref sando:sha256:[0-9a-f]+ --start-line \d+ --end-line \d+$/);
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

test('read enforces the byte budget after artifact path materialization', () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'secret.txt'), `password=cli-secret\n${'middle\n'.repeat(100)}tail\n`);
  const policy = { mode: 'apply', maxInlineBytes: 256, maxArtifactBytes: 4_096, redact: true };

  const result = runCli(['read', '--', 'secret.txt'], root, policy);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout.trimEnd()) <= policy.maxInlineBytes, `${Buffer.byteLength(result.stdout.trimEnd())}B`);
  assert.doesNotMatch(result.stdout, /cli-secret/);
  assert.match(result.stdout, /\.sando\/sando\/artifacts\/[a-f0-9]{64}\.txt/);
  assert.match(result.stdout, /\[sando\] display redacted; Sando did not sanitize source files\n$/);
  assert.equal((result.stdout.match(/\[sando\] display redacted/g) ?? []).length, 1);
});

test('read fails safely when mandatory artifact metadata cannot fit the outer cap', () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'secret.txt'), `password=cli-secret\n${'middle\n'.repeat(100)}tail\n`);

  const result = runCli(['read', '--', 'secret.txt'], root, {
    mode: 'apply', maxInlineBytes: 64, maxArtifactBytes: 4_096, redact: true,
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /cli-secret/);
  assert.match(result.stderr, /cannot fit mandatory metadata within 64-byte output budget/);
});

test('exec preserves child status and side effects when the outer cap only fits a safe envelope', () => {
  const root = workspace();
  const script = "require('fs').writeFileSync('marker.txt', 'done'); process.stdout.write('password=' + 'x'.repeat(500)); process.exit(7)";
  const result = runCli(['exec', '--', process.execPath, '-e', script], root, {
    mode: 'apply', maxInlineBytes: 64, maxArtifactBytes: 4_096, redact: true,
  });

  assert.equal(result.status, 7, result.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'marker.txt'), 'utf8'), 'done');
  assert.match(result.stdout, /^\[sando\] output withheld/);
  assert.doesNotMatch(result.stdout, /password=|x{10}/);
});


test('log recovery hint retrieves the omitted range in one bounded call', () => {
  const root = workspace();
  const source = Array.from({ length: 720 }, (_, index) => `${String(index + 1).padStart(4, '0')} INFO ${'event '.repeat(12)}`).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'build.log'), source);
  const result = runCli(['read', '--', 'build.log'], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /For omitted content, use this bounded recovery call before repeated small reads; recover:/);
  assert.ok(Buffer.byteLength(result.stdout.trimEnd()) <= 4096);
  const hint = result.stdout.match(/recover: (.+) artifact get --ref (\S+) --start-line (\d+) --end-line (\d+)/);
  assert.ok(hint);
  assert.equal(hint[1], path.join(path.dirname(CLI), 'bin', 'sando'));
  const recovered = runCli(['artifact', 'get', '--ref', hint[2], '--start-line', hint[3], '--end-line', hint[4], '--json'], root);
  assert.equal(recovered.status, 0, recovered.stderr);
  const report = JSON.parse(recovered.stdout);
  assert.equal(report.truncated, false);
  assert.equal(report.content, source.split('\n').slice(Number(hint[3]) - 1, Number(hint[4])).join('\n'));
});
