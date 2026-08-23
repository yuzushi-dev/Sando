function number(value) { return Number.isFinite(value) ? value : 0; }

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

function hasStatusOk(value, seen = new Set()) {
  if (typeof value === 'string') {
    try { return hasStatusOk(JSON.parse(value), seen); } catch { return false; }
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  if (value.status === 'ok') return true;
  seen.add(value);
  return Object.values(value).some((child) => hasStatusOk(child, seen));
}

export function hasOkStatus(stdout) {
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    try { if (hasStatusOk(JSON.parse(line))) return true; } catch {}
  }
  return false;
}

function redactDiagnostic(value) {
  return String(value ?? '').replace(/((?:api[_-]?key|authorization|password|secret)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|gh[pousr])-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
}

export function formatChildFailure(host, variant, result) {
  const details = redactDiagnostic([result?.stderr, result?.stdout].filter(Boolean).join('\n')).trim() || 'no diagnostic output';
  return `${host} ${variant} failed (${result?.code ?? result?.signal}): ${details.slice(-1000)}`;
}

export function parseClaudeUsage(stdout) {
  const value = JSON.parse(stdout);
  const usage = value?.usage;
  if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return null;
  const cacheCreationInputTokens = number(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = number(usage.cache_read_input_tokens);
  const inputTokens = usage.input_tokens + cacheCreationInputTokens + cacheReadInputTokens;
  const resolvedModel = findModel(value);
  return {
    inputTokens,
    uncachedInputTokens: usage.input_tokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens: usage.output_tokens,
    totalTokens: inputTokens + usage.output_tokens,
    ...(resolvedModel ? { resolvedModel } : {}),
  };
}

function findCodexUsage(value, inheritedModel = null) {
  if (!value || typeof value !== 'object') return null;
  const model = typeof value.model === 'string' && value.model ? value.model : inheritedModel;
  if (Number.isFinite(value.input_tokens) && Number.isFinite(value.output_tokens)) {
    return {
      inputTokens: value.input_tokens,
      cacheReadInputTokens: number(value.cached_input_tokens ?? value.cache_read_input_tokens),
      outputTokens: value.output_tokens,
      totalTokens: number(value.total_tokens) || value.input_tokens + value.output_tokens,
      ...(model ? { resolvedModel: model } : {}),
    };
  }
  for (const child of Object.values(value)) {
    const found = findCodexUsage(child, model);
    if (found) return found;
  }
  return null;
}

export function parseCodexUsage(stdout) {
  for (const line of stdout.trim().split('\n').filter(Boolean).reverse()) {
    try {
      const usage = findCodexUsage(JSON.parse(line));
      if (usage) return usage;
    } catch {}
  }
  return null;
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
