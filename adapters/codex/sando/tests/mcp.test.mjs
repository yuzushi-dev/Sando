import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { callMcpTool } from '../lib/mcp-tools.mjs';
import { transformModelOutputRequest } from '../lib/output-transform-cli.mjs';
import { serializeMcpPassthroughResult, serializeMcpRpcError } from '../lib/mcp-delivery.mjs';
import { requestKey } from '../lib/mcp-entry.mjs';

const root = path.resolve(import.meta.dirname, '..');
const workspaceRoot = path.resolve(root, '../../..');
const pluginServer = path.join(workspaceRoot, 'plugins/sando/mcp/server.mjs');

function runMcp(requests, { server = path.join(root, 'mcp/server.mjs'), env } = {}) {
  return spawnSync(process.execPath, [server], {
    input: Buffer.from(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`),
    env: { ...process.env, ...env },
  });
}

function onlyWireMessage(result) {
  assert.equal(result.status, 0, result.stderr.toString('utf8'));
  assert.equal(result.stdout.at(-1), 0x0a, 'wire response must end with one newline');
  assert.equal(result.stdout.subarray(0, -1).includes(0x0a), false, 'wire response must be one complete JSON line');
  return JSON.parse(result.stdout.subarray(0, -1).toString('utf8'));
}

function openMcp(server) {
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffered = Buffer.alloc(0);
  const messages = [];
  const waiters = [];
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    while (true) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) break;
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      const message = JSON.parse(line.toString('utf8'));
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else messages.push(message);
    }
  });
  child.on('error', (cause) => {
    for (const waiter of waiters.splice(0)) waiter.reject(cause);
  });
  return {
    call(request) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      if (messages.length > 0) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    async close() {
      child.stdin.end();
      const [code, signal] = await new Promise((resolve) => child.once('exit', (...args) => resolve(args)));
      assert.equal(code, 0, `signal=${signal ?? 'none'} stderr=${stderr}`);
      assert.equal(buffered.length, 0, 'MCP server left an incomplete stdout line');
    },
  };
}

test('MCP cancellation keys preserve JSON-RPC ID types', () => {
  assert.notEqual(requestKey(1), requestKey('1'));
  assert.equal(requestKey(1), requestKey(1));
});

test('MCP wire envelope budgets duplicated content and structuredContent bytes', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-mcp-envelope-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'large.log'), `${'alpha βeta\n'.repeat(800)}tail`);
  const maxEnvelopeBytes = 3_200;
  const unbounded = runMcp([{
    jsonrpc: '2.0', id: 'control', method: 'tools/call', params: {
      name: 'sando_read',
      arguments: { path: 'large.log', cwd, policy: { maxInlineBytes: 900, maxArtifactBytes: 32_768 } },
    },
  }]);
  const unboundedMessage = onlyWireMessage(unbounded);
  assert.ok(Buffer.byteLength(unboundedMessage.result.structuredContent.inline) <= 900);
  assert.ok(unbounded.stdout.length > maxEnvelopeBytes, `${unbounded.stdout.length} does not exercise aggregate overflow`);
  const result = runMcp([{
    jsonrpc: '2.0', id: 'bounded', method: 'tools/call', params: {
      name: 'sando_read',
      arguments: {
        path: 'large.log', cwd,
        policy: { maxInlineBytes: 900, maxArtifactBytes: 32_768, maxEnvelopeBytes },
      },
    },
  }]);
  const message = onlyWireMessage(result);

  assert.ok(result.stdout.length <= maxEnvelopeBytes, `${result.stdout.length} exceeds ${maxEnvelopeBytes}`);
  assert.equal(message.result.isError, false);
  assert.equal(message.result.content[0].text, message.result.structuredContent.inline);
  assert.ok(Buffer.byteLength(message.result.structuredContent.inline) < 900);
  assert.equal(message.result.structuredContent.source.truncated, false);
  assert.equal(message.result.structuredContent.route, 'passthrough');
  assert.equal(message.result.structuredContent.disclosure.schema, 'sando-result-disclosure/v1');
  assert.equal(Object.hasOwn(message.result.structuredContent.artifact, 'content'), false);
  assert.match(message.result.structuredContent.artifact.ref, /^sando:sha256:/);
  assert.match(message.result.content[0].text, /recover:/);
  assert.match(message.result.content[0].text, new RegExp(message.result.structuredContent.artifact.ref));
  assert.doesNotThrow(() => JSON.parse(result.stdout.toString('utf8')));
});

test('MCP wire envelope emits a bounded declared error when required recovery metadata cannot fit', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-mcp-envelope-error-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const maxEnvelopeBytes = 512;
  const result = runMcp([{
    jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
      name: 'prepare_tool_output',
      arguments: {
        toolName: 'Read', cwd, output: 'x'.repeat(20_000),
        policy: { maxInlineBytes: 4_096, maxArtifactBytes: 32_768, maxEnvelopeBytes },
      },
    },
  }]);
  const message = onlyWireMessage(result);

  assert.ok(result.stdout.length <= maxEnvelopeBytes, `${result.stdout.length} exceeds ${maxEnvelopeBytes}`);
  assert.equal(message.result.isError, true);
  assert.equal(message.result.structuredContent.schema, 'sando-mcp-envelope-error/v1');
  assert.equal(message.result.structuredContent.code, 'SANDO_MCP_ENVELOPE_BUDGET');
  assert.equal(message.result.structuredContent.maxEnvelopeBytes, maxEnvelopeBytes);
  assert.equal(message.result.structuredContent.recovery.available, true);
  assert.match(message.result.structuredContent.recovery.ref, /^sando:sha256:/);
  assert.doesNotThrow(() => JSON.parse(result.stdout.toString('utf8')));
});

test('plugin MCP applies the aggregate budget to its actual stdout bytes', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-plugin-mcp-envelope-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'large.log'), `${'plugin line\n'.repeat(900)}tail`);
  const maxEnvelopeBytes = 3_200;
  const request = (policy) => ({
    jsonrpc: '2.0', id: 'plugin-bounded', method: 'tools/call', params: {
      name: 'sando_read', arguments: { path: 'large.log', cwd, policy },
    },
  });
  const control = runMcp([request({ maxInlineBytes: 900, maxArtifactBytes: 32_768 })], { server: pluginServer });
  assert.ok(control.stdout.length > maxEnvelopeBytes, `${control.stdout.length} does not exercise aggregate overflow`);

  const result = runMcp([request({ maxInlineBytes: 900, maxArtifactBytes: 32_768, maxEnvelopeBytes })], { server: pluginServer });
  const message = onlyWireMessage(result);
  assert.ok(result.stdout.length <= maxEnvelopeBytes, `${result.stdout.length} exceeds ${maxEnvelopeBytes}`);
  assert.equal(message.result.isError, false);
  assert.equal(message.result.content[0].text, message.result.structuredContent.inline);
  assert.equal(message.result.structuredContent.disclosure.schema, 'sando-result-disclosure/v1');
  assert.match(message.result.structuredContent.artifact.ref, /^sando:sha256:/);
});

test('Slice passthrough success and RPC error serializers are bounded and preserve request IDs', () => {
  const success = serializeMcpPassthroughResult({
    id: 'slice-success', maxEnvelopeBytes: 512,
    result: {
      content: [{ type: 'text', text: 'x'.repeat(20_000) }],
      structuredContent: { value: 'x'.repeat(20_000) }, isError: false,
    },
  });
  const successMessage = JSON.parse(success.toString('utf8'));
  assert.ok(success.length <= 512);
  assert.equal(successMessage.id, 'slice-success');
  assert.equal(successMessage.result.isError, true);
  assert.equal(successMessage.result.structuredContent.code, 'SANDO_MCP_ENVELOPE_BUDGET');
  assert.equal(successMessage.result.structuredContent.recovery.available, false);

  const failure = serializeMcpRpcError({
    id: 'slice-error', code: -32602, message: 'fixture error',
    data: { detail: 'z'.repeat(20_000) }, maxEnvelopeBytes: 512,
  });
  const failureMessage = JSON.parse(failure.toString('utf8'));
  assert.ok(failure.length <= 512);
  assert.equal(failureMessage.id, 'slice-error');
  assert.equal(failureMessage.error.code, -32602);
  assert.equal(failureMessage.error.message, 'fixture error');
  assert.equal(failureMessage.error.data, undefined);
});

for (const [label, server] of [
  ['Codex', path.join(root, 'mcp/server.mjs')],
  ['plugin', pluginServer],
]) test(`${label} MCP bounds tool errors and control-plane responses on actual stdout`, () => {
  const callLimit = 512;
  const hugeCallId = 'call-id'.repeat(100_000);
  const unknownTool = runMcp([{
    jsonrpc: '2.0', id: hugeCallId, method: 'tools/call', params: {
      name: 'missing_tool', arguments: { policy: { maxEnvelopeBytes: callLimit } },
    },
  }], { server });
  const unknownToolMessage = onlyWireMessage(unknownTool);
  assert.ok(unknownTool.stdout.length <= callLimit, `${unknownTool.stdout.length} exceeds ${callLimit}`);
  assert.equal(unknownToolMessage.id, null);
  assert.equal(unknownToolMessage.error.code, -32001);

  const initialize = runMcp([{
    jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18' },
  }], { server });
  const initializeMessage = onlyWireMessage(initialize);
  assert.ok(initialize.stdout.length <= 1024 * 1024);
  assert.equal(initializeMessage.id, 'init');
  assert.equal(initializeMessage.result.protocolVersion, '2025-06-18');

  const hugeControlId = 'control-id'.repeat(120_000);
  const unknownMethod = runMcp([{
    jsonrpc: '2.0', id: hugeControlId, method: 'unknown/method', params: {},
  }], { server });
  const unknownMethodMessage = onlyWireMessage(unknownMethod);
  assert.ok(unknownMethod.stdout.length <= 1024 * 1024);
  assert.equal(unknownMethodMessage.id, null);
  assert.equal(unknownMethodMessage.error.code, -32001);

  const invalidRequest = runMcp([{
    jsonrpc: '2.0', id: hugeControlId, method: 7, params: {},
  }], { server });
  const invalidRequestMessage = onlyWireMessage(invalidRequest);
  assert.ok(invalidRequest.stdout.length <= 1024 * 1024);
  assert.equal(invalidRequestMessage.id, null);
  assert.equal(invalidRequestMessage.error.code, -32001);

  const toolsList = runMcp([{
    jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {},
  }], { server });
  const toolsListMessage = onlyWireMessage(toolsList);
  assert.ok(toolsList.stdout.length <= 1024 * 1024);
  assert.ok(toolsListMessage.result.tools.length >= 5);

  const parseError = spawnSync(process.execPath, [server], { input: Buffer.from('{broken json\n') });
  const parseErrorMessage = onlyWireMessage(parseError);
  assert.ok(parseError.stdout.length <= 1024 * 1024);
  assert.equal(parseErrorMessage.id, null);
  assert.equal(parseErrorMessage.error.code, -32700);

  const notification = runMcp([{
    jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'absent' },
  }], { server });
  assert.equal(notification.status, 0, notification.stderr.toString('utf8'));
  assert.equal(notification.stdout.length, 0);
});

for (const [label, server] of [
  ['Codex', path.join(root, 'mcp/server.mjs')],
  ['plugin', pluginServer],
]) test(`${label} MCP aggregate compaction recovers the emitted line range exactly`, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `sando-${label.toLowerCase()}-mcp-recovery-`));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const lines = Array.from({ length: 120 }, (_, index) => `line-${String(index + 1).padStart(4, '0')} ${'value '.repeat(8)}${index + 1}`);
  fs.writeFileSync(path.join(cwd, 'large.log'), lines.join('\n'));
  const client = openMcp(server);
  t.after(() => client.close());

  const compacted = await client.call({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'sando_read', arguments: {
        path: 'large.log', cwd,
        policy: { maxInlineBytes: 900, maxArtifactBytes: 65_536, maxEnvelopeBytes: 3_200 },
      },
    },
  });
  assert.equal(compacted.result.isError, false);
  const exposed = compacted.result.structuredContent;
  const range = exposed.disclosure.artifact.elidedRange;
  assert.ok(Number.isInteger(range.startLine) && Number.isInteger(range.endLine));

  const recovered = await client.call({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'sando_artifact_get', arguments: {
        ref: exposed.artifact.ref, startLine: range.startLine, endLine: range.endLine, maxBytes: 65_536,
      },
    },
  });
  assert.equal(recovered.result.isError, false);
  const recovery = recovered.result.structuredContent;
  assert.equal(recovery.handle, exposed.artifact.ref);
  assert.equal(recovery.content, lines.slice(range.startLine - 1, range.endLine).join('\n'));
  assert.equal(recovery.bytes, Buffer.byteLength(recovery.content));
  assert.equal(recovery.truncated, false);
});

test('standalone Codex MCP reads and greps only inside cwd', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-mcp-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), `secret=hidden\nneedle\n${'x'.repeat(4_000)}`);
  const coveragePath = path.join(cwd, 'coverage.json');
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sando_read', arguments: { path: 'fixture.txt', cwd, policy: { maxInlineBytes: 256, maxArtifactBytes: 8_192 } } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sando_grep', arguments: { pattern: 'needle', path: 'fixture.txt', cwd } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'sando_read', arguments: { path: '../fixture.txt', cwd } } },
  ];
  const result = spawnSync(process.execPath, [path.join(root, 'mcp/server.mjs')], {
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`, encoding: 'utf8',
    env: { ...process.env, SANDO_COVERAGE_PATH: coveragePath },
  });
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(messages[0].result.tools.map((tool) => tool.name), ['prepare_tool_output', 'sando_read', 'sando_grep', 'sando_exec', 'sando_artifact_get']);
  const artifactTool = messages[0].result.tools[4];
  assert.match(artifactTool.description, /copy artifact\.handle exactly/i);
  assert.match(artifactTool.description, /this MCP session/i);
  // The oneOf/examples block was removed: it duplicated the runtime check in
  // recoverArtifactContent ('artifact range is ambiguous') at a prompt cost
  // larger than the rest of the catalog.
  assert.equal(artifactTool.inputSchema.oneOf, undefined);
  assert.equal(artifactTool.inputSchema.examples, undefined);
  const policyTools = messages[0].result.tools.filter((tool) => tool.inputSchema.properties.policy);
  assert.ok(policyTools.length >= 4);
  for (const tool of policyTools) {
    assert.deepEqual(tool.inputSchema.properties.policy.properties.maxEnvelopeBytes, {
      type: 'integer', minimum: 512, maximum: 1_048_576, default: 16_384,
      description: 'Maximum UTF-8 bytes for the complete JSON-RPC response, including its trailing newline.',
    });
  }
  assert.equal(artifactTool.inputSchema.properties.policy, undefined);
  assert.equal(messages[1].result.structuredContent.source.truncated, false);
  assert.equal(Object.hasOwn(messages[1].result.structuredContent.artifact, 'content'), false);
  assert.equal(messages[1].result.structuredContent.disclosure.schema, 'sando-result-disclosure/v1');
  assert.match(messages[2].result.structuredContent.inline, /fixture\.txt:2:needle/);
  assert.equal(messages[3].result.isError, true);
});

test('MCP artifact handles recover bounded redacted content', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-mcp-artifact-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), `secret=hidden\n${'x'.repeat(2_000)}`);
  const prepared = callMcpTool('sando_read', {
    path: 'fixture.txt', cwd, policy: { maxInlineBytes: 128, maxArtifactBytes: 4_096 },
  });
  const recovered = callMcpTool('sando_artifact_get', { ref: prepared.artifact.ref, maxBytes: 64 });
  assert.equal(recovered.schema, 'sando-artifact-recovery/v1');
  assert.equal(recovered.content, 'secret=[REDACTED]\n' + 'x'.repeat(46));
  assert.equal(recovered.truncated, true);
  assert.equal(callMcpTool('sando_artifact_get', { ref: prepared.artifact.ref, startByte: 0, endByte: 6 }).content, 'secret');
  assert.equal(callMcpTool('sando_artifact_get', { ref: prepared.artifact.ref, startLine: 1, endLine: 1 }).content, 'secret=[REDACTED]');
  assert.throws(() => callMcpTool('sando_artifact_get', { ref: prepared.artifact.ref, startByte: 0, startLine: 1 }), /ambiguous/i);
  assert.throws(() => callMcpTool('sando_artifact_get', { ref: prepared.artifact.ref, maxBytes: 0 }), /maxBytes/i);
  assert.throws(() => callMcpTool('sando_artifact_get', { ref: '/tmp/.sando/sando/artifacts/file.txt' }), /invalid/i);
  assert.throws(() => callMcpTool('sando_artifact_get', { ref: 'sando:sha256:0123456789abcdef' }), /artifact handle is unavailable/i);
});

test('Codex MCP recovery reads artifacts materialized by the model output helper', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-output-recovery-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const source = Array.from({ length: 700 }, (_, index) => `output recovery fixture line ${index}`).join('\n');
  const response = transformModelOutputRequest({
    schema: 'sando-model-output-transform/v1',
    requestId: '00000000-0000-4000-8000-000000000001',
    deliveryId: '00000000-0000-4000-8000-000000000002',
    surface: 'direct',
    recoveryDelivery: false,
    cwd,
    tool: { name: 'Bash', callId: 'output-recovery-call' },
    budget: { maxResponseBytes: 1_048_576 },
    segments: [{ index: 0, text: source }],
  }, { env: { SANDO_POLICY: '' } });

  assert.equal(response.edits.length, 1);
  const ref = response.edits[0].text.match(/sando:sha256:[a-f0-9]{16,64}/)?.[0];
  assert.ok(ref, response.edits[0].text);
  const recovered = callMcpTool('sando_artifact_get', { ref }, {}, cwd);
  assert.equal(recovered.schema, 'sando-artifact-recovery/v1');
  assert.equal(recovered.content, source);
});

test('MCP artifact recovery discloses source uncertainty in text and structured envelopes', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-mcp-artifact-view-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const content = `${'safe line\n'.repeat(100)}tail`;
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), content);
  const ref = `sando:sha256:${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sando_read', arguments: { path: 'fixture.txt', cwd, policy: { maxInlineBytes: 128, maxArtifactBytes: 4_096 } } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sando_artifact_get', arguments: { ref, startLine: 1, endLine: 1 } } },
  ];
  const result = spawnSync(process.execPath, [path.join(root, 'mcp/server.mjs')], {
    input: Buffer.from(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`),
  });
  assert.equal(result.status, 0, result.stderr.toString('utf8'));
  const wireLines = result.stdout.subarray(0, -1).toString('utf8').split('\n');
  assert.ok(Buffer.byteLength(wireLines[1]) + 1 <= 16_384);
  const messages = wireLines.map((line) => JSON.parse(line));
  assert.equal(messages[1].result.structuredContent.content, 'safe line');
  assert.deepEqual(messages[1].result.structuredContent.disclosure, {
    scope: 'artifact-view', sourceSanitization: 'not-certified',
  });
  assert.match(messages[1].result.content[0].text, /safe line\n\[sando\] artifact view; source-file sanitization is not certified$/);
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

test('G5: sando_read routes by source class, not by the default budget', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-mcp-source-class-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const line = `${'x'.repeat(120)}\n`;
  const bulk = line.repeat(600);
  fs.writeFileSync(path.join(cwd, 'sample.log'), bulk);
  fs.writeFileSync(path.join(cwd, 'sample.mjs'), bulk.slice(0, 20_000));

  // A .log is `bulk` (4 KB), not the 32 KB `source` fallback: the gates below this line
  // exercise optimizeToolOutput directly, so only an end-to-end read catches a tool that
  // forgets to forward the path to the classifier.
  const log = callMcpTool('sando_read', { path: 'sample.log', cwd });
  assert.ok(log.inline.length <= 4 * 1024, `bulk inline ${log.inline.length} exceeds the 4 KB cap`);
  assert.match(log.inline, /\[middle elided\]/);

  // ...and a source file under 32 KB still arrives whole.
  const source = callMcpTool('sando_read', { path: 'sample.mjs', cwd });
  assert.equal(source.inline.includes('[middle elided]'), false);
  assert.ok(source.inline.length > 4 * 1024);
});
