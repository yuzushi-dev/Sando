export function compactHistoricalStructure({ toolName, text, historical, isError }) {
  const normalizedTool = typeof toolName === 'string' ? toolName.toLowerCase() : '';
  if (!historical || isError || (normalizedTool !== 'bash' && normalizedTool !== 'log')) return text;

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
