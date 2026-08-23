import { createHash } from 'node:crypto';

const DEFAULT_POLICY = Object.freeze({
  mode: 'apply', maxInlineBytes: 4096, maxArtifactBytes: 65536, headBytes: undefined, tailBytes: undefined,
  maxColumns: 768, redact: true,
});
const POLICY_FIELDS = new Set(Object.keys(DEFAULT_POLICY));

function sha256(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function stableJson(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) throw new Error('output must not be cyclic');
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = `[${value.map((item) => stableJson(item, seen)).join(',')}]`;
  else result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

function textOutput(output) {
  if (typeof output === 'string') return output;
  const value = stableJson(output);
  if (value === undefined) throw new Error('output must be a string or JSON value');
  return value;
}

function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let output = '';
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

function suffixUtf8(text, maxBytes) {
  let bytes = 0;
  const characters = [];
  for (const character of [...text].reverse()) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    characters.push(character);
    bytes += size;
  }
  return characters.reverse().join('');
}

function truncateLine(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  if (maxBytes <= 1) return '~';
  return `${truncateUtf8(text, maxBytes - 1)}~`;
}

function capColumns(text, maxColumns) {
  if (!maxColumns) return text;
  return text.split('\n').map((line) => truncateLine(line, maxColumns)).join('\n');
}

function middleView(text, maxBytes, headBytes, tailBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = '[middle elided]';
  const markerBytes = Buffer.byteLength(marker);
  if (maxBytes <= markerBytes) return truncateUtf8(marker, maxBytes);
  const available = maxBytes - markerBytes;
  const requested = Math.max(1, headBytes) + Math.max(1, tailBytes);
  const head = Math.max(1, Math.floor(available * Math.max(1, headBytes) / requested));
  const tail = Math.max(1, available - head);
  return `${truncateUtf8(text, head)}${marker}${suffixUtf8(text, tail)}`;
}

function inlineView(text, maxBytes, headBytes, tailBytes, maxColumns) {
  return middleView(capColumns(text, maxColumns), maxBytes, headBytes, tailBytes);
}

function redact(text) {
  let count = 0;
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      count += 1;
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    });
  };
  replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,"'}]+/gi, (_match, prefix) => `${prefix}[REDACTED]`);
  replace(/(["']?(?:api[_-]?key|access[_-]?token|password|secret|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, (_match, prefix) => `${prefix}[REDACTED]`);
  return { text, count };
}

export function estimateTokens(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  return text.length === 0 ? 0 : Math.ceil(Buffer.byteLength(text) / 4);
}

export function normalizePolicy(policy = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || Object.keys(policy).some((key) => !POLICY_FIELDS.has(key))) throw new Error('invalid policy');
  const result = { ...DEFAULT_POLICY, ...policy };
  result.headBytes = result.headBytes ?? Math.floor(result.maxInlineBytes * 0.6);
  result.tailBytes = result.tailBytes ?? Math.floor(result.maxInlineBytes * 0.25);
  if (!['apply', 'dry-run', 'observe'].includes(result.mode)
    || !Number.isInteger(result.maxInlineBytes) || result.maxInlineBytes < 64 || result.maxInlineBytes > 1_048_576
    || !Number.isInteger(result.maxArtifactBytes) || result.maxArtifactBytes < 256 || result.maxArtifactBytes > 16_777_216
    || !Number.isInteger(result.headBytes) || result.headBytes < 1
    || !Number.isInteger(result.tailBytes) || result.tailBytes < 1
    || result.headBytes + result.tailBytes > result.maxInlineBytes
    || !Number.isInteger(result.maxColumns) || result.maxColumns < 1 || result.maxColumns > 1_048_576
    || typeof result.redact !== 'boolean') throw new Error('invalid policy');
  return result;
}

export function optimizeToolOutput({ toolName, output, cwd, policy } = {}) {
  if (typeof toolName !== 'string' || !toolName.trim() || toolName.length > 128) throw new Error('toolName is invalid');
  if (typeof cwd !== 'string' || !cwd) throw new Error('cwd is invalid');
  const normalizedPolicy = normalizePolicy(policy);
  const input = textOutput(output);
  const redacted = normalizedPolicy.redact ? redact(input) : { text: input, count: 0 };
  const sourceBytes = Buffer.byteLength(redacted.text);
  let inline = redacted.text;
  let artifact;
  const hasLongLine = normalizedPolicy.maxColumns > 0
    && redacted.text.split('\n').some((line) => Buffer.byteLength(line) > normalizedPolicy.maxColumns);
  if (sourceBytes > normalizedPolicy.maxInlineBytes || hasLongLine) {
    const sourceDigest = sha256(redacted.text);
    artifact = {
      schema: 'sando-artifact/v1',
      ref: `sando:${sourceDigest.slice(0, 23)}`,
      digest: sourceDigest,
      sourceDigest,
      mediaType: 'text/plain; charset=utf-8',
      content: redacted.text,
      bytes: sourceBytes,
      sourceBytes,
      truncated: false,
    };
    const header = `artifact ${artifact.ref} ${artifact.bytes}B\n`;
    const viewBudget = Math.max(1, normalizedPolicy.maxInlineBytes - Buffer.byteLength(header));
    inline = `${truncateUtf8(header, normalizedPolicy.maxInlineBytes)}${inlineView(
      redacted.text,
      viewBudget,
      normalizedPolicy.headBytes,
      normalizedPolicy.tailBytes,
      normalizedPolicy.maxColumns,
    )}`;
    inline = truncateUtf8(inline, normalizedPolicy.maxInlineBytes);
  }
  const stats = {
    mode: normalizedPolicy.mode,
    inputBytes: Buffer.byteLength(input),
    redactedBytes: sourceBytes,
    inlineBytes: Buffer.byteLength(inline),
    artifactBytes: artifact?.bytes ?? 0,
    estimatedInputTokens: estimateTokens(input),
    estimatedInlineTokens: estimateTokens(inline),
    redactions: redacted.count,
    artifactTruncated: artifact?.truncated ?? false,
  };
  return artifact ? { inline, artifact, stats } : { inline, stats };
}

export function normalizeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('event must be an object');
  const event = {
    eventName: input.hook_event_name ?? input.hookEventName ?? input.event_name ?? input.eventName,
    toolName: input.tool_name ?? input.toolName,
    output: input.tool_response ?? input.toolResponse ?? input.tool_output ?? input.toolOutput ?? input.output,
    cwd: input.cwd,
    sessionId: input.session_id ?? input.sessionId ?? input.thread_id ?? input.threadId
      ?? input.conversation_id ?? input.conversationId,
    eventId: input.event_id ?? input.eventId ?? input.uuid ?? input.id,
    client: input.client ?? input.client_name ?? input.clientName,
    clientVersion: input.client_version ?? input.clientVersion,
    model: input.model ?? input.model_name ?? input.modelName,
    timestamp: input.timestamp ?? input.event_timestamp ?? input.eventTimestamp
      ?? input.occurred_at ?? input.occurredAt,
    providerUsage: input.provider_usage ?? input.providerUsage,
  };
  if (typeof event.eventName !== 'string' || typeof event.toolName !== 'string'
    || event.output === undefined || typeof event.cwd !== 'string' || !event.cwd) throw new Error('event is incomplete');
  for (const field of ['sessionId', 'eventId', 'client', 'clientVersion', 'model', 'timestamp', 'providerUsage']) {
    if (event[field] === undefined) delete event[field];
  }
  return event;
}

export function createReceipt({ host, event, optimization } = {}) {
  if (typeof host !== 'string' || !host || !event || !optimization?.stats) throw new Error('receipt input is invalid');
  const body = {
    schema: 'sando-receipt/v1', host, eventName: event.eventName, toolName: event.toolName,
    sessionId: event.sessionId ?? null, inputDigest: sha256(textOutput(event.output)),
    inlineDigest: sha256(optimization.inline), artifactRef: optimization.artifact?.ref ?? null, stats: optimization.stats,
  };
  return { ...body, digest: sha256(stableJson(body)) };
}
