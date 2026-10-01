// Intentional assertions for the shared-core hardening that also changes Codex output (0.7.0).
import assert from 'node:assert/strict';
import test from 'node:test';

import { optimizeToolOutput } from '../src/core.mjs';

const NOTICE = '[sando] display redacted; Sando did not sanitize source files';
const rows = (count, make) => Array.from({ length: count }, (_, i) => make(i)).join('\n');

test('a redacted result ends with one display-redaction notice', () => {
  const r = optimizeToolOutput({ toolName: 'Bash', output: 'password=hunter2hunter2\nok\n', cwd: '/tmp' });
  assert.equal(r.stats.redactions, 1);
  assert.ok(r.inline.endsWith(`\n${NOTICE}`));
  assert.equal(r.inline.split(NOTICE).length - 1, 1);
  assert.ok(!r.inline.includes('hunter2hunter2'));
});

test('the notice is paid for inside the inline budget, not added on top of it', () => {
  const output = `password=hunter2hunter2\n${rows(300, (i) => `row ${i} filler filler`)}`;
  const r = optimizeToolOutput({ toolName: 'Bash', output, cwd: '/tmp', policy: { mode: 'apply', maxInlineBytes: 1024, maxArtifactBytes: 100_000 } });
  assert.ok(Buffer.byteLength(r.inline) <= 1024, `${Buffer.byteLength(r.inline)}B`);
  assert.ok(r.inline.endsWith(NOTICE));
});

test('redaction runs a second time on the VT-stripped preview for every tool, not only Bash', () => {
  const output = `pass\u001b[0mword=hunter2hunter2\n${'x\n'.repeat(5)}`;
  for (const toolName of ['Bash', 'Read', 'Grep']) {
    const r = optimizeToolOutput({ toolName, output, cwd: '/tmp' });
    assert.ok(!r.inline.includes('hunter2hunter2'), toolName);
    assert.equal(r.stats.redactions, 1, toolName);
  }
});

test('a tight cap keeps the exit status as [exit_code=N] instead of a truncated status line', () => {
  const output = `[sando exec exit_code=3 signal=none timed_out=false]\n${rows(80, (i) => `line ${i} padding padding`)}`;
  const r = optimizeToolOutput({ toolName: 'Bash', output, cwd: '/tmp', policy: { mode: 'apply', maxInlineBytes: 90, maxArtifactBytes: 100_000 } });
  assert.match(r.inline, /^\[sando\] artifact sando:sha256:[a-f0-9]{16} \d+B\n\[exit_code=3\]\n/);
  assert.ok(Buffer.byteLength(r.inline) <= 90);
});
