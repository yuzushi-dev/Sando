import { ARTIFACT_VIEW_NOTICE } from './artifact-recovery.mjs';
import { finalizeResultDelivery } from './result-disclosure.mjs';

export const DEFAULT_MCP_ENVELOPE_BYTES = 16 * 1024;
export const MIN_MCP_ENVELOPE_BYTES = 512;
export const MAX_MCP_ENVELOPE_BYTES = 1024 * 1024;
export const MCP_PROTOCOL_MAX_BYTES = MAX_MCP_ENVELOPE_BYTES;
export const MCP_ENVELOPE_ERROR_SCHEMA = 'sando-mcp-envelope-error/v1';
const MCP_ENVELOPE_POLICY_SCHEMA = Object.freeze({
  type: 'integer', minimum: MIN_MCP_ENVELOPE_BYTES, maximum: MAX_MCP_ENVELOPE_BYTES,
  default: DEFAULT_MCP_ENVELOPE_BYTES,
  description: 'Maximum UTF-8 bytes for the complete JSON-RPC response, including its trailing newline.',
});

function envelopeBytes(value) {
  return Buffer.byteLength(JSON.stringify(value)) + 1;
}

function encode(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function modelFacingText(exposed) {
  const text = exposed.inline ?? exposed.content;
  return exposed.disclosure?.scope === 'artifact-view' ? `${text}\n${ARTIFACT_VIEW_NOTICE}` : text;
}

function success(id, exposed) {
  return {
    jsonrpc: '2.0', id,
    result: {
      content: [{ type: 'text', text: modelFacingText(exposed) }],
      structuredContent: exposed,
      isError: false,
    },
  };
}

function budgetFailure(id, maxEnvelopeBytes, exposed) {
  const ref = exposed?.artifact?.ref ?? exposed?.handle;
  const recovery = typeof ref === 'string'
    ? { available: true, tool: 'sando_artifact_get', ref }
    : { available: false };
  return {
    jsonrpc: '2.0', id,
    result: {
      content: [{ type: 'text', text: 'Sando MCP result exceeded the aggregate envelope budget.' }],
      structuredContent: {
        schema: MCP_ENVELOPE_ERROR_SCHEMA,
        code: 'SANDO_MCP_ENVELOPE_BUDGET',
        maxEnvelopeBytes,
        recovery,
      },
      isError: true,
    },
  };
}

function minimalBudgetFailure(id, maxEnvelopeBytes) {
  return {
    jsonrpc: '2.0', id,
    error: {
      code: -32001,
      message: 'Sando MCP envelope budget exceeded; recovery metadata unavailable in envelope.',
      data: { maxEnvelopeBytes, recoveryAvailable: false },
    },
  };
}

function validateEnvelopeBytes(value) {
  if (!Number.isSafeInteger(value) || value < MIN_MCP_ENVELOPE_BYTES || value > MAX_MCP_ENVELOPE_BYTES) {
    throw new RangeError(`maxEnvelopeBytes must be an integer from ${MIN_MCP_ENVELOPE_BYTES} to ${MAX_MCP_ENVELOPE_BYTES}`);
  }
  return value;
}

export function extractMcpEnvelopePolicy(args) {
  const maxEnvelopeBytes = args?.policy?.maxEnvelopeBytes === undefined
    ? DEFAULT_MCP_ENVELOPE_BYTES
    : validateEnvelopeBytes(args.policy.maxEnvelopeBytes);
  if (!args?.policy || !Object.hasOwn(args.policy, 'maxEnvelopeBytes')) {
    return { args, maxEnvelopeBytes };
  }
  const policy = { ...args.policy };
  delete policy.maxEnvelopeBytes;
  const cleanArgs = { ...args };
  if (Object.keys(policy).length === 0) delete cleanArgs.policy;
  else cleanArgs.policy = policy;
  return { args: cleanArgs, maxEnvelopeBytes };
}

export function declareMcpEnvelopePolicy(tools) {
  return tools.map((tool) => {
    const inputSchema = tool.inputSchema ?? { type: 'object' };
    const properties = inputSchema.properties ?? {};
    if (!properties.policy) return tool;
    const policy = properties.policy;
    return {
      ...tool,
      inputSchema: {
        ...inputSchema,
        properties: {
          ...properties,
          policy: {
            ...policy,
            properties: { ...(policy.properties ?? {}), maxEnvelopeBytes: MCP_ENVELOPE_POLICY_SCHEMA },
          },
        },
      },
    };
  });
}

export function serializeMcpToolResult({ id, result, expose, maxEnvelopeBytes = DEFAULT_MCP_ENVELOPE_BYTES }) {
  validateEnvelopeBytes(maxEnvelopeBytes);
  if (!result || typeof result !== 'object' || typeof expose !== 'function') throw new TypeError('MCP result delivery input is invalid');
  const exposed = expose(result);
  const initial = success(id, exposed);
  if (envelopeBytes(initial) <= maxEnvelopeBytes) return encode(initial);

  let best;
  if (result.artifact && typeof result.inline === 'string') {
    let low = 1;
    let high = Buffer.byteLength(result.inline);
    while (low <= high) {
      const inlineBudget = Math.floor((low + high) / 2);
      try {
        const compacted = finalizeResultDelivery(result, { inline: result.inline, maxInlineBytes: inlineBudget });
        const candidate = success(id, expose(compacted));
        if (envelopeBytes(candidate) <= maxEnvelopeBytes) {
          best = candidate;
          low = inlineBudget + 1;
        } else {
          high = inlineBudget - 1;
        }
      } catch (cause) {
        if (cause?.code !== 'SANDO_OUTPUT_BUDGET') throw cause;
        low = inlineBudget + 1;
      }
    }
  }
  if (best) return encode(best);

  const failure = budgetFailure(id, maxEnvelopeBytes, exposed);
  if (envelopeBytes(failure) <= maxEnvelopeBytes) return encode(failure);
  let minimal = minimalBudgetFailure(id, maxEnvelopeBytes);
  if (envelopeBytes(minimal) > maxEnvelopeBytes) minimal = minimalBudgetFailure(null, maxEnvelopeBytes);
  if (envelopeBytes(minimal) <= maxEnvelopeBytes) return encode(minimal);
  throw new RangeError('maxEnvelopeBytes cannot contain a JSON-RPC error envelope');
}

export function serializeMcpToolError({ id, message, maxEnvelopeBytes = DEFAULT_MCP_ENVELOPE_BYTES }) {
  validateEnvelopeBytes(maxEnvelopeBytes);
  const text = typeof message === 'string' && message ? message : 'invalid tool input';
  const source = Buffer.from(text);
  let high = source.length;
  let low = 0;
  let best;
  while (low <= high) {
    const byteLimit = Math.floor((low + high) / 2);
    let end = Math.min(byteLimit, source.length);
    while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
    const candidate = {
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: source.subarray(0, end).toString('utf8') }], isError: true },
    };
    if (envelopeBytes(candidate) <= maxEnvelopeBytes) {
      best = candidate;
      low = byteLimit + 1;
    } else {
      high = byteLimit - 1;
    }
  }
  if (best) return encode(best);
  let minimal = minimalBudgetFailure(id, maxEnvelopeBytes);
  if (envelopeBytes(minimal) > maxEnvelopeBytes) minimal = minimalBudgetFailure(null, maxEnvelopeBytes);
  return encode(minimal);
}

export function serializeMcpPassthroughResult({ id, result, maxEnvelopeBytes = DEFAULT_MCP_ENVELOPE_BYTES }) {
  validateEnvelopeBytes(maxEnvelopeBytes);
  const candidate = { jsonrpc: '2.0', id, result };
  if (envelopeBytes(candidate) <= maxEnvelopeBytes) return encode(candidate);
  const failure = budgetFailure(id, maxEnvelopeBytes);
  if (envelopeBytes(failure) <= maxEnvelopeBytes) return encode(failure);
  let minimal = minimalBudgetFailure(id, maxEnvelopeBytes);
  if (envelopeBytes(minimal) > maxEnvelopeBytes) minimal = minimalBudgetFailure(null, maxEnvelopeBytes);
  return encode(minimal);
}

export function serializeMcpRpcError({ id, code, message, data, maxEnvelopeBytes = DEFAULT_MCP_ENVELOPE_BYTES }) {
  validateEnvelopeBytes(maxEnvelopeBytes);
  const candidate = { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
  if (envelopeBytes(candidate) <= maxEnvelopeBytes) return encode(candidate);
  const withoutData = { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  if (envelopeBytes(withoutData) <= maxEnvelopeBytes) return encode(withoutData);
  let minimal = minimalBudgetFailure(id ?? null, maxEnvelopeBytes);
  if (envelopeBytes(minimal) > maxEnvelopeBytes) minimal = minimalBudgetFailure(null, maxEnvelopeBytes);
  return encode(minimal);
}

export function serializeMcpProtocolResponse({ response, maxEnvelopeBytes = MCP_PROTOCOL_MAX_BYTES }) {
  validateEnvelopeBytes(maxEnvelopeBytes);
  if (!response || typeof response !== 'object') throw new TypeError('MCP protocol response is invalid');
  if (envelopeBytes(response) <= maxEnvelopeBytes) return encode(response);
  const id = response.id ?? null;
  let minimal = minimalBudgetFailure(id, maxEnvelopeBytes);
  if (envelopeBytes(minimal) > maxEnvelopeBytes) minimal = minimalBudgetFailure(null, maxEnvelopeBytes);
  return encode(minimal);
}
