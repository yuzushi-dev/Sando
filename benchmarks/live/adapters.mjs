function number(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

function requiredNumber(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

function reportedCost(value) {
  const candidates = [
    value?.total_cost_usd, value?.totalCostUsd, value?.cost_usd, value?.costUsd,
    value?.cost?.total_cost_usd, value?.cost?.totalCostUsd, value?.cost?.usd,
  ];
  return candidates.find((candidate) => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) ?? null;
}

function jsonDocuments(stdout, { tolerateMalformed = false } = {}) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  try { return [JSON.parse(stdout)]; } catch {}
  const documents = [];
  for (const line of stdout.trim().split('\n')) {
    try { documents.push(JSON.parse(line)); } catch { if (!tolerateMalformed) return null; }
  }
  return documents.length ? documents : null;
}

function findModel(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  if (typeof value.model === 'string' && value.model) return value.model;
  if (value.modelUsage && typeof value.modelUsage === 'object') {
    for (const usage of Object.values(value.modelUsage)) {
      if (usage && typeof usage.canonicalModel === 'string' && usage.canonicalModel) return usage.canonicalModel;
    }
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    const model = findModel(child, seen);
    if (model) return model;
  }
  return null;
}

function exactOkResponse(response) {
  if (typeof response !== 'string') return false;
  try {
    const value = JSON.parse(response);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 1 && value.status === 'ok';
  } catch { return false; }
}

export function hasOkStatus(stdout, host) {
  const documents = jsonDocuments(stdout);
  if (!documents?.length) return false;
  if (host === 'claude') {
    const terminal = documents.at(-1);
    return terminal?.type === 'result' && terminal?.subtype === 'success'
      && exactOkResponse(terminal.result);
  }
  if (host !== 'codex') return false;
  const terminal = documents.at(-1);
  if (terminal?.type !== 'turn.completed') return false;
  const assistant = documents.slice(0, -1).reverse().find((document) =>
    document?.type === 'item.completed' && document.item?.type === 'agent_message');
  return exactOkResponse(assistant?.item?.text);
}

function redactDiagnostic(value) {
  return String(value ?? '').replace(/((?:api[_-]?key|authorization|password|secret)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|gh[pousr])-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
}

export function formatChildFailure(host, variant, result) {
  const details = redactDiagnostic([result?.stderr, result?.stdout].filter(Boolean).join('\n')).trim() || 'no diagnostic output';
  return `${host} ${variant} failed (${result?.code ?? result?.signal}): ${details.slice(-1000)}`;
}

export function parseClaudeUsage(stdout, options) {
  const documents = jsonDocuments(stdout, options);
  const candidate = options?.tolerateMalformed
    ? documents?.slice().reverse().find((document) => document?.type === 'result')
    : documents?.at(-1);
  if (!candidate || typeof candidate !== 'object' || candidate.type !== 'result' || candidate.subtype !== 'success') return null;
  const usage = candidate?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const uncachedInputTokens = requiredNumber(usage?.input_tokens);
  const outputTokens = requiredNumber(usage?.output_tokens);
  if (uncachedInputTokens === null || outputTokens === null) return null;
  const cacheCreationInputTokens = usage.cache_creation_input_tokens === undefined
    ? 0 : number(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = usage.cache_read_input_tokens === undefined
    ? 0 : number(usage.cache_read_input_tokens);
  if (cacheCreationInputTokens === null || cacheReadInputTokens === null) return null;
  const inputTokens = [uncachedInputTokens, cacheCreationInputTokens, cacheReadInputTokens]
    .reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(inputTokens)) return null;
  const totalTokens = usage.total_tokens === undefined ? inputTokens + outputTokens : number(usage.total_tokens);
  if (totalTokens === null || !Number.isSafeInteger(totalTokens) || totalTokens !== inputTokens + outputTokens) return null;
  const resolvedModel = findModel(candidate);
  const reasoningOutputTokens = usage.reasoning_output_tokens === undefined
    ? undefined : number(usage.reasoning_output_tokens);
  if (reasoningOutputTokens === null) return null;
  const totalCostUsd = reportedCost(usage) ?? reportedCost(candidate);
  return {
    inputTokens,
    uncachedInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
    totalTokens,
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    ...(totalCostUsd === null ? {} : { totalCostUsd }),
    ...(resolvedModel ? { resolvedModel } : {}),
  };
}

export function parseCodexUsage(stdout) {
  const documents = jsonDocuments(stdout);
  const terminal = documents?.at(-1);
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal) || terminal.type !== 'turn.completed') return null;
  const usage = terminal.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const inputTokens = requiredNumber(usage.input_tokens);
  const outputTokens = requiredNumber(usage.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  const cacheReadInputTokens = usage.cached_input_tokens === undefined && usage.cache_read_input_tokens === undefined
    ? 0 : number(usage.cached_input_tokens ?? usage.cache_read_input_tokens);
  const hasCacheWrite = usage.cache_write_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;
  const cacheWriteInputTokens = !hasCacheWrite
    ? 0 : number(usage.cache_write_input_tokens ?? usage.cache_creation_input_tokens);
  const reasoningOutputTokens = usage.reasoning_output_tokens === undefined
    ? undefined : number(usage.reasoning_output_tokens);
  if (cacheReadInputTokens === null || cacheWriteInputTokens === null || reasoningOutputTokens === null
    || cacheReadInputTokens + cacheWriteInputTokens > inputTokens) return null;
  const totalTokens = usage.total_tokens === undefined ? inputTokens + outputTokens : requiredNumber(usage.total_tokens);
  if (!Number.isSafeInteger(inputTokens + outputTokens)
    || totalTokens === null || totalTokens !== inputTokens + outputTokens) return null;
  const model = typeof terminal.model === 'string' && terminal.model ? terminal.model : null;
  return {
    inputTokens,
    cacheReadInputTokens,
    outputTokens,
    totalTokens,
    ...(hasCacheWrite ? {
      uncachedInputTokens: inputTokens - cacheReadInputTokens - cacheWriteInputTokens,
      cacheCreationInputTokens: cacheWriteInputTokens,
      cacheWriteInputTokens,
    } : {}),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    ...(reportedCost(usage) === null && reportedCost(terminal) === null ? {} : { totalCostUsd: reportedCost(usage) ?? reportedCost(terminal) }),
    ...(model ? { resolvedModel: model } : {}),
  };
}

export function buildClaudeArgs({ prompt, model, maxBudgetUsd }) {
  if (typeof prompt !== 'string' || !prompt) throw new TypeError('prompt is required');
  return [
    ...(model ? ['--model', model] : []),
    '--print', '--no-session-persistence', '--disable-slash-commands', '--no-chrome',
    '--tools', '', '--permission-mode', 'plan', '--strict-mcp-config', '--output-format', 'json',
    ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : []), prompt,
  ];
}

export function buildCodexArgs({ prompt, model }) {
  if (typeof prompt !== 'string' || !prompt) throw new TypeError('prompt is required');
  return [
    'exec', ...(model ? ['--model', model] : []), '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--json', prompt,
  ];
}
