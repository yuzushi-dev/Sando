import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { persistArtifact } from './artifacts.mjs';
import { exposeMcpResult, rememberArtifact } from './artifact-store.mjs';
import { callMcpToolAsync, MCP_TOOLS } from './mcp-tools.mjs';
import { PLUGIN_VERSION } from './version.mjs';

function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function error(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }
export function requestKey(id) { return `${typeof id}:${JSON.stringify(id)}`; }

function artifactCwd(name, args, meta) {
  if (name !== 'sando_exec') return args?.cwd;
  const value = meta?.['codex/sandbox-state-meta']?.sandboxCwd;
  if (typeof value !== 'string' || !value) return undefined;
  try { return value.startsWith('file:') ? fileURLToPath(value) : value; } catch { return undefined; }
}

function publicResult(name, args, meta, result) {
  if (name !== 'sando_exec' || !result.artifact) return result;
  rememberArtifact(result.artifact);
  const cwd = artifactCwd(name, args, meta);
  if (!cwd) throw new Error('artifact cwd is unavailable');
  const ref = persistArtifact(cwd, result.artifact);
  const inline = result.inline.replace(result.artifact.ref, ref);
  const { content: _content, ...artifact } = result.artifact;
  return { ...result, inline, artifact };
}

async function dispatch(message, active) {
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
  if (message.method === 'tools/list') return response(message.id, { tools: MCP_TOOLS });
  if (message.method === 'tools/call') {
    if (!MCP_TOOLS.some((tool) => tool.name === message.params?.name)) return error(message.id, -32602, 'Unknown tool');
    const controller = new AbortController();
    active.set(requestKey(message.id), controller);
    try {
      const result = await callMcpToolAsync(message.params.name, message.params.arguments, process.env, message.params?._meta, controller.signal);
      const exposed = result.artifact && message.params.name === 'sando_exec'
        ? publicResult(message.params.name, message.params.arguments, message.params?._meta, result)
        : exposeMcpResult(result);
      return response(message.id, { content: [{ type: 'text', text: exposed.inline ?? exposed.content }], structuredContent: exposed, isError: false });
    } catch (cause) {
      return response(message.id, { content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'invalid tool input' }], isError: true });
    } finally { active.delete(requestKey(message.id)); }
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
