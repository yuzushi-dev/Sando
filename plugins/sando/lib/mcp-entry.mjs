import readline from 'node:readline';

import { callMcpToolAsync, MCP_TOOLS } from './mcp-tools.mjs';

function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function error(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

async function dispatch(message, active) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(message?.id, -32600, 'Invalid Request');
  if (message.method === 'notifications/cancelled') {
    active.get(String(message.params?.requestId))?.abort();
    return null;
  }
  if (message.id === undefined) return null;
  if (message.method === 'initialize') return response(message.id, {
    protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false }, experimental: { 'codex/sandbox-state-meta': {} } }, serverInfo: { name: 'sando', version: '0.1.0' },
  });
  if (message.method === 'ping') return response(message.id, {});
  if (message.method === 'tools/list') return response(message.id, { tools: MCP_TOOLS });
  if (message.method === 'tools/call') {
    if (!MCP_TOOLS.some((tool) => tool.name === message.params?.name)) return error(message.id, -32602, 'Unknown tool');
    const controller = new AbortController();
    active.set(String(message.id), controller);
    try {
      const result = await callMcpToolAsync(message.params.name, message.params.arguments, process.env, message.params?._meta, controller.signal);
      return response(message.id, { content: [{ type: 'text', text: result.inline }], structuredContent: result, isError: false });
    } catch (cause) {
      return response(message.id, { content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'invalid tool input' }], isError: true });
    } finally { active.delete(String(message.id)); }
  }
  return error(message.id, -32601, 'Method not found');
}

export function startMcpServer() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const active = new Map();
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify(error(null, -32700, 'Parse error'))}\n`); return; }
    void dispatch(message, active).then((output) => {
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    }).catch(() => process.stdout.write(`${JSON.stringify(error(message?.id, -32603, 'Internal error'))}\n`));
  });
}
