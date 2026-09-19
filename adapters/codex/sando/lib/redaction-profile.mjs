import { createHash } from 'node:crypto';

const BUILT_IN_MATCHERS = Object.freeze([
  [/-----BEGIN [A-Z ]+ KEY-----[\s\S]*?-----END [A-Z ]+ KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED TOKEN]'],
  [/\bgh[pousr]_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_-]{20,}\b/g, '[REDACTED TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED TOKEN]'],
]);
const PROFILE_SCHEMA = 'sando-redaction-profile-v1';
const MAX_CUSTOM_RULES = 100;
const MAX_NAME_LENGTH = 64;
const MAX_TOKEN_LENGTH = 4096;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const REDACTION_WORD = 'REDACTED';
const REDACTION_PLACEHOLDER = `[${REDACTION_WORD}]`;
const REDACTION_VALUE = String.raw`\[${REDACTION_WORD}(?: (?:PRIVATE KEY|TOKEN))?\]`;
const ASSIGNMENT_VALUE = String.raw`${REDACTION_VALUE}(?=$|[\s,"'}])|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\\n])*(?=\n|$)|'(?:\\.|[^'\\\n])*(?=\n|$)|[^\s,"'}]+`;

function isRedactionPlaceholder(value) {
  const unquoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) ? value.slice(1, -1) : value;
  return new RegExp(`^${REDACTION_VALUE}$`).test(unquoted);
}

function redactAssignment(prefix, value) {
  if (isRedactionPlaceholder(value)) return `${prefix}${value}`;
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
  return `${prefix}${quote}${REDACTION_PLACEHOLDER}${quote}`;
}

function assignmentMatcher(keyPattern) {
  return [
    new RegExp(`(${keyPattern}\\s*[:=]\\s*)(${ASSIGNMENT_VALUE})`, 'gi'),
    (_match, prefix, value) => redactAssignment(prefix, value),
  ];
}

const AUTHORIZATION_MATCHER = [
  new RegExp(
    '(["\\\']?authorization["\\\']?\\s*[:=]\\s*(?:(?:bearer|basic)\\s+)?' + ')(' + ASSIGNMENT_VALUE + ')',
    'gi',
  ),
  (_match, prefix, value) => redactAssignment(prefix, value),
];
const AUTHORIZATION_FIELD_MATCHER = [
  new RegExp(
    '(["\\\']?authorization["\\\']?\\s*[:=]\\s*)(?!(?:\\s*)(?:bearer|basic)\\s+)('
      + '"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|[^\\r\\n]+)',
    'gi',
  ),
  (_match, prefix, value) => {
    const leading = value.match(/^\s*/u)?.[0] ?? '';
    const withoutLeading = value.slice(leading.length);
    const trailing = withoutLeading.match(/\s*$/u)?.[0] ?? '';
    const body = trailing ? withoutLeading.slice(0, -trailing.length) : withoutLeading;
    return `${prefix}${leading}${redactAssignment('', body)}${trailing}`;
  },
];
const BUILT_IN_ASSIGNMENT_MATCHER = assignmentMatcher(
  String.raw`["']?(?:api[_-]?key|access[_-]?token|password|secret|private[_-]?key)["']?`,
);

function compareCanonical(left, right) {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeRules(customRules) {
  if (!Array.isArray(customRules)) throw new TypeError('customRules must be an array');
  if (customRules.length > MAX_CUSTOM_RULES) throw new TypeError('customRules must contain at most 100 rules');
  const identities = new Set();
  const normalized = customRules.map((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(rule))) {
      throw new TypeError('each custom rule must be a plain object');
    }
    let result;
    let identity;
    if (rule.type === 'assignment-key') {
      const allowed = new Set(['type', 'key']);
      if (Reflect.ownKeys(rule).some((field) => typeof field !== 'string' || !allowed.has(field))
        || typeof rule.key !== 'string'
        || !new RegExp(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,${MAX_NAME_LENGTH - 1}}$`).test(rule.key)) {
        throw new TypeError('invalid assignment-key rule');
      }
      const key = rule.key.toLowerCase();
      result = { type: rule.type, key };
      identity = `${rule.type}:${key}`;
    } else if (rule.type === 'token-prefix') {
      const allowed = new Set(['type', 'prefix', 'minLength', 'maxLength']);
      if (Reflect.ownKeys(rule).some((field) => typeof field !== 'string' || !allowed.has(field))
        || typeof rule.prefix !== 'string'
        || !new RegExp(`^[\\x21-\\x7e]{1,${MAX_NAME_LENGTH}}$`).test(rule.prefix)) {
        throw new TypeError('invalid token-prefix rule');
      }
      const minLength = Object.hasOwn(rule, 'minLength') ? rule.minLength : 12;
      const maxLength = Object.hasOwn(rule, 'maxLength') ? rule.maxLength : null;
      if (!Number.isSafeInteger(minLength) || minLength < 1 || minLength > MAX_TOKEN_LENGTH
        || (maxLength !== null
          && (!Number.isSafeInteger(maxLength) || maxLength < minLength || maxLength > MAX_TOKEN_LENGTH))
        || (Object.hasOwn(rule, 'maxLength') && rule.maxLength === null)) {
        throw new TypeError('invalid token-prefix lengths');
      }
      result = { type: rule.type, prefix: rule.prefix, minLength, maxLength };
      identity = `${rule.type}:${rule.prefix}`;
    } else {
      throw new TypeError('unsupported custom rule type');
    }
    if (identities.has(identity)) throw new TypeError('duplicate custom rule');
    identities.add(identity);
    return result;
  });
  return normalized.sort(compareCanonical);
}

function customMatchers(rules) {
  const assignments = [];
  const tokens = [];
  for (const rule of rules) {
    if (rule.type === 'assignment-key') {
    const key = escapeRegExp(rule.key);
      assignments.push(assignmentMatcher(
        String.raw`(?<![A-Za-z0-9_.-])["']?${key}["']?`,
      ));
    } else {
      const maximum = rule.maxLength === null ? '' : rule.maxLength;
      tokens.push([
        new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(rule.prefix)}[A-Za-z0-9_-]{${rule.minLength},${maximum}}(?![A-Za-z0-9_-])`, 'g'),
        '[REDACTED]',
      ]);
    }
  }
  return { assignments, tokens };
}

function applyMatchers(text, matchers) {
  let count = 0;
  for (const [pattern, replacement] of matchers) {
    text = text.replace(pattern, (...args) => {
      const next = typeof replacement === 'function' ? replacement(...args) : replacement;
      if (next !== args[0]) count += 1;
      return next;
    });
  }
  return { text, count };
}

export function createRedactionProfile(customRules = []) {
  const rules = normalizeRules(customRules);
  const custom = customMatchers(rules);
  const matchers = [
    BUILT_IN_MATCHERS[0],
    AUTHORIZATION_FIELD_MATCHER,
    AUTHORIZATION_MATCHER,
    BUILT_IN_ASSIGNMENT_MATCHER,
    ...custom.assignments,
    ...BUILT_IN_MATCHERS.slice(1),
    ...custom.tokens,
  ];
  const digest = `sha256:${createHash('sha256')
    .update(JSON.stringify({ schema: PROFILE_SCHEMA, customRules: rules }))
    .digest('hex')}`;
  const redact = (text) => {
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    return applyMatchers(text, matchers);
  };
  const redactStructured = (value) => {
    const ancestors = new Set();
    const visit = (item) => {
      if (typeof item === 'string') {
        const result = redact(item);
        return { value: result.text, count: result.count };
      }
      if (item === null || typeof item === 'boolean' || typeof item === 'number') {
        return { value: item, count: 0 };
      }
      if (typeof item !== 'object'
        || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) {
        throw new TypeError('value must contain only plain objects, arrays, and JSON primitives');
      }
      if (ancestors.has(item)) throw new TypeError('value must not be cyclic');
      ancestors.add(item);
      let count = 0;
      const entries = Object.entries(item).map(([key, child]) => {
        const result = visit(child);
        count += result.count;
        return [key, result.value];
      });
      ancestors.delete(item);
      return {
        value: Array.isArray(item) ? entries.map(([, child]) => child) : Object.fromEntries(entries),
        count,
      };
    };
    return visit(value);
  };
  return {
    digest,
    redact,
    redactStructured,
    hasSecret(text) {
      return redact(text).count > 0;
    },
  };
}
