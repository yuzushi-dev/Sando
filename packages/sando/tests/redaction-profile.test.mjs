import assert from 'node:assert/strict';
import test from 'node:test';

import { createRedactionProfile } from '../src/redaction-profile.mjs';

test('redacts every built-in secret shape', () => {
  const profile = createRedactionProfile();
  const pem = '-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----';
  const input = [
    pem,
    'sk-abcdefghijkl',
    'rk-abcdefghijkl',
    'ghp_abcdefghijkl',
    'github_pat_abcdefghijklmnopqrst',
    'AKIAABCDEFGHIJKLMNOP',
    'Authorization: Bearer bearer-value',
    'api_key=assigned-value',
    'apikey=assigned-value',
    'api-key=assigned-value',
    'access_token=assigned-value',
    'access-token=assigned-value',
    'password=assigned-value',
    'secret=assigned-value',
    'private_key=assigned-value',
    'private-key=assigned-value',
  ].join('\n');

  assert.deepEqual(profile.redact(input), {
    text: [
      '[REDACTED PRIVATE KEY]',
      '[REDACTED TOKEN]',
      '[REDACTED TOKEN]',
      '[REDACTED TOKEN]',
      '[REDACTED TOKEN]',
      '[REDACTED TOKEN]',
      'Authorization: Bearer [REDACTED]',
      'api_key=[REDACTED]',
      'apikey=[REDACTED]',
      'api-key=[REDACTED]',
      'access_token=[REDACTED]',
      'access-token=[REDACTED]',
      'password=[REDACTED]',
      'secret=[REDACTED]',
      'private_key=[REDACTED]',
      'private-key=[REDACTED]',
    ].join('\n'),
    count: 16,
  });
});

test('derives detection from redaction and ignores redacted placeholders', () => {
  const profile = createRedactionProfile();
  const secrets = [
    'gho_abcdefghijkl',
    'ghu_abcdefghijkl',
    'ghs_abcdefghijkl',
    'ghr_abcdefghijkl',
    'password=plain-value',
  ];
  const safe = [
    'ordinary text',
    'Authorization: Bearer [REDACTED]',
    'secret=[REDACTED]',
    '[REDACTED PRIVATE KEY] [REDACTED TOKEN]',
  ];

  for (const sample of secrets) {
    assert.equal(profile.redact(sample).count > 0, true, sample);
    assert.equal(profile.hasSecret(sample), true, sample);
  }
  for (const sample of safe) {
    assert.equal(profile.redact(sample).count, 0, sample);
    assert.equal(profile.hasSecret(sample), false, sample);
  }
  assert.equal(profile.hasSecret('secret=[REDACTED]suffix'), true);
});

test('is idempotent', () => {
  const profile = createRedactionProfile();
  const first = profile.redact('secret=one ghp_abcdefghijkl');

  assert.deepEqual(profile.redact(first.text), { text: first.text, count: 0 });
});

test('applies declarative custom rules with the fixed placeholder', () => {
  const profile = createRedactionProfile([
    { type: 'assignment-key', key: 'session_code' },
    { type: 'token-prefix', prefix: 'acme_', minLength: 4, maxLength: 8 },
  ]);
  const input = 'SESSION_CODE="value" acme_abcd acme_abc acme_abcdefghi';

  assert.deepEqual(profile.redact(input), {
    text: 'SESSION_CODE="[REDACTED]" [REDACTED] acme_abc acme_abcdefghi',
    count: 2,
  });
  assert.equal(profile.hasSecret(input), true);
  assert.equal(profile.hasSecret('SESSION_CODE="[REDACTED]" [REDACTED]'), false);
});

test('produces a deterministic digest for the canonical profile', () => {
  const rules = [
    { type: 'assignment-key', key: 'session_code' },
    { type: 'token-prefix', prefix: 'acme_', minLength: 4 },
  ];
  const digest = createRedactionProfile(rules).digest;

  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(createRedactionProfile([...rules].reverse()).digest, digest);
  assert.notEqual(
    createRedactionProfile([{ type: 'assignment-key', key: 'other_code' }]).digest,
    digest,
  );
});

test('redacts nested objects and arrays without mutating the input', () => {
  const profile = createRedactionProfile();
  const input = {
    header: 'Authorization: Bearer bearer-value',
    nested: ['safe', { token: 'sk-abcdefghijkl' }],
    enabled: true,
    missing: null,
  };

  assert.deepEqual(profile.redactStructured(input), {
    value: {
      header: 'Authorization: Bearer [REDACTED]',
      nested: ['safe', { token: '[REDACTED TOKEN]' }],
      enabled: true,
      missing: null,
    },
    count: 2,
  });
  assert.equal(input.header, 'Authorization: Bearer bearer-value');
  assert.equal(input.nested[1].token, 'sk-abcdefghijkl');
});

test('rejects cyclic structured input', () => {
  const profile = createRedactionProfile();
  const input = {};
  input.self = input;

  assert.throws(() => profile.redactStructured(input), {
    name: 'TypeError',
    message: 'value must not be cyclic',
  });
});

test('rejects invalid text and structured inputs', () => {
  const profile = createRedactionProfile();

  for (const value of [undefined, null, 1, {}, []]) {
    assert.throws(() => profile.redact(value), TypeError);
    assert.throws(() => profile.hasSecret(value), TypeError);
  }
  for (const value of [undefined, 1n, Symbol('value'), () => {}, new Date()]) {
    assert.throws(() => profile.redactStructured(value), TypeError);
  }
});

test('strictly validates custom rule schemas', () => {
  const invalidConfigs = [
    null,
    {},
    Array.from({ length: 101 }, (_, index) => ({ type: 'assignment-key', key: `key_${index}` })),
    [null],
    [[]],
    [{}],
    [{ type: 'regex', regex: /secret/g }],
    [{ type: 'assignment-key' }],
    [{ type: 'assignment-key', key: '' }],
    [{ type: 'assignment-key', key: 'contains space' }],
    [{ type: 'assignment-key', key: 'a'.repeat(65) }],
    [{ type: 'assignment-key', key: 'valid', replacement: 'leak' }],
    [{ type: 'assignment-key', key: 'valid', callback: () => {} }],
    [{ type: 'token-prefix' }],
    [{ type: 'token-prefix', prefix: '' }],
    [{ type: 'token-prefix', prefix: 'contains space' }],
    [{ type: 'token-prefix', prefix: 'x'.repeat(65) }],
    [{ type: 'token-prefix', prefix: 'acme_', minLength: 0 }],
    [{ type: 'token-prefix', prefix: 'acme_', minLength: 1.5 }],
    [{ type: 'token-prefix', prefix: 'acme_', minLength: '4' }],
    [{ type: 'token-prefix', prefix: 'acme_', minLength: 4097 }],
    [{ type: 'token-prefix', prefix: 'acme_', minLength: 8, maxLength: 7 }],
    [{ type: 'token-prefix', prefix: 'acme_', maxLength: null }],
    [{ type: 'token-prefix', prefix: 'acme_', replacement: '[CUSTOM]' }],
    [{ type: 'token-prefix', prefix: 'acme_', regex: /secret/g }],
  ];

  for (const config of invalidConfigs) {
    assert.throws(() => createRedactionProfile(config), TypeError);
  }
});

test('rejects duplicate custom rules', () => {
  assert.throws(() => createRedactionProfile([
    { type: 'assignment-key', key: 'Session_Code' },
    { type: 'assignment-key', key: 'session_code' },
  ]), TypeError);
  assert.throws(() => createRedactionProfile([
    { type: 'token-prefix', prefix: 'acme_', minLength: 4 },
    { type: 'token-prefix', prefix: 'acme_', minLength: 8 },
  ]), TypeError);
});
