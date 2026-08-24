import assert from 'node:assert/strict';
import test from 'node:test';

import { dedupeHistory } from '../src/history-dedupe.mjs';

const DUPLICATE = '[sando duplicate historical result]';

test('deduplicates older identical Read, Grep, and Bash results deterministically', () => {
  const readOutput = 'same read '.repeat(20);
  const grepOutput = 'same grep '.repeat(20);
  const bashOutput = '/work '.repeat(20);
  const entries = [
    { id: 'read-old', toolName: 'Read', input: { offset: 1, file_path: 'a' }, output: readOutput },
    { id: 'read-new', toolName: 'read', input: { file_path: 'a', offset: 1 }, output: readOutput },
    { id: 'grep-old', toolName: 'Grep', input: { path: '.', pattern: 'x' }, output: grepOutput },
    { id: 'grep-new', toolName: 'GREP', input: { pattern: 'x', path: '.' }, output: grepOutput },
    { id: 'bash-old', toolName: 'Bash', input: { command: 'pwd' }, output: bashOutput },
    { id: 'bash-new', toolName: 'bash', input: { command: 'pwd' }, output: bashOutput },
  ];

  const result = dedupeHistory(entries);

  assert.deepEqual(result.entries.map(({ id, output }) => ({ id, output })), [
    { id: 'read-old', output: DUPLICATE },
    { id: 'read-new', output: readOutput },
    { id: 'grep-old', output: DUPLICATE },
    { id: 'grep-new', output: grepOutput },
    { id: 'bash-old', output: DUPLICATE },
    { id: 'bash-new', output: bashOutput },
  ]);
  assert.equal(result.deduplicated, 3);
  assert.deepEqual(entries[0].output, readOutput);
});

test('preserves current and error results', () => {
  const output = 'same '.repeat(20);
  const entries = [
    { id: 'historical', toolName: 'Read', input: { file_path: 'a' }, output },
    { id: 'current', toolName: 'Read', input: { file_path: 'a' }, output, current: true },
    { id: 'error-old', toolName: 'Bash', input: { command: 'false' }, output: 'failed', isError: true },
    { id: 'error-new', toolName: 'Bash', input: { command: 'false' }, output: 'failed', isError: true },
  ];

  const result = dedupeHistory(entries);

  assert.equal(result.entries[0].output, DUPLICATE);
  assert.equal(result.entries[1].output, output);
  assert.equal(result.entries[2].output, 'failed');
  assert.equal(result.entries[3].output, 'failed');
  assert.equal(result.deduplicated, 1);
});

test('fails closed when the duplicate marker would be larger', () => {
  const entries = [
    { id: 'old', toolName: 'Read', input: { file_path: 'a' }, output: 'same' },
    { id: 'new', toolName: 'Read', input: { file_path: 'a' }, output: 'same', current: true },
  ];

  assert.deepEqual(dedupeHistory(entries), { entries, deduplicated: 0 });
});

test('preserves IDs and text-block result shape', () => {
  const firstText = 'same '.repeat(20);
  const secondText = ' result '.repeat(20);
  const entries = [
    {
      id: 'old', toolName: 'Grep', input: { pattern: 'x' }, current: false,
      output: [{ type: 'text', text: firstText, citations: ['a'] }, { type: 'text', text: secondText }],
    },
    {
      id: 'new', toolName: 'Grep', input: { pattern: 'x' }, current: false,
      output: [{ type: 'text', text: firstText, citations: ['a'] }, { type: 'text', text: secondText }],
    },
  ];

  const result = dedupeHistory(entries);

  assert.equal(result.entries[0].id, 'old');
  assert.deepEqual(result.entries[0].output, [
    { type: 'text', text: DUPLICATE, citations: ['a'] },
    { type: 'text', text: '' },
  ]);
  assert.deepEqual(result.entries[1], entries[1]);
});

test('keeps non-identical and unsupported tool results', () => {
  const entries = [
    { id: 'read-a', toolName: 'Read', input: { file_path: 'a' }, output: 'same' },
    { id: 'read-b', toolName: 'Read', input: { file_path: 'b' }, output: 'same' },
    { id: 'grep-a', toolName: 'Grep', input: { pattern: 'x' }, output: 'first' },
    { id: 'grep-b', toolName: 'Grep', input: { pattern: 'x' }, output: 'second' },
    { id: 'write-a', toolName: 'Write', input: { file_path: 'a' }, output: 'same' },
    { id: 'write-b', toolName: 'Write', input: { file_path: 'a' }, output: 'same' },
  ];

  assert.deepEqual(dedupeHistory(entries), { entries, deduplicated: 0 });
});

test('fails closed for malformed records, duplicate IDs, and non-JSON inputs', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const entries = [
    { id: 'same-id', toolName: 'Read', input: { file_path: 'a' }, output: 'same' },
    { id: 'same-id', toolName: 'Read', input: { file_path: 'a' }, output: 'same' },
    { id: '', toolName: 'Bash', input: { command: 'pwd' }, output: '/work' },
    { id: 'bad-input-a', toolName: 'Grep', input: cyclic, output: 'same' },
    { id: 'bad-input-b', toolName: 'Grep', input: cyclic, output: 'same' },
    { id: 'null-input-a', toolName: 'Bash', input: null, output: 'same' },
    { id: 'null-input-b', toolName: 'Bash', input: null, output: 'same' },
    { id: 'bad-output-a', toolName: 'Read', input: { file_path: 'a' }, output: { text: 'same' } },
    { id: 'bad-output-b', toolName: 'Read', input: { file_path: 'a' }, output: { text: 'same' } },
  ];

  const result = dedupeHistory(entries);

  assert.deepEqual(result.entries, entries);
  assert.equal(result.deduplicated, 0);
});
