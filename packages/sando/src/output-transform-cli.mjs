import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizePolicy, optimizeToolOutput } from './core.mjs';
import { storeArtifactInWorkspace } from './artifact-store.mjs';
import { finalizeResultDelivery } from './result-disclosure.mjs';

export const MODEL_OUTPUT_TRANSFORM_SCHEMA = 'sando-model-output-transform/v1';
export const MAX_MODEL_OUTPUT_PROTOCOL_BYTES = 1_048_576;

const SURFACES = new Set(['direct', 'code-mode-execute', 'code-mode-wait', 'code-mode-notify']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_KEYS = ['budget', 'cwd', 'deliveryId', 'recoveryDelivery', 'requestId', 'schema', 'segments', 'surface'];
const MAX_IDENTIFIER_BYTES = 1024;

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  return required.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => allowed.includes(key));
}

function identifier(value, name, pattern) {
  if (typeof value !== 'string' || !pattern.test(value) || Buffer.byteLength(value) > MAX_IDENTIFIER_BYTES) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

export function validateModelOutputTransformRequest(input) {
  if (!exactKeys(input, REQUEST_KEYS, ['tool'])) throw new TypeError('request shape is invalid');
  if (input.schema !== MODEL_OUTPUT_TRANSFORM_SCHEMA) throw new TypeError('request schema is invalid');
  identifier(input.requestId, 'requestId', UUID);
  identifier(input.deliveryId, 'deliveryId', UUID);
  if (!SURFACES.has(input.surface)) throw new TypeError('surface is invalid');
  if (typeof input.recoveryDelivery !== 'boolean') throw new TypeError('recoveryDelivery is invalid');
  if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || Buffer.byteLength(input.cwd) > 4096) {
    throw new TypeError('cwd is invalid');
  }
  if (!exactKeys(input.budget, ['maxResponseBytes'])
    || !Number.isSafeInteger(input.budget.maxResponseBytes)
    || input.budget.maxResponseBytes < 1
    || input.budget.maxResponseBytes > MAX_MODEL_OUTPUT_PROTOCOL_BYTES) {
    throw new TypeError('budget is invalid');
  }
  if (!Array.isArray(input.segments)) throw new TypeError('segments are invalid');
  for (const [expected, segment] of input.segments.entries()) {
    if (!exactKeys(segment, ['index', 'text']) || segment.index !== expected || typeof segment.text !== 'string') {
      throw new TypeError('segments are invalid');
    }
  }
  if (input.tool !== undefined) {
    if (!exactKeys(input.tool, ['name'], ['callId'])) throw new TypeError('tool identity is invalid');
    identifier(input.tool.name, 'tool name', /^.{1,128}$/su);
    if (input.tool.callId !== undefined) identifier(input.tool.callId, 'tool callId', /^.+$/su);
  }
  return input;
}

function policyFromEnvironment(env) {
  if (!env.SANDO_POLICY) return normalizePolicy({ mode: 'apply' });
  return normalizePolicy(JSON.parse(env.SANDO_POLICY));
}

function encode(response) {
  return JSON.stringify(response);
}

export function transformModelOutputRequest(input, { env = process.env } = {}) {
  const request = validateModelOutputTransformRequest(input);
  const empty = {
    schema: MODEL_OUTPUT_TRANSFORM_SCHEMA,
    requestId: request.requestId,
    edits: [],
  };
  if (Buffer.byteLength(encode(empty)) > request.budget.maxResponseBytes) {
    throw new RangeError('response budget cannot contain the protocol response');
  }
  if (request.recoveryDelivery || request.segments.length === 0) return empty;

  const policy = policyFromEnvironment(env);
  const toolName = request.tool?.name ?? 'model-output';
  const candidates = request.segments.map((segment) => {
    const optimization = optimizeToolOutput({
      toolName,
      output: segment.text,
      cwd: request.cwd,
      policy,
      recoveryStyle: 'mcp',
    });
    const delivered = finalizeResultDelivery(optimization, {
      inline: optimization.inline,
      maxInlineBytes: optimization.deliveryBudget,
    });
    return { index: segment.index, text: delivered.inline, artifact: delivered.artifact };
  }).filter((candidate) => candidate.text !== request.segments[candidate.index].text);

  const response = {
    ...empty,
    edits: candidates.map(({ index, text }) => ({ index, text })),
  };
  if (Buffer.byteLength(encode(response)) > request.budget.maxResponseBytes) return empty;

  for (const candidate of candidates) {
    if (candidate.artifact) storeArtifactInWorkspace({ cwd: request.cwd, artifact: candidate.artifact });
  }
  return response;
}

async function readInput(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_MODEL_OUTPUT_PROTOCOL_BYTES) {
      throw new RangeError(`request exceeds ${MAX_MODEL_OUTPUT_PROTOCOL_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

export async function runOutputTransformCli({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  try {
    const source = await readInput(stdin);
    const input = JSON.parse(source);
    const response = transformModelOutputRequest(input, { env });
    const output = encode(response);
    if (Buffer.byteLength(output) > input.budget.maxResponseBytes) throw new RangeError('response exceeds budget');
    stdout.write(output);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`sando output transform: ${message.slice(0, 900)}\n`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runOutputTransformCli();
}
