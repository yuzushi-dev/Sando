import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { persistArtifact } from './artifacts.mjs';
import { exposeMcpResult, rememberArtifact } from './artifact-store.mjs';
import { callMcpToolAsync, codexSandboxKey, MCP_TOOLS, spawnCodexSandboxedProcess } from './mcp-tools.mjs';
import { PLUGIN_VERSION } from './version.mjs';
import { createSliceBridge, isSliceTool, SLICE_TOOLS, SliceRpcError } from './slice.mjs';

function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function error(id, code, message, data) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }; }
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
  const tools = [...MCP_TOOLS, ...SLICE_TOOLS()];
  if (message.method === 'tools/list') return response(message.id, { tools });
  if (message.method === 'tools/call') {
    if (!tools.some((tool) => tool.name === message.params?.name)) return error(message.id, -32602, 'Unknown tool');
    const controller = new AbortController();
    active.set(requestKey(message.id), controller);
    try {
      if (isSliceTool(message.params.name)) {
        return response(message.id, await bridge.call(message.params.name, message.params.arguments, {
          meta: message.params?._meta, signal: controller.signal,
        }));
      }
      const result = await callMcpToolAsync(message.params.name, message.params.arguments, process.env, message.params?._meta, controller.signal);
      const exposed = result.artifact && message.params.name === 'sando_exec'
        ? publicResult(message.params.name, message.params.arguments, message.params?._meta, result)
        : exposeMcpResult(result);
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
  const active = new Map();
  const pending = new Set();
  const bridge = createSliceBridge({
    contextKey: ({ meta }) => codexSandboxKey(meta),
    spawnBackend: ({ executable, root }, { meta }) => spawnCodexSandboxedProcess({
      command: executable, args: [root, '--mcp'], cwd: root, meta,
    }),
  });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify(error(null, -32700, 'Parse error'))}\n`); return; }
    const task = dispatch(message, active, bridge).then((output) => {
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
