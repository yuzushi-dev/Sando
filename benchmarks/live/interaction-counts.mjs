function jsonDocuments(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  if (typeof value !== 'string' || !value.trim()) return [];
  try { return [JSON.parse(value)]; } catch {}
  return value.trim().split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function objects(value, result = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return result;
  seen.add(value);
  result.push(value);
  for (const child of Object.values(value)) objects(child, result, seen);
  return result;
}

function sandoName(value) {
  return typeof value === 'string' && (value.startsWith('sando_') || value.includes('__sando__'));
}

export function countInteractions(stdout, host) {
  if (!['claude', 'codex'].includes(host)) throw new TypeError('host must be claude or codex');
  const documents = jsonDocuments(stdout);
  const values = documents.flatMap((document) => objects(document));
  const toolCalls = values.filter((value) => {
    if (host === 'claude') return value.type === 'tool_use';
    return value.type === 'command_execution' || value.type === 'shell_command' || value.type === 'mcp_tool_call';
  });
  const nativeToolCalls = toolCalls.filter((value) => host === 'claude'
    ? !sandoName(value.name)
    : value.type === 'command_execution' || value.type === 'shell_command').length;
  const sandoMcpCalls = toolCalls.filter((value) => sandoName(value.name) || sandoName(value.tool)).length;
  const modelTurns = host === 'claude'
    ? documents.filter((value) => value?.type === 'assistant').length
    : documents.filter((value) => value?.type === 'turn.completed').length
      || documents.filter((value) => value?.type === 'turn.started').length;
  return { modelTurns, totalToolCalls: toolCalls.length, nativeToolCalls, sandoMcpCalls };
}
