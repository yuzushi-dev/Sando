import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { callMcpToolAsync, MCP_TOOLS } from '../lib/mcp-tools.mjs';

function sandboxMeta(cwd) {
  const helper = spawnSync('which', ['codex-linux-sandbox'], { encoding: 'utf8' });
  assert.equal(helper.status, 0, helper.stderr);
  return { 'codex/sandbox-state-meta': {
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
  } };
}

test('plugin sando_exec executes only through the Codex sandbox', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-exec-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = await callMcpToolAsync('sando_exec', {
    command: "printf '%s' 'Authorization: Bearer plugin-secret'; printf ok > marker.txt",
  }, { SANDO_COVERAGE_PATH: path.join(cwd, 'coverage.json') }, sandboxMeta(cwd));

  assert.equal(result.execution.exitCode, 0);
  assert.equal(result.inline.includes('plugin-secret'), false);
  assert.equal(fs.readFileSync(path.join(cwd, 'marker.txt'), 'utf8'), 'ok');
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
