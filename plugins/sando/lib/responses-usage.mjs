const FIELDS = {
  inputTokens: ['input_tokens'],
  outputTokens: ['output_tokens'],
  cachedInputTokens: ['input_tokens_details.cached_tokens', 'cached_input_tokens', 'cache_read_input_tokens'],
  cacheWriteInputTokens: ['input_tokens_details.cache_write_tokens', 'cache_write_input_tokens'],
  reasoningOutputTokens: ['output_tokens_details.reasoning_tokens', 'reasoning_output_tokens'],
};

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Preserve legacy zero defaults only in usage. Quality records whether zero was observed.
// Nested fields take precedence when aliases agree; disagreement invalidates the record.
export function normalizeResponsesUsage(value) {
  const quality = { schema: 'sando-usage-quality/v1', status: 'complete', sources: {}, missing: [], errors: [] };
  const usage = {};
  if (!object(value)) {
    quality.errors.push({ code: 'invalid-usage' });
  } else {
    for (const name of ['input_tokens_details', 'output_tokens_details']) {
      if (value[name] !== undefined && !object(value[name])) quality.errors.push({ code: 'invalid-details', field: name });
    }
    for (const [name, paths] of Object.entries(FIELDS)) {
      const observed = paths.map((field) => ({ field, value: field.split('.').reduce((item, key) => item?.[key], value) }))
        .filter((item) => item.value !== undefined);
      if (!observed.length) {
        quality.missing.push(name);
        usage[name] = 0;
        if (name === 'inputTokens' || name === 'outputTokens') quality.errors.push({ code: 'missing-required-counter', field: name });
        continue;
      }
      quality.sources[name] = observed[0].field;
      usage[name] = observed[0].value;
      for (const item of observed) {
        if (!Number.isSafeInteger(item.value) || item.value < 0) quality.errors.push({ code: 'invalid-counter', field: item.field });
      }
      if (observed.some((item) => item.value !== observed[0].value)) quality.errors.push({ code: 'conflicting-aliases', field: name });
    }
    if (!quality.errors.length) {
      if (usage.cacheWriteInputTokens > usage.inputTokens
        || usage.cachedInputTokens > usage.inputTokens - usage.cacheWriteInputTokens) {
        quality.errors.push({ code: 'cache-exceeds-input' });
      }
      if (usage.reasoningOutputTokens > usage.outputTokens) quality.errors.push({ code: 'reasoning-exceeds-output' });
      const total = usage.inputTokens + usage.outputTokens;
      if (!Number.isSafeInteger(total)) quality.errors.push({ code: 'total-overflow' });
      if (value.total_tokens !== undefined
        && (!Number.isSafeInteger(value.total_tokens) || value.total_tokens < 0 || value.total_tokens !== total)) {
        quality.errors.push({ code: 'invalid-total', field: 'total_tokens' });
      }
      usage.totalTokens = total;
      usage.cacheReadInputTokens = usage.cachedInputTokens;
      if (typeof value.total_cost_usd === 'number' && Number.isFinite(value.total_cost_usd) && value.total_cost_usd >= 0) {
        usage.totalCostUsd = value.total_cost_usd;
      }
    }
  }
  quality.status = quality.errors.length ? 'invalid' : quality.missing.length ? 'incomplete' : 'complete';
  return { usage: quality.status === 'invalid' ? null : usage, quality };
}
