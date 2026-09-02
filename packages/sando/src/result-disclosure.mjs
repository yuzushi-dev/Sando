import { createHash } from 'node:crypto';

export const RESULT_DISCLOSURE_SCHEMA = 'sando-result-disclosure/v1';
export const RESULT_DISCLOSURE_VERSION = 1;
export const ARTIFACT_TOOL_NAME = 'sando_artifact_get';

function sha256(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function stableJson(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) throw new TypeError('result disclosure must not be cyclic');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableJson(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

function resultType(toolName) {
  const name = typeof toolName === 'string' ? toolName.toLowerCase() : '';
  if (name === 'read') return 'read';
  if (name === 'grep') return 'grep';
  if (name === 'bash' || name === 'exec') return 'bash';
  if (name === 'log') return 'log';
  return 'mcp';
}

function policyName(type, route) {
  if (type === 'read') return route === 'summary' ? 'read-structure' : 'read-bounded';
  if (type === 'grep') return 'grep-matches';
  if (type === 'bash') return 'bash-head-tail';
  if (type === 'log') return 'log-head-tail';
  return 'mcp-bounded';
}

function markers(inline, artifact) {
  const result = [];
  if (artifact) result.push('artifact-handle');
  if (inline.includes('[middle elided]')) result.push('middle-elision');
  if (inline.includes('[sando read structure:')) result.push('structure-preview');
  if (inline.includes('[sando repeated x')) result.push('repetition-elision');
  return result;
}

function bytes(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

export function buildResultDisclosure({
  toolName, route, reason, inline, redactedText, inputBytes, redactedBytes, artifact,
} = {}) {
  if (typeof toolName !== 'string' || !toolName || typeof route !== 'string' || !route
    || typeof reason !== 'string' || !reason || typeof inline !== 'string' || typeof redactedText !== 'string') {
    throw new TypeError('result disclosure input is invalid');
  }
  const original = bytes(inputBytes ?? Buffer.byteLength(redactedText), 'inputBytes');
  const redacted = bytes(redactedBytes ?? Buffer.byteLength(redactedText), 'redactedBytes');
  const visible = Buffer.byteLength(inline);
  const provenanceDigest = sha256(redactedText);
  if (artifact !== undefined && artifact !== null) {
    const validRef = typeof artifact.ref === 'string' && /^sando:sha256:[a-f0-9]{16,64}$/.test(artifact.ref);
    const refDigest = validRef ? artifact.ref.slice('sando:'.length) : null;
    const contentValid = artifact.content === undefined
      || (typeof artifact.content === 'string' && sha256(artifact.content) === provenanceDigest
        && Buffer.byteLength(artifact.content) === redacted);
    if (!validRef || typeof artifact.sourceDigest !== 'string'
      || artifact.sourceDigest !== provenanceDigest
      || !refDigest || !provenanceDigest.startsWith(refDigest)
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes !== redacted
      || !contentValid) {
      throw new TypeError('result artifact is invalid');
    }
  }
  const type = resultType(toolName);
  const recovery = !artifact && reason === 'artifact-admission-limit'
    ? { mode: 'unavailable', bounded: true }
    : undefined;
  return {
    schema: RESULT_DISCLOSURE_SCHEMA,
    version: RESULT_DISCLOSURE_VERSION,
    type,
    policy: policyName(type, route),
    route,
    reason,
    provenanceDigest,
    bytes: { original, redacted, visible },
    markers: markers(inline, artifact),
    ...(recovery ? { recovery } : {}),
    artifact: artifact ? {
      handle: artifact.ref,
      digest: artifact.sourceDigest,
      bytes: artifact.bytes,
      recovery: {
        tool: ARTIFACT_TOOL_NAME,
        command: `sando artifact get --ref ${artifact.ref} --max-bytes 65536`,
        bounded: true,
      },
    } : null,
  };
}

export function serializeResultDisclosure(report) {
  if (!report || report.schema !== RESULT_DISCLOSURE_SCHEMA) throw new TypeError('result disclosure is invalid');
  return stableJson(report);
}
