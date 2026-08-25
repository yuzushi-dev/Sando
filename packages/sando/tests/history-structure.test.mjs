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

test('collapses repeated lines for every tool history-shake supports', async () => {
  // These two modules do variants of the same job and previously disagreed on which
  // tools qualify: shake allowed exec/grep, structure did not. Codex reports tool
  // results as exec/grep, so structural collapse could never run there — the cause of
  // the mirrored compactedStructures/shakenResults counts in the recorded proxy runs.
  const { shakeHistoricalResult } = await import('../src/history-shake.mjs');
  const text = ['header', ...Array.from({ length: 900 }, () => 'repeated-noise'), 'tail'].join('\n');

  for (const toolName of ['bash', 'exec', 'grep', 'log']) {
    const compacted = compactHistoricalStructure({ toolName, text, historical: true, isError: false });
    assert.notEqual(compacted, text, `${toolName} should collapse`);
    assert.ok(Buffer.byteLength(compacted) < Buffer.byteLength(text));
    // and the tool is one shake accepts too, so the allowlists stay in step
    assert.equal(shakeHistoricalResult({ toolName, text, historical: true, isError: false }).changed, true);
  }

  // `read` is deliberately excluded: whole-file reads are handled by the
  // superseded-read path, not by structural line collapse.
  assert.equal(compactHistoricalStructure({ toolName: 'read', text, historical: true, isError: false }), text);
});
