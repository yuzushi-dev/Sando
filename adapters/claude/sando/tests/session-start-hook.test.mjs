import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const hook = path.join(root, 'hooks/session-start.mjs');

function run(env) {
  const result = spawnSync(process.execPath, [hook], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('never prompted: shows a one-line, non-blocking telemetry notice', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-session-start-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = run({ XDG_CONFIG_HOME: path.join(directory, '.config') });
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(typeof output.systemMessage, 'string');
  assert.equal(Object.hasOwn(output.hookSpecificOutput, 'systemMessage'), false);
  assert.match(output.systemMessage, /sando telemetry yes/);
  assert.match(output.systemMessage, /sando telemetry no/);
  assert.match(output.systemMessage, /TELEMETRY\.md/);
});

test('already answered (enabled): stays silent', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-session-start-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configDir = path.join(directory, '.config', 'sando');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'telemetry.json'), JSON.stringify({
    schema_version: 1, enabled: true, consent_state: 'enabled', prompted_consent_version: 1,
    consent_version: 1, consented_at: new Date().toISOString(), endpoint: 'https://example/v1/logs',
  }));
  const output = run({ XDG_CONFIG_HOME: path.join(directory, '.config') });
  assert.deepEqual(output, {});
});

test('already answered (declined): stays silent', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-session-start-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configDir = path.join(directory, '.config', 'sando');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'telemetry.json'), JSON.stringify({
    schema_version: 1, enabled: false, consent_state: 'declined', prompted_consent_version: 1,
  }));
  const output = run({ XDG_CONFIG_HOME: path.join(directory, '.config') });
  assert.deepEqual(output, {});
});

test('a corrupt config file never crashes the hook or blocks the session', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-session-start-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configDir = path.join(directory, '.config', 'sando');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'telemetry.json'), 'not json');
  const output = run({ XDG_CONFIG_HOME: path.join(directory, '.config') });
  assert.deepEqual(output, {});
});

test('DO_NOT_TRACK suppresses the first-use telemetry notice', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-session-start-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = run({ XDG_CONFIG_HOME: path.join(directory, '.config'), DO_NOT_TRACK: '1' });
  assert.deepEqual(output, {});
});
