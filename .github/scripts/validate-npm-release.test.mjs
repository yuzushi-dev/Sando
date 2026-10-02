import assert from 'node:assert/strict';
import test from 'node:test';
import { validateNpmRelease } from './validate-npm-release.mjs';

test('accepts a stable tag matching the package version', () => {
  assert.equal(validateNpmRelease('v0.7.1', '0.7.1'), '0.7.1');
});

test('rejects a tag that does not match the package version', () => {
  assert.throws(() => validateNpmRelease('v0.7.2', '0.7.1'), /does not match package version/);
});

test('rejects prerelease tags', () => {
  assert.throws(() => validateNpmRelease('v0.7.1-jev.1', '0.7.1-jev.1'), /stable vX\.Y\.Z tag/);
});

test('rejects malformed or non-canonical tags', () => {
  assert.throws(() => validateNpmRelease('v01.7.1', '1.7.1'), /stable vX\.Y\.Z tag/);
  assert.throws(() => validateNpmRelease('0.7.1', '0.7.1'), /stable vX\.Y\.Z tag/);
});
