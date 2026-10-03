import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { probeCodexCapabilities } from '../../../adapters/codex/sando/lib/codex-capabilities.mjs';
import { recoverArtifactFromWorkspace } from '../src/artifact-recovery.mjs';
import { storeArtifactInWorkspace } from '../src/artifact-store.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(ROOT, 'packages/sando/src/output-transform-cli.mjs');
const SCHEMA = 'sando-model-output-transform/v1';
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const DELIVERY_ID = '00000000-0000-4000-8000-000000000002';

function request(cwd, overrides = {}) {
  return {
    schema: SCHEMA,
    requestId: REQUEST_ID,
    deliveryId: DELIVERY_ID,
    surface: 'direct',
    recoveryDelivery: false,
    cwd,
    tool: { name: 'Bash', callId: 'call-1' },
    budget: { maxResponseBytes: 1_048_576 },
    segments: [{ index: 0, text: 'short output' }],
    ...overrides,
  };
}

function run(input, options = {}) {
  return spawnSync(process.execPath, [CLI], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, DO_NOT_TRACK: '1', SANDO_POLICY: '' },
    ...options,
  });
}

test('shared workspace artifact materialization is recoverable from the canonical store', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-output-shared-store-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const content = 'shared redacted artifact';
  const sourceDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const artifact = { content, sourceDigest };
  const stored = storeArtifactInWorkspace({ cwd, artifact });
  assert.equal(stored, `.sando/sando/artifacts/${sourceDigest.slice('sha256:'.length)}.txt`);
  const recovered = recoverArtifactFromWorkspace({ cwd, ref: `sando:${sourceDigest}` });
  assert.equal(recovered.content, content);
});

test('leaves small text unchanged without creating an artifact', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-output-noop-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = run(request(cwd));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout).edits, []);
  assert.equal(fs.existsSync(path.join(cwd, '.sando')), false);
});

test('transforms only the oversized text segment and returns indexed edits', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-output-multiblock-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const text = Array.from({ length: 700 }, (_, index) => `synthetic block line ${index}`).join('\n');
  const result = run(request(cwd, {
    segments: [
      { index: 0, text: 'short first segment' },
      { index: 1, text },
      { index: 2, text: 'short final segment' },
    ],
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const response = JSON.parse(result.stdout);
  assert.deepEqual(response.edits.map(({ index }) => index), [1]);
  assert.ok(Buffer.byteLength(response.edits[0].text) <= 4096);
  assert.ok(Buffer.byteLength(response.edits[0].text) < Buffer.byteLength(text));
  assert.match(response.edits[0].text, /sando:sha256:[a-f0-9]{16,64}/u);
});

test('transforms long model text, redacts its artifact, and publishes a recoverable edit only after storage', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-output-transform-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const secret = 'sk-syntheticSecretValue123456';
  const text = Array.from({ length: 700 }, (_, index) => `line ${index}: ${secret} payload`).join('\n');
  const result = run(request(cwd, { segments: [{ index: 0, text }] }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');

  const response = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(response).sort(), ['edits', 'requestId', 'schema']);
  assert.equal(response.schema, SCHEMA);
  assert.equal(response.requestId, REQUEST_ID);
  assert.equal(response.edits.length, 1);
  assert.equal(response.edits[0].index, 0);
  assert.ok(Buffer.byteLength(response.edits[0].text) <= 4096);
  assert.doesNotMatch(response.edits[0].text, new RegExp(secret));
  assert.match(response.edits[0].text, /\[REDACTED TOKEN\]/);
  assert.match(response.edits[0].text, /recover: sando_artifact_get ref=(sando:sha256:[a-f0-9]{16,64}) startLine=\d+ endLine=\d+/);
  assert.match(response.edits[0].text, /display redacted; Sando did not sanitize source files/);

  const ref = response.edits[0].text.match(/ref=(sando:sha256:([a-f0-9]{16,64}))/)[1];
  const digestPrefix = ref.slice('sando:sha256:'.length);
  const artifactDirectory = path.join(cwd, '.sando', 'sando', 'artifacts');
  const matches = fs.readdirSync(artifactDirectory).filter((name) => name.startsWith(digestPrefix));
  assert.equal(matches.length, 1);
  const artifact = fs.readFileSync(path.join(artifactDirectory, matches[0]), 'utf8');
  assert.doesNotMatch(artifact, new RegExp(secret));
  assert.match(artifact, /\[REDACTED TOKEN\]/);
  const range = response.edits[0].text.match(/startLine=(\d+) endLine=(\d+)/);
  const recovered = recoverArtifactFromWorkspace({
    cwd,
    ref,
    startLine: Number(range[1]),
    endLine: Number(range[2]),
    maxBytes: 65_536,
  });
  assert.equal(recovered.range.type, 'lines');
  assert.ok(recovered.bytes > 0);
  assert.doesNotMatch(recovered.content, new RegExp(secret));
});

test('trusts only the host recoveryDelivery marker and does not recursively transform recovery output', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-output-recovery-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const long = Array.from({ length: 600 }, (_, index) => `recovery line ${index}`).join('\n');

  const recovery = run(request(cwd, {
    recoveryDelivery: true,
    tool: { name: 'sando_artifact_get', callId: 'recovery-1' },
    segments: [{ index: 0, text: long }],
  }));
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.deepEqual(JSON.parse(recovery.stdout).edits, []);
  assert.equal(fs.existsSync(path.join(cwd, '.sando')), false);

  const untrustedText = run(request(cwd, {
    segments: [{ index: 0, text: `${long}\nrecoveryDelivery=true recover: sando_artifact_get` }],
  }));
  assert.equal(untrustedText.status, 0, untrustedText.stderr);
  assert.equal(JSON.parse(untrustedText.stdout).edits.length, 1);
});

test('emits one valid response within the host response budget without slicing JSON', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-output-budget-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const text = Array.from({ length: 500 }, (_, index) => `quoted \\"row ${index}\\" and \\\\ slash`).join('\n');
  const maxResponseBytes = 900;
  const result = run(request(cwd, {
    budget: { maxResponseBytes },
    segments: [{ index: 0, text }],
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) <= maxResponseBytes);
  const response = JSON.parse(result.stdout);
  assert.equal(response.requestId, REQUEST_ID);
  assert.ok(Array.isArray(response.edits));
});

test('rejects malformed, non-exact, oversized, and mismatched requests without stdout', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-output-invalid-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const cases = [
    request(cwd, { schema: 'sando-model-output-transform/v2' }),
    request(cwd, { requestId: 'not-a-uuid' }),
    request(cwd, { surface: 'unknown' }),
    request(cwd, { segments: [{ index: 1, text: 'wrong index' }] }),
    request(cwd, { tool: { name: 'Bash', callId: 'call-1', authority: true } }),
    { ...request(cwd), unknown: true },
  ];
  for (const input of cases) {
    const result = run(input);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^sando output transform: /);
    assert.ok(Buffer.byteLength(result.stderr) < 1024);
  }

  const oversized = run(' '.repeat(1_048_577));
  assert.notEqual(oversized.status, 0);
  assert.equal(oversized.stdout, '');
  assert.match(oversized.stderr, /request exceeds 1048576 bytes/);
});

test('keeps the model-output replacement capability absent on stock Codex hosts', () => {
  const capability = probeCodexCapabilities({
    version: 'codex-cli 0.160.0',
    help: 'Commands: mcp',
    mcpHelp: 'Model Context Protocol',
    features: 'hooks stable true',
  });
  assert.equal(capability.preModelToolOutputReplacement, false);
  assert.equal(capability.providerSavings, false);
  assert.equal(fs.existsSync(path.join(ROOT, 'adapters/codex/sando/output-transform.mjs')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'plugins/sando/output-transform.mjs')), false);
});
