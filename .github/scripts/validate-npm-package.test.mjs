import assert from 'node:assert/strict';
import test from 'node:test';
import { validateNpmPack } from './validate-npm-package.mjs';

function packed(files, name = 'sandoichi') {
  return [{ name, version: '0.7.1', files: files.map((path) => ({ path })) }];
}

test('accepts the public Sando npm package file allowlist', () => {
  assert.equal(validateNpmPack(packed([
    'LICENSE', 'README.md', 'index.mjs', 'package.json', 'src/core.mjs', 'pricing/default.json',
  ])), 6);
});

test('rejects files outside the public package allowlist', () => {
  assert.throws(() => validateNpmPack(packed(['README.md', 'docs/internal.md'])), /Unexpected npm package files/);
});

test('rejects forbidden canary, instruction, and F2 files', () => {
  for (const path of ['src/canary.mjs', 'src/instruction-plan.mjs', 'src/f2-telemetry.mjs']) {
    assert.throws(() => validateNpmPack(packed([path])), /Unexpected npm package files/);
  }
});

test('rejects an invalid or ambiguous npm pack result', () => {
  assert.throws(() => validateNpmPack([]), /expected one sandoichi package/);
  assert.throws(() => validateNpmPack([...packed(['README.md']), ...packed(['README.md'])]), /expected one sandoichi package/);
  assert.throws(() => validateNpmPack(packed(['README.md'], 'another-package')), /expected one sandoichi package/);
  assert.throws(() => validateNpmPack([{ name: 'sandoichi', files: [null] }]), /Unexpected npm package files/);
});
