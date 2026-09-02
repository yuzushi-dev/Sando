import { CONTEXT_CATEGORIES } from './context-footprint.mjs';

const CATEGORY_SET = new Set(CONTEXT_CATEGORIES);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonBytes(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
  } catch {
    return 0;
  }
}

function nameOf(value) {
  return typeof value?.name === 'string' ? value.name : '';
}

function deferred(value) {
  return value?.defer_loading === true
    || value?.deferred === true
    || value?.deferLoading === true;
}

function toolCategory(tool) {
  const name = nameOf(tool).toLowerCase();
  if (name.includes('sando') || name.startsWith('sando_')) return 'sando';
  if (deferred(tool)) return 'mcp-deferred';
  if (name.startsWith('mcp__') || name.startsWith('mcp_')) return 'mcp-direct';
  return 'builtin-tools';
}

function without(value, keys) {
  if (!object(value)) return value;
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

function hasToolOutput(item) {
  const type = typeof item?.type === 'string' ? item.type.toLowerCase() : '';
  return item?.role === 'tool'
    || type === 'tool_result'
    || type.endsWith('_tool_call_output')
    || type.endsWith('function_call_output')
    || Object.hasOwn(item ?? {}, 'output');
}

function addSegment(segments, budget, category, value) {
  if (!CATEGORY_SET.has(category)) return budget;
  const bytes = Math.min(jsonBytes(value), budget);
  if (bytes > 0) segments.push({ category, bytes });
  return budget - bytes;
}

function classifyAnthropic(body, segments, budget) {
  const handled = new Set(['system', 'tools', 'messages']);
  if (Object.hasOwn(body, 'system')) budget = addSegment(segments, budget, 'host-instructions', body.system);

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      budget = addSegment(segments, budget, toolCategory(tool), tool);
    }
  }

  if (Array.isArray(body.messages)) {
    let currentUser = -1;
    body.messages.forEach((message, index) => {
      if (message?.role === 'user' && !hasToolOutput(message)) currentUser = index;
    });
    body.messages.forEach((message, index) => {
      const category = index === currentUser ? 'user-prompt' : 'history';
      budget = addSegment(segments, budget, category, message);
    });
  }

  for (const [key, value] of Object.entries(body)) {
    if (!handled.has(key)) budget = addSegment(segments, budget, 'provider-overhead', value);
  }
  return budget;
}

function codexMessageCategory(item, currentUser) {
  if (item?.role === 'developer' || item?.role === 'system') return 'host-instructions';
  if (currentUser && item === currentUser) return 'user-prompt';
  return 'history';
}

function classifyCodex(body, segments, budget) {
  const handled = new Set(['instructions', 'input', 'tools']);
  if (Object.hasOwn(body, 'instructions')) budget = addSegment(segments, budget, 'host-instructions', body.instructions);

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) budget = addSegment(segments, budget, toolCategory(tool), tool);
  }

  if (Array.isArray(body.input)) {
    let currentUser = null;
    for (const item of body.input) {
      if (object(item) && item.role === 'user' && !hasToolOutput(item)) currentUser = item;
    }
    for (const item of body.input) {
      if (!object(item)) {
        budget = addSegment(segments, budget, 'provider-overhead', item);
        continue;
      }
      if (Array.isArray(item.tools)) {
        for (const tool of item.tools) budget = addSegment(segments, budget, toolCategory(tool), tool);
      }
      const message = Object.hasOwn(item, 'content')
        ? without(item, ['content', 'tools'])
        : without(item, ['tools']);
      const messageCategory = hasToolOutput(item)
        ? 'history'
        : codexMessageCategory(item, currentUser);
      if (Object.hasOwn(item, 'content')) {
        budget = addSegment(segments, budget, messageCategory, item.content);
        budget = addSegment(segments, budget, 'provider-overhead', message);
      } else {
        budget = addSegment(segments, budget, 'provider-overhead', message);
      }
    }
  }

  for (const [key, value] of Object.entries(body)) {
    if (!handled.has(key)) budget = addSegment(segments, budget, 'provider-overhead', value);
  }
  return budget;
}

export function classifyContextRequest({ provider, body } = {}) {
  const segments = [];
  if (!object(body)) return { segments };
  const bodyBytes = jsonBytes(body);
  let budget = bodyBytes;
  if (provider === 'anthropic') budget = classifyAnthropic(body, segments, budget);
  else if (provider === 'openai-responses') budget = classifyCodex(body, segments, budget);
  return { segments, unclassifiedBytes: budget };
}
