import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { callMcpToolAsync, MCP_TOOLS } from '../lib/mcp-tools.mjs';

const CODEX_HOST_AVAILABLE = spawnSync('which', ['codex']).status === 0;
const CODEX_HOST_SKIP = CODEX_HOST_AVAILABLE ? false : 'requires the Codex host binary';

// `codex` dispatches to its Linux sandbox helper surface when invoked via a
// symlink named `codex-linux-sandbox` (argv0-based dispatch) — there is no
// separately installed binary to `which`, so we make our own shim.
// The sandbox self-dispatch trick below needs the real codex ELF binary --
// on a machine where session-handoff has swapped `codex` on PATH for its own
// active-session wrapper (a `python3 ... session-handoff run codex --executable
// <real>` shim), that indirection breaks argv0-based dispatch. Follow through
// to the real binary session-handoff records alongside its wrapper, if present.
function realCodexBinary() {
  const codex = spawnSync('which', ['codex'], { encoding: 'utf8' });
  assert.equal(codex.status, 0, codex.stderr);
  const resolved = codex.stdout.trim();
  const original = `${resolved}.session-handoff-original`;
  return fs.existsSync(original) ? fs.realpathSync(original) : resolved;
}

function codexLinuxSandboxShim(cwd) {
  const shimPath = path.join(cwd, 'codex-linux-sandbox');
  fs.symlinkSync(realCodexBinary(), shimPath);
  return shimPath;
}

function sandboxMeta(cwd) {
  return { 'codex/sandbox-state-meta': {
    permissionProfile: {
      type: 'managed',
      file_system: { type: 'restricted', entries: [
        { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
        { path: { type: 'special', value: { kind: 'project_roots' } }, access: 'write' },
      ] },
      network: 'restricted',
    },
    codexLinuxSandboxExe: codexLinuxSandboxShim(cwd),
    sandboxCwd: pathToFileURL(cwd).href,
    useLegacyLandlock: false,
  } };
}

test('plugin sando_exec executes only through the Codex sandbox', { skip: CODEX_HOST_SKIP }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-exec-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = await callMcpToolAsync('sando_exec', {
    command: "printf '%s' 'Authorization: Bearer plugin-secret'; printf ok > marker.txt",
  }, { SANDO_COVERAGE_PATH: path.join(cwd, 'coverage.json') }, sandboxMeta(cwd));

  assert.equal(result.execution.exitCode, 0);
  assert.equal(result.inline.includes('plugin-secret'), false);
  assert.equal(fs.readFileSync(path.join(cwd, 'marker.txt'), 'utf8'), 'ok');
});

test('plugin sando_exec retains its cap without terminating the command', { skip: CODEX_HOST_SKIP }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-exec-cap-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = await callMcpToolAsync('sando_exec', {
    command: "head -c 100000 /dev/zero | tr '\\0' x; printf ok > after.txt",
    policy: { maxInlineBytes: 128, maxArtifactBytes: 256 },
  }, {}, sandboxMeta(cwd));

  assert.equal(result.execution.exitCode, 0);
  assert.equal(result.execution.outputTruncated, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'after.txt'), 'utf8'), 'ok');
});

test('plugin sando_exec keeps stderr visible when stdout reaches its cap', { skip: CODEX_HOST_SKIP }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-exec-stderr-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = await callMcpToolAsync('sando_exec', {
    command: "printf '%s' 'stdout-noise'; head -c 10000 /dev/zero | tr '\\0' x; printf '%s' 'stderr-marker' >&2",
    policy: { maxInlineBytes: 512, maxArtifactBytes: 256 },
  }, {}, sandboxMeta(cwd));

  assert.equal(result.execution.exitCode, 0);
  assert.match(result.inline, /stderr-marker/);
  assert.equal(result.execution.outputTruncated, true);
});

test('plugin sando_exec preserves a valid UTF-8 prefix when the cap cuts a multibyte character', { skip: CODEX_HOST_SKIP }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-exec-utf8-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = await callMcpToolAsync('sando_exec', {
    command: "i=0; while [ \"$i\" -lt 255 ]; do printf x; i=$((i+1)); done; printf '€'",
    policy: { maxInlineBytes: 512, maxArtifactBytes: 256 },
  }, {}, sandboxMeta(cwd));

  assert.equal(result.execution.binaryOutput, false);
  assert.doesNotMatch(result.inline, /binary output withheld/);
  assert.match(result.inline, /x{10}/);
});

test('plugin MCP advertises the sandbox metadata capability and sando_exec', () => {
  assert.ok(MCP_TOOLS.some((tool) => tool.name === 'sando_exec'));
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, '../mcp/server.mjs')], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const message = JSON.parse(result.stdout);
  assert.deepEqual(message.result.capabilities.experimental, { 'codex/sandbox-state-meta': {} });
});

test('plugin MCP keeps read-only artifact handling read-only', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-mcp-artifact-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'secret=hidden\n' + 'x'.repeat(2_000));
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, '../mcp/server.mjs')], {
    input: `${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'sando_read', arguments: { path: 'fixture.txt', cwd, policy: { maxInlineBytes: 128, maxArtifactBytes: 4096 } } },
    })}\n`,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const message = JSON.parse(result.stdout);
  assert.equal(Object.hasOwn(message.result.structuredContent.artifact, 'content'), true);
  assert.equal(fs.existsSync(path.join(cwd, '.sando')), false);
  assert.match(message.result.content[0].text, /sando:/);
});
