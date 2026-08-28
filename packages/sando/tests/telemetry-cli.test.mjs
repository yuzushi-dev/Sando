import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runTelemetryCli } from '../src/telemetry-cli.mjs';
import { readTelemetryConfig } from '../src/telemetry.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sando-telemetry-cli-'));
}

function harness(overrides = {}) {
  const dir = tempDir();
  const configPath = path.join(dir, 'telemetry.json');
  const stateDir = path.join(dir, 'state');
  const statePaths = { counters: path.join(stateDir, 'telemetry-counters.json'), queue: path.join(stateDir, 'telemetry-queue.jsonl') };
  let out = '';
  let err = '';
  return {
    configPath, statePaths,
    stdout: { write: (chunk) => { out += chunk; } },
    stderr: { write: (chunk) => { err += chunk; } },
    output: () => out,
    errorOutput: () => err,
    ...overrides,
  };
}

test('status reports disabled by default with no config file', async () => {
  const h = harness();
  const result = await runTelemetryCli({ argv: ['status'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr });
  assert.equal(result.enabled, false);
  assert.match(h.output(), /disabled/i);
});

test('interactive enable with an explicit yes enables telemetry', async () => {
  const h = harness();
  const result = await runTelemetryCli({
    argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: true, prompt: async () => 'yes',
  });
  assert.equal(result.enabled, true);
  assert.equal(readTelemetryConfig(h.configPath).enabled, true);
});

test('consent prompt links to the published telemetry disclosure', async () => {
  const h = harness();
  await runTelemetryCli({
    argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: true, prompt: async (message) => { h.stdout.write(message); return 'no'; },
  });
  assert.match(h.output(), /https:\/\/github\.com\/yuzushi-dev\/Sando\/blob\/main\/TELEMETRY\.md/);
});

test('enable points to the disclosure instead of printing it inline', async () => {
  const h = harness();
  await runTelemetryCli({
    argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: true, prompt: async (message) => { h.stdout.write(message); return 'no'; },
  });
  assert.match(h.output(), /TELEMETRY\.md/);
  assert.doesNotMatch(h.output(), /Retention:/);
});

test('ambiguous consent stays off without recording a decline', async () => {
  const h = harness();
  const result = await runTelemetryCli({
    argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: true, prompt: async () => '',
  });
  assert.equal(result.enabled, false);
  assert.equal(fs.existsSync(h.configPath), true);
  assert.equal(readTelemetryConfig(h.configPath).enabled, false);
  assert.equal(readTelemetryConfig(h.configPath).consent_state, 'asked');
});

test('an explicit CLI enable can resolve an unanswered consent state', async () => {
  const h = harness();
  await runTelemetryCli({
    argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: true, prompt: async () => 'maybe',
  });
  const result = await runTelemetryCli({
    argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: true, prompt: async () => 'yes',
  });
  assert.equal(result.enabled, true);
  assert.equal(readTelemetryConfig(h.configPath).consent_state, 'enabled');
});

test('declined consent ("no") writes the disabled marker', async () => {
  const h = harness();
  const result = await runTelemetryCli({
    argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: true, prompt: async () => 'no',
  });
  assert.equal(result.enabled, false);
});

test('a non-interactive context cannot enable telemetry even with an explicit yes', async () => {
  const h = harness();
  const result = await runTelemetryCli({
    argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: false, prompt: async () => 'yes',
  });
  assert.equal(result.enabled, false);
  assert.match(h.errorOutput(), /interactive/i);
});

test('non-interactive enable leaves an existing enabled config byte-for-byte unchanged and fails', async () => {
  const h = harness();
  await runTelemetryCli({
    argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: true, prompt: async () => 'yes',
  });
  const before = fs.readFileSync(h.configPath);
  const result = await runTelemetryCli({
    argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: false,
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(fs.readFileSync(h.configPath), before);
});

test('already enabled telemetry does not prompt or rewrite the config', async () => {
  const h = harness();
  await runTelemetryCli({
    argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: true, prompt: async () => 'yes',
  });
  const before = fs.readFileSync(h.configPath);
  let prompted = false;
  const result = await runTelemetryCli({
    argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: true, prompt: async () => { prompted = true; return ''; },
  });
  assert.equal(result.enabled, true);
  assert.equal(prompted, false);
  assert.match(h.output(), /already enabled/i);
  assert.deepEqual(fs.readFileSync(h.configPath), before);
});

test('DO_NOT_TRACK prevents enable without rewriting config', async () => {
  const h = harness();
  let prompted = false;
  const result = await runTelemetryCli({
    argv: ['enable'], env: { DO_NOT_TRACK: '1' }, configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: true, prompt: async () => { prompted = true; return 'yes'; },
  });
  assert.equal(prompted, false);
  assert.equal(result.enabled, false);
  assert.equal(fs.existsSync(h.configPath), false);
  assert.match(h.errorOutput(), /DO_NOT_TRACK/);
});

test('DO_NOT_TRACK prevents flush even when config is enabled', async () => {
  const h = harness();
  await runTelemetryCli({ argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr, interactive: true, prompt: async () => 'yes' });
  const result = await runTelemetryCli({
    argv: ['flush'], env: { DO_NOT_TRACK: '1' }, configPath: h.configPath, statePaths: h.statePaths,
    stdout: h.stdout, stderr: h.stderr,
  });
  assert.equal(result.sent, 0);
  assert.match(h.output(), /DO_NOT_TRACK/);
});

test('disable --purge removes counters and queue but keeps the disabled prompt marker', async () => {
  const h = harness();
  fs.mkdirSync(path.dirname(h.statePaths.counters), { recursive: true });
  fs.writeFileSync(h.statePaths.counters, '{}');
  fs.writeFileSync(h.statePaths.queue, '');
  await runTelemetryCli({
    argv: ['enable'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr,
    interactive: true, prompt: async () => 'yes',
  });
  const result = await runTelemetryCli({
    argv: ['disable', '--purge'], configPath: h.configPath, statePaths: h.statePaths, stdout: h.stdout, stderr: h.stderr,
  });
  assert.equal(result.enabled, false);
  assert.equal(fs.existsSync(h.statePaths.counters), false);
  assert.equal(fs.existsSync(h.statePaths.queue), false);
  assert.equal(readTelemetryConfig(h.configPath).prompted_consent_version, 1);
});

test('an invalid config file surfaces a clear error on status', async () => {
  const h = harness();
  fs.mkdirSync(path.dirname(h.configPath), { recursive: true });
  fs.writeFileSync(h.configPath, JSON.stringify({ schema_version: 1, enabled: 'yes' }));
  const result = await runTelemetryCli({ argv: ['status'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr });
  assert.equal(result, null);
  assert.match(h.errorOutput(), /invalid/i);
});

test('an unknown subcommand prints usage and does not throw', async () => {
  const h = harness();
  const result = await runTelemetryCli({ argv: ['bogus'], configPath: h.configPath, stdout: h.stdout, stderr: h.stderr });
  assert.equal(result, null);
  assert.match(h.output(), /Usage/);
});
