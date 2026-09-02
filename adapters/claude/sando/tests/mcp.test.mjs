import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('Claude MCP exposes preview metadata without raw artifact content', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'mcp/server.mjs')], {
    input: `${[
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'prepare_tool_output',
        arguments: { toolName: 'Bash', output: `secret=hidden\n${'x'.repeat(2_000)}`, cwd: '/work', policy: { maxInlineBytes: 128, maxArtifactBytes: 4_096 },
      } } },
    ].map((request) => JSON.stringify(request)).join('\n')}\n`,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages[0].result.tools.map((tool) => tool.name), ['prepare_tool_output', 'sando_artifact_get']);
  assert.equal(Object.hasOwn(messages[1].result.structuredContent.artifact, 'content'), false);
  assert.equal(messages[1].result.structuredContent.disclosure.schema, 'sando-result-disclosure/v1');
  assert.doesNotMatch(messages[1].result.content[0].text, /hidden/);
});
