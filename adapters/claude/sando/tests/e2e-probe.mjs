#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createReceipt, normalizeEvent, optimizeToolOutput } from '../lib/core.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixturePath = process.argv[2] || path.join(root, 'tests/fixtures/post-tool-use-bash.json');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-e2e-'));

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

try {
  const input = JSON.parse(fs.readFileSync(fixturePath, 'utf8').replaceAll('__PROBE_CWD__', cwd));
  const policy = { mode: 'apply', maxInlineBytes: 128, maxArtifactBytes: 256, redact: true };
  const metricsPath = path.join(cwd, 'metrics.json');
  const result = spawnSync(process.execPath, [path.join(root, 'hooks/post-tool-use.mjs')], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, SANDO_POLICY: JSON.stringify(policy), SANDO_METRICS_PATH: metricsPath },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const replacement = output.hookSpecificOutput?.updatedToolOutput;
  assert.equal(output.hookSpecificOutput?.hookEventName, 'PostToolUse');
  assert.equal(typeof replacement?.stdout, 'string');
  assert.equal(replacement.stderr, 'ERROR: tail failure');
  assert.equal(replacement.interrupted, false);
  assert.equal(replacement.isImage, false);
  assert.equal(replacement.stdout.includes('fixture-secret'), false);

  const relativeArtifact = replacement.stdout.match(/\.sando\/sando\/artifacts\/[^\s]+\.txt/)?.[0];
  assert.ok(relativeArtifact);
  const artifact = fs.readFileSync(path.join(cwd, relativeArtifact), 'utf8');
  assert.match(artifact, /Authorization: Bearer \[REDACTED\]/);
  assert.match(artifact, /TAIL-FACT/);

  const event = normalizeEvent(input);
  const optimization = optimizeToolOutput({ toolName: event.toolName, output: event.output, cwd, policy });
  const receipt = createReceipt({ host: 'claude', event, optimization, replacement });
  assert.equal(receipt.inlineDigest, digest(stableJson(replacement)));
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  assert.equal(metrics.records[0].receiptDigest, receipt.digest);

  process.stdout.write(`${JSON.stringify({
    probe: 'claude-post-tool-use', adapterBoundary: 'exercised', hostLifecycle: 'not-run',
    replacementShape: 'bash', artifactResolved: true, receiptAligned: true,
  })}\n`);
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
