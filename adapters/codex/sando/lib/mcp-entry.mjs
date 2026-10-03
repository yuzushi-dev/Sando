import readline from 'node:readline';

import { exposeMcpResult } from './artifact-store.mjs';
import { callMcpToolAsync, codexSandboxKey, MCP_TOOLS, spawnCodexSandboxedProcess } from './mcp-tools.mjs';
import { declareMcpEnvelopePolicy, extractMcpEnvelopePolicy, serializeMcpPassthroughResult, serializeMcpProtocolResponse, serializeMcpRpcError, serializeMcpToolError, serializeMcpToolResult } from './mcp-delivery.mjs';
import { PLUGIN_VERSION } from './version.mjs';
import { createSliceBridge, isSliceTool, SLICE_TOOLS, SliceRpcError } from './slice.mjs';

function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function error(id, code, message, data) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }; }
export function requestKey(id) { return `${typeof id}:${JSON.stringify(id)}`; }

async function dispatch(message, active, bridge) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(message?.id, -32600, 'Invalid Request');
  if (message.method === 'notifications/cancelled') {
    active.get(requestKey(message.params?.requestId))?.abort();
    return null;
  }
  if (message.id === undefined) return null;
  if (message.method === 'initialize') return response(message.id, {
    protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false }, experimental: { 'codex/sandbox-state-meta': {} } }, serverInfo: { name: 'sando', version: PLUGIN_VERSION },
  });
  if (message.method === 'ping') return response(message.id, {});
  const tools = declareMcpEnvelopePolicy([...MCP_TOOLS, ...SLICE_TOOLS()]);
  if (message.method === 'tools/list') return response(message.id, { tools });
  if (message.method === 'tools/call') {
    let delivery;
    try {
      delivery = extractMcpEnvelopePolicy(message.params?.arguments);
    } catch (cause) {
      return serializeMcpToolError({ id: message.id, message: cause instanceof Error ? cause.message : 'invalid tool input' });
    }
    if (!tools.some((tool) => tool.name === message.params?.name)) {
      return serializeMcpRpcError({ id: message.id, code: -32602, message: 'Unknown tool', maxEnvelopeBytes: delivery.maxEnvelopeBytes });
    }
    const controller = new AbortController();
    active.set(requestKey(message.id), controller);
    const { maxEnvelopeBytes } = delivery;
    try {
      if (isSliceTool(message.params.name)) {
        const result = await bridge.call(message.params.name, delivery.args, {
          meta: message.params?._meta, signal: controller.signal,
        });
        return serializeMcpPassthroughResult({ id: message.id, result, maxEnvelopeBytes });
      }
      const result = await callMcpToolAsync(message.params.name, delivery.args, process.env, message.params?._meta, controller.signal);
      return serializeMcpToolResult({ id: message.id, result, expose: exposeMcpResult, maxEnvelopeBytes });
    } catch (cause) {
      if (cause instanceof SliceRpcError) return serializeMcpRpcError({
        id: message.id, code: cause.code, message: cause.message, data: cause.data, maxEnvelopeBytes,
      });
      return serializeMcpToolError({ id: message.id, message: cause instanceof Error ? cause.message : 'invalid tool input', maxEnvelopeBytes });
    } finally { active.delete(requestKey(message.id)); }
  }
  return error(message.id, -32601, 'Method not found');
}

export function startMcpServer() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const active = new Map();
  const pending = new Set();
  const bridge = createSliceBridge({
    contextKey: ({ meta }) => codexSandboxKey(meta),
    spawnBackend: ({ executable, root }, { meta }) => spawnCodexSandboxedProcess({
      command: executable, args: [root, '--mcp'], cwd: root, meta,
    }),
  });
  const writeOutput = (output) => {
    if (!output) return;
    process.stdout.write(Buffer.isBuffer(output) ? output : serializeMcpProtocolResponse({ response: output }));
  };
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { writeOutput(error(null, -32700, 'Parse error')); return; }
    const task = dispatch(message, active, bridge).then((output) => {
      writeOutput(output);
    }).catch(() => writeOutput(error(message?.id, -32603, 'Internal error')));
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
