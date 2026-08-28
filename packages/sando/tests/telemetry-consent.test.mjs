import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { runSessionStart } from '../src/session-start.mjs';
import { runUserPromptSubmit } from '../src/user-prompt-submit.mjs';
import {
  CONSENT_VERSION, enableTelemetry, readTelemetryConfig,
} from '../src/telemetry.mjs';

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-consent-'));
  const env = { XDG_CONFIG_HOME: path.join(directory, 'config') };
  const configPath = path.join(env.XDG_CONFIG_HOME, 'sando', 'telemetry.json');
  const statePaths = {
    counters: path.join(directory, 'state', 'telemetry-counters.json'),
    queue: path.join(directory, 'state', 'telemetry-queue.jsonl'),
  };
  let output = '';
  return {
    directory, env, configPath, statePaths,
    stdout: { write: (chunk) => { output += chunk; } },
    output: () => output,
  };
}

test('SessionStart stores asked before emitting a top-level systemMessage', () => {
  const h = harness();
  runSessionStart({ env: h.env, configPath: h.configPath, statePaths: h.statePaths, stdout: h.stdout, rootEnv: 'PLUGIN_ROOT' });

  const payload = JSON.parse(h.output());
  assert.equal(typeof payload.systemMessage, 'string');
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(Object.hasOwn(payload.hookSpecificOutput, 'systemMessage'), false);
  assert.match(payload.systemMessage, /sando telemetry yes/);
  assert.match(payload.systemMessage, /sando telemetry no/);
  assert.equal(readTelemetryConfig(h.configPath).consent_state, 'asked');
  assert.equal(readTelemetryConfig(h.configPath).prompted_consent_version, CONSENT_VERSION);
});

test('SessionStart emits no question when the asked transition cannot be persisted', () => {
  const h = harness();
  const blocker = path.join(h.directory, 'not-a-directory');
  fs.writeFileSync(blocker, 'block');
  const output = [];
  runSessionStart({
    env: h.env,
    configPath: path.join(blocker, 'telemetry.json'),
    statePaths: h.statePaths,
    stdout: { write: (chunk) => output.push(chunk) },
  });
  assert.deepEqual(JSON.parse(output.join('')), {});
});

test('consent normalization accepts y/yes and n/no case-insensitively', () => {
  for (const answer of ['y', 'yes', 'Y', 'YES']) {
    const h = harness();
    const result = enableTelemetry({ configPath: h.configPath, answer, interactive: true });
    assert.equal(result.enabled, true, answer);
    assert.equal(readTelemetryConfig(h.configPath).consent_state, 'enabled', answer);
  }
  for (const answer of ['n', 'no', 'N', 'NO']) {
    const h = harness();
    const result = enableTelemetry({ configPath: h.configPath, answer, interactive: true });
    assert.equal(result.enabled, false, answer);
    assert.equal(readTelemetryConfig(h.configPath).consent_state, 'declined', answer);
  }
});

test('blank or ambiguous consent stays off without recording a decline', () => {
  for (const answer of ['', 'maybe', undefined]) {
    const h = harness();
    const result = enableTelemetry({ configPath: h.configPath, answer, interactive: true });
    assert.equal(result.enabled, false, String(answer));
    assert.equal(readTelemetryConfig(h.configPath).consent_state, 'asked', String(answer));
  }
});

test('legacy disabled consent markers remain recoverable as asked', () => {
  const h = harness();
  fs.mkdirSync(path.dirname(h.configPath), { recursive: true });
  fs.writeFileSync(h.configPath, JSON.stringify({ schema_version: 1, enabled: false, prompted_consent_version: 1 }));
  const output = [];
  runUserPromptSubmit({
    env: h.env,
    input: JSON.stringify({ prompt: 'sando telemetry yes' }),
    stdout: { write: (chunk) => output.push(chunk) },
  });
  assert.equal(readTelemetryConfig(h.configPath).enabled, true);
  assert.match(JSON.parse(output.join('')).systemMessage, /enabled/i);
});

test('an ambiguous answer leaves the one-time question answered but not declined', () => {
  const h = harness();
  enableTelemetry({ configPath: h.configPath, answer: 'maybe', interactive: true });
  const output = [];
  runSessionStart({ env: h.env, configPath: h.configPath, statePaths: h.statePaths, stdout: { write: (chunk) => output.push(chunk) } });
  assert.deepEqual(JSON.parse(output.join('')), {});
  assert.equal(readTelemetryConfig(h.configPath).consent_state, 'asked');
});

test('UserPromptSubmit accepts only the two exact chat commands and passes everything else through', () => {
  const h = harness();
  const output = [];
  runUserPromptSubmit({
    env: h.env,
    input: JSON.stringify({ prompt: 'sando telemetry yes please' }),
    stdout: { write: (chunk) => output.push(chunk) },
  });
  assert.deepEqual(JSON.parse(output.join('')), {});
  assert.equal(fs.existsSync(h.configPath), false);
});

test('UserPromptSubmit records an exact yes without blocking the prompt', () => {
  const h = harness();
  runSessionStart({ env: h.env, configPath: h.configPath, statePaths: h.statePaths, stdout: { write() {} } });
  const output = [];
  runUserPromptSubmit({
    env: h.env,
    input: JSON.stringify({ prompt: 'sando telemetry yes' }),
    stdout: { write: (chunk) => output.push(chunk) },
  });
  const payload = JSON.parse(output.join(''));
  assert.match(payload.systemMessage, /enabled/i);
  assert.equal(Object.hasOwn(payload, 'decision'), false);
  assert.equal(Object.hasOwn(payload, 'additionalContext'), false);
  assert.equal(readTelemetryConfig(h.configPath).consent_state, 'enabled');
});

test('UserPromptSubmit records an exact no as a decline', () => {
  const h = harness();
  runSessionStart({ env: h.env, configPath: h.configPath, statePaths: h.statePaths, stdout: { write() {} } });
  const output = [];
  runUserPromptSubmit({
    env: h.env,
    input: JSON.stringify({ prompt: 'sando telemetry no' }),
    stdout: { write: (chunk) => output.push(chunk) },
  });
  const payload = JSON.parse(output.join(''));
  assert.match(payload.systemMessage, /disabled/i);
  assert.equal(readTelemetryConfig(h.configPath).consent_state, 'declined');
});

test('UserPromptSubmit obeys DO_NOT_TRACK', () => {
  const h = harness();
  runSessionStart({ env: h.env, configPath: h.configPath, statePaths: h.statePaths, stdout: { write() {} } });
  const output = [];
  runUserPromptSubmit({
    env: { ...h.env, DO_NOT_TRACK: '1' },
    input: JSON.stringify({ prompt: 'sando telemetry no' }),
    stdout: { write: (chunk) => output.push(chunk) },
  });
  assert.deepEqual(JSON.parse(output.join('')), {});
  assert.equal(readTelemetryConfig(h.configPath).consent_state, 'asked');
});

test('installed Claude and plugin UserPromptSubmit wrappers preserve the fail-open contract', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  for (const bundle of ['adapters/claude/sando', 'plugins/sando']) {
    const h = harness();
    const environment = { ...process.env, ...h.env };
    const start = spawnSync(process.execPath, [path.join(root, bundle, 'hooks/session-start.mjs')], {
      encoding: 'utf8', env: environment,
    });
    assert.equal(start.status, 0, start.stderr);
    assert.equal(typeof JSON.parse(start.stdout).systemMessage, 'string');
    const response = spawnSync(process.execPath, [path.join(root, bundle, 'hooks/user-prompt-submit.mjs')], {
      input: JSON.stringify({ prompt: 'sando telemetry maybe' }), encoding: 'utf8', env: environment,
    });
    assert.equal(response.status, 0, response.stderr);
    assert.deepEqual(JSON.parse(response.stdout), {});
    assert.equal(readTelemetryConfig(h.configPath).consent_state, 'asked');
  }
});
