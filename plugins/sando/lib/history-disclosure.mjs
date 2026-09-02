import { createHash } from 'node:crypto';

import { createRedactionProfile } from './redaction-profile.mjs';

export const HISTORY_DISCLOSURE_SCHEMA = 'sando-history-disclosure/v1';
export const HISTORY_DISCLOSURE_VERSION = 1;
const DEFAULT_PROFILE = createRedactionProfile();

function digest(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function typeOf(toolName) {
  const name = toolName.toLowerCase();
  if (name === 'read') return 'read';
  if (name === 'grep') return 'grep';
  if (name === 'bash' || name === 'exec') return 'bash';
  if (name === 'log') return 'log';
  return 'mcp';
}

function bytes(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`);
  return value;
}

export function buildHistoryDisclosure({ toolName, reason, originalText, visibleText, recovery = 'rerun-tool', redactionProfile } = {}) {
  if (typeof toolName !== 'string' || !toolName.trim() || typeof reason !== 'string' || !reason
    || typeof originalText !== 'string' || typeof visibleText !== 'string') {
    throw new TypeError('history disclosure input is invalid');
  }
  if (!['rerun-tool', 'newer-result'].includes(recovery)) throw new TypeError('history disclosure recovery is invalid');
  const original = Buffer.byteLength(originalText, 'utf8');
  const profile = redactionProfile ?? DEFAULT_PROFILE;
  if (!profile || typeof profile.redact !== 'function') throw new TypeError('history disclosure redaction profile is invalid');
  const redactedText = profile.redact(originalText).text;
  const redacted = Buffer.byteLength(redactedText, 'utf8');
  const visible = Buffer.byteLength(visibleText, 'utf8');
  return {
    schema: HISTORY_DISCLOSURE_SCHEMA,
    version: HISTORY_DISCLOSURE_VERSION,
    type: typeOf(toolName),
    reason,
    provenanceDigest: digest(redactedText),
    bytes: {
      original: bytes(original, 'original bytes'),
      redacted: bytes(redacted, 'redacted bytes'),
      visible: bytes(visible, 'visible bytes'),
    },
    recovery: { mode: recovery, bounded: true },
  };
}

function stableJson(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) throw new TypeError('history disclosure must not be cyclic');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableJson(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

export function serializeHistoryDisclosure(report) {
  if (!report || report.schema !== HISTORY_DISCLOSURE_SCHEMA || report.version !== HISTORY_DISCLOSURE_VERSION) {
    throw new TypeError('history disclosure is invalid');
  }
  return stableJson(report);
}
