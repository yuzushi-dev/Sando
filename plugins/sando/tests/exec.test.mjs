import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const entry = fs.existsSync(original) ? fs.realpathSync(original) : resolved;
  return nativeCodexBinary(entry);
}

// A standalone Codex install resolves straight to the ELF. An npm install
// resolves to `<pkg>/bin/codex.js`, a Node shim that never reaches the sandbox
// surface through argv0 -- follow through to the ELF the package vendors.
function nativeCodexBinary(entry) {
  const target = fs.realpathSync(entry);
  if (isElf(target)) return target;
  const pkgRoot = path.dirname(path.dirname(target));
  const vendored = fs.globSync(path.join(pkgRoot, 'node_modules/@openai/*/vendor/*/bin/codex'));
  const native = vendored.find(isElf);
  assert.ok(native, `no vendored codex binary under ${pkgRoot}`);
  return native;
}

function isElf(candidate) {
  let fd;
  try {
    fd = fs.openSync(candidate, 'r');
  } catch {
    return false;
  }
  try {
    const magic = Buffer.alloc(4);
    return fs.readSync(fd, magic, 0, 4, 0) === 4 && magic.toString('latin1') === '\x7fELF';
  } finally {
    fs.closeSync(fd);
  }
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

test('plugin sando_exec writes a private raw receipt independently of redacted output', { skip: CODEX_HOST_SKIP }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-exec-receipt-'));
  const nested = path.join(cwd, 'nested');
  const receiptDir = path.join(cwd, 'receipts');
  fs.mkdirSync(nested);
  fs.mkdirSync(receiptDir, { mode: 0o700 });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const command = "printf 'nonce-stdout'; printf 'nonce-stderr' >&2";
  const result = await callMcpToolAsync('sando_exec', { command, workdir: 'nested' }, { SANDO_EXEC_RECEIPT_DIR: receiptDir }, sandboxMeta(cwd));
  const entries = fs.readdirSync(receiptDir);
  assert.equal(entries.length, 1);
  const receiptPath = path.join(receiptDir, entries[0]);
  assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const sha256 = (value) => createHash('sha256').update(value).digest('hex');

  assert.equal(receipt.schema, 'sando-exec-receipt/v1');
  assert.match(receipt.run_id, /^[0-9a-f-]{36}$/);
  assert.equal(receipt.command, command);
  assert.equal(receipt.workdir, 'nested');
  assert.equal(receipt.stdout, 'nonce-stdout');
  assert.equal(receipt.stderr, 'nonce-stderr');
  assert.equal(receipt.stdout_sha256, sha256('nonce-stdout'));
  assert.equal(receipt.stderr_sha256, sha256('nonce-stderr'));
  assert.equal(receipt.stdout_bytes, Buffer.byteLength('nonce-stdout'));
  assert.equal(receipt.stderr_bytes, Buffer.byteLength('nonce-stderr'));
  assert.equal(receipt.exit_code, 0);
  assert.equal(receipt.signal, null);
  assert.equal(receipt.timed_out, false);
  assert.equal(receipt.cancelled, false);
  assert.equal(receipt.stdout_truncated, false);
  assert.equal(receipt.stderr_truncated, false);
  assert.equal(receipt.truncated, false);
  assert.match(result.inline, /nonce-stdout/);
});

test('plugin sando_exec fails closed when its configured receipt directory is invalid', { skip: CODEX_HOST_SKIP }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-exec-receipt-invalid-'));
  const receiptFile = path.join(cwd, 'not-a-directory');
  fs.writeFileSync(receiptFile, 'not a directory');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  await assert.rejects(
    callMcpToolAsync('sando_exec', { command: 'printf ok' }, { SANDO_EXEC_RECEIPT_DIR: receiptFile }, sandboxMeta(cwd)),
    /absolute real directory/i,
  );
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
  assert.equal(Object.hasOwn(message.result.structuredContent.artifact, 'content'), false);
  assert.equal(message.result.structuredContent.disclosure.schema, 'sando-result-disclosure/v1');
  assert.equal(fs.existsSync(path.join(cwd, '.sando')), false);
  assert.match(message.result.content[0].text, /sando:/);
});
