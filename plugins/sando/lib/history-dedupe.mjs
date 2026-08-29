const DUPLICATE = '[sando duplicate historical result]';
const TOOLS = new Set(['read', 'exec', 'grep', 'bash']);

function canonical(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (typeof value !== 'object' || seen.has(value)) return null;

  seen.add(value);
  let result = null;
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return null;
      const item = canonical(value[index], seen);
      if (item === null) return null;
      items.push(item);
    }
    result = `[${items.join(',')}]`;
  } else if ([Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.getOwnPropertySymbols(value).length === 0) {
    const items = [];
    for (const key of Object.keys(value).sort()) {
      const item = canonical(value[key], seen);
      if (item === null) return null;
      items.push(`${JSON.stringify(key)}:${item}`);
    }
    result = `{${items.join(',')}}`;
  }
  seen.delete(value);
  return result;
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output) || output.length === 0
    || !output.every((block) => ['text', 'input_text'].includes(block?.type) && typeof block.text === 'string')) return null;
  return output.map((block) => block.text).join('');
}

function error(entry, text) {
  return entry.isError === true || Object.hasOwn(entry, 'error')
    || ['error', 'failed'].includes(entry.status)
    || /^\s*(?:error|failed|failure)\b[:\s-]*/i.test(text);
}

function identity(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.id !== 'string' || entry.id.length === 0 || typeof entry.toolName !== 'string') return null;
  const tool = entry.toolName.toLowerCase();
  if (!TOOLS.has(tool)) return null;
  if (entry.input === null || (typeof entry.input !== 'object' && typeof entry.input !== 'string') || Array.isArray(entry.input)) return null;
  const input = canonical(entry.input);
  const output = canonical(entry.output);
  const text = outputText(entry.output);
  if (input === null || output === null || text === null || error(entry, text)) return null;
  return `${tool}\0${input}\0${output}`;
}

function elide(output) {
  if (typeof output === 'string') return DUPLICATE;
  return output.map((block, index) => ({ ...block, text: index === 0 ? DUPLICATE : '' }));
}

function serializedBytes(value) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? Infinity : Buffer.byteLength(serialized);
}

export function dedupeHistory(entries) {
  if (!Array.isArray(entries)) return { entries, deduplicated: 0 };

  const idCounts = new Map();
  for (const entry of entries) {
    if (typeof entry?.id === 'string' && entry.id.length > 0) {
      idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
    }
  }

  const seen = new Set();
  const result = [...entries];
  let deduplicated = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (idCounts.get(entry?.id) !== 1) continue;
    const key = identity(entry);
    if (key === null) continue;
    if (seen.has(key) && entry.current !== true) {
      const replacement = elide(entry.output);
      if (serializedBytes(replacement) >= serializedBytes(entry.output)) continue;
      result[index] = { ...entry, output: replacement };
      deduplicated += 1;
    } else {
      seen.add(key);
    }
  }
  return { entries: result, deduplicated };
}
