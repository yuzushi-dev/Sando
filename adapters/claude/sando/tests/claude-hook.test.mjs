import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createReceipt, normalizeEvent, optimizeToolOutput } from '../lib/core.mjs';

const root = path.resolve(import.meta.dirname, '..');
const hook = path.join(root, 'hooks/post-tool-use.mjs');

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function runHook(input, cwd, policy, extraEnv = {}) {
  const metricsPath = path.join(cwd, 'metrics.json');
  const env = {
    ...process.env,
    SANDO_METRICS_PATH: metricsPath,
    ...extraEnv,
  };
  if (policy) env.SANDO_POLICY = JSON.stringify(policy);
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input), encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  return { output: JSON.parse(result.stdout), metrics: JSON.parse(fs.readFileSync(metricsPath, 'utf8')) };
}

test('Claude defaults to apply when no mode is configured', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-default-apply-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { output, metrics } = runHook({
    hook_event_name: 'PostToolUse', tool_name: 'Read', cwd,
    tool_response: `Authorization: Bearer fixture-secret\n${'x'.repeat(6000)}`,
  }, cwd);

  assert.equal(typeof output.hookSpecificOutput?.updatedToolOutput, 'string');
  assert.equal(metrics.records[0].estimatedTransformSavingsTokens > 0, true);
});

test('Claude PostToolUse applies structural Read routing and respects selectors', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-read-routing-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const output = [
    ...Array.from({ length: 70 }, (_, index) => `noise:${index}`),
    ...Array.from({ length: 10 }, (_, index) => `export const item${index} = ${index};`),
    ...Array.from({ length: 60 }, (_, index) => `tail:${index}`),
  ].join('\n');
  const summarized = runHook({
    hook_event_name: 'PostToolUse', tool_name: 'Read', cwd, tool_response: output,
  }, cwd, { mode: 'apply', maxInlineBytes: 512, maxArtifactBytes: 8192 });
  assert.match(summarized.output.hookSpecificOutput.updatedToolOutput, /sando read structure/);

  const selected = runHook({
    hook_event_name: 'PostToolUse', tool_name: 'Read', cwd,
    tool_input: { file_path: 'fixture.mjs', offset: 1, limit: 120 }, tool_response: output,
  }, cwd, { mode: 'apply', maxInlineBytes: 512, maxArtifactBytes: 8192 });
  assert.doesNotMatch(selected.output.hookSpecificOutput.updatedToolOutput, /sando read structure/);
});

test('observe-only guard never replaces Claude output', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-observe-only-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { output, metrics } = runHook({
    hook_event_name: 'PostToolUse', tool_name: 'Read', cwd,
    tool_response: `secret=hidden\n${'x'.repeat(600)}`,
  }, cwd, { mode: 'apply', maxInlineBytes: 128, redact: true }, { SANDO_OBSERVE_ONLY: '1' });

  assert.deepEqual(output, {});
  assert.equal(metrics.records[0].estimatedTransformSavingsTokens > 0, true);
});

test('Claude apply stays fail-open for structured output with non-text stdout', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-shape-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { output } = runHook({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd,
    tool_response: { stdout: 7, stderr: '', interrupted: false, isImage: false },
  }, cwd, { mode: 'apply' });
  assert.deepEqual(output, {});
});

test('Claude apply leaves unsupported structured output unchanged', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-unsupported-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { output } = runHook({
    hook_event_name: 'PostToolUse', tool_name: 'Read', cwd,
    tool_response: { content: [{ type: 'text', text: 'structured result' }] },
  }, cwd, { mode: 'apply' });
  assert.deepEqual(output, {});
});

test('Claude receipt hashes the exact structured replacement payload', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-receipt-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const input = {
    hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd, event_id: 'receipt-event',
    tool_response: {
      stdout: `Authorization: Bearer fixture-secret\n${'x'.repeat(220)}`,
      stderr: 'tail error', interrupted: false, isImage: false, extra: 'preserved',
    },
  };
  const policy = { mode: 'apply', maxInlineBytes: 128, maxArtifactBytes: 256, redact: true };
  const { output, metrics } = runHook(input, cwd, policy);
  const replacement = output.hookSpecificOutput.updatedToolOutput;
  assert.equal(replacement.extra, 'preserved');
  const event = normalizeEvent(input);
  const optimization = optimizeToolOutput({ toolName: event.toolName, output: event.output, cwd, policy });
  const receipt = createReceipt({ host: 'claude', event, optimization, replacement });

  assert.equal(receipt.inlineDigest, digest(stableJson(replacement)));
  assert.equal(metrics.records[0].receiptDigest, receipt.digest);
});

test('Claude apply redacts secrets in preserved structured string fields', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-structured-redaction-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { output } = runHook({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd,
    tool_response: {
      stdout: 'ok', stderr: '', interrupted: false, isImage: false,
      extra: 'password=fixture-extra-secret',
    },
  }, cwd, { mode: 'apply', maxInlineBytes: 128, redact: true });

  const replacement = output.hookSpecificOutput.updatedToolOutput;
  assert.equal(replacement.extra, 'password=[REDACTED]');
  assert.doesNotMatch(JSON.stringify(replacement), /fixture-extra-secret/);
});

test('Claude applies project redaction rules to inline output and the complete artifact', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-project-redaction-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, '.sando'));
  fs.writeFileSync(path.join(cwd, '.sando', 'redaction.json'), JSON.stringify({
    schema: 'sando-redaction/v1',
    rules: [{ type: 'assignment-key', key: 'TEAM_DB_URL' }],
  }));

  const { output, metrics } = runHook({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd,
    tool_response: `TEAM_DB_URL=fixture-team-secret\n${'x'.repeat(6000)}`,
  }, cwd, { mode: 'apply', maxInlineBytes: 128, redact: true });

  const replacement = output.hookSpecificOutput.updatedToolOutput;
  assert.doesNotMatch(replacement, /fixture-team-secret/);
  assert.match(replacement, /\[sando\] artifact/);
  const artifactReference = replacement.match(/(\.sando\/sando\/artifacts\/[^\s]+)/)?.[1];
  assert.ok(artifactReference);
  const artifact = fs.readFileSync(path.join(cwd, artifactReference), 'utf8');
  assert.equal(artifact.includes('fixture-team-secret'), false);
  assert.match(artifact, /TEAM_DB_URL=\[REDACTED\]/);
  assert.equal(metrics.records[0].estimatedTransformSavingsTokens > 0, true);
});

test('Claude surfaces an invalid project redaction profile', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-invalid-redaction-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, '.sando'));
  fs.writeFileSync(path.join(cwd, '.sando', 'redaction.json'), '{');

  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd, tool_response: 'ok' }),
    encoding: 'utf8',
    env: { ...process.env, SANDO_POLICY: JSON.stringify({ mode: 'apply', redact: true }) },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid redaction config/i);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('fixture probe validates replacement, artifact resolution, and receipt alignment', () => {
  const probe = path.join(root, 'tests/e2e-probe.mjs');
  const result = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    probe: 'claude-post-tool-use',
    adapterBoundary: 'exercised',
    hostLifecycle: 'not-run',
    replacementShape: 'bash',
    artifactResolved: true,
    receiptAligned: true,
  });
});
