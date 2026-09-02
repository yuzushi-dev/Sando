import readline from 'node:readline';

import { exposeMcpResult, recoverStoredArtifact } from './artifact-store.mjs';
import { optimizeToolOutput } from './core.mjs';
import { ARTIFACT_TOOL_NAME } from './result-disclosure.mjs';
import { PLUGIN_VERSION } from './version.mjs';

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
  description: 'Recover a bounded redacted byte or line range from an artifact created in this MCP session.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['ref'],
    properties: {
      ref: { type: 'string', pattern: '^sando:sha256:[a-f0-9]{16,64}$' },
      startByte: { type: 'integer', minimum: 0 }, endByte: { type: 'integer', minimum: 0 },
      startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 },
      maxBytes: { type: 'integer', minimum: 1, maximum: 1048576 },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const TOOLS = [TOOL, ARTIFACT_TOOL];

function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function error(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

function dispatch(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(message?.id, -32600, 'Invalid Request');
  if (message.id === undefined) return null;
  if (message.method === 'initialize') return response(message.id, {
    protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sando', version: PLUGIN_VERSION },
  });
  if (message.method === 'ping') return response(message.id, {});
  if (message.method === 'tools/list') return response(message.id, { tools: TOOLS });
  if (message.method === 'tools/call') {
    if (!TOOLS.some((tool) => tool.name === message.params?.name)) return error(message.id, -32602, 'Unknown tool');
    try {
      const result = message.params.name === TOOL.name
        ? optimizeToolOutput(message.params.arguments)
        : recoverStoredArtifact(message.params.arguments);
      const exposed = message.params.name === TOOL.name ? exposeMcpResult(result) : result;
      return response(message.id, { content: [{ type: 'text', text: exposed.inline ?? exposed.content }], structuredContent: exposed, isError: false });
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
