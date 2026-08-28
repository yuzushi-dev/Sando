import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../../..');
const bundles = [
  path.join(root, 'adapters/codex/sando'),
  path.join(root, 'plugins/sando'),
];

function run(hook, env) {
  const result = spawnSync(process.execPath, [hook], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const bundle of bundles) {
  test(`${path.basename(path.dirname(bundle))} Codex SessionStart shows the telemetry nudge`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-session-start-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = run(path.join(bundle, 'hooks/session-start.mjs'), {
      XDG_CONFIG_HOME: path.join(directory, '.config'),
    });
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(typeof output.systemMessage, 'string');
    assert.equal(Object.hasOwn(output.hookSpecificOutput, 'systemMessage'), false);
    assert.match(output.systemMessage, /sando telemetry yes/);
    assert.match(output.systemMessage, /sando telemetry no/);
    assert.match(output.systemMessage, /anonymous aggregate telemetry/);
  });

  test(`${path.basename(path.dirname(bundle))} Codex SessionStart stays silent after a decision`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-session-start-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configDir = path.join(directory, '.config', 'sando');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'telemetry.json'), JSON.stringify({
      schema_version: 1, enabled: false, consent_state: 'declined', prompted_consent_version: 1,
    }));
    const output = run(path.join(bundle, 'hooks/session-start.mjs'), {
      XDG_CONFIG_HOME: path.join(directory, '.config'),
    });
    assert.deepEqual(output, {});
  });
}
