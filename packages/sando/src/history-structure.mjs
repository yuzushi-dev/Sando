// Matches history-shake.mjs's SUPPORTED_TOOLS. These two modules do variants of the
// same job — collapsing repetitive historical line output — and previously disagreed
// on which tools qualify: shake allowed exec/grep, this one did not. Codex reports
// tool results as `exec`/`grep`, so structural collapse could never run there, which
// is the whole reason the recorded Claude and Codex proxy runs show mirrored
// compactedStructures/shakenResults counts. This transform is the more conservative
// of the two (identical consecutive lines only, and it returns the original unless
// the result is strictly smaller), so anything shake may touch it may touch too.
const SUPPORTED_TOOLS = new Set(['bash', 'exec', 'grep', 'log']);

export function compactHistoricalStructure({ toolName, text, historical, isError }) {
  const normalizedTool = typeof toolName === 'string' ? toolName.toLowerCase() : '';
  if (!historical || isError || !SUPPORTED_TOOLS.has(normalizedTool)) return text;

  const lines = text.split('\n');
  const compacted = [];
  for (let index = 0; index < lines.length;) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) end += 1;
    const count = end - index;
    if (lines[index] && count > 1) compacted.push(lines[index], `[sando repeated x${count}]`);
    else compacted.push(...lines.slice(index, end));
    index = end;
  }

  const result = compacted.join('\n');
  return Buffer.byteLength(result) < Buffer.byteLength(text) ? result : text;
}
