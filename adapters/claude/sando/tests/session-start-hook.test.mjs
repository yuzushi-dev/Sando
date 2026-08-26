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
  assert.match(output.hookSpecificOutput.systemMessage, /telemetry-cli\.mjs" enable/);
  assert.match(output.hookSpecificOutput.systemMessage, /TELEMETRY\.md/);
});

test('already answered (enabled): stays silent', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-session-start-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configDir = path.join(directory, '.config', 'sando');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'telemetry.json'), JSON.stringify({
    schema_version: 1, enabled: true, prompted_consent_version: 1,
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
    schema_version: 1, enabled: false, prompted_consent_version: 1,
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
