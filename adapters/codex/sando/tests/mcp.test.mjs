import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('standalone Codex MCP reads and greps only inside cwd', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-mcp-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), `secret=hidden\nneedle\n${'x'.repeat(4_000)}`);
  const coveragePath = path.join(cwd, 'coverage.json');
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sando_read', arguments: { path: 'fixture.txt', cwd, policy: { maxInlineBytes: 256, maxArtifactBytes: 512 } } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sando_grep', arguments: { pattern: 'needle', path: 'fixture.txt', cwd } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'sando_read', arguments: { path: '../fixture.txt', cwd } } },
  ];
  const result = spawnSync(process.execPath, [path.join(root, 'mcp/server.mjs')], {
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`, encoding: 'utf8',
    env: { ...process.env, SANDO_COVERAGE_PATH: coveragePath },
  });
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages[0].result.tools.map((tool) => tool.name), ['prepare_tool_output', 'sando_read', 'sando_grep', 'sando_exec']);
  assert.equal(messages[1].result.structuredContent.source.truncated, true);
  assert.equal(messages[1].result.structuredContent.artifact.content.includes('hidden'), false);
  assert.match(messages[2].result.structuredContent.inline, /fixture\.txt:2:needle/);
  assert.equal(messages[3].result.isError, true);
});

test('MCP transformations record real coverage evidence', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-mcp-coverage-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle\n');
  const coveragePath = path.join(cwd, 'coverage.json');
  const result = spawnSync(process.execPath, [path.join(root, 'mcp/server.mjs')], {
    input: `${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'sando_read', arguments: { path: 'fixture.txt', cwd } },
    })}\n`,
    encoding: 'utf8',
    env: { ...process.env, SANDO_COVERAGE_PATH: coveragePath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.isError, false);
  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  assert.equal(coverage.counts.transformed, 1);
  assert.equal(coverage.events[0].route, 'sando_read');
});

test('MCP Read passes file metadata and multi-file Grep keeps OMP bounds', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-mcp-bounds-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'large.mjs'), [
    ...Array.from({ length: 70 }, (_, index) => `noise:${index}`),
    ...Array.from({ length: 10 }, (_, index) => `export const item${index} = ${index};`),
    ...Array.from({ length: 60 }, (_, index) => `tail:${index}`),
  ].join('\n'));
  for (const name of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(cwd, name), `${'needle\n'.repeat(25)}`);
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sando_read', arguments: { path: 'large.mjs', cwd, policy: { maxInlineBytes: 512, maxArtifactBytes: 8192 } } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sando_grep', arguments: { pattern: 'needle', path: '.', cwd, maxMatches: 200 } } },
  ];
  const result = spawnSync(process.execPath, [path.join(root, 'mcp/server.mjs')], {
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(messages[0].result.structuredContent.route, 'summary');
  assert.equal(messages[1].result.structuredContent.source.matches, 40);
});
