import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const digest = (file) => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');

// `scripts/sync-bundles.mjs` copies an explicit list from packages/sando/src into the three
// bundles. Everything outside that list is maintained by hand in each copy, which is how a fix
// lands in one bundle and silently misses the other — the shape of several bugs in this repo's
// history. These tests do not decide which copy is right; they fail when the answer changes
// without anyone saying so.

const CODEX_BUNDLES = ['plugins/sando', 'adapters/codex/sando'];

// Files that exist in both Codex bundles and are known to differ today. Each entry needs a reason,
// so that "it has always been like that" cannot quietly become the reason.
const KNOWN_DIVERGENT = new Map([
  ['lib/hook-entry.mjs', 'entry point: resolves its bundle layout'],
  ['lib/mcp-entry.mjs', 'entry point: resolves its bundle layout'],
  ['cli.mjs', 'the truncation notice sits before the status line in plugins/, after stderr in adapters/'],
]);

function duplicatedFiles() {
  const [a, b] = CODEX_BUNDLES;
  const files = [];
  const walk = (relative) => {
    const dir = path.join(root, a, relative);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'tests' || entry.name === 'node_modules') continue;
        walk(next);
      } else if (entry.isFile() && entry.name.endsWith('.mjs') && fs.existsSync(path.join(root, b, next))) {
        files.push(next);
      }
    }
  };
  walk('');
  return files;
}

test('the two Codex bundles diverge only where this repo says they do', () => {
  const divergent = duplicatedFiles()
    .filter((file) => digest(path.join(CODEX_BUNDLES[0], file)) !== digest(path.join(CODEX_BUNDLES[1], file)));

  const unexpected = divergent.filter((file) => !KNOWN_DIVERGENT.has(file));
  assert.deepEqual(unexpected, [], `these copies drifted apart with no recorded reason: ${unexpected.join(', ')}`);

  const healed = [...KNOWN_DIVERGENT.keys()].filter((file) => !divergent.includes(file));
  assert.deepEqual(healed, [], `these copies now match; drop them from KNOWN_DIVERGENT: ${healed.join(', ')}`);
});

test('enforcement.mjs is identical in both Codex bundles', () => {
  // sync-bundles does not copy this file, and it carries the routing decision: a fix applied to
  // one bundle and not the other changes what runs on half the installs.
  assert.equal(
    digest('plugins/sando/lib/enforcement.mjs'),
    digest('adapters/codex/sando/lib/enforcement.mjs'),
  );
});

test('every figure the README advertises is backed by docs/measurements.md', () => {
  // The capacity figure went stale three times because the README quoted a number that moves with
  // the corpus while the page behind it moved on. Whatever the table claims has to appear on the
  // page a reader is sent to.
  const table = read('README.md').split('## Expected savings')[1]?.split('\n## ')[0];
  assert.ok(table, 'the README no longer has an "Expected savings" section');

  const figures = [...new Set(table.match(/\d+[.,]\d+\s*(?:%|x|M\b)/g) ?? [])];
  assert.ok(figures.length >= 5, `expected the savings table to quote figures, found ${figures.length}`);

  const measurements = read('docs/measurements.md');
  const unbacked = figures.filter((figure) => !measurements.includes(figure));
  assert.deepEqual(unbacked, [], `quoted in the README, absent from docs/measurements.md: ${unbacked.join(', ')}`);
});
