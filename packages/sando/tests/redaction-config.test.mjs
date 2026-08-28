import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadProjectRedactionProfile } from '../src/redaction-config.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-redaction-config-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function writeConfig(cwd, value) {
  const configPath = path.join(cwd, '.sando', 'redaction.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, typeof value === 'string' ? value : JSON.stringify(value));
  return configPath;
}

test('missing config returns the built-in profile and does not search parents', (t) => {
  const parent = fixture(t);
  writeConfig(parent, { schema: 'sando-redaction/v1', rules: [] });
  const cwd = path.join(parent, 'child');
  fs.mkdirSync(cwd);

  const result = loadProjectRedactionProfile(cwd);

  assert.ok(result.profile);
  assert.equal(result.path, null);
});

test('valid config returns its compiled profile and absolute path', (t) => {
  const cwd = fixture(t);
  const configPath = writeConfig(cwd, {
    schema: 'sando-redaction/v1',
    rules: [{ type: 'assignment-key', key: 'session_code' }],
  });

  const result = loadProjectRedactionProfile(cwd);

  assert.equal(result.profile.redact('session_code=private').text, 'session_code=[REDACTED]');
  assert.equal(result.path, configPath);
});

test('malformed JSON is rejected', (t) => {
  const cwd = fixture(t);
  writeConfig(cwd, '{');

  assert.throws(() => loadProjectRedactionProfile(cwd), /JSON/i);
});

test('wrong schema is rejected', (t) => {
  const cwd = fixture(t);
  writeConfig(cwd, { schema: 'sando-redaction/v2', rules: [] });

  assert.throws(() => loadProjectRedactionProfile(cwd), /schema/i);
});

test('symlinks are rejected for both .sando and redaction.json', async (t) => {
  await t.test('.sando symlink', (t) => {
    const cwd = fixture(t);
    const target = fixture(t);
    writeConfig(target, { schema: 'sando-redaction/v1', rules: [] });
    fs.symlinkSync(path.join(target, '.sando'), path.join(cwd, '.sando'), 'dir');

    assert.throws(() => loadProjectRedactionProfile(cwd), /symlink/i);
  });

  await t.test('redaction.json symlink', (t) => {
    const cwd = fixture(t);
    const target = path.join(cwd, 'target.json');
    fs.mkdirSync(path.join(cwd, '.sando'));
    fs.writeFileSync(target, JSON.stringify({ schema: 'sando-redaction/v1', rules: [] }));
    fs.symlinkSync(target, path.join(cwd, '.sando', 'redaction.json'));

    assert.throws(() => loadProjectRedactionProfile(cwd), /symlink/i);
  });
});

test('a non-file redaction.json is rejected', (t) => {
  const cwd = fixture(t);
  fs.mkdirSync(path.join(cwd, '.sando', 'redaction.json'), { recursive: true });

  assert.throws(() => loadProjectRedactionProfile(cwd), /file/i);
});

test('config larger than 64 KiB is rejected', (t) => {
  const cwd = fixture(t);
  writeConfig(cwd, ' '.repeat(64 * 1024 + 1));

  assert.throws(() => loadProjectRedactionProfile(cwd), /64 KiB|too large/i);
});

test('invalid rules are rejected by the RedactionProfile', (t) => {
  const cwd = fixture(t);
  writeConfig(cwd, {
    schema: 'sando-redaction/v1',
    rules: [{ type: 'arbitrary-regex', pattern: '.*' }],
  });

  assert.throws(() => loadProjectRedactionProfile(cwd), /rule|type/i);
});

test('cache is reused for unchanged metadata and invalidated by size changes', (t) => {
  const cwd = fixture(t);
  writeConfig(cwd, { schema: 'sando-redaction/v1', rules: [] });

  const first = loadProjectRedactionProfile(cwd);
  const cached = loadProjectRedactionProfile(cwd);
  assert.strictEqual(cached.profile, first.profile);

  writeConfig(cwd, '{ "schema": "sando-redaction/v1", "rules": [] }\n');
  const invalidated = loadProjectRedactionProfile(cwd);
  assert.notStrictEqual(invalidated.profile, first.profile);
  assert.equal(invalidated.path, first.path);
});
