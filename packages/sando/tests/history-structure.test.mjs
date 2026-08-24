import assert from 'node:assert/strict';
import test from 'node:test';

import { compactHistoricalStructure } from '../src/history-structure.mjs';

test('compacts repeated non-empty lines in historical Bash output deterministically', () => {
  const input = {
    toolName: 'Bash',
    historical: true,
    isError: false,
    text: `${'warning: this line is deliberately long\n'.repeat(4)}final fact\n`,
  };

  const expected = 'warning: this line is deliberately long\n[sando repeated x4]\nfinal fact\n';
  assert.equal(compactHistoricalStructure(input), expected);
  assert.equal(compactHistoricalStructure(input), expected);
});

test('matches Bash case-insensitively', () => {
  const line = 'warning: this line is deliberately long';
  assert.equal(compactHistoricalStructure({
    toolName: 'bash', historical: true, isError: false, text: `${line}\n${line}\n${line}\n`,
  }), `${line}\n[sando repeated x3]\n`);
});

test('preserves empty lines and non-repeated text', () => {
  const text = 'first\n\n\nsecond\nthird\n';

  assert.equal(compactHistoricalStructure({
    toolName: 'Log', historical: true, isError: false, text,
  }), text);
});

test('preserves errors and current results', () => {
  const text = 'a sufficiently long repeated error line\na sufficiently long repeated error line\na sufficiently long repeated error line\n';

  assert.equal(compactHistoricalStructure({
    toolName: 'Bash', historical: true, isError: true, text,
  }), text);
  assert.equal(compactHistoricalStructure({
    toolName: 'Bash', historical: false, isError: false, text,
  }), text);
});

test('fails closed when a replacement would not reduce the text', () => {
  const text = 'x\nx\n';

  assert.equal(compactHistoricalStructure({
    toolName: 'Bash', historical: true, isError: false, text,
  }), text);
});
