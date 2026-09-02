import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';

import { estimateTokens } from './core.mjs';
import { buildContextCaptureRecord, recordContextCapture } from './context-capture.mjs';
import { detectProviderBody, listSemanticCandidates, transformProviderRequest } from './context-transform.mjs';
import { publishF1Telemetry } from './f1-telemetry.mjs';
import { recordProxyRequest } from './proxy-metrics.mjs';
import {
  closeFinishedDays, defaultTelemetryConfigPath, defaultTelemetryStatePaths, incrementCounter, isDoNotTrack, readTelemetryConfig, recordFailure,
} from './telemetry.mjs';
import { PLUGIN_VERSION } from './version.mjs';

function todayUtc() { return new Date().toISOString().slice(0, 10); }

function telemetryProvider(provider) {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openai-chat' || provider === 'openai-responses') return 'openai';
  return 'unknown';
}

/** Only counts (never request/response content). */
function recordProxyTelemetry({ env, provider, transformed, beforeText, afterText }) {
  try {
    const configPath = defaultTelemetryConfigPath(env);
    const config = readTelemetryConfig(configPath);
    if (!config.enabled || isDoNotTrack(env)) return;
    const statePaths = defaultTelemetryStatePaths(env);
    incrementCounter({
      statePaths,
      day: todayUtc(),
      event: 'proxy_summary',
      provider: telemetryProvider(provider),
      mode: 'enforce',
      deltas: {
        rewritesApplied: transformed.changed ? 1 : 0,
        rewritesSkippedCache: transformed.stats.cacheProtectedSkips > 0 ? 1 : 0,
        inputTokensSaved: Math.max(0, estimateTokens(beforeText) - estimateTokens(afterText)),
      },
    });
    closeFinishedDays({ statePaths, configPath, day: todayUtc(), pluginVersion: PLUGIN_VERSION });
  } catch { /* telemetry is best-effort and must never affect the proxied response */ }
}

function recordProxyFailure({ env, provider, failureStage }) {
  try {
    const configPath = defaultTelemetryConfigPath(env);
    const config = readTelemetryConfig(configPath);
    if (!config.enabled || isDoNotTrack(env)) return;
    const statePaths = defaultTelemetryStatePaths(env);
    const day = todayUtc();
    recordFailure({
      statePaths, day, event: 'proxy_failure_summary',
      provider: telemetryProvider(provider), failureStage,
    });
    closeFinishedDays({ statePaths, configPath, day, pluginVersion: PLUGIN_VERSION });
  } catch { /* telemetry is best-effort and must never affect the proxied response */ }
}

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'content-length', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
  'accept-encoding', 'content-encoding', 'x-sando-session-key',
]);
const REQUEST_EXCLUDED_HEADERS = new Set(HOP_BY_HOP_HEADERS);
REQUEST_EXCLUDED_HEADERS.delete('content-encoding');

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
    if (REQUEST_EXCLUDED_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('accept-encoding', 'identity');
  return headers;
}

function decodeRequestBody(rawBody, contentEncoding) {
  const encodings = String(contentEncoding ?? '')
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding && encoding !== 'identity');
  if (encodings.length === 0) return rawBody;
  try {
    return encodings.reverse().reduce((body, encoding) => {
      if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(body);
      if (encoding === 'deflate') return inflateSync(body);
      if (encoding === 'br') return brotliDecompressSync(body);
      if (encoding === 'zstd') return zstdDecompressSync(body);
      throw new Error(`unsupported request content encoding: ${encoding}`);
    }, rawBody);
  } catch {
    return null;
  }
}

function responseHeaders(response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  });
  return headers;
}

const MAX_USAGE_SCAN_BYTES = 2 * 1024 * 1024;

function readJsonObject(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** Merges every usage object seen across a streamed provider response. */
function extractUsage(text) {
  let usage = null;
  for (const match of text.matchAll(/"usage"\s*:/g)) {
    const start = text.indexOf('{', match.index + match[0].length);
    const fragment = start < 0 ? null : readJsonObject(text, start);
    if (!fragment) continue;
    try { usage = { ...usage, ...JSON.parse(fragment) }; } catch { /* ignore malformed fragment */ }
  }
  return usage;
}

function detectCaptureProvider(body, headers) {
  const provider = detectProviderBody(body, headers);
  if (provider) return provider;
  if (Array.isArray(body?.input) && typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.length > 0) {
    return 'openai-responses';
  }
  return null;
}

function resolveContextSessionKey(value, { provider, body, headers }) {
  let candidate = value;
  if (typeof value === 'function') {
    try { candidate = value({ provider, body, headers }); } catch { return null; }
  }
  if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  const header = headers['x-sando-session-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (provider === 'anthropic' && typeof body?.metadata?.user_id === 'string' && body.metadata.user_id.length > 0) {
    return `anthropic-metadata-user:${body.metadata.user_id}`;
  }
  if (provider === 'openai-responses' && typeof body?.prompt_cache_key === 'string' && body.prompt_cache_key.length > 0) {
    return `openai-responses-prompt-cache:${body.prompt_cache_key}`;
  }
  return null;
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

const MAX_WEBSOCKET_HANDSHAKE_BYTES = 64 * 1024;
const MAX_WEBSOCKET_MESSAGE_BYTES = 16 * 1024 * 1024;

function connectWebSocketUpstream(target) {
  return new Promise((resolve, reject) => {
    const options = {
      host: target.hostname,
      port: Number(target.port) || (target.protocol === 'https:' ? 443 : 80),
      ...(target.protocol === 'https:' ? { servername: target.hostname } : {}),
    };
    let connected = false;
    const onError = (error) => {
      if (!connected) reject(error);
    };
    const socket = target.protocol === 'https:'
      ? tls.connect(options, () => {
        connected = true;
        socket.off('error', onError);
        resolve(socket);
      })
      : net.connect(options, () => {
        connected = true;
        socket.off('error', onError);
        resolve(socket);
      });
    socket.once('error', onError);
  });
}

function websocketUpgradeRequest(request, target) {
  const excluded = new Set([
    'accept-encoding', 'connection', 'content-length', 'content-encoding',
    'host', 'sec-websocket-extensions', 'transfer-encoding', 'upgrade',
    'x-sando-session-key',
  ]);
  const lines = [
    `GET ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
  ];
  for (const [name, value] of Object.entries(request.headers)) {
    if (excluded.has(name.toLowerCase()) || value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) lines.push(`${name}: ${item}`);
  }
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8');
}

function websocketInspector(onMessage) {
  let buffered = Buffer.alloc(0);
  let fragments = [];
  let fragmentBytes = 0;

  function emit(payload) {
    if (payload.length > MAX_WEBSOCKET_MESSAGE_BYTES) return;
    try { onMessage(payload.toString('utf8')); } catch { /* inspection is best-effort */ }
  }

  return (chunk) => {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return;
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const first = buffered[0];
      const second = buffered[1];
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const longLength = buffered.readBigUInt64BE(2);
        if (longLength > BigInt(MAX_WEBSOCKET_MESSAGE_BYTES)) {
          buffered = Buffer.alloc(0);
          fragments = [];
          fragmentBytes = 0;
          return;
        }
        length = Number(longLength);
        offset = 10;
      }
      const maskOffset = masked ? offset : 0;
      const frameBytes = offset + (masked ? 4 : 0) + length;
      if (buffered.length < frameBytes) return;
      const frame = buffered.subarray(0, frameBytes);
      buffered = buffered.subarray(frameBytes);
      let payload = frame.subarray(offset + (masked ? 4 : 0));
      if (masked) {
        payload = Buffer.from(payload);
        const mask = frame.subarray(maskOffset, maskOffset + 4);
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      const opcode = first & 0x0f;
      const fin = (first & 0x80) !== 0;
      if (opcode === 0x1 || opcode === 0x2) {
        fragments = [payload];
        fragmentBytes = payload.length;
        if (fin) {
          emit(payload);
          fragments = [];
          fragmentBytes = 0;
        }
      } else if (opcode === 0x0 && fragments.length > 0) {
        fragmentBytes += payload.length;
        if (fragmentBytes > MAX_WEBSOCKET_MESSAGE_BYTES) {
          fragments = [];
          fragmentBytes = 0;
        } else {
          fragments.push(payload);
          if (fin) {
            emit(Buffer.concat(fragments));
            fragments = [];
            fragmentBytes = 0;
          }
        }
      }
    }
  };
}

function findResponsesRequest(value, seen = new Set(), depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value) && Array.isArray(value.input)
    && typeof value.prompt_cache_key === 'string' && value.prompt_cache_key.length > 0) return value;
  const values = Array.isArray(value) ? value : Object.values(value);
  for (const child of values) {
    const found = findResponsesRequest(child, seen, depth + 1);
    if (found) return found;
  }
  return null;
}

function websocketCompletion(text) {
  try {
    const value = JSON.parse(text);
    return value?.type === 'response.completed' || value?.type === 'response.done';
  } catch {
    return false;
  }
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

export async function createProviderProxy({
  upstream, host = '127.0.0.1', port = 0, policy = {}, maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  semanticCompactor, metricsPath, contextCapturePath, contextCaptureHost, contextSessionKey,
  f1TelemetryPublisher = publishF1Telemetry, transformProviderRequests = true,
  env = process.env,
} = {}) {
  const upstreamUrl = assertUpstream(upstream);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port is invalid');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024) throw new TypeError('maxBodyBytes is invalid');
  if (typeof transformProviderRequests !== 'boolean') throw new TypeError('transformProviderRequests is invalid');
  let lastStats = null;
  let lastRequestAt = null;
  const capturedContextSessions = new Set();
  const upgradedSockets = new Set();

  function persistCapture({ provider, body, rawBody, sessionKey, model, providerUsage }) {
    if (!contextCapturePath || !sessionKey) return false;
    try {
      const record = buildContextCaptureRecord({
        host: contextCaptureHost ?? (provider === 'anthropic' ? 'claude' : 'codex'),
        provider,
        rawBody,
        requestBody: body,
        sessionKey,
        model,
        providerUsage,
      });
      if (!record) return false;
      if (capturedContextSessions.has(record.sessionKeyDigest)) return true;
      const reported = record.report.tokenAccounting.providerReported;
      if (providerUsage !== undefined && providerUsage !== null && !reported) return false;
      if (reported?.outputTokens === 0) return false;
      recordContextCapture({ storagePath: contextCapturePath, record });
      capturedContextSessions.add(record.sessionKeyDigest);
      if (env.SANDO_F1_TELEMETRY === '1' && typeof f1TelemetryPublisher === 'function') {
        try {
          Promise.resolve(f1TelemetryPublisher({ record, endpoint: env.SANDO_F1_TELEMETRY_ENDPOINT }))
            .catch(() => {});
        } catch { /* local telemetry must never affect the proxied response */ }
      }
      return true;
    } catch { /* capture is best-effort and must never affect the proxied response */ }
    return false;
  }

  const server = http.createServer(async (request, outgoing) => {
    let failureProvider = null;
    try {
      if (request.method === 'GET' && new URL(request.url, 'http://sando.invalid').pathname === '/health') {
        jsonResponse(outgoing, 200, { schema: 'sando-provider-proxy/v1', status: 'ok', lastStats });
        return;
      }
      let rawBody;
      try {
        rawBody = await readBody(request, maxBodyBytes);
      } catch (error) {
        recordProxyFailure({ env, provider: null, failureStage: 'input' });
        if (!outgoing.headersSent) jsonResponse(outgoing, error.message === 'request body exceeds proxy limit' ? 413 : 502, { error: 'sando proxy upstream failure' });
        else outgoing.destroy();
        return;
      }
      let body = rawBody;
      const inspectionBody = decodeRequestBody(rawBody, request.headers['content-encoding']);
      let recordProvider = null;
      let recordModel = null;
      let recordStats = null;
      let captureProvider = null;
      let captureModel = null;
      let captureSessionKey = null;
      let parsed;
      if (inspectionBody?.length > 0 && /application\/json/i.test(request.headers['content-type'] ?? '')) {
        try {
          parsed = JSON.parse(inspectionBody.toString('utf8'));
        } catch {
          recordProxyFailure({ env, provider: null, failureStage: 'input' });
        }
        if (parsed) {
          const provider = detectProviderBody(parsed, request.headers);
          const observedProvider = detectCaptureProvider(parsed, request.headers);
          failureProvider = provider ?? observedProvider;
          if (observedProvider) {
            captureProvider = observedProvider;
            captureModel = typeof parsed?.model === 'string' ? parsed.model : null;
            captureSessionKey = resolveContextSessionKey(contextSessionKey, {
              provider: observedProvider, body: parsed, headers: request.headers,
            });
          }
          try {
            if (provider && transformProviderRequests && inspectionBody === rawBody) {
              const now = Date.now();
              const idleMs = lastRequestAt === null ? null : now - lastRequestAt;
              lastRequestAt = now;
              const transformed = transformProviderRequest({ provider, body: parsed, policy, idleMs });
              if (transformed.changed) body = Buffer.from(JSON.stringify(transformed.body));
              const mechanicalContextTrimmedBytes = Math.max(0, rawBody.length - body.length);
              recordProxyTelemetry({
                env, provider, transformed,
                beforeText: rawBody.toString('utf8'), afterText: body.toString('utf8'),
              });
              lastStats = { provider, ...transformed.stats, mechanicalContextTrimmedBytes, changed: transformed.changed, reasons: transformed.reasons };
              recordProvider = provider;
              recordModel = typeof parsed?.model === 'string' ? parsed.model : null;
              recordStats = { ...transformed.stats, mechanicalContextTrimmedBytes };
              if (typeof semanticCompactor === 'function') {
                const candidates = listSemanticCandidates({ provider, body: transformed.body });
                const stats = createSemanticStats(candidates);
                lastStats.semantic = stats;
                setImmediate(() => observeSemanticCandidates({ provider, candidates, semanticCompactor, stats }));
              }
            }
          } catch {
            recordProxyFailure({ env, provider, failureStage: 'optimization' });
            body = rawBody;
          }
        }
      }
      let response;
      try {
        response = await fetch(targetUrl(upstreamUrl, request.url), {
          method: request.method,
          headers: forwardedHeaders(request),
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
          redirect: 'manual',
        });
      } catch {
        recordProxyFailure({ env, provider: failureProvider, failureStage: 'upstream' });
        if (!outgoing.headersSent) jsonResponse(outgoing, 502, { error: 'sando proxy upstream failure' });
        else outgoing.destroy();
        return;
      }
      let responseText = '';
      try {
        const observeResponse = metricsPath || (contextCapturePath && captureProvider);
        await pipeResponse(response, outgoing, observeResponse ? (chunk) => { responseText += chunk; } : undefined);
      } catch {
        recordProxyFailure({ env, provider: failureProvider, failureStage: 'response' });
        if (!outgoing.headersSent) jsonResponse(outgoing, 502, { error: 'sando proxy upstream failure' });
        else outgoing.destroy();
        return;
      }
      if (metricsPath && recordProvider) {
        try {
          recordProxyRequest({
            storagePath: metricsPath, provider: recordProvider, model: recordModel,
            stats: recordStats, usage: extractUsage(responseText),
          });
        } catch { /* metrics are best-effort and must never affect the proxied response */ }
      }
      persistCapture({
        provider: captureProvider,
        body: parsed,
        rawBody: inspectionBody,
        sessionKey: captureSessionKey,
        model: captureModel,
        providerUsage: extractUsage(responseText),
      });
    } catch (error) {
      recordProxyFailure({ env, provider: failureProvider, failureStage: 'response' });
      if (!outgoing.headersSent) jsonResponse(outgoing, error.message === 'request body exceeds proxy limit' ? 413 : 502, { error: 'sando proxy upstream failure' });
      else outgoing.destroy();
    }
  });

  server.on('upgrade', async (request, client, head) => {
    upgradedSockets.add(client);
    let upstreamSocket;
    let established = false;
    let closed = false;
    let upstreamBuffer = Buffer.alloc(0);
    const clientQueue = head?.length ? [Buffer.from(head)] : [];
    let requestBody = null;
    let requestBodyRaw = null;
    let requestSessionKey = null;
    let requestModel = null;
    let responseUsage = null;
    let captured = false;

    const captureMessage = (text, direction) => {
      if (!contextCapturePath) return;
      if (direction === 'client') {
        let parsed;
        try { parsed = JSON.parse(text); } catch { return; }
        const candidate = findResponsesRequest(parsed);
        if (!candidate) return;
        requestBody = candidate;
        requestBodyRaw = Buffer.from(JSON.stringify(candidate), 'utf8');
        requestModel = typeof candidate.model === 'string' ? candidate.model : null;
        requestSessionKey = resolveContextSessionKey(contextSessionKey, {
          provider: 'openai-responses', body: candidate, headers: request.headers,
        });
      } else {
        const usage = extractUsage(text);
        if (usage) responseUsage = { ...responseUsage, ...usage };
        if (websocketCompletion(text)) {
          captured = persistCapture({
            provider: 'openai-responses',
            body: requestBody,
            rawBody: requestBodyRaw,
            sessionKey: requestSessionKey,
            model: requestModel,
            providerUsage: responseUsage,
          });
        }
      }
    };

    const inspectClient = websocketInspector((text) => captureMessage(text, 'client'));
    const inspectUpstream = websocketInspector((text) => captureMessage(text, 'upstream'));

    const destroy = () => {
      if (closed) return;
      closed = true;
      client.destroy();
      upstreamSocket?.destroy();
    };

    const forwardQueuedClientData = () => {
      for (const chunk of clientQueue.splice(0)) {
        inspectClient(chunk);
        if (!upstreamSocket.destroyed) upstreamSocket.write(chunk);
      }
    };

    const onClientData = (chunk) => {
      if (!established) {
        clientQueue.push(Buffer.from(chunk));
        return;
      }
      inspectClient(chunk);
      if (!upstreamSocket.destroyed) upstreamSocket.write(chunk);
    };

    client.on('data', onClientData);
    client.once('error', destroy);
    client.once('close', () => {
      upgradedSockets.delete(client);
      if (!captured) persistCapture({
        provider: 'openai-responses', body: requestBody, rawBody: requestBodyRaw,
        sessionKey: requestSessionKey, model: requestModel, providerUsage: responseUsage,
      });
      destroy();
    });

    try {
      const target = targetUrl(upstreamUrl, request.url);
      upstreamSocket = await connectWebSocketUpstream(target);
      upgradedSockets.add(upstreamSocket);
      upstreamSocket.once('error', destroy);
      upstreamSocket.once('close', () => {
        upgradedSockets.delete(upstreamSocket);
        if (!closed) client.destroy();
      });
      const upgrade = websocketUpgradeRequest(request, target);
      let handshakeComplete = false;
      upstreamSocket.on('data', (chunk) => {
        if (!handshakeComplete) {
          upstreamBuffer = upstreamBuffer.length === 0 ? chunk : Buffer.concat([upstreamBuffer, chunk]);
          if (upstreamBuffer.length > MAX_WEBSOCKET_HANDSHAKE_BYTES) {
            destroy();
            return;
          }
          const boundary = upstreamBuffer.indexOf('\r\n\r\n');
          if (boundary < 0) return;
          const handshake = upstreamBuffer;
          upstreamBuffer = Buffer.alloc(0);
          handshakeComplete = /^HTTP\/1\.1 101\b/m.test(handshake.subarray(0, boundary).toString('latin1'));
          client.write(handshake);
          if (!handshakeComplete) {
            destroy();
            return;
          }
          established = true;
          inspectUpstream(handshake.subarray(boundary + 4));
          forwardQueuedClientData();
          return;
        }
        inspectUpstream(chunk);
        if (!client.destroyed) client.write(chunk);
      });
      upstreamSocket.write(upgrade);
    } catch {
      destroy();
      return;
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
    close: () => new Promise((resolve, reject) => {
      for (const socket of upgradedSockets) socket.destroy();
      server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    }),
  };
}
