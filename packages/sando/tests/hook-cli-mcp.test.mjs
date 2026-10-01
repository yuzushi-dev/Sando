// Canonical hook-cli and mcp-server counterpart of adapters/claude/sando/tests/mcp-bounding.test.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { rememberArtifact, recoverArtifact } from '../src/artifact-store.mjs';

const root = path.resolve(import.meta.dirname, '..');
const server = path.join(root, 'src/mcp-server.mjs');
const runner = path.join(os.tmpdir(), `sando-hook-cli-runner-${process.pid}.mjs`);
fs.writeFileSync(runner, `import { runHookCli } from ${JSON.stringify(path.join(root, 'src/hook-cli.mjs'))};\nrunHookCli({ host: 'claude', env: process.env });\n`);
test.after(() => fs.rmSync(runner, { force: true }));
const sha = (text) => createHash('sha256').update(text).digest('hex');

function tmp(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sando-claude-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runHook(input, cwd) {
  const result = spawnSync(process.execPath, [runner], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', cwd, ...input }), encoding: 'utf8',
    env: { ...process.env, DO_NOT_TRACK: '1', SANDO_METRICS_PATH: path.join(cwd, 'metrics.json') },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function artifactDir(cwd) {
  const dir = path.join(cwd, '.sando/sando/artifacts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeArtifact(cwd, content, name = sha(content)) {
  fs.writeFileSync(path.join(artifactDir(cwd), `${name}.txt`), content);
  return `sando:sha256:${name.slice(0, 16)}`;
}

const big = Array.from({ length: 400 }, (_, i) => `row ${i} ${'x'.repeat(40)}`).join('\n');
const MCP_TOOL = 'mcp__claude_ai_Atlassian__getConfluencePage';

test('external MCP text blocks are bounded, written to an artifact and name sando_artifact_get', (t) => {
  const cwd = tmp(t, 'mcp-bound');
  const out = runHook({ tool_name: MCP_TOOL, tool_response: [{ type: 'text', text: big }] }, cwd);
  const blocks = out.hookSpecificOutput.updatedMCPToolOutput;
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.ok(Buffer.byteLength(blocks[0].text) < Buffer.byteLength(big) / 2);
  assert.match(blocks[0].text, /recover: sando_artifact_get ref=sando:sha256:[a-f0-9]{16,64} (startLine=\d+ endLine=\d+|maxBytes=65536)/);
  assert.doesNotMatch(blocks[0].text, /sando artifact get/);
  const file = path.join(cwd, '.sando/sando/artifacts', `${sha(big)}.txt`);
  assert.equal(fs.readFileSync(file, 'utf8'), big);
});

test('non-text MCP blocks pass through untouched while text blocks are bounded', (t) => {
  const cwd = tmp(t, 'mcp-nontext');
  const image = { type: 'image', data: 'iVBORw0KGgo='.repeat(2000), mimeType: 'image/png' };
  const resource = { type: 'resource', resource: { uri: 'file:///x', text: big } };
  const out = runHook({ tool_name: MCP_TOOL, tool_response: [image, { type: 'text', text: big }, resource, { type: 'text', text: 'ok' }] }, cwd);
  const blocks = out.hookSpecificOutput.updatedMCPToolOutput;
  assert.deepEqual(blocks[0], image);
  assert.deepEqual(blocks[2], resource);
  assert.deepEqual(blocks[3], { type: 'text', text: 'ok' });
  assert.match(blocks[1].text, /^\[sando\] artifact /);
});

test('small MCP output is left unchanged', (t) => {
  const cwd = tmp(t, 'mcp-small');
  assert.deepEqual(runHook({ tool_name: MCP_TOOL, tool_response: [{ type: 'text', text: 'hello' }] }, cwd), {});
  assert.equal(fs.existsSync(path.join(cwd, '.sando')), false);
});

test("Sando's own MCP tools are never bounded", (t) => {
  const cwd = tmp(t, 'mcp-own');
  for (const name of ['mcp__plugin_sando_sando__sando_artifact_get', 'mcp__plugin_sando_sando__prepare_tool_output', 'mcp__sando__sando_artifact_get']) {
    assert.deepEqual(runHook({ tool_name: name, tool_response: [{ type: 'text', text: big }] }, cwd), {}, name);
  }
  assert.equal(fs.existsSync(path.join(cwd, '.sando')), false);
});

test('non-array MCP responses pass through unchanged', (t) => {
  const cwd = tmp(t, 'mcp-nonarray');
  for (const response of [big, { content: [{ type: 'text', text: big }], structuredContent: { rows: big } }, null]) {
    assert.deepEqual(runHook({ tool_name: MCP_TOOL, tool_response: response ?? '' }, cwd), {});
  }
});

test('hook-written artifacts are recovered by prefix, with slicing and maxBytes honoured', (t) => {
  const cwd = tmp(t, 'recover');
  const ref = writeArtifact(cwd, 'one\ntwo\nthree\n');
  assert.equal(recoverArtifact({ ref }, { cwd }).content, 'one\ntwo\nthree\n');
  assert.equal(recoverArtifact({ ref, startLine: 2, endLine: 2 }, { cwd }).content, 'two');
  assert.ok(Buffer.byteLength(recoverArtifact({ ref, maxBytes: 5 }, { cwd }).content) <= 5);
  const bigRef = writeArtifact(cwd, big);
  const limited = recoverArtifact({ ref: bigRef, maxBytes: 100 }, { cwd });
  assert.ok(Buffer.byteLength(limited.content) <= 100);
  assert.notEqual(limited.content, big);
});

test('the in-process store wins over the on-disk artifact', (t) => {
  const cwd = tmp(t, 'prefer');
  const content = 'in-process copy';
  const digest = `sha256:${sha(content)}`;
  const ref = `sando:${digest.slice(0, 'sha256:'.length + 16)}`;
  rememberArtifact({ ref, content, sourceDigest: digest, sourceBytes: Buffer.byteLength(content) });
  writeArtifact(cwd, 'different on-disk file', sha(content));
  assert.equal(recoverArtifact({ ref }, { cwd }).content, content);
});

test('recovery rejects a short prefix, an ambiguous prefix and a missing artifact', (t) => {
  const cwd = tmp(t, 'reject');
  writeArtifact(cwd, 'alpha');
  assert.throws(() => recoverArtifact({ ref: 'sando:sha256:0123456789abcde' }, { cwd }), /invalid/i);
  const prefix = 'abcdef0123456789';
  fs.writeFileSync(path.join(artifactDir(cwd), `${prefix}${'0'.repeat(48)}.txt`), 'a');
  fs.writeFileSync(path.join(artifactDir(cwd), `${prefix}${'1'.repeat(48)}.txt`), 'b');
  assert.throws(() => recoverArtifact({ ref: `sando:sha256:${prefix}` }, { cwd }), /ambiguous/i);
  assert.throws(() => recoverArtifact({ ref: 'sando:sha256:fedcba9876543210' }, { cwd }), /unavailable/i);
});

test('recovery rejects symlinked artifacts and symlinked artifact directories', (t) => {
  const cwd = tmp(t, 'symlink');
  const outside = tmp(t, 'outside');
  const content = 'secret outside the artifact store';
  fs.writeFileSync(path.join(outside, 'target.txt'), content);
  fs.symlinkSync(path.join(outside, 'target.txt'), path.join(artifactDir(cwd), `${sha(content)}.txt`));
  assert.throws(() => recoverArtifact({ ref: `sando:sha256:${sha(content).slice(0, 16)}` }, { cwd }), /unavailable/i);

  const cwd2 = tmp(t, 'symlink-dir');
  fs.writeFileSync(path.join(outside, `${sha(content)}.txt`), content);
  fs.mkdirSync(path.join(cwd2, '.sando/sando'), { recursive: true });
  fs.symlinkSync(outside, path.join(cwd2, '.sando/sando/artifacts'));
  assert.throws(() => recoverArtifact({ ref: `sando:sha256:${sha(content).slice(0, 16)}` }, { cwd: cwd2 }), /unsafe|unavailable/i);
});

test('recovery rejects content whose SHA-256 does not match the file name', (t) => {
  const cwd = tmp(t, 'mismatch');
  const claimed = sha('what the name claims');
  fs.writeFileSync(path.join(artifactDir(cwd), `${claimed}.txt`), 'tampered content');
  assert.throws(() => recoverArtifact({ ref: `sando:sha256:${claimed.slice(0, 16)}` }, { cwd }), /integrity|does not match/i);
});

test('end to end: a bounded MCP result is recovered through the sando_artifact_get tool', (t) => {
  const cwd = tmp(t, 'e2e');
  const out = runHook({ tool_name: MCP_TOOL, tool_response: [{ type: 'text', text: big }] }, cwd);
  const hint = out.hookSpecificOutput.updatedMCPToolOutput[0].text.match(/recover: sando_artifact_get ref=(sando:sha256:[a-f0-9]+)/);
  assert.ok(hint);
  const result = spawnSync(process.execPath, [server], {
    cwd,
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sando_artifact_get', arguments: { ref: hint[1], startLine: 1, endLine: 3 } } })}\n`,
    encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  assert.equal(result.status, 0, result.stderr);
  const message = JSON.parse(result.stdout.trim().split('\n')[0]);
  assert.equal(message.result.isError, false);
  assert.ok(message.result.content[0].text.startsWith(big.split('\n').slice(0, 3).join('\n')));
});
