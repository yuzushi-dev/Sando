#!/usr/bin/env node

import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import { exposeMcpResult, recoverStoredArtifact } from './artifact-store.mjs';
import { optimizeToolOutput } from './core.mjs';
import { ARTIFACT_TOOL_NAME } from './result-disclosure.mjs';
import { PLUGIN_VERSION } from './version.mjs';
import { createSliceBridge, isSliceTool, SLICE_TOOLS, SliceRpcError } from './slice.mjs';

const TOOL = {
  name: 'prepare_tool_output',
  description: 'Prepare deterministic bounded inline output and optional redacted artifact handle. Full content is recovered with sando_artifact_get.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['toolName', 'output', 'cwd'],
    properties: { toolName: { type: 'string', minLength: 1, maxLength: 128 }, output: {}, cwd: { type: 'string', minLength: 1 }, policy: { type: 'object' } },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const ARTIFACT_TOOL = {
  name: ARTIFACT_TOOL_NAME,
  description: 'Recover bounded redacted content from an artifact created in this MCP session. Copy artifact.handle exactly into ref (for example, sando:sha256:0123456789abcdef). Omit range fields to select the full artifact; the response remains bounded by maxBytes (default 65536). Otherwise use either 0-based byte offsets or a 1-based inclusive line range, and omit fields for the unused mode.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['ref'],
    properties: {
      ref: { type: 'string', pattern: '^sando:sha256:[a-f0-9]{16,64}$' },
      startByte: { type: 'integer', minimum: 0, description: '0-based inclusive byte offset.' },
      endByte: { type: 'integer', minimum: 0, description: '0-based exclusive byte offset.' },
      startLine: { type: 'integer', minimum: 1, description: '1-based inclusive line number.' },
      endLine: { type: 'integer', minimum: 1, description: '1-based inclusive line number.' },
      maxBytes: { type: 'integer', minimum: 1, maximum: 1048576, description: 'Maximum output bytes; omit for the default.' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const TOOLS = [TOOL, ARTIFACT_TOOL];

function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function error(id, code, message, data) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }; }
function requestKey(id) { return `${typeof id}:${JSON.stringify(id)}`; }

async function dispatch(message, bridge, active) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(message?.id, -32600, 'Invalid Request');
  if (message.method === 'notifications/cancelled') {
    active.get(requestKey(message.params?.requestId))?.abort();
    return null;
  }
  if (message.id === undefined) return null;
  if (message.method === 'initialize') return response(message.id, {
    protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sando', version: PLUGIN_VERSION },
  });
  if (message.method === 'ping') return response(message.id, {});
  const tools = [...TOOLS, ...SLICE_TOOLS()];
  if (message.method === 'tools/list') return response(message.id, { tools });
  if (message.method === 'tools/call') {
    if (!tools.some((tool) => tool.name === message.params?.name)) return error(message.id, -32602, 'Unknown tool');
    const controller = new AbortController();
    active.set(requestKey(message.id), controller);
    try {
      if (isSliceTool(message.params.name)) {
        return response(message.id, await bridge.call(message.params.name, message.params.arguments, { signal: controller.signal }));
      }
      const result = message.params.name === TOOL.name
        ? optimizeToolOutput(message.params.arguments)
        : recoverStoredArtifact(message.params.arguments);
      const exposed = message.params.name === TOOL.name ? exposeMcpResult(result) : result;
      return response(message.id, { content: [{ type: 'text', text: exposed.inline ?? exposed.content }], structuredContent: exposed, isError: false });
    } catch (cause) {
      if (cause instanceof SliceRpcError) return error(message.id, cause.code, cause.message, cause.data);
      return response(message.id, { content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'invalid tool input' }], isError: true });
    } finally { active.delete(requestKey(message.id)); }
  }
  return error(message.id, -32601, 'Method not found');
}

export function startMcpServer() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const bridge = createSliceBridge();
  const active = new Map();
  const pending = new Set();
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify(error(null, -32700, 'Parse error'))}\n`); return; }
    const task = dispatch(message, bridge, active).then((output) => {
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    }).catch(() => process.stdout.write(`${JSON.stringify(error(message?.id, -32603, 'Internal error'))}\n`));
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  lines.once('close', async () => { await Promise.allSettled(pending); bridge.close(); });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    lines.close();
    for (const controller of active.values()) controller.abort();
    bridge.close();
    await Promise.allSettled(pending);
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) startMcpServer();
