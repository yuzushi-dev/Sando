import { estimateTokens } from './core.mjs';

const SUPPORTED_TOOLS = new Set(['bash', 'exec', 'grep', 'log']);
const DEFAULT_MIN_TOKENS = 400;
const HEAD_LINES = 3;
const TAIL_LINES = 3;
const MAX_SIGNAL_LINES = 12;
const SIGNAL_LINE = /\b(?:error|failed|failure|fatal|panic|exception|warning|todo|fixme)\b/i;

function result(text, changed = false, compactedText = text) {
  return {
    text: compactedText,
    changed,
    originalTokens: estimateTokens(text),
    compactedTokens: estimateTokens(compactedText),
    originalLines: text.split('\n').length,
    compactedLines: compactedText.split('\n').length,
  };
}

function selectedLines(lines) {
  const selected = new Set();
  for (let index = 0; index < Math.min(HEAD_LINES, lines.length); index += 1) selected.add(index);
  for (let index = Math.max(0, lines.length - TAIL_LINES); index < lines.length; index += 1) selected.add(index);

  let signalCount = 0;
  for (let index = 0; index < lines.length && signalCount < MAX_SIGNAL_LINES; index += 1) {
    if (!SIGNAL_LINE.test(lines[index])) continue;
    selected.add(index);
    signalCount += 1;
  }
  return selected;
}

function compact(lines, selected) {
  const output = [];
  for (let index = 0; index < lines.length;) {
    if (selected.has(index)) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    const start = index;
    while (index < lines.length && !selected.has(index)) index += 1;
    output.push(`[sando history shake: ${index - start} lines elided; rerun tool if needed]`);
  }
  return output.join('\n');
}

export function shakeHistoricalResult({ toolName, text, historical, isError, minTokens = DEFAULT_MIN_TOKENS } = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!Number.isSafeInteger(minTokens) || minTokens <= 0) throw new TypeError('minTokens must be a positive safe integer');
  const normalizedTool = typeof toolName === 'string' ? toolName.toLowerCase() : '';
  const originalTokens = estimateTokens(text);
  if (!historical || isError === true || !SUPPORTED_TOOLS.has(normalizedTool) || originalTokens < minTokens) {
    return result(text);
  }

  const lines = text.split('\n');
  const selected = selectedLines(lines);
  if (selected.size >= lines.length) return result(text);

  const compacted = compact(lines, selected);
  if (Buffer.byteLength(compacted) >= Buffer.byteLength(text)) return result(text);
  return result(text, true, compacted);
}
