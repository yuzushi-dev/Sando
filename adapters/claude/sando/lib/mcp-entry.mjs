import readline from 'node:readline';

import { optimizeToolOutput } from './core.mjs';

const TOOL = {
  name: 'prepare_tool_output',
  description: 'Prepare deterministic bounded inline output and an optional redacted artifact payload. Performs no writes or network access.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['toolName', 'output', 'cwd'],
    properties: { toolName: { type: 'string', minLength: 1, maxLength: 128 }, output: {}, cwd: { type: 'string', minLength: 1 }, policy: { type: 'object' } },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function error(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

function dispatch(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(message?.id, -32600, 'Invalid Request');
  if (message.id === undefined) return null;
  if (message.method === 'initialize') return response(message.id, {
    protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sando', version: '0.1.0' },
  });
  if (message.method === 'ping') return response(message.id, {});
  if (message.method === 'tools/list') return response(message.id, { tools: [TOOL] });
  if (message.method === 'tools/call') {
    if (message.params?.name !== TOOL.name) return error(message.id, -32602, 'Unknown tool');
    try {
      const result = optimizeToolOutput(message.params.arguments);
      return response(message.id, { content: [{ type: 'text', text: result.inline }], structuredContent: result, isError: false });
    } catch (cause) {
      return response(message.id, { content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'invalid tool input' }], isError: true });
    }
  }
  return error(message.id, -32601, 'Method not found');
}

export function startMcpServer() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let output;
    try { output = dispatch(JSON.parse(line)); } catch { output = error(null, -32700, 'Parse error'); }
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  });
}
