// Regression tests for the review of the 0.7.0 working tree. Every case runs against the canonical
// hook-cli and against the Claude adapter entrypoint, so the two cannot diverge again.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { optimizeToolOutput } from '../src/core.mjs';
import { recoverArtifact } from '../src/artifact-store.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const TARGETS = [
  { label: 'canonical', hook: path.join(ROOT, 'packages/sando/src/hook-cli.mjs'), server: path.join(ROOT, 'packages/sando/src/mcp-server.mjs') },
  { label: 'claude adapter', hook: path.join(ROOT, 'adapters/claude/sando/lib/hook-entry.mjs'), server: path.join(ROOT, 'adapters/claude/sando/mcp/server.mjs') },
];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const lines = (count, make) => Array.from({ length: count }, (_, i) => make(i)).join('\n');

function tmp(t, label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sando-review-${label}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runHook(target, input, { cwd, env = {} } = {}) {
  const runner = path.join(cwd, '.runner.mjs');
  fs.writeFileSync(runner, `import { runHookCli } from ${JSON.stringify(pathToFileURL(target.hook).href)};\nrunHookCli({ host: 'claude', env: process.env });\n`);
  const result = spawnSync(process.execPath, [runner], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', cwd, ...input }), encoding: 'utf8',
    env: { ...process.env, DO_NOT_TRACK: '1', SANDO_METRICS_PATH: path.join(cwd, '.metrics.json'), SANDO_MODE: 'apply', ...env },
  });
  fs.rmSync(runner, { force: true });
  return result;
}

function callServer(target, args, { cwd, env = {}, tool = 'sando_artifact_get' }) {
  const result = spawnSync(process.execPath, [target.server], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } })}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n')[0]).result;
}

for (const target of TARGETS) {
  const name = (text) => `${text} [${target.label}]`;

  test(name('1: a passthrough result above the 4 KiB default is delivered, not rejected with exit 2'), (t) => {
    const cwd = tmp(t, 'budget');
    const output = lines(300, (i) => `const line${i} = ${i}; // padding padding`);
    for (const response of [output, { stdout: output, stderr: '', interrupted: false, isImage: false }]) {
      const result = runHook(target, { tool_name: 'Bash', tool_input: { command: 'cat src/foo.mjs' }, tool_response: response }, { cwd });
      assert.equal(result.status, 0, result.stderr);
      const delivered = JSON.parse(result.stdout).hookSpecificOutput.updatedToolOutput;
      const text = typeof delivered === 'string' ? delivered : delivered.stdout;
      assert.ok(Buffer.byteLength(text) <= 32 * 1024);
    }
  });

  test(name('1: an internal error never leaks the unredacted output (fail closed, exit 0)'), (t) => {
    const cwd = tmp(t, 'failclosed');
    const outside = tmp(t, 'outside');
    fs.symlinkSync(outside, path.join(cwd, '.sando'));
    const secret = 'password=hunter2-super-secret-value';
    const output = `${secret}\n${lines(800, (i) => `row ${i} value value value value`)}`;
    for (const response of [output, { stdout: output, stderr: '', interrupted: false, isImage: false }, [{ type: 'text', text: output }]]) {
      const tool = Array.isArray(response) ? 'mcp__x__y' : 'Bash';
      const result = runHook(target, { tool_name: tool, tool_input: { command: 'x' }, tool_response: response }, { cwd });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.stdout.includes('hunter2-super-secret-value'), 'stdout leaks the secret');
      const emitted = JSON.parse(result.stdout).hookSpecificOutput;
      assert.ok(emitted && (emitted.updatedToolOutput !== undefined || emitted.updatedMCPToolOutput !== undefined), 'a safe replacement must be emitted');
    }
  });

  test(name('2: artifacts are written under CLAUDE_PROJECT_DIR and recovered after a cd into a subdirectory'), (t) => {
    const project = tmp(t, 'project');
    const sub = path.join(project, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const output = lines(500, (i) => `row ${i} ${'x'.repeat(40)}`);
    const result = runHook(target, { tool_name: 'mcp__ext__big', tool_response: [{ type: 'text', text: output }] }, { cwd: sub, env: { CLAUDE_PROJECT_DIR: project } });
    assert.equal(result.status, 0, result.stderr);
    const block = JSON.parse(result.stdout).hookSpecificOutput.updatedMCPToolOutput[0].text;
    assert.ok(fs.existsSync(path.join(project, '.sando/sando/artifacts', `${sha(output)}.txt`)));
    assert.equal(fs.existsSync(path.join(sub, '.sando')), false);
    const ref = block.match(/ref=(sando:sha256:[a-f0-9]+)/)[1];
    for (const serverCwd of [project, sub]) {
      const recovered = callServer(target, { ref, startLine: 1, endLine: 2 }, { cwd: serverCwd, env: { CLAUDE_PROJECT_DIR: project } });
      assert.equal(recovered.isError, false, JSON.stringify(recovered));
      assert.ok(recovered.content[0].text.startsWith('row 0 '));
    }
    const abs = block.split('\n')[0].match(/\[sando\] artifact (\S+) /)[1];
    assert.ok(path.isAbsolute(abs) && abs.startsWith(project), `header path should be absolute outside the cwd: ${abs}`);
  });

  test(name('3: the same events produce the same output through hook-cli and the Claude entrypoint'), (t) => {
    const reference = TARGETS[0];
    const events = [
      { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: lines(900, (i) => `entry ${i} padding padding padding`), stderr: '', interrupted: false, isImage: false } },
      { tool_name: 'Bash', tool_input: { command: 'cat x' }, tool_response: `token=abc123supersecretvalue\n${lines(700, (i) => `line ${i} ${'y'.repeat(30)}`)}` },
      { tool_name: 'mcp__ext__big', tool_response: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: lines(600, (i) => `row ${i} value value value`) }] },
      { tool_name: 'mcp__ext__small', tool_response: [{ type: 'text', text: 'hello' }] },
      { tool_name: 'Read', tool_input: { file_path: '/x/a.mjs' }, tool_response: lines(400, (i) => `export const v${i} = ${i};`) },
    ];
    for (const event of events) {
      const cwdA = tmp(t, 'parity-a');
      const cwdB = tmp(t, 'parity-b');
      const a = runHook(reference, event, { cwd: cwdA });
      const b = runHook(target, event, { cwd: cwdB });
      assert.equal(b.status, a.status, b.stderr);
      assert.equal(b.stdout, a.stdout, event.tool_name);
    }
  });

  test(name('4: startLine covers the partially visible head line and excludes the artifact header'), () => {
    const output = lines(600, (i) => `row ${i} value value value`);
    for (const toolName of ['Bash', 'mcp__x__y']) {
      const r = optimizeToolOutput({ toolName, toolInput: { command: 'x' }, output, cwd: '/work', policy: { mode: 'apply' }, recoveryStyle: 'mcp' });
      const marker = r.inline.indexOf('[middle elided]');
      const head = r.inline.slice(r.inline.indexOf('\n') + 1, marker);
      const tail = r.inline.slice(marker + '[middle elided]'.length);
      const range = r.disclosure.artifact.elidedRange;
      assert.equal(range.startLine, head.split('\n').length, toolName);
      assert.equal(range.endLine, 600 - (tail.split('\n').length - 1), toolName);
      assert.match(r.inline.split('\n')[0], new RegExp(`startLine=${range.startLine} endLine=${range.endLine}`));
      const fullLines = output.split('\n');
      const cutLine = fullLines[range.startLine - 1];
      assert.ok(cutLine.startsWith(head.split('\n').at(-1)), 'the partial head line is inside the recoverable range');
    }
  });

  test(name('5: many MCP text blocks are bounded in total, not only one by one'), (t) => {
    const cwd = tmp(t, 'aggregate');
    const blocks = Array.from({ length: 50 }, (_, b) => ({ type: 'text', text: lines(64, (i) => `block ${b} row ${i} ${'z'.repeat(50)}`).slice(0, 4000) }));
    const result = runHook(target, { tool_name: 'mcp__ext__many', tool_response: blocks }, { cwd });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout).hookSpecificOutput.updatedMCPToolOutput;
    const total = out.filter((b) => b.type === 'text').reduce((sum, b) => sum + Buffer.byteLength(b.text), 0);
    assert.ok(total <= 16 * 1024, `aggregate text was ${total} bytes`);
    const ref = out.map((b) => b.text).join('\n').match(/ref=(sando:sha256:[a-f0-9]+)/)[1];
    const recovered = recoverArtifact({ ref, maxBytes: 1_048_576 }, { cwd });
    assert.ok(recovered.content.includes('block 0 row 0') && recovered.sourceBytes >= 190_000);
  });

  test(name('7: recovery ignores caller-supplied content/digest and the tool rejects unknown arguments'), (t) => {
    const cwd = tmp(t, 'inject');
    const real = 'the real artifact content\n';
    fs.mkdirSync(path.join(cwd, '.sando/sando/artifacts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.sando/sando/artifacts', `${sha(real)}.txt`), real);
    const ref = `sando:sha256:${sha(real).slice(0, 16)}`;
    assert.throws(() => recoverArtifact({ ref, content: 'forged', digest: 'sha256:00' }, { cwd }), /unknown|argument|integrity|forged/i);
    const rejected = callServer(target, { ref, content: 'forged', digest: 'sha256:00' }, { cwd, env: { CLAUDE_PROJECT_DIR: cwd } });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /unknown argument/i);
    const ok = callServer(target, { ref }, { cwd, env: { CLAUDE_PROJECT_DIR: cwd } });
    assert.equal(ok.isError, false);
  });

  test(name('10: structured redaction uses redactStructured and appends the notice once'), (t) => {
    const cwd = tmp(t, 'structured');
    const response = { stdout: 'ok', stderr: '', interrupted: false, isImage: false, a: 'password=aaa111secretvalue', b: 'password=bbb222secretvalue' };
    const result = runHook(target, { tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: response }, { cwd });
    assert.equal(result.status, 0, result.stderr);
    const delivered = JSON.parse(result.stdout).hookSpecificOutput.updatedToolOutput;
    const all = JSON.stringify(delivered);
    assert.ok(!all.includes('aaa111secretvalue') && !all.includes('bbb222secretvalue'));
    assert.equal(all.split('display redacted').length - 1, 1, all);
  });
}
