import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runPostinstall } from '../src/postinstall.mjs';
import { readTelemetryConfig } from '../src/telemetry.mjs';

// Mirrors defaultTelemetryConfigPath's own XDG_CONFIG_HOME/sando/telemetry.json
// layout, so the env passed to runPostinstall resolves to exactly this path.
function tempConfigPath() {
  const xdgConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-postinstall-'));
  return { xdgConfigHome, configPath: path.join(xdgConfigHome, 'sando', 'telemetry.json') };
}

function fakeStream({ isTTY }) {
  return { isTTY };
}

test('non-interactive install (no TTY) never prompts or writes a config', async () => {
  const { xdgConfigHome, configPath } = tempConfigPath();
  await runPostinstall({
    env: { XDG_CONFIG_HOME: xdgConfigHome },
    stdin: fakeStream({ isTTY: false }),
    stdout: fakeStream({ isTTY: true }),
  });
  assert.equal(fs.existsSync(configPath), false);
});

test('SANDO_SKIP_TELEMETRY_PROMPT short-circuits even with a real TTY', async () => {
  const { xdgConfigHome, configPath } = tempConfigPath();
  await runPostinstall({
    env: { SANDO_SKIP_TELEMETRY_PROMPT: '1', XDG_CONFIG_HOME: xdgConfigHome },
    stdin: fakeStream({ isTTY: true }),
    stdout: fakeStream({ isTTY: true }),
  });
  assert.equal(fs.existsSync(configPath), false);
});

test('interactive install with an explicit yes enables telemetry and records the config', async () => {
  const { xdgConfigHome, configPath } = tempConfigPath();
  const env = { XDG_CONFIG_HOME: xdgConfigHome };
  let written = '';
  const rl = { question: async () => 'yes', close: () => {} };
  await runPostinstall({
    env,
    stdin: fakeStream({ isTTY: true }),
    stdout: { ...fakeStream({ isTTY: true }), write: (chunk) => { written += chunk; } },
    readlineFactory: () => rl,
  });
  assert.match(written, /telemetry enabled/);
  assert.equal(readTelemetryConfig(configPath).enabled, true);
});

test('declined consent records the disabled marker, not a config write failure', async () => {
  const { xdgConfigHome, configPath } = tempConfigPath();
  const env = { XDG_CONFIG_HOME: xdgConfigHome };
  const rl = { question: async () => 'no', close: () => {} };
  await runPostinstall({
    env,
    stdin: fakeStream({ isTTY: true }),
    stdout: { ...fakeStream({ isTTY: true }), write: () => {} },
    readlineFactory: () => rl,
  });
  assert.equal(readTelemetryConfig(configPath).enabled, false);
  assert.equal(readTelemetryConfig(configPath).prompted_consent_version, 1);
});

test('a second run never re-prompts once already prompted', async () => {
  const { xdgConfigHome } = tempConfigPath();
  const env = { XDG_CONFIG_HOME: xdgConfigHome };
  let calls = 0;
  const rl = { question: async () => { calls += 1; return 'no'; }, close: () => {} };
  const opts = {
    env,
    stdin: fakeStream({ isTTY: true }),
    stdout: { ...fakeStream({ isTTY: true }), write: () => {} },
    readlineFactory: () => rl,
  };
  await runPostinstall(opts);
  await runPostinstall(opts);
  assert.equal(calls, 1);
});

test('a thrown error during the prompt is swallowed, not propagated', async () => {
  const { xdgConfigHome } = tempConfigPath();
  const env = { XDG_CONFIG_HOME: xdgConfigHome };
  const rl = { question: async () => { throw new Error('boom'); }, close: () => {} };
  await assert.doesNotReject(runPostinstall({
    env,
    stdin: fakeStream({ isTTY: true }),
    stdout: { ...fakeStream({ isTTY: true }), write: () => {} },
    readlineFactory: () => rl,
  }));
});
