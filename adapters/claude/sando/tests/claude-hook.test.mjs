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

function runHook(input, cwd, policy) {
  const metricsPath = path.join(cwd, 'metrics.json');
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, SANDO_POLICY: JSON.stringify(policy), SANDO_METRICS_PATH: metricsPath },
  });
  assert.equal(result.status, 0, result.stderr);
  return { output: JSON.parse(result.stdout), metrics: JSON.parse(fs.readFileSync(metricsPath, 'utf8')) };
}

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
