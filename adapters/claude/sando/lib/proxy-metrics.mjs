import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCHEMA = 'sando-proxy-metrics/v1';

/**
 * Durable per-request record of what the proxy did and what the provider actually
 * billed, so a real median savings figure can be computed later from real usage
 * instead of a single live probe. Append-only JSONL: one line per forwarded request,
 * safe to `tail -f` or fold with a small aggregation script.
 */
export function defaultProxyMetricsPath(env = process.env) {
  const configured = env.SANDO_PROXY_METRICS_PATH;
  if (configured !== undefined) return configured;
  const stateHome = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'sando', 'proxy-requests.jsonl');
}

export function recordProxyRequest({ storagePath, provider, model, stats, usage, now = new Date() } = {}) {
  if (typeof storagePath !== 'string' || !storagePath) throw new TypeError('storagePath is required');
  if (typeof provider !== 'string' || !provider) throw new TypeError('provider is required');
  fs.mkdirSync(path.dirname(storagePath), { recursive: true, mode: 0o700 });
  const record = {
    schema: SCHEMA,
    at: now.toISOString(),
    provider,
    model: typeof model === 'string' ? model : null,
    stats: stats ?? null,
    usage: usage ?? null,
  };
  fs.appendFileSync(storagePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}
