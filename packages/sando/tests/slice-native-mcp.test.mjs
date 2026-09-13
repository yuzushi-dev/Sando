import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnMcpTransport } from '../src/lazy-mcp-gateway-stdio.mjs';

const repo = path.resolve(import.meta.dirname, '../../..');
const binary = process.env.SANDO_SLICE_TEST_BINARY;
const codexAvailable = spawnSync('which', ['codex']).status === 0;
const entries = [
  'packages/sando/src/mcp-server.mjs',
  'adapters/claude/sando/mcp/server.mjs',
  'adapters/codex/sando/mcp/server.mjs',
  'plugins/sando/mcp/server.mjs',
];

for (const [index, entry] of entries.entries()) {
  for (const writable of index < 2 ? [true] : [true, false]) {
    test(`${entry}: native Slice ${writable ? 'edits through MCP' : 'preserves files in a read-only sandbox'}`, {
      skip: !binary ? 'set SANDO_SLICE_TEST_BINARY to test a real native backend'
        : index >= 2 && !codexAvailable ? 'requires the Codex host binary' : false,
      timeout: 30_000,
    }, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-native-mcp-'));
      const file = path.join(root, 'sample.mjs');
      const original = 'export function greet() { return "Hello"; }\n';
      fs.writeFileSync(file, original);
      const transport = spawnMcpTransport({
        command: process.execPath, args: [path.join(repo, entry)], cwd: root,
        env: {
          DO_NOT_TRACK: '1', SANDO_SLICE_BINARY: binary, SANDO_SLICE_ROOT: root, SANDO_SLICE_WRITE: '1',
          XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'),
        },
      });
      t.after(() => { transport.close(); fs.rmSync(root, { recursive: true, force: true }); });
      const meta = { 'codex/sandbox-state-meta': {
        sandboxCwd: pathToFileURL(root).href, codexLinuxSandboxExe: null,
        permissionProfile: {
          type: 'managed', network: 'restricted',
          file_system: { type: 'restricted', entries: [
            { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
            { path: { type: 'special', value: { kind: 'project_roots' } }, access: writable ? 'write' : 'read' },
          ] },
        },
        useLegacyLandlock: false,
      } };
      const request = (method, params) => transport.request({ jsonrpc: '2.0', method, params }, { signal: AbortSignal.timeout(10_000) });
      const initialized = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'sando-test', version: '1' } });
      assert.equal(initialized.error, undefined);
      transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const call = async (verb, args) => {
        const response = await request('tools/call', { name: `sando_slice_${verb}`, arguments: args, _meta: meta });
        assert.equal(response.error, undefined, JSON.stringify(response));
        assert.notEqual(response.result.isError, true, JSON.stringify(response));
        return JSON.parse(response.result.content[0].text);
      };
      const { symbol: { handle } } = await call('find_symbol', { symbol: 'greet' });
      const { body } = await call('fetch_body', { handle });
      const args = { handle, new_body: body.replace('Hello', 'Ciao') };
      if (writable) {
        await call('replace_symbol_body', args);
        assert.equal(fs.readFileSync(file, 'utf8'), original.replace('Hello', 'Ciao'));
      } else {
        const response = await request('tools/call', { name: 'sando_slice_replace_symbol_body', arguments: args, _meta: meta });
        assert.ok(response.error || response.result?.isError, JSON.stringify(response));
        assert.match(JSON.stringify(response), /atomic write failed/);
        assert.equal(fs.readFileSync(file, 'utf8'), original);
      }
    });
  }
}
