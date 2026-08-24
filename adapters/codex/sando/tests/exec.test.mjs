import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { callMcpTool, callMcpToolAsync, MCP_TOOLS } from '../lib/mcp-tools.mjs';
import { readCoverage } from '../lib/coverage.mjs';

function sandboxMeta(cwd) {
  const helper = spawnSync('which', ['codex-linux-sandbox'], { encoding: 'utf8' });
  assert.equal(helper.status, 0, helper.stderr);
  return {
    'codex/sandbox-state-meta': {
      permissionProfile: {
        type: 'managed',
        file_system: { type: 'restricted', entries: [
          { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
          { path: { type: 'special', value: { kind: 'project_roots' } }, access: 'write' },
        ] },
        network: 'restricted',
      },
      codexLinuxSandboxExe: helper.stdout.trim(),
      sandboxCwd: pathToFileURL(cwd).href,
      useLegacyLandlock: false,
    },
  };
}

test('sando_exec is advertised as a sandboxed terminal tool', () => {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === 'sando_exec');
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, true);
  assert.deepEqual(tool.inputSchema.required, ['command']);
});

test('sando_exec fails closed without Codex sandbox metadata', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-exec-no-state-'));
  const coveragePath = path.join(cwd, 'coverage.json');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.throws(
    () => callMcpTool('sando_exec', { command: 'printf unsafe', workdir: '.' }, { SANDO_COVERAGE_PATH: coveragePath }),
    /sandbox metadata/i,
  );
  assert.equal(readCoverage(coveragePath).counts.bypassed, 1);
});

test('sando_exec runs inside the supplied Codex sandbox and redacts output', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-exec-run-'));
  const nested = path.join(cwd, 'nested');
  fs.mkdirSync(nested);
  const coveragePath = path.join(cwd, 'coverage.json');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const result = await callMcpToolAsync('sando_exec', {
    command: "printf '%s' 'Authorization: Bearer secret123'; printf '%s' 'password=secret456' >&2; printf ok > marker.txt; exit 7",
    workdir: 'nested',
  }, { SANDO_COVERAGE_PATH: coveragePath }, sandboxMeta(cwd));

  assert.equal(result.execution.exitCode, 7);
  assert.equal(result.execution.tty, false);
  assert.equal(result.execution.workdir, 'nested');
  assert.equal(result.execution.binaryOutput, false);
  assert.equal(result.stats.redactions, 2);
  assert.equal(result.inline.includes('secret123'), false);
  assert.equal(result.inline.includes('secret456'), false);
  assert.equal(fs.readFileSync(path.join(nested, 'marker.txt'), 'utf8'), 'ok');
  assert.equal(readCoverage(coveragePath).counts.transformed, 1);
});

test('sando_exec bounds text into an artifact', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-exec-artifact-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = await callMcpToolAsync('sando_exec', {
    command: `printf '%s' '${'x'.repeat(2_000)}'`,
    policy: { maxInlineBytes: 128, maxArtifactBytes: 4_096 },
  }, {}, sandboxMeta(cwd));

  assert.ok(result.artifact);
  assert.equal(result.artifact.bytes <= 4_096, true);
  assert.equal(result.inline.length <= 128, true);
});

test('sando_exec reports timeout, cancellation, binary output, and nonzero status', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-exec-control-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const meta = sandboxMeta(cwd);

  const timeout = await callMcpToolAsync('sando_exec', { command: 'sleep 1', timeoutMs: 50 }, {}, meta);
  assert.equal(timeout.execution.timedOut, true);
  assert.equal(timeout.execution.tty, false);

  const controller = new AbortController();
  const cancelledPromise = callMcpToolAsync('sando_exec', { command: 'sleep 5' }, {}, meta, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const cancelled = await cancelledPromise;
  assert.equal(cancelled.execution.cancelled, true);

  const binary = await callMcpToolAsync('sando_exec', { command: "printf '\\000\\001'; exit 3" }, {}, meta);
  assert.equal(binary.execution.binaryOutput, true);
  assert.equal(binary.execution.exitCode, 3);
  assert.match(binary.inline, /binary output withheld/);
});

test('sando_exec rejects interactive and unsafe workdirs before execution', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-exec-invalid-'));
  const coveragePath = path.join(cwd, 'coverage.json');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const meta = sandboxMeta(cwd);

  await assert.rejects(callMcpToolAsync('sando_exec', { command: 'read', interactive: true }, { SANDO_COVERAGE_PATH: coveragePath }, meta), /TTY|interactive/i);
  await assert.rejects(callMcpToolAsync('sando_exec', { command: 'printf no', workdir: '../' }, { SANDO_COVERAGE_PATH: coveragePath }, meta), /workspace-relative|escapes/i);
  assert.equal(readCoverage(coveragePath).counts.bypassed, 2);
});

test('sando_exec rejects an unsandboxed Codex state', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-exec-unsafe-state-'));
  const coveragePath = path.join(cwd, 'coverage.json');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const meta = sandboxMeta(cwd);
  meta['codex/sandbox-state-meta'].permissionProfile.type = 'disabled';

  await assert.rejects(callMcpToolAsync('sando_exec', { command: 'printf unsafe' }, { SANDO_COVERAGE_PATH: coveragePath }, meta), /managed restricted/i);
  assert.equal(readCoverage(coveragePath).counts.bypassed, 1);
});
