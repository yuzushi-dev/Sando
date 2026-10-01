import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { readTelemetryConfig } from '../src/telemetry.mjs';
import { readMetrics } from '../src/metrics.mjs';
import { PLUGIN_VERSION } from '../src/version.mjs';

const HOOK_CLI_PATH = fileURLToPath(new URL('../src/hook-cli.mjs', import.meta.url));

function runnerScript(dir) {
  const scriptPath = path.join(dir, 'run.mjs');
  fs.writeFileSync(scriptPath, `
    import { runHookCli } from ${JSON.stringify(HOOK_CLI_PATH)};
    runHookCli({ host: process.env.SANDO_TEST_HOST, env: process.env });
  `);
  return scriptPath;
}

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-hook-cli-'));
  return {
    dir,
    env: {
      PATH: process.env.PATH,
      XDG_CONFIG_HOME: path.join(dir, 'config'),
      XDG_STATE_HOME: path.join(dir, 'state'),
    },
    configPath: path.join(dir, 'config', 'sando', 'telemetry.json'),
    countersPath: path.join(dir, 'state', 'sando', 'telemetry-counters.json'),
  };
}

function enableTelemetry(configPath) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    schema_version: 1, enabled: true, prompted_consent_version: 1, consent_version: 1,
    consented_at: '2026-08-25T00:00:00.000Z', endpoint: 'http://127.0.0.1:1/v1/logs',
  }));
}

function readCounters(countersPath) {
  return JSON.parse(fs.readFileSync(countersPath, 'utf8')).counters;
}

function firstCounter(countersPath) {
  const counters = readCounters(countersPath);
  const values = Object.values(counters);
  assert.equal(values.length, 1, 'expected exactly one counter bucket');
  return values[0];
}

test('telemetry disabled by default: no counters file is created', () => {
  const { dir, env } = tempEnv();
  const script = runnerScript(dir);
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_response: 'some tool output that is not secret', cwd: dir,
  });
  execFileSync(process.execPath, [script], { input, env: { ...env, SANDO_TEST_HOST: 'claude' } });
  assert.equal(fs.existsSync(path.join(dir, 'state', 'sando', 'telemetry-counters.json')), false);
});

test('Claude leaves external MCP output unchanged', () => {
  const { dir, env } = tempEnv();
  const script = runnerScript(dir);
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__claude_ai_Atlassian__getConfluencePage',
    tool_response: 'x'.repeat(20_000),
    cwd: dir,
  });
  const output = execFileSync(process.execPath, [script], {
    input,
    env: { ...env, SANDO_TEST_HOST: 'claude', SANDO_MODE: 'apply' },
  });

  assert.deepEqual(JSON.parse(output), {});
  assert.equal(fs.existsSync(path.join(dir, '.sando')), false);
});

test('Claude apply output carries the display-only redaction notice with tracking disabled', () => {
  const { dir, env } = tempEnv();
  const script = runnerScript(dir);
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_response: 'password=hook-secret', cwd: dir,
  });
  const output = execFileSync(process.execPath, [script], {
    input,
    env: { ...env, SANDO_TEST_HOST: 'claude', SANDO_MODE: 'apply', DO_NOT_TRACK: '1' },
  });
  const updated = JSON.parse(output).hookSpecificOutput.updatedToolOutput;

  assert.doesNotMatch(updated, /hook-secret/);
  assert.match(updated, /\[sando\] display redacted; Sando did not sanitize source files$/);
  assert.equal((updated.match(/\[sando\] display redacted/g) ?? []).length, 1);
});

test('Claude receipts and metrics account for the final materialized delivery', () => {
  const { dir, env } = tempEnv();
  const script = runnerScript(dir);
  const metricsPath = path.join(dir, 'metrics.json');
  const policy = { mode: 'apply', maxInlineBytes: 256, maxArtifactBytes: 4_096, redact: true };
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse', event_id: 'final-delivery', tool_name: 'Read',
    tool_input: { file_path: 'fixture.txt' },
    tool_response: `password=hook-secret\n${'middle\n'.repeat(100)}tail\n`, cwd: dir,
  });
  const output = execFileSync(process.execPath, [script], {
    input,
    env: {
      ...env, SANDO_TEST_HOST: 'claude', DO_NOT_TRACK: '1',
      SANDO_POLICY: JSON.stringify(policy), SANDO_METRICS_PATH: metricsPath,
    },
  });
  const delivered = JSON.parse(output).hookSpecificOutput.updatedToolOutput;
  const [record] = readMetrics(metricsPath).records;

  assert.ok(Buffer.byteLength(delivered) <= policy.maxInlineBytes);
  assert.doesNotMatch(delivered, /hook-secret/);
  assert.match(delivered, /\[sando\] display redacted; Sando did not sanitize source files$/);
  assert.equal(record.estimatedInlineTokens, Math.ceil(Buffer.byteLength(delivered) / 4));
});

test('Claude structured stdout and stderr disclose each transformed textual field', () => {
  const { dir, env } = tempEnv();
  const script = runnerScript(dir);
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: dir,
    tool_response: {
      stdout: 'api_key=stdout-secret',
      stderr: 'password=stderr-secret',
      interrupted: false,
    },
  });
  const output = execFileSync(process.execPath, [script], {
    input,
    env: { ...env, SANDO_TEST_HOST: 'claude', SANDO_MODE: 'apply', DO_NOT_TRACK: '1' },
  });
  const updated = JSON.parse(output).hookSpecificOutput.updatedToolOutput;

  for (const [field, secret] of [['stdout', 'stdout-secret'], ['stderr', 'stderr-secret']]) {
    assert.doesNotMatch(updated[field], new RegExp(secret));
    assert.match(updated[field], /\[sando\] display redacted; Sando did not sanitize source files$/);
    assert.equal((updated[field].match(/\[sando\] display redacted/g) ?? []).length, 1);
  }
  assert.equal(updated.interrupted, false);
});

test('Claude structured extra string fields are redacted with one disclosure', () => {
  const { dir, env } = tempEnv();
  const script = runnerScript(dir);
  const extraToken = ['sk', 'abcdefghijklmnop'].join('-');
  const nestedValue = ['nested', 'value'].join('-');
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: dir,
    tool_response: {
      stdout: 'safe stdout', stderr: '',
      summary: `token=${extraToken}`,
      nested: { detail: `password=${nestedValue}` },
    },
  });
  const output = execFileSync(process.execPath, [script], {
    input,
    env: { ...env, SANDO_TEST_HOST: 'claude', SANDO_MODE: 'apply', DO_NOT_TRACK: '1' },
  });
  const updated = JSON.parse(output).hookSpecificOutput.updatedToolOutput;

  // Extra fields are redacted through redactStructured and the disclosure is appended once, to stdout.
  assert.match(updated.stdout, /^safe stdout\n\[sando\] display redacted; Sando did not sanitize source files$/);
  assert.equal(JSON.stringify(updated).includes(extraToken), false);
  assert.equal(JSON.stringify(updated).includes(nestedValue), false);
  assert.equal(JSON.stringify(updated).split('display redacted').length - 1, 1);
});

test('Codex fallback discloses that its prepared redacted display did not sanitize source files', () => {
  const { dir, env } = tempEnv();
  const script = runnerScript(dir);
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_response: 'password=codex-secret', cwd: dir,
  });
  const output = execFileSync(process.execPath, [script], {
    input,
    env: {
      ...env, SANDO_TEST_HOST: 'codex', SANDO_MODE: 'apply',
      SANDO_CODEX_FALLBACK: 'feedback', DO_NOT_TRACK: '1',
    },
  });
  const fallback = JSON.parse(output);

  assert.equal(fallback.continue, false);
  assert.match(fallback.systemMessage, /\[sando\] display redacted; Sando did not sanitize source files$/);
  assert.doesNotMatch(JSON.stringify(fallback), /codex-secret/);
});

test('enabled telemetry counts a tool call with a redaction', () => {
  const { dir, env, configPath, countersPath } = tempEnv();
  enableTelemetry(configPath);
  const script = runnerScript(dir);
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_response: 'token AKIAABCDEFGHIJKLMNOP is present', cwd: dir,
  });
  execFileSync(process.execPath, [script], {
    input, env: { ...env, SANDO_TEST_HOST: 'claude', SANDO_MODE: 'apply' },
  });
  const counter = firstCounter(countersPath);
  assert.equal(counter.event, 'hook_summary');
  assert.equal(counter.host, 'claude');
  assert.equal(counter.mode, 'enforce');
  assert.equal(counter.toolCalls, 1);
  assert.ok(counter.redactions >= 1);
});

test('observe mode maps to the observe telemetry bucket', () => {
  const { dir, env, configPath, countersPath } = tempEnv();
  enableTelemetry(configPath);
  const script = runnerScript(dir);
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: 'plain output', cwd: dir,
  });
  execFileSync(process.execPath, [script], {
    input, env: { ...env, SANDO_TEST_HOST: 'claude', SANDO_MODE: 'observe' },
  });
  const counter = firstCounter(countersPath);
  assert.equal(counter.mode, 'observe');
  assert.equal(counter.redactions, 0);
});

test('dry-run mode maps to the dry_run telemetry bucket', () => {
  const { dir, env, configPath, countersPath } = tempEnv();
  enableTelemetry(configPath);
  const script = runnerScript(dir);
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: 'plain output', cwd: dir,
  });
  execFileSync(process.execPath, [script], {
    input, env: { ...env, SANDO_TEST_HOST: 'claude', SANDO_MODE: 'dry-run' },
  });
  assert.equal(firstCounter(countersPath).mode, 'dry_run');
});

test('invalid hook input records an input failure summary without raw error data', () => {
  const { dir, env, configPath, countersPath } = tempEnv();
  enableTelemetry(configPath);
  const script = runnerScript(dir);
  execFileSync(process.execPath, [script], {
    input: '{', env: { ...env, SANDO_TEST_HOST: 'claude' },
  });
  const state = JSON.parse(fs.readFileSync(countersPath, 'utf8'));
  assert.deepEqual(Object.values(state.counters), [{
    day: Object.values(state.counters)[0].day, pluginVersion: PLUGIN_VERSION,
    event: 'hook_failure_summary', host: 'claude', failureStage: 'input', count: 1,
  }]);
});

test('a large output that gets artifacted increments cappedOutputs', () => {
  const { dir, env, configPath, countersPath } = tempEnv();
  enableTelemetry(configPath);
  const script = runnerScript(dir);
  const bigOutput = 'x'.repeat(200_000);
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: bigOutput, cwd: dir,
  });
  execFileSync(process.execPath, [script], {
    input, env: { ...env, SANDO_TEST_HOST: 'claude', SANDO_MODE: 'apply' },
  });
  const counter = firstCounter(countersPath);
  assert.equal(counter.cappedOutputs, 1);
  assert.ok(counter.bytesSaved > 0);
  assert.ok(counter.inputTokensSaved > 0);
});

test('invalid hook policy records a policy failure summary', () => {
  const { dir, env, configPath, countersPath } = tempEnv();
  enableTelemetry(configPath);
  const script = runnerScript(dir);
  assert.throws(() => execFileSync(process.execPath, [script], {
    input: '{}', env: { ...env, SANDO_TEST_HOST: 'claude', SANDO_POLICY: '{' }, stderr: 'ignore',
  }));
  const state = JSON.parse(fs.readFileSync(countersPath, 'utf8'));
  assert.equal(Object.values(state.counters)[0].failureStage, 'policy');
});

test('telemetry failure never changes the hook exit code or stdout contract', () => {
  const { dir, env, configPath, countersPath } = tempEnv();
  enableTelemetry(configPath);
  fs.mkdirSync(path.dirname(countersPath), { recursive: true });
  fs.mkdirSync(countersPath, { recursive: true }); // a directory where a file is expected: forces a write failure
  const script = runnerScript(dir);
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: 'plain output', cwd: dir,
  });
  const out = execFileSync(process.execPath, [script], {
    input, env: { ...env, SANDO_TEST_HOST: 'claude', SANDO_MODE: 'apply' },
  });
  assert.doesNotThrow(() => JSON.parse(out.toString('utf8')));
});

test('a non-PostToolUse event never writes telemetry counters', () => {
  const { dir, env, configPath, countersPath } = tempEnv();
  enableTelemetry(configPath);
  const script = runnerScript(dir);
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_response: 'x', cwd: dir });
  execFileSync(process.execPath, [script], { input, env: { ...env, SANDO_TEST_HOST: 'claude' } });
  assert.equal(fs.existsSync(countersPath), false);
});

test('DO_NOT_TRACK prevents hook telemetry despite enabled config', () => {
  const { dir, env, configPath, countersPath } = tempEnv();
  enableTelemetry(configPath);
  const script = runnerScript(dir);
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: 'plain output', cwd: dir,
  });
  execFileSync(process.execPath, [script], {
    input, env: { ...env, SANDO_TEST_HOST: 'claude', DO_NOT_TRACK: '1' },
  });
  assert.equal(fs.existsSync(countersPath), false);
});
