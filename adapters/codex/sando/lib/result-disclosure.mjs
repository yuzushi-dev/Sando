import { createHash } from 'node:crypto';

export const RESULT_DISCLOSURE_SCHEMA = 'sando-result-disclosure/v1';
export const RESULT_DISCLOSURE_VERSION = 1;
export const ARTIFACT_TOOL_NAME = 'sando_artifact_get';
export const DISPLAY_REDACTION_NOTICE = '[sando] display redacted; Sando did not sanitize source files';
const MIDDLE_ELISION = '[middle elided]';

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

function outputBudgetError(maxInlineBytes) {
  const error = new Error(`cannot fit mandatory metadata within ${maxInlineBytes}-byte output budget`);
  error.code = 'SANDO_OUTPUT_BUDGET';
  return error;
}

function utf8Prefix(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function utf8Suffix(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function compactBody(body, maxBytes, outerBudget) {
  if (Buffer.byteLength(body) <= maxBytes) return body;
  const marker = `\n${MIDDLE_ELISION}\n`;
  const markerBytes = Buffer.byteLength(marker);
  if (maxBytes < markerBytes) throw outputBudgetError(outerBudget);
  const markerIndex = body.indexOf(MIDDLE_ELISION);
  const head = (markerIndex === -1 ? body : body.slice(0, markerIndex)).replace(/\n+$/u, '');
  const tail = (markerIndex === -1 ? body : body.slice(markerIndex + MIDDLE_ELISION.length)).replace(/^\n+/u, '');
  const contentBudget = maxBytes - markerBytes;
  const headBudget = Math.ceil(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  return `${utf8Prefix(head, headBudget)}${marker}${utf8Suffix(tail, tailBudget)}`;
}

function bodyParts(body) {
  const markerIndex = body.indexOf(MIDDLE_ELISION);
  if (markerIndex === -1) return undefined;
  return {
    head: body.slice(0, markerIndex).replace(/\n+$/u, ''),
    tail: body.slice(markerIndex + MIDDLE_ELISION.length).replace(/^\n+/u, ''),
  };
}

function deliveredElidedRange(content, body, previous) {
  const parts = bodyParts(body);
  if (!parts || typeof content !== 'string') return undefined;
  const totalLines = content.split('\n').length;
  const visibleHeadLines = parts.head.split('\n').length;
  const visibleTailNewlines = (parts.tail.match(/\n/g) ?? []).length;
  const previousStart = Number.isInteger(previous?.startLine) ? previous.startLine : totalLines;
  const previousEnd = Number.isInteger(previous?.endLine) ? previous.endLine : 1;
  return {
    startLine: Math.min(totalLines, Math.max(1, Math.min(previousStart, visibleHeadLines))),
    endLine: Math.min(totalLines, Math.max(previousEnd, totalLines - visibleTailNewlines)),
  };
}

function recoveryHeader(header, elidedRange) {
  if (!header.includes(' recover: ')) return header;
  if (header.includes(' recover: sando_artifact_get ')) {
    const mcpSelector = elidedRange
      ? ` startLine=${elidedRange.startLine} endLine=${elidedRange.endLine}`
      : ' maxBytes=65536';
    if (/ startLine=\d+ endLine=\d+/u.test(header)) return header.replace(/ startLine=\d+ endLine=\d+/u, mcpSelector);
    if (/ maxBytes=\d+/u.test(header)) return header.replace(/ maxBytes=\d+/u, mcpSelector);
    return header;
  }
  const selector = elidedRange
    ? ` --start-line ${elidedRange.startLine} --end-line ${elidedRange.endLine}`
    : ' --max-bytes 65536';
  if (/ --start-line \d+ --end-line \d+/u.test(header)) {
    return header.replace(/ --start-line \d+ --end-line \d+/u, selector);
  }
  if (/ --max-bytes \d+/u.test(header)) return header.replace(/ --max-bytes \d+/u, selector);
  return header;
}

function compactArtifactDelivery(result, delivered, maxInlineBytes) {
  const lineEnd = delivered.indexOf('\n');
  if (lineEnd === -1) throw outputBudgetError(maxInlineBytes);
  const originalHeader = delivered.slice(0, lineEnd);
  const noticeSuffix = delivered.endsWith(`\n${DISPLAY_REDACTION_NOTICE}`)
    ? `\n${DISPLAY_REDACTION_NOTICE}` : '';
  const bodyEnd = noticeSuffix ? delivered.length - noticeSuffix.length : delivered.length;
  const originalBody = delivered.slice(lineEnd + 1, bodyEnd);
  let header = originalHeader;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const bodyBudget = maxInlineBytes - Buffer.byteLength(header) - Buffer.byteLength(noticeSuffix) - 1;
    if (bodyBudget < 0) throw outputBudgetError(maxInlineBytes);
    const body = compactBody(originalBody, bodyBudget, maxInlineBytes);
    const elidedRange = deliveredElidedRange(
      result.artifact.content, body, result.disclosure?.artifact?.elidedRange,
    );
    const updatedHeader = recoveryHeader(header, elidedRange);
    const candidate = `${updatedHeader}\n${body}${noticeSuffix}`;
    if (Buffer.byteLength(candidate) <= maxInlineBytes) return { inline: candidate, body, elidedRange };
    header = updatedHeader;
  }
  throw outputBudgetError(maxInlineBytes);
}

/** Reconciles byte/token metadata with the exact string delivered by a host. */
export function finalizeResultDelivery(result, { inline, maxInlineBytes } = {}) {
  if (!result || typeof result !== 'object' || typeof inline !== 'string'
    || !Number.isSafeInteger(maxInlineBytes) || maxInlineBytes < 1) {
    throw new TypeError('final result delivery input is invalid');
  }
  let delivered = inline;
  let deliveredBody;
  let elidedRange;
  if (result.artifact) {
    const digest = result.artifact.sourceDigest?.slice('sha256:'.length);
    const hasHandle = delivered.startsWith('[sando] artifact ')
      && (delivered.includes(result.artifact.ref) || (digest && delivered.includes(digest)));
    if (!hasHandle) throw outputBudgetError(maxInlineBytes);
  }
  if (Buffer.byteLength(delivered) > maxInlineBytes) {
    if (!result.artifact) throw outputBudgetError(maxInlineBytes);
    const compacted = compactArtifactDelivery(result, delivered, maxInlineBytes);
    delivered = compacted.inline;
    deliveredBody = compacted.body;
    elidedRange = compacted.elidedRange;
  }
  const visible = Buffer.byteLength(delivered);
  if (result.artifact && deliveredBody === undefined) {
    const lineEnd = delivered.indexOf('\n');
    const noticeSuffix = delivered.endsWith(`\n${DISPLAY_REDACTION_NOTICE}`)
      ? `\n${DISPLAY_REDACTION_NOTICE}` : '';
    deliveredBody = lineEnd === -1 ? '' : delivered.slice(lineEnd + 1, noticeSuffix ? -noticeSuffix.length : undefined);
    elidedRange = deliveredElidedRange(
      result.artifact.content, deliveredBody, result.disclosure?.artifact?.elidedRange,
    );
  }
  const markers = Array.isArray(result.disclosure?.markers) ? [...result.disclosure.markers] : [];
  const markerIndex = markers.indexOf('middle-elision');
  if (delivered.includes(MIDDLE_ELISION) && markerIndex === -1) markers.push('middle-elision');
  if (!delivered.includes(MIDDLE_ELISION) && markerIndex !== -1) markers.splice(markerIndex, 1);
  let disclosureArtifact;
  if (result.disclosure?.artifact) {
    const { elidedRange: _staleRange, ...artifactDisclosure } = result.disclosure.artifact;
    disclosureArtifact = { ...artifactDisclosure, ...(elidedRange ? { elidedRange } : {}) };
  }
  return {
    ...result,
    inline: delivered,
    stats: { ...result.stats, inlineBytes: visible, estimatedInlineTokens: visible === 0 ? 0 : Math.ceil(visible / 4) },
    ...(result.disclosure ? { disclosure: {
      ...result.disclosure,
      bytes: { ...result.disclosure.bytes, visible },
      markers,
      ...(disclosureArtifact ? { artifact: disclosureArtifact } : {}),
    } } : {}),
  };
}

export function buildResultDisclosure({
  toolName, route, reason, inline, redactedText, inputBytes, redactedBytes, artifact, elidedRange,
  redactionCount = 0,
} = {}) {
  if (typeof toolName !== 'string' || !toolName || typeof route !== 'string' || !route
    || typeof reason !== 'string' || !reason || typeof inline !== 'string' || typeof redactedText !== 'string') {
    throw new TypeError('result disclosure input is invalid');
  }
  const original = bytes(inputBytes ?? Buffer.byteLength(redactedText), 'inputBytes');
  const redacted = bytes(redactedBytes ?? Buffer.byteLength(redactedText), 'redactedBytes');
  const visible = Buffer.byteLength(inline);
  const substitutions = bytes(redactionCount, 'redactionCount');
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
  const recoveryCommand = artifact
    ? (elidedRange && Number.isInteger(elidedRange.startLine) && Number.isInteger(elidedRange.endLine)
      ? `sando artifact get --ref ${artifact.ref} --start-line ${elidedRange.startLine} --end-line ${elidedRange.endLine}`
      : `sando artifact get --ref ${artifact.ref} --max-bytes 65536`)
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
    ...(substitutions > 0 ? {
      redaction: { count: substitutions, scope: 'display', sourceModifiedBySando: false },
    } : {}),
    ...(recovery ? { recovery } : {}),
    artifact: artifact ? {
      handle: artifact.ref,
      digest: artifact.sourceDigest,
      bytes: artifact.bytes,
      recovery: {
        tool: ARTIFACT_TOOL_NAME,
        command: recoveryCommand,
        bounded: true,
      },
      ...(elidedRange ? { elidedRange } : {}),
    } : null,
  };
}

export function serializeResultDisclosure(report) {
  if (!report || report.schema !== RESULT_DISCLOSURE_SCHEMA) throw new TypeError('result disclosure is invalid');
  return stableJson(report);
}
