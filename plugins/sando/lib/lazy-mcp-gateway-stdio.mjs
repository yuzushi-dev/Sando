import { spawn } from 'node:child_process';
import readline from 'node:readline';

export function spawnMcpTransport({ command, args = [], cwd, env, onMessage }) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('gateway command configuration is invalid');
  const child = spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) { const { resolve } = pending.get(message.id); pending.delete(message.id); resolve(message); }
    else { const reply = onMessage?.(message); if (reply) child.stdin.write(`${JSON.stringify(reply)}\n`); }
  });
  const fail = (error) => { closed = true; for (const { reject } of pending.values()) reject(error); pending.clear(); };
  child.on('error', fail);
  child.on('close', (code) => fail(new Error(`downstream MCP exited with code ${code}`)));
  return {
    request(message, { signal, notify } = {}) {
      if (closed) return Promise.reject(new Error('downstream MCP transport is closed'));
      const id = `sando:${++sequence}`;
      const request = { ...message, id };
      return new Promise((resolve, reject) => {
        const abort = () => { pending.delete(id); this.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled' } }); reject(Object.assign(new Error('downstream request cancelled'), { code: 'CANCELLED' })); };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        pending.set(id, { resolve: (value) => { signal?.removeEventListener('abort', abort); resolve(value); }, reject });
        child.stdin.write(`${JSON.stringify(request)}\n`, (error) => { if (error) reject(error); });
        void notify;
      });
    },
    notify(message) { if (!closed) child.stdin.write(`${JSON.stringify({ ...message, id: undefined })}\n`); },
    close() { if (!closed) { closed = true; child.kill(); lines.close(); } },
  };
}

export function createConfiguredMcpServers(config) {
  if (!Array.isArray(config?.servers)) throw new TypeError('gateway servers must be an array');
  return config.servers.map((server) => ({ ...server, connect: ({ onMessage }) => spawnMcpTransport({ ...server, onMessage }) }));
}

export function startLazyMcpGatewayStdio({ gateway, input = process.stdin, output = process.stdout } = {}) {
  if (!gateway) throw new TypeError('gateway is required');
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve();
  input.resume();
  lines.on('line', (line) => {
    queue = queue.then(() => processLine(line));
  });
  async function processLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); return; }
    try { const result = await gateway.handle(message); if (result) output.write(`${JSON.stringify(result)}\n`); }
    catch (error) { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: error.code ?? -32000, message: error.message || 'Gateway failure' } })}\n`); }
  }
  return lines;
}
