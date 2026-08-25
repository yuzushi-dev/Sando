const SCHEMA_VERSION = 1;
const MAX_STRING_LENGTH = 32;
const MAX_EVENT_BYTES = 2048;

const COUNT_BUCKETS = ['zero', 'one', '2_to_5', '6_to_20', 'gt_20'];
const BYTE_BUCKETS = ['lt_4k', '4_to_16k', '16_to_64k', 'gte_64k'];
const HOSTS = ['claude', 'codex'];
const MODES = ['enforce', 'observe'];
const YES_NO_UNKNOWN = ['yes', 'no', 'unknown'];

const SHARED_FIELDS = {
  schema_version: (value) => value === SCHEMA_VERSION,
  event: (value) => value === 'hook_summary' || value === 'proxy_summary',
  day_utc: (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
  plugin_version: (value) => typeof value === 'string' && /^\d+\.\d+$/.test(value) && value.length <= MAX_STRING_LENGTH,
  host: (value) => HOSTS.includes(value),
};

const HOOK_FIELDS = {
  mode: (value) => MODES.includes(value),
  tool_calls_bucket: (value) => COUNT_BUCKETS.includes(value),
  redactions_bucket: (value) => COUNT_BUCKETS.includes(value),
  capped_outputs_bucket: (value) => COUNT_BUCKETS.includes(value),
  bytes_saved_bucket: (value) => BYTE_BUCKETS.includes(value),
};

const PROXY_FIELDS = {
  rewrites_applied_bucket: (value) => COUNT_BUCKETS.includes(value),
  rewrites_skipped_cache_bucket: (value) => COUNT_BUCKETS.includes(value),
  input_tokens_saved_bucket: (value) => BYTE_BUCKETS.includes(value),
  prompt_cache_hit: (value) => YES_NO_UNKNOWN.includes(value),
};

function fieldsForEvent(eventType) {
  return eventType === 'hook_summary' ? HOOK_FIELDS : PROXY_FIELDS;
}

export function countBucket(count) {
  if (!Number.isInteger(count) || count < 0) throw new Error('countBucket: invalid count');
  if (count === 0) return 'zero';
  if (count === 1) return 'one';
  if (count <= 5) return '2_to_5';
  if (count <= 20) return '6_to_20';
  return 'gt_20';
}

export function byteBucket(bytes) {
  if (!Number.isInteger(bytes) || bytes < 0) throw new Error('byteBucket: invalid byte count');
  if (bytes < 4096) return 'lt_4k';
  if (bytes < 16384) return '4_to_16k';
  if (bytes < 65536) return '16_to_64k';
  return 'gte_64k';
}

export function validateEvent(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('event must be an object');
  if (!SHARED_FIELDS.event(payload.event)) throw new Error('event: unknown event type');
  const allowed = { ...SHARED_FIELDS, ...fieldsForEvent(payload.event) };
  for (const key of Object.keys(payload)) {
    if (!Object.hasOwn(allowed, key)) throw new Error(`unknown field: ${key}`);
  }
  for (const [key, check] of Object.entries(allowed)) {
    if (!Object.hasOwn(payload, key)) throw new Error(`missing field: ${key}`);
    if (typeof payload[key] === 'string' && payload[key].length > MAX_STRING_LENGTH) throw new Error(`${key}: string too long`);
    if (!check(payload[key])) throw new Error(`${key}: invalid value`);
  }
  return payload;
}

export function serializeEvent(payload) {
  validateEvent(payload);
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_EVENT_BYTES) throw new Error('event exceeds serialized size limit');
  return serialized;
}
