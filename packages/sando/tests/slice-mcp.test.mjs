import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');
const entries = [
  'packages/sando/src/mcp-server.mjs',
  'adapters/claude/sando/mcp/server.mjs',
  'adapters/codex/sando/mcp/server.mjs',
  'plugins/sando/mcp/server.mjs',
];

for (const entry of entries) {
  test(`${entry}: Slice tools are connected and writes are opt-in`, () => {
    for (const write of ['', '1']) {
      const result = spawnSync(process.execPath, [path.join(root, entry)], {
        input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`,
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, SANDO_SLICE_BINARY: process.execPath, SANDO_SLICE_ROOT: root, SANDO_SLICE_WRITE: write },
      });
      assert.equal(result.status, 0, result.stderr);
      const tools = JSON.parse(result.stdout).result.tools.filter((tool) => tool.name.startsWith('sando_slice_'));
      assert.equal(tools.length, write ? 6 : 4);
      assert.equal(tools.some((tool) => tool.name === 'sando_slice_insert_before_symbol'), false);
      assert.equal(tools.filter((tool) => !tool.annotations.readOnlyHint).length, write ? 2 : 0);
    }
  });
}

for (const entry of entries.slice(2)) {
  test(`${entry}: Slice calls refuse missing Codex sandbox metadata`, () => {
    const result = spawnSync(process.execPath, [path.join(root, entry)], {
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'sando_slice_find_symbol', arguments: { symbol: 'example' },
      } })}\n`,
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, SANDO_SLICE_BINARY: process.execPath, SANDO_SLICE_ROOT: root },
    });
    assert.equal(result.status, 0, result.stderr);
    const message = JSON.parse(result.stdout);
    assert.equal(message.result.isError, true);
    assert.match(message.result.content[0].text, /requires Codex sandbox metadata/);
  });
}
