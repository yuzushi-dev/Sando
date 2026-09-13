import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import path from 'node:path';

import { rememberArtifact, recoverStoredArtifact } from '../lib/artifact-store.mjs';

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
  const artifactTool = messages[0].result.tools[1];
  assert.match(artifactTool.description, /copy artifact\.handle exactly/i);
  assert.match(artifactTool.description, /this MCP session/i);
  // The oneOf/examples block was removed: it duplicated the runtime check in
  // recoverArtifactContent ('artifact range is ambiguous') at a prompt cost
  // larger than the rest of the catalog.
  assert.equal(artifactTool.inputSchema.oneOf, undefined);
  assert.equal(artifactTool.inputSchema.examples, undefined);
  assert.equal(Object.hasOwn(messages[1].result.structuredContent.artifact, 'content'), false);
  assert.equal(messages[1].result.structuredContent.disclosure.schema, 'sando-result-disclosure/v1');
  assert.doesNotMatch(messages[1].result.content[0].text, /hidden/);
});

test('Claude MCP artifact recovery keeps the session handle contract', () => {
  const content = 'first\nsecond\nthird';
  const sourceDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const ref = `sando:${sourceDigest}`;
  rememberArtifact({ ref, content, sourceDigest, sourceBytes: Buffer.byteLength(content) });
  assert.equal(recoverStoredArtifact({ ref, startByte: 0, endByte: 5 }).content, 'first');
  assert.equal(recoverStoredArtifact({ ref, startLine: 2, endLine: 2 }).content, 'second');
  assert.throws(() => recoverStoredArtifact({ ref, startByte: 0, startLine: 1 }), /ambiguous/i);
  assert.throws(() => recoverStoredArtifact({ ref, maxBytes: 0 }), /maxBytes/i);
  assert.throws(() => recoverStoredArtifact({ ref: '/tmp/.sando/sando/artifacts/file.txt' }), /invalid/i);
  assert.throws(() => recoverStoredArtifact({ ref: 'sando:sha256:0123456789abcdef' }), /unavailable in this MCP session/i);
});
