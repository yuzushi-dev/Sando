import http from 'node:http';

import { estimateTokens } from './core.mjs';
import { detectProviderBody, listSemanticCandidates, transformProviderRequest } from './context-transform.mjs';
import { recordProxyRequest } from './proxy-metrics.mjs';
import {
  defaultTelemetryConfigPath, defaultTelemetryStatePaths, incrementCounter, readTelemetryConfig,
} from './telemetry.mjs';

function todayUtc() { return new Date().toISOString().slice(0, 10); }

/** Only counts (never request/response content) — see docs/plans/2026-08-25-sando-telemetry-design.md.
 *  `host` here is the provider request shape (`anthropic`/`openai`), which does not map cleanly to
 *  Sando's `claude`/`codex` telemetry host enum; the proxy fronts both hosts equally, so it reports
 *  under a fixed `claude` label — this is the one place the design doc's host/provider split is
 *  approximate, flagged for the design doc rather than silently assumed. */
function recordProxyTelemetry({ env, transformed, beforeText, afterText }) {
  let config;
  try { config = readTelemetryConfig(defaultTelemetryConfigPath(env)); } catch { return; }
  if (!config.enabled) return;
  const cacheWarm = transformed.stats.cacheRewriteRatio !== null;
  try {
    incrementCounter({
      statePaths: defaultTelemetryStatePaths(env),
      day: todayUtc(),
      event: 'proxy_summary',
      host: 'claude',
      deltas: {
        rewritesApplied: transformed.changed ? 1 : 0,
        rewritesSkippedCache: transformed.stats.cacheProtectedSkips > 0 ? 1 : 0,
        inputTokensSaved: Math.max(0, estimateTokens(beforeText) - estimateTokens(afterText)),
        cacheHitYes: cacheWarm ? 1 : 0,
        cacheHitNo: cacheWarm ? 0 : 1,
      },
    });
  } catch { /* telemetry is best-effort and must never affect the proxied response */ }
}

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'content-length', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
  'accept-encoding', 'content-encoding',
]);

function assertUpstream(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('upstream must be an absolute URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('upstream must use http or https');
  if (url.username || url.password) throw new TypeError('upstream must not contain credentials');
  return url;
}

function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error('request body exceeds proxy limit'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function targetUrl(upstream, requestUrl) {
  const request = new URL(requestUrl, 'http://sando.invalid');
  const target = new URL(upstream);
  const basePath = target.pathname.replace(/\/$/, '');
  target.pathname = `${basePath}${request.pathname}` || '/';
  target.search = request.search;
  return target;
}

function forwardedHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('accept-encoding', 'identity');
  return headers;
}

function responseHeaders(response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  });
  return headers;
}

const MAX_USAGE_SCAN_BYTES = 2 * 1024 * 1024;

/** Merges every `"usage":{...}` object seen across a (possibly streamed) Anthropic
 *  response: `message_start` carries input/cache token counts, `message_delta`
 *  carries the final output count, and later objects overwrite matching keys. */
function extractUsage(text) {
  let usage = null;
  for (const match of text.matchAll(/"usage":\s*(\{[^{}]*\})/g)) {
    try { usage = { ...usage, ...JSON.parse(match[1]) }; } catch { /* ignore malformed fragment */ }
  }
  return usage;
}

async function pipeResponse(response, outgoing, onText) {
  outgoing.writeHead(response.status, response.statusText, responseHeaders(response));
  if (!response.body) {
    outgoing.end();
    return;
  }
  const decoder = new TextDecoder();
  let scanned = 0;
  for await (const chunk of response.body) {
    outgoing.write(chunk);
    if (onText && scanned < MAX_USAGE_SCAN_BYTES) {
      scanned += chunk.length;
      onText(decoder.decode(chunk, { stream: true }));
    }
  }
  outgoing.end();
}

function jsonResponse(outgoing, status, body) {
  const text = JSON.stringify(body);
  outgoing.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  outgoing.end(text);
}

function createSemanticStats(candidates) {
  return {
    candidates: candidates.length,
    attempted: candidates.length,
    accepted: 0,
    cacheHits: 0,
    fallbacks: 0,
    skipped: 0,
    netSavedTokens: 0,
    pending: candidates.length,
  };
}

async function observeSemanticCandidates({ provider, candidates, semanticCompactor, stats }) {
  for (const candidate of candidates) {
    try {
      const result = await semanticCompactor({ provider, ...candidate });
      if (result?.status === 'candidate') stats.accepted += 1;
      else if (result?.status === 'fallback') stats.fallbacks += 1;
      else stats.skipped += 1;
      if (result?.cacheHit === true) stats.cacheHits += 1;
      if (Number.isSafeInteger(result?.netSavedTokens)) stats.netSavedTokens += result.netSavedTokens;
    } catch {
      stats.fallbacks += 1;
    } finally {
      stats.pending -= 1;
    }
  }
}

export async function createProviderProxy({ upstream, host = '127.0.0.1', port = 0, policy = {}, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, semanticCompactor, metricsPath, env = process.env } = {}) {
  const upstreamUrl = assertUpstream(upstream);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port is invalid');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) throw new TypeError('maxBodyBytes is invalid');
  let lastStats = null;
  let lastRequestAt = null;

  const server = http.createServer(async (request, outgoing) => {
    try {
      if (request.method === 'GET' && new URL(request.url, 'http://sando.invalid').pathname === '/health') {
        jsonResponse(outgoing, 200, { schema: 'sando-provider-proxy/v1', status: 'ok', lastStats });
        return;
      }
      const rawBody = await readBody(request, maxBodyBytes);
      let body = rawBody;
      let recordProvider = null;
      let recordModel = null;
      let recordStats = null;
      if (rawBody.length > 0 && /application\/json/i.test(request.headers['content-type'] ?? '')) {
        try {
          const parsed = JSON.parse(rawBody.toString('utf8'));
          const provider = detectProviderBody(parsed, request.headers);
          if (provider) {
            const now = Date.now();
            const idleMs = lastRequestAt === null ? null : now - lastRequestAt;
            lastRequestAt = now;
            const transformed = transformProviderRequest({ provider, body: parsed, policy, idleMs });
            if (transformed.changed) body = Buffer.from(JSON.stringify(transformed.body));
            recordProxyTelemetry({
              env, transformed,
              beforeText: rawBody.toString('utf8'), afterText: body.toString('utf8'),
            });
            lastStats = { provider, ...transformed.stats, changed: transformed.changed, reasons: transformed.reasons };
            recordProvider = provider;
            recordModel = typeof parsed?.model === 'string' ? parsed.model : null;
            recordStats = transformed.stats;
            if (typeof semanticCompactor === 'function') {
              const candidates = listSemanticCandidates({ provider, body: transformed.body });
              const stats = createSemanticStats(candidates);
              lastStats.semantic = stats;
              setImmediate(() => observeSemanticCandidates({ provider, candidates, semanticCompactor, stats }));
            }
          }
        } catch {
          body = rawBody;
        }
      }
      const response = await fetch(targetUrl(upstreamUrl, request.url), {
        method: request.method,
        headers: forwardedHeaders(request),
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
        redirect: 'manual',
      });
      let responseText = '';
      await pipeResponse(response, outgoing, metricsPath ? (chunk) => { responseText += chunk; } : undefined);
      if (metricsPath && recordProvider) {
        try {
          recordProxyRequest({
            storagePath: metricsPath, provider: recordProvider, model: recordModel,
            stats: recordStats, usage: extractUsage(responseText),
          });
        } catch { /* metrics are best-effort and must never affect the proxied response */ }
      }
    } catch (error) {
      if (!outgoing.headersSent) jsonResponse(outgoing, error.message === 'request body exceeds proxy limit' ? 413 : 502, { error: 'sando proxy upstream failure' });
      else outgoing.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    get lastStats() { return lastStats; },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
