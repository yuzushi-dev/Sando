import assert from 'node:assert/strict';
import test from 'node:test';

import { shakeHistoricalResult } from '../src/history-shake.mjs';

test('extractively compacts a large historical Bash result', () => {
  const lines = [
    'build started',
    'loading workspace',
    'checking dependencies',
    ...Array.from({ length: 90 }, (_, index) => `generated detail ${index} ${'x'.repeat(24)}`),
    'ERROR: compiler failed at src/app.ts:42',
    ...Array.from({ length: 20 }, (_, index) => `cleanup detail ${index} ${'y'.repeat(24)}`),
    'build finished',
  ];
  const source = lines.join('\n');

  const result = shakeHistoricalResult({
    toolName: 'Bash',
    text: source,
    historical: true,
    isError: false,
  });

  assert.equal(result.changed, true);
  assert.ok(result.compactedTokens < result.originalTokens);
  assert.ok(result.text.includes('build started'));
  assert.ok(result.text.includes('ERROR: compiler failed at src/app.ts:42'));
  assert.ok(result.text.includes('build finished'));
  assert.match(result.text, /\[sando history shake: \d+ lines elided;/);
});

test('preserves current, error, Read, small, and non-reducing results', () => {
  const source = Array.from({ length: 100 }, (_, index) => `line ${index} ${'z'.repeat(24)}`).join('\n');

  for (const input of [
    { toolName: 'Bash', historical: false, isError: false },
    { toolName: 'Bash', historical: true, isError: true },
    { toolName: 'Read', historical: true, isError: false },
  ]) {
    const result = shakeHistoricalResult({ ...input, text: source });
    assert.equal(result.changed, false);
    assert.equal(result.text, source);
  }

  const small = shakeHistoricalResult({
    toolName: 'Grep',
    text: 'a\nb\nc',
    historical: true,
    isError: false,
  });
  assert.equal(small.changed, false);
  assert.equal(small.text, 'a\nb\nc');
});

test('is deterministic and keeps high-signal lines in order', () => {
  const source = Array.from({ length: 80 }, (_, index) => (
    index === 30 ? 'WARNING: retrying request' : `trace ${index} ${'q'.repeat(32)}`
  )).join('\n');

  const first = shakeHistoricalResult({ toolName: 'grep', text: source, historical: true });
  const second = shakeHistoricalResult({ toolName: 'grep', text: source, historical: true });

  assert.deepEqual(first, second);
  assert.equal(first.changed, true);
  assert.ok(first.text.indexOf('trace 0') < first.text.indexOf('WARNING: retrying request'));
  assert.ok(first.text.indexOf('WARNING: retrying request') < first.text.indexOf('trace 79'));
});
