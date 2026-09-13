import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

import { planToolRoute, ROUTING_POLICY_VERSION } from './routing.mjs';
import { loadProjectRedactionProfile } from './redaction-config.mjs';
import { buildResultDisclosure } from './result-disclosure.mjs';

const DEFAULT_POLICY = Object.freeze({
  mode: 'apply', maxInlineBytes: 4096, maxArtifactBytes: 1_048_576, headBytes: undefined, tailBytes: undefined,
  maxColumns: 768, redact: true,
});
const POLICY_FIELDS = new Set(Object.keys(DEFAULT_POLICY));
const SEVERE_DIAGNOSTIC_LINE = /\b(?:error|fail(?:ed|ure)?|exception|fatal|panic|traceback|assertion)\b/i;
const WARNING_LINE = /\bwarning\b/i;
// A test runner puts its totals in the middle of its own output as often as at the end — node's
// TAP summary lands there whenever a second suite follows. Eliding those lines leaves a model
// reading a plausible but partial count, with nothing to signal that a block went missing.
const SUMMARY_LINE = /^\s*(?:#\s*(?:tests|pass|fail|skipped|todo|cancelled|suites)\b|test result:|(?:Tests|Test Suites):\s|=+[^=]*\b\d+\s+(?:passed|failed)\b)/i;
const MAX_DIAGNOSTIC_LINES = 8;
// Summaries get a reserved share: in a TAP stream most test names contain "error" or "fail", so
// severe lines would otherwise crowd out the totals that actually answer the question.
const MAX_SUMMARY_LINES = 4;
// A TAP block prints seven counters and only three of them answer "did it pass": keeping the
// block in source order would spend the quota on `cancelled` and `todo`.
const HEADLINE_SUMMARY_LINE = /^\s*(?:#\s*(?:tests|pass|fail)\b|test result:|Tests:\s)/i;
const MAX_DIAGNOSTIC_LINE_BYTES = 256;

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

function resolveRedactionProfile(cwd, candidate) {
  const profile = candidate ?? loadProjectRedactionProfile(cwd).profile;
  if (!profile || typeof profile.redact !== 'function' || typeof profile.digest !== 'string') {
    throw new TypeError('redactionProfile is invalid');
  }
  return profile;
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

function middleView(text, maxBytes, headBytes, tailBytes, salvageDiagnostics) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = '[middle elided]';
  const markerBytes = Buffer.byteLength(marker);
  if (maxBytes <= markerBytes) return truncateUtf8(marker, maxBytes);
  const available = maxBytes - markerBytes;
  const requested = Math.max(1, headBytes) + Math.max(1, tailBytes);
  if (!salvageDiagnostics) {
    const head = Math.max(1, Math.floor(available * Math.max(1, headBytes) / requested));
    const tail = Math.max(1, available - head);
    return `${truncateUtf8(text, head)}${marker}${suffixUtf8(text, tail)}`;
  }
  const totalBytes = Buffer.byteLength(text);
  const diagnosticBudget = Math.max(0, Math.floor(available / 2) - 2);
  const minimumEdgeBytes = available - diagnosticBudget - 2;
  const minimumHead = Math.max(1, Math.floor(minimumEdgeBytes * Math.max(1, headBytes) / requested));
  const minimumTail = Math.max(1, minimumEdgeBytes - minimumHead);
  const summaries = [];
  const severe = [];
  const warnings = [];
  let offset = 0;
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const lineBytes = Buffer.byteLength(line);
    if (offset >= minimumHead && offset + lineBytes <= totalBytes - minimumTail) {
      if (SUMMARY_LINE.test(line)) summaries.push(line);
      else if (SEVERE_DIAGNOSTIC_LINE.test(line)) severe.push(line);
      else if (WARNING_LINE.test(line)) warnings.push(line);
    }
    offset += lineBytes + (index < lines.length - 1 ? 1 : 0);
  }
  const keptSummaries = [
    ...summaries.filter((line) => HEADLINE_SUMMARY_LINE.test(line)),
    ...summaries.filter((line) => !HEADLINE_SUMMARY_LINE.test(line)),
  ].slice(0, MAX_SUMMARY_LINES);
  const diagnostics = [];
  let diagnosticBytes = 0;
  for (const line of [...keptSummaries, ...severe, ...warnings].slice(0, MAX_DIAGNOSTIC_LINES)) {
    const separatorBytes = diagnostics.length ? 1 : 0;
    const remaining = diagnosticBudget - diagnosticBytes - separatorBytes;
    if (remaining < 1) break;
    const salvaged = truncateLine(line, Math.min(MAX_DIAGNOSTIC_LINE_BYTES, remaining));
    diagnostics.push(salvaged);
    diagnosticBytes += separatorBytes + Buffer.byteLength(salvaged);
  }
  const diagnosticBlock = diagnostics.length ? `\n${diagnostics.join('\n')}\n` : '';
  const edgeBytes = available - Buffer.byteLength(diagnosticBlock);
  const head = Math.max(1, Math.floor(edgeBytes * Math.max(1, headBytes) / requested));
  const tail = Math.max(1, edgeBytes - head);
  return `${truncateUtf8(text, head)}${marker}${diagnosticBlock}${suffixUtf8(text, tail)}`;
}

function inlineView(text, maxBytes, headBytes, tailBytes, maxColumns, salvageDiagnostics) {
  return middleView(capColumns(text, maxColumns), maxBytes, headBytes, tailBytes, salvageDiagnostics);
}

const DECLARATION_REGEX = /^\s*(?:import\b|from\b|export\b|use\b|package\b|(?:async\s+)?(?:def|function)\b|class\b|interface\b|trait\b|impl\b|struct\b|enum\b|namespace\b|module\b|type\b|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|func\b|(?:pub(?:\([^)]+\))?\s+)?fn\b|(?:(?:public|private|protected|static|abstract|async|get|set)\s+)+[A-Za-z_$][\w$]*\s*\(|@[A-Za-z_])/;

function structuralRead(text) {
  const lines = text.split('\n');
  const selected = lines.flatMap((line, index) => DECLARATION_REGEX.test(line) ? [`${index + 1}:${line}`] : []);
  if (!selected.length) return null;
  if (lines.length >= 100 && selected.length < 2) return null;
  const outline = `[sando read structure: ${selected.length}/${lines.length} lines]\n${selected.join('\n')}`;
  return Buffer.byteLength(outline) + 64 < Buffer.byteLength(text) ? outline : null;
}

function collapseRepeatedLines(text) {
  const lines = text.split('\n');
  const compacted = [];
  for (let index = 0; index < lines.length;) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) end += 1;
    const count = end - index;
    if (count >= 3 && lines[index] !== '') {
      compacted.push(lines[index], `[sando repeated x${count}]`);
    } else {
      compacted.push(...lines.slice(index, end));
    }
    index = end;
  }
  const result = compacted.join('\n');
  return Buffer.byteLength(result) + 32 < Buffer.byteLength(text) ? result : text;
}

function readSelector(toolInput) {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return false;
  return ['offset', 'limit', 'line_start', 'line_end', 'start_line', 'end_line']
    .some((key) => Object.hasOwn(toolInput, key));
}

const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.mts', '.cts', '.tsx',
  '.py', '.pyw',
  '.go',
  '.rs',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx',
  '.java', '.kt', '.kts', '.scala',
  '.cs', '.fs',
  '.rb',
  '.php',
  '.swift',
  '.sh', '.bash', '.zsh',
  '.sql',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.vue', '.svelte',
  '.lua', '.zig', '.nim',
]);

const STRUCTURED_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.toml', '.xml', '.csv',
]);

function parseReadCommand(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  const match = /^(?:cat|head|tail|sed)\b\s*(.*)$/.exec(trimmed);
  if (!match) return null;
  const rest = match[1];
  if (/[|><;]/.test(rest)) return null;
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const last = tokens[tokens.length - 1];
  const cleanedPath = last.replace(/^['"]|['"]$/g, '');
  const isSedSelector = /^sed\b/.test(trimmed) && /-n\b/.test(trimmed);
  const isHeadOrTail = /^(?:head|tail)\b/.test(trimmed);
  return {
    filePath: cleanedPath,
    selector: isSedSelector || isHeadOrTail,
  };
}

function resolveSourceClass({ toolName, toolInput }) {
  const name = typeof toolName === 'string' ? toolName.toLowerCase() : '';
  if (name === 'grep') return { sourceClass: 'structured', selector: false, filePath: null };
  let filePath = null;
  let isSelector = false;
  if (name === 'read') {
    filePath = toolInput?.file_path ?? toolInput?.filePath ?? toolInput?.path ?? null;
    isSelector = readSelector(toolInput);
  } else if (name === 'bash') {
    const cmd = typeof toolInput?.command === 'string' ? toolInput.command : null;
    const parsed = cmd ? parseReadCommand(cmd) : null;
    if (parsed) {
      filePath = parsed.filePath;
      isSelector = parsed.selector;
    } else {
      return { sourceClass: 'process-output', selector: false, filePath: null };
    }
  } else {
    return { sourceClass: 'generic', selector: false, filePath: null };
  }

  if (filePath) {
    const dotIndex = filePath.lastIndexOf('.');
    if (dotIndex !== -1) {
      const ext = filePath.slice(dotIndex).toLowerCase();
      if (STRUCTURED_EXTENSIONS.has(ext)) return { sourceClass: 'structured-data', selector: isSelector, filePath };
      if (ext === '.log' || filePath.endsWith('.min.js') || ext === '.map') return { sourceClass: 'bulk', selector: isSelector, filePath };
      if (SOURCE_EXTENSIONS.has(ext)) return { sourceClass: 'source', selector: isSelector, filePath };
    }
  }
  return { sourceClass: 'source', selector: isSelector, filePath };
}

const SOURCE_CLASS_LIMITS = Object.freeze({
  source: Object.freeze({
    maxInlineBytes: 32 * 1024,
    headBytes: 20 * 1024,
    tailBytes: 10 * 1024,
  }),
  'structured-data': Object.freeze({
    maxInlineBytes: 8 * 1024,
    headBytes: 5 * 1024,
    tailBytes: 2 * 1024,
  }),
  'process-output': Object.freeze({
    maxInlineBytes: 4 * 1024,
    headBytes: 2457,
    tailBytes: 1024,
  }),
  bulk: Object.freeze({
    maxInlineBytes: 4 * 1024,
    headBytes: 2048,
    tailBytes: 1024,
  }),
  generic: Object.freeze({
    maxInlineBytes: 4 * 1024,
    headBytes: 2457,
    tailBytes: 1024,
  }),
});

// Appends the recovery command to the `[sando] artifact ...` line so the model reading a bounded
// result can see how to get the rest back. Space for it was reserved before the view was cut.
function withRecoveryHint(inline, artifact, elidedRange) {
  const header = `[sando] artifact ${artifact.ref} ${artifact.bytes}B`;
  if (!inline.startsWith(header)) return inline;
  const range = elidedRange && Number.isInteger(elidedRange.startLine) && Number.isInteger(elidedRange.endLine)
    ? ` --start-line ${elidedRange.startLine} --end-line ${elidedRange.endLine}`
    : ' --max-bytes 65536';
  return `${header} recover: sando artifact get --ref ${artifact.ref}${range}${inline.slice(header.length)}`;
}

function calculateElidedRange(fullText, inlineText) {
  const marker = '[middle elided]';
  const markerIndex = inlineText.indexOf(marker);
  if (markerIndex === -1) return null;
  const headPart = inlineText.slice(0, markerIndex);
  const tailPart = inlineText.slice(markerIndex + marker.length);
  const totalLines = fullText.split('\n').length;
  const headLines = headPart.split('\n').length;
  const tailLines = tailPart.split('\n').length;
  const startLine = Math.max(1, headLines);
  const endLine = Math.max(startLine, totalLines - tailLines + 1);
  return { startLine, endLine };
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

export function optimizeToolOutput({
  toolName, output, cwd, policy, selector, raw, lineCount, fileBytes, prose, summarizeProse,
  summarizeEnabled, grepScope, outputBytes, toolInput, redactionProfile,
} = {}) {
  if (typeof toolName !== 'string' || !toolName.trim() || toolName.length > 128) throw new Error('toolName is invalid');
  if (typeof cwd !== 'string' || !cwd) throw new Error('cwd is invalid');
  const normalizedPolicy = normalizePolicy(policy);
  const input = textOutput(output);
  const name = toolName.toLowerCase();
  const { sourceClass, selector: detectedSelector } = resolveSourceClass({ toolName, toolInput });
  const isTargetedSelector = selector ?? (detectedSelector || readSelector(toolInput));
  let baseInlineBudget = normalizedPolicy.maxInlineBytes;
  let baseHeadBytes = normalizedPolicy.headBytes;
  let baseTailBytes = normalizedPolicy.tailBytes;

  if (sourceClass === 'source' || sourceClass === 'structured-data') {
    const classLimit = SOURCE_CLASS_LIMITS[sourceClass];
    const hasCustomInline = policy !== undefined && policy !== null
      && Object.hasOwn(policy, 'maxInlineBytes')
      && policy.maxInlineBytes !== DEFAULT_POLICY.maxInlineBytes;
    if (!hasCustomInline) {
      baseInlineBudget = classLimit.maxInlineBytes;
      if (!policy || !Object.hasOwn(policy, 'headBytes')) baseHeadBytes = classLimit.headBytes;
      if (!policy || !Object.hasOwn(policy, 'tailBytes')) baseTailBytes = classLimit.tailBytes;
    }
  }
  const derivedLineCount = lineCount ?? (name === 'read' ? input.split(/\r?\n/).length : lineCount);
  const derivedFileBytes = fileBytes ?? (name === 'read' ? Buffer.byteLength(input) : fileBytes);
  let route = planToolRoute({
    toolName, selector: isTargetedSelector, raw: raw ?? toolInput?.raw === true,
    lineCount: derivedLineCount, fileBytes: derivedFileBytes, prose, summarizeProse, summarizeEnabled, grepScope,
    outputBytes: outputBytes ?? Buffer.byteLength(input),
  });
  const profile = normalizedPolicy.redact ? resolveRedactionProfile(cwd, redactionProfile) : null;
  const redacted = profile ? profile.redact(input) : { text: input, count: 0 };
  const cleanedPreview = name === 'bash' ? stripVTControlCharacters(redacted.text) : redacted.text;
  const previewRedacted = profile && name === 'bash'
    ? profile.redact(cleanedPreview)
    : { text: cleanedPreview, count: 0 };
  const previewText = previewRedacted.text;
  const sourceText = previewRedacted.count ? previewText : redacted.text;
  let modelText = name === 'bash' && normalizedPolicy.maxColumns >= 32
    ? collapseRepeatedLines(previewText)
    : previewText;
  const routePolicy = route.route === 'artifact' || route.route === 'structured'
    ? {
      ...normalizedPolicy,
      maxInlineBytes: Math.min(baseInlineBudget, route.route === 'artifact' ? (route.limits.headBytes + route.limits.tailBytes) : baseInlineBudget),
      ...(route.route === 'artifact' ? {
        headBytes: Math.min(baseHeadBytes, route.limits.headBytes),
        tailBytes: Math.min(baseTailBytes, route.limits.tailBytes),
      } : {
        headBytes: baseHeadBytes,
        tailBytes: baseTailBytes,
      }),
      maxColumns: Math.min(normalizedPolicy.maxColumns, route.limits.maxColumns),
    }
    : {
      ...normalizedPolicy,
      maxInlineBytes: baseInlineBudget,
      headBytes: baseHeadBytes,
      tailBytes: baseTailBytes,
    };
  const shouldSummarize = route.route === 'summary'
    || (sourceClass === 'source' && !isTargetedSelector && (derivedLineCount ?? 0) >= 100 && (outputBytes ?? Buffer.byteLength(input)) > routePolicy.maxInlineBytes);
  if (shouldSummarize) {
    const outline = structuralRead(previewText);
    if (outline) {
      modelText = outline;
      if (route.route !== 'summary') {
        route = { route: 'summary', modelVisible: 'elided-structure', source: 'sando-read-summarize' };
      }
    } else if (route.route === 'summary') {
      route = { route: 'passthrough', modelVisible: 'bounded-output', source: 'sando-read-bounded' };
    }
  }
  const sourceBytes = Buffer.byteLength(sourceText);
  let inline = modelText;
  let artifact;
  const artifactAdmitted = sourceBytes <= normalizedPolicy.maxArtifactBytes;
  const hasLongLine = routePolicy.maxColumns > 0
    && modelText.split('\n').some((line) => Buffer.byteLength(line) > routePolicy.maxColumns);
  let recoveryHintAffordable = false;
  if (!artifactAdmitted && (route.route === 'summary' || route.route === 'artifact'
    || sourceBytes > routePolicy.maxInlineBytes || hasLongLine)) {
    route = { route: 'passthrough', modelVisible: 'bounded-output', source: 'artifact-admission-limit' };
    inline = truncateUtf8(inlineView(
      modelText,
      routePolicy.maxInlineBytes,
      routePolicy.headBytes,
      routePolicy.tailBytes,
      routePolicy.maxColumns,
      name === 'bash',
    ), normalizedPolicy.maxInlineBytes);
  } else if (route.route === 'summary' || route.route === 'artifact' || sourceBytes > routePolicy.maxInlineBytes || hasLongLine) {
    const sourceDigest = sha256(sourceText);
    artifact = {
      schema: 'sando-artifact/v1',
      ref: `sando:${sourceDigest.slice(0, 23)}`,
      digest: sourceDigest,
      sourceDigest,
      mediaType: 'text/plain; charset=utf-8',
      content: sourceText,
      bytes: sourceBytes,
      sourceBytes,
      truncated: false,
    };
    // The recovery command has to reach the model, not just the disclosure object: on the CLI
    // surface the structured disclosure is never rendered, so a bare artifact path leaves the
    // model to improvise its way back to the elided middle. The exact line range is only known
    // after the view is cut, so reserve the widest header the range could need and rewrite it
    // once the range is settled -- reserving after the fact would push the payload over the cap.
    const header = `[sando] artifact ${artifact.ref} ${artifact.bytes}B\n`;
    const widestLineNumber = String(sourceText.split('\n').length).length;
    const reservedHeader = Buffer.byteLength(header)
      + Buffer.byteLength(` recover: sando artifact get --ref ${artifact.ref} --start-line  --end-line `)
      + (widestLineNumber * 2);
    // Under a tight cap the hint would cost more room than the content it points at, so it is
    // only affordable when the whole header stays a small fraction of the budget.
    recoveryHintAffordable = reservedHeader * 4 <= routePolicy.maxInlineBytes;
    const viewBudget = Math.max(1, routePolicy.maxInlineBytes - (recoveryHintAffordable ? reservedHeader : Buffer.byteLength(header)));
    const isOutline = typeof modelText === 'string' && modelText.startsWith('[sando read structure:');
    if (isOutline && Buffer.byteLength(modelText) <= viewBudget) {
      inline = `${truncateUtf8(header, routePolicy.maxInlineBytes)}${modelText}`;
    } else {
      inline = `${truncateUtf8(header, routePolicy.maxInlineBytes)}${inlineView(
        modelText,
        viewBudget,
        routePolicy.headBytes,
        routePolicy.tailBytes,
        routePolicy.maxColumns,
        name === 'bash',
      )}`;
    }
    inline = truncateUtf8(inline, routePolicy.maxInlineBytes);
  }
  const stats = {
    mode: normalizedPolicy.mode,
    inputBytes: Buffer.byteLength(input),
    redactedBytes: sourceBytes,
    inlineBytes: Buffer.byteLength(inline),
    artifactBytes: artifact?.bytes ?? 0,
    estimatedInputTokens: estimateTokens(input),
    estimatedInlineTokens: estimateTokens(inline),
    redactions: redacted.count + previewRedacted.count,
    artifactTruncated: artifact?.truncated ?? false,
  };
  const elidedRange = artifact && inline.includes('[middle elided]')
    ? calculateElidedRange(sourceText, inline)
    : undefined;
  if (artifact && recoveryHintAffordable) inline = withRecoveryHint(inline, artifact, elidedRange);
  const result = {
    inline, route: route.route, reason: route.source, policyVersion: ROUTING_POLICY_VERSION,
    redactionProfileDigest: profile?.digest ?? null, stats,
    disclosure: buildResultDisclosure({
      toolName, route: route.route, reason: route.source, inline,
      redactedText: sourceText, inputBytes: Buffer.byteLength(input), redactedBytes: sourceBytes, artifact,
      elidedRange,
    }),
  };
  if (artifact) result.artifact = artifact;
  return result;
}

export function normalizeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('event must be an object');
  const event = {
    eventName: input.hook_event_name ?? input.hookEventName ?? input.event_name ?? input.eventName,
    toolName: input.tool_name ?? input.toolName,
    toolInput: input.tool_input ?? input.toolInput,
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
  for (const field of ['toolInput', 'sessionId', 'eventId', 'client', 'clientVersion', 'model', 'timestamp', 'providerUsage']) {
    if (event[field] === undefined) delete event[field];
  }
  return event;
}

export function createReceipt({ host, event, optimization, replacement } = {}) {
  if (typeof host !== 'string' || !host || !event || !optimization?.stats) throw new Error('receipt input is invalid');
  const body = {
    schema: 'sando-receipt/v1', host, eventName: event.eventName, toolName: event.toolName,
    sessionId: event.sessionId ?? null, inputDigest: sha256(textOutput(event.output)),
    inlineDigest: sha256(textOutput(replacement === undefined ? optimization.inline : replacement)), artifactRef: optimization.artifact?.ref ?? null,
    route: optimization.route ?? 'passthrough', reason: optimization.reason ?? 'spike-default',
    policyVersion: optimization.policyVersion ?? ROUTING_POLICY_VERSION,
    redactionProfileDigest: optimization.redactionProfileDigest ?? null, stats: optimization.stats,
  };
  return { ...body, digest: sha256(stableJson(body)) };
}
