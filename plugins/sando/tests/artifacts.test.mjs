import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { materializeArtifactResult, persistArtifact } from '../lib/artifacts.mjs';
import { normalizePolicy, optimizeToolOutput } from '../lib/core.mjs';
import { callMcpTool } from '../lib/mcp-tools.mjs';
import { transformModelOutputRequest } from '../lib/output-transform-cli.mjs';

function artifact(content) {
  const digest = createHash('sha256').update(content).digest('hex');
  return {
    content,
    sourceDigest: `sha256:${digest}`,
    ref: `sando:sha256:${digest}`,
    bytes: Buffer.byteLength(content),
  };
}

function artifactFile(cwd, value) {
  return path.join(cwd, '.sando', 'sando', 'artifacts', `${value.sourceDigest.slice('sha256:'.length)}.txt`);
}

test('persistArtifact cleans after a write and keeps the returned artifact', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-artifacts-write-'));
  try {
    const first = artifact('old');
    const second = artifact('new');
    persistArtifact(cwd, first, { cleanup: { maxBytes: 3 } });
    const firstPath = artifactFile(cwd, first);
    fs.utimesSync(firstPath, new Date(1_000), new Date(1_000));
    const ref = persistArtifact(cwd, second, { cleanup: { maxBytes: 3 } });

    assert.equal(ref, '.sando/sando/artifacts/' + second.sourceDigest.slice('sha256:'.length) + '.txt');
    assert.equal(fs.existsSync(artifactFile(cwd, first)), false);
    assert.equal(fs.readFileSync(artifactFile(cwd, second), 'utf8'), 'new');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('persistArtifact fails closed when the new artifact alone exceeds the cap', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-artifacts-oversize-'));
  try {
    const value = artifact('too-large');
    assert.throws(
      () => persistArtifact(cwd, value, { cleanup: { maxBytes: 3 } }),
      /artifact storage limit/i,
    );
    assert.equal(fs.existsSync(artifactFile(cwd, value)), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('materializeArtifactResult caps and accounts the final delivered path', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-artifacts-delivery-'));
  try {
    const policy = normalizePolicy({ mode: 'apply', maxInlineBytes: 256, maxArtifactBytes: 4_096, redact: true });
    const result = optimizeToolOutput({
      toolName: 'Read', toolInput: { file_path: 'fixture.txt' }, cwd, policy,
      output: `password=artifact-secret\n${'middle\n'.repeat(100)}tail\n`,
    });
    const delivered = materializeArtifactResult(result, cwd, { maxInlineBytes: policy.maxInlineBytes });

    assert.ok(Buffer.byteLength(delivered.inline) <= policy.maxInlineBytes);
    assert.doesNotMatch(delivered.inline, /artifact-secret/);
    assert.match(delivered.inline, /\.sando\/sando\/artifacts\/[a-f0-9]{64}\.txt/);
    assert.match(delivered.inline, /\[sando\] display redacted; Sando did not sanitize source files$/);
    assert.equal(delivered.stats.inlineBytes, Buffer.byteLength(delivered.inline));
    assert.equal(delivered.disclosure.bytes.visible, Buffer.byteLength(delivered.inline));
    assert.equal(delivered.disclosure.artifact.digest, result.artifact.sourceDigest);
    assert.ok(delivered.disclosure.artifact.elidedRange);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('persistArtifact rejects an existing symlink before reading or chmodding it', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-artifacts-symlink-'));
  const cwd = path.join(fixture, 'workspace');
  const outside = path.join(fixture, 'outside.txt');
  try {
    fs.mkdirSync(cwd, { mode: 0o700 });
    const value = artifact('owned fixture');
    const destination = artifactFile(cwd, value);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outside, value.content, { mode: 0o644 });
    fs.chmodSync(outside, 0o644);
    fs.symlinkSync(outside, destination);

    assert.throws(() => persistArtifact(cwd, value), /artifact/i);
    assert.equal(fs.readFileSync(outside, 'utf8'), value.content);
    assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('persistArtifact rejects an existing hardlink before chmodding its shared inode', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-artifacts-hardlink-'));
  const cwd = path.join(fixture, 'workspace');
  const outside = path.join(fixture, 'outside.txt');
  try {
    fs.mkdirSync(cwd, { mode: 0o700 });
    const value = artifact('hardlink fixture');
    const destination = artifactFile(cwd, value);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outside, value.content, { mode: 0o644 });
    fs.chmodSync(outside, 0o644);
    fs.linkSync(outside, destination);

    assert.throws(() => persistArtifact(cwd, value), /unsafe|artifact/i);
    assert.equal(fs.readFileSync(outside, 'utf8'), value.content);
    assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('persistArtifact rejects an existing FIFO without blocking', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-artifacts-fifo-'));
  try {
    const value = artifact('fifo fixture');
    const destination = artifactFile(cwd, value);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const fifo = spawnSync('mkfifo', ['-m', '600', destination]);
    assert.equal(fifo.status, 0, fifo.stderr?.toString());
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { persistArtifact } from './plugins/sando/lib/artifacts.mjs';
      const content = process.env.SANDO_FIXTURE_CONTENT;
      const digest = process.env.SANDO_FIXTURE_DIGEST;
      persistArtifact(process.env.SANDO_FIXTURE_ROOT, {
        content, sourceDigest: 'sha256:' + digest, ref: 'sando:sha256:' + digest,
        bytes: Buffer.byteLength(content),
      });
    `], {
      cwd: path.resolve(import.meta.dirname, '../../..'),
      env: {
        ...process.env,
        SANDO_FIXTURE_ROOT: cwd,
        SANDO_FIXTURE_CONTENT: value.content,
        SANDO_FIXTURE_DIGEST: value.sourceDigest.slice('sha256:'.length),
      },
      timeout: 1500,
    });
    assert.equal(result.error, undefined, `FIFO persistence timed out: ${result.error?.message}`);
    assert.notEqual(result.status, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('persistArtifact reuses a regular existing artifact without changing its content', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-artifacts-reuse-'));
  try {
    const value = artifact('regular fixture');
    const destination = artifactFile(cwd, value);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, value.content, { mode: 0o644 });
    assert.equal(persistArtifact(cwd, value), `.sando/sando/artifacts/${value.sourceDigest.slice('sha256:'.length)}.txt`);
    assert.equal(fs.readFileSync(destination, 'utf8'), value.content);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('hook entrypoints reject an existing artifact symlink without chmodding its target', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-hook-artifact-symlink-'));
  const cwd = path.join(fixture, 'workspace');
  const outside = path.join(fixture, 'outside.txt');
  const output = 'hook fixture '.repeat(1_000);
  const policy = normalizePolicy({ mode: 'apply', maxInlineBytes: 64, maxArtifactBytes: 1_048_576 });
  try {
    fs.mkdirSync(cwd, { mode: 0o700 });
    const optimization = optimizeToolOutput({ toolName: 'Bash', output, cwd, policy });
    assert.ok(optimization.artifact);
    fs.writeFileSync(outside, optimization.artifact.content, { mode: 0o644 });
    fs.chmodSync(outside, 0o644);
    const name = `${optimization.artifact.sourceDigest.slice('sha256:'.length)}.txt`;
    const destination = path.join(cwd, '.sando', 'sando', 'artifacts', name);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, destination);
    const input = JSON.stringify({
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: output, cwd,
    });
    for (const relative of ['plugins/sando/lib/hook-cli.mjs', 'plugins/sando/lib/hook-entry.mjs']) {
      const moduleUrl = pathToFileURL(path.resolve(relative)).href;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { runHookCli } from ${JSON.stringify(moduleUrl)};
        runHookCli({ host: 'claude', env: process.env });
      `], {
        cwd: path.resolve(import.meta.dirname, '../../..'),
        env: { ...process.env, SANDO_POLICY: JSON.stringify(policy) },
        input,
        timeout: 1_500,
      });
      assert.equal(child.error, undefined, `${relative} timed out: ${child.error?.message}`);
      assert.equal(child.status, 0, child.stderr?.toString());
      assert.equal(fs.statSync(outside).mode & 0o777, 0o644, relative);
    }
    assert.equal(fs.readFileSync(outside, 'utf8'), optimization.artifact.content);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('MCP artifact recovery keeps the session handle contract', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-mcp-artifact-contract-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), `first\nsecond\nthird\n${'x'.repeat(300)}`);
  const prepared = callMcpTool('sando_read', {
    path: 'fixture.txt', cwd, policy: { maxInlineBytes: 64, maxArtifactBytes: 256 },
  });
  const ref = prepared.artifact.ref;
  assert.equal(callMcpTool('sando_artifact_get', { ref, startByte: 0, endByte: 5 }).content, 'first');
  assert.equal(callMcpTool('sando_artifact_get', { ref, startLine: 2, endLine: 2 }).content, 'second');
  assert.throws(() => callMcpTool('sando_artifact_get', { ref, startByte: 0, startLine: 1 }), /ambiguous/i);
  assert.throws(() => callMcpTool('sando_artifact_get', { ref, maxBytes: 0 }), /maxBytes/i);
  assert.throws(() => callMcpTool('sando_artifact_get', { ref: '/tmp/.sando/sando/artifacts/file.txt' }), /invalid/i);
  fs.mkdirSync(path.join(cwd, '.sando', 'sando', 'artifacts'), { recursive: true, mode: 0o700 });
  assert.throws(() => callMcpTool('sando_artifact_get', { ref: 'sando:sha256:0123456789abcdef' }, {}, cwd), /artifact handle is unavailable/i);
});

test('plugin MCP recovery reads artifacts materialized by the model output helper', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-output-recovery-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const source = Array.from({ length: 700 }, (_, index) => `output recovery fixture line ${index}`).join('\n');
  const response = transformModelOutputRequest({
    schema: 'sando-model-output-transform/v1',
    requestId: '00000000-0000-4000-8000-000000000001',
    deliveryId: '00000000-0000-4000-8000-000000000002',
    surface: 'direct',
    recoveryDelivery: false,
    cwd,
    tool: { name: 'Bash', callId: 'output-recovery-call' },
    budget: { maxResponseBytes: 1_048_576 },
    segments: [{ index: 0, text: source }],
  }, { env: { SANDO_POLICY: '' } });

  assert.equal(response.edits.length, 1);
  const ref = response.edits[0].text.match(/sando:sha256:[a-f0-9]{16,64}/)?.[0];
  assert.ok(ref, response.edits[0].text);
  const recovered = callMcpTool('sando_artifact_get', { ref }, {}, cwd);
  assert.equal(recovered.schema, 'sando-artifact-recovery/v1');
  assert.equal(recovered.content, source);
});

test('standalone plugin artifact recovery discloses uncertainty in text and JSON', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-artifact-view-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const value = artifact('historical artifact');
  persistArtifact(cwd, value);
  const launcher = path.resolve(import.meta.dirname, '..', 'bin', 'sando');

  const textResult = spawnSync(launcher, ['artifact', 'get', '--root', cwd, '--ref', value.ref], { encoding: 'utf8' });
  assert.equal(textResult.status, 0, textResult.stderr);
  assert.match(textResult.stdout, /\[sando\] artifact view; source-file sanitization is not certified\n$/);

  const jsonResult = spawnSync(launcher, ['artifact', 'get', '--root', cwd, '--ref', value.ref, '--json'], { encoding: 'utf8' });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const report = JSON.parse(jsonResult.stdout);
  assert.equal(report.content, value.content);
  assert.deepEqual(report.disclosure, { scope: 'artifact-view', sourceSanitization: 'not-certified' });
});

test('standalone plugin artifact recovery discloses uncertainty in text and JSON', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-artifact-view-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const value = artifact('historical artifact');
  persistArtifact(cwd, value);
  const launcher = path.resolve(import.meta.dirname, '..', 'bin', 'sando');

  const textResult = spawnSync(launcher, ['artifact', 'get', '--root', cwd, '--ref', value.ref], { encoding: 'utf8' });
  assert.equal(textResult.status, 0, textResult.stderr);
  assert.match(textResult.stdout, /\[sando\] artifact view; source-file sanitization is not certified\n$/);

  const jsonResult = spawnSync(launcher, ['artifact', 'get', '--root', cwd, '--ref', value.ref, '--json'], { encoding: 'utf8' });
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const report = JSON.parse(jsonResult.stdout);
  assert.equal(report.content, value.content);
  assert.deepEqual(report.disclosure, { scope: 'artifact-view', sourceSanitization: 'not-certified' });
});

test('G5: sando_read routes by source class, not by the default budget', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-source-class-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const line = `${'x'.repeat(120)}\n`;
  const bulk = line.repeat(600);
  fs.writeFileSync(path.join(cwd, 'sample.log'), bulk);
  fs.writeFileSync(path.join(cwd, 'sample.mjs'), bulk.slice(0, 20_000));

  // A .log is `bulk` (4 KB), not the 32 KB `source` fallback: the routing gates exercise
  // optimizeToolOutput directly, so only an end-to-end read catches a tool that forgets to
  // forward the path to the classifier.
  const log = callMcpTool('sando_read', { path: 'sample.log', cwd });
  assert.ok(log.inline.length <= 4 * 1024, `bulk inline ${log.inline.length} exceeds the 4 KB cap`);
  assert.match(log.inline, /\[middle elided\]/);

  // ...and a source file under 32 KB still arrives whole.
  const source = callMcpTool('sando_read', { path: 'sample.mjs', cwd });
  assert.equal(source.inline.includes('[middle elided]'), false);
  assert.ok(source.inline.length > 4 * 1024);
});
