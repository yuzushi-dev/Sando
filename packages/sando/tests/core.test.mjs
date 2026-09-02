import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function core() {
  try {
    return await import('../index.mjs');
  } catch {
    assert.fail('sando public API is missing');
  }
}

test('estimateTokens is deterministic and explicitly approximate', async () => {
  const { estimateTokens } = await core();
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('12345'), 2);
  assert.equal(estimateTokens('é'), 1);
  assert.throws(() => estimateTokens(null), /text must be a string/);
});

test('optimizeToolOutput bounds inline output when the artifact is over the admission limit', async () => {
  const { optimizeToolOutput } = await core();
  const result = optimizeToolOutput({
    toolName: 'Bash',
    output: `Authorization: Bearer secret-value\n${'x'.repeat(600)}`,
    cwd: '/work',
    policy: { mode: 'apply', maxInlineBytes: 256, maxArtifactBytes: 320, redact: true },
  });

  assert.ok(Buffer.byteLength(result.inline) <= 256);
  assert.match(result.inline, /middle elided/i);
  assert.equal(result.inline.includes('secret-value'), false);
  assert.equal(result.artifact, undefined);
  assert.equal(result.route, 'passthrough');
  assert.equal(result.reason, 'artifact-admission-limit');
  assert.equal(result.disclosure.artifact, null);
  assert.deepEqual(result.disclosure.recovery, { mode: 'unavailable', bounded: true });
  assert.deepEqual(result.stats, optimizeToolOutput({
    toolName: 'Bash',
    output: `Authorization: Bearer secret-value\n${'x'.repeat(600)}`,
    cwd: '/work',
    policy: { mode: 'apply', maxInlineBytes: 256, maxArtifactBytes: 320, redact: true },
  }).stats);
  assert.equal(Object.hasOwn(result.stats, 'tokenSavings'), false);
});

test('large output keeps head and tail inline, elides middle, and caps columns', async () => {
  const { optimizeToolOutput } = await core();
  const result = optimizeToolOutput({
    toolName: 'Bash',
    output: `HEAD-FACT\n${'middle-noise\n'.repeat(20)}TAIL-FACT\nERROR: tail failure`,
    cwd: '/work',
    policy: {
      mode: 'apply', maxInlineBytes: 120, headBytes: 32, tailBytes: 42, maxColumns: 12, redact: true,
    },
  });

  assert.match(result.inline, /HEAD-FACT/);
  assert.match(result.inline, /ERROR: tail/);
  assert.match(result.inline, /middle elided/i);
  for (const line of result.inline.split('\n')) {
    assert.ok(line.startsWith('[sando] artifact ') || Buffer.byteLength(line) <= 12 || /middle elided/i.test(line));
  }
  assert.equal(result.artifact.content.includes('HEAD-FACT'), true);
  assert.equal(result.artifact.content.includes('TAIL-FACT'), true);
  assert.equal(result.artifact.content.includes('ERROR: tail failure'), true);
  assert.equal(result.artifact.content.includes('middle-noise'), true);
  assert.equal(result.artifact.sourceBytes, Buffer.byteLength(`HEAD-FACT\n${'middle-noise\n'.repeat(20)}TAIL-FACT\nERROR: tail failure`));
});

test('derives Read metadata on the hook path and compacts repeated Bash lines', async () => {
  const { optimizeToolOutput } = await core();
  const read = optimizeToolOutput({
    toolName: 'Read',
    output: [
      ...Array.from({ length: 70 }, (_, index) => `noise:${index}`),
      ...Array.from({ length: 10 }, (_, index) => `export const item${index} = ${index};`),
      ...Array.from({ length: 60 }, (_, index) => `tail:${index}`),
    ].join('\n'),
    cwd: '/work',
    policy: { maxInlineBytes: 256, maxArtifactBytes: 4096 },
  });
  assert.equal(read.route, 'summary');
  assert.match(read.inline, /sando read structure/);

  const bash = optimizeToolOutput({
    toolName: 'Bash',
    output: `${'warning: repeated\n'.repeat(80)}final fact\n`,
    cwd: '/work',
    policy: { maxInlineBytes: 512, maxArtifactBytes: 4096 },
  });
  assert.match(bash.inline, /repeated x80/);
  assert.equal(bash.artifact.content, `${'warning: repeated\n'.repeat(80)}final fact\n`);
});

test('optimizeToolOutput preserves small output and rejects invalid policy', async () => {
  const { optimizeToolOutput } = await core();
  const result = optimizeToolOutput({ toolName: 'Read', output: { ok: true }, cwd: '/work' });
  assert.equal(result.inline, '{"ok":true}');
  assert.equal(result.artifact, undefined);
  assert.equal(result.stats.mode, 'apply');
  assert.throws(() => optimizeToolOutput({
    toolName: 'Read', output: 'ok', cwd: '/work', policy: { mode: 'unsafe' },
  }), /invalid policy/);
});

test('optimizeToolOutput loads project redaction rules and records the profile digest', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-project-redaction-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, '.sando'));
  fs.writeFileSync(path.join(cwd, '.sando', 'redaction.json'), JSON.stringify({
    schema: 'sando-redaction/v1',
    rules: [{ type: 'assignment-key', key: 'TEAM_DB_URL' }],
  }));

  const { createReceipt, normalizeEvent, optimizeToolOutput } = await core();
  const result = optimizeToolOutput({
    toolName: 'Bash', output: `TEAM_DB_URL=postgres://fixture-secret\n${'x'.repeat(600)}`, cwd,
    policy: { mode: 'apply', maxInlineBytes: 256, redact: true },
  });

  assert.ok(result.artifact);
  assert.ok(!result.inline.includes('fixture-secret'));
  assert.ok(!result.artifact.content.includes('fixture-secret'));
  assert.equal(result.artifact.content, `TEAM_DB_URL=[REDACTED]\n${'x'.repeat(600)}`);
  assert.match(result.redactionProfileDigest, /^sha256:[a-f0-9]{64}$/);
  const event = normalizeEvent({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: `TEAM_DB_URL=postgres://fixture-secret\n${'x'.repeat(600)}`, cwd,
  });
  const receipt = createReceipt({ host: 'claude', event, optimization: result });
  assert.equal(receipt.redactionProfileDigest, result.redactionProfileDigest);
});

test('event normalization and receipts are deterministic across host aliases', async () => {
  const { createReceipt, normalizeEvent, optimizeToolOutput } = await core();
  const event = normalizeEvent({
    hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'ok', cwd: '/work', session_id: 's1',
  });
  assert.deepEqual(event, {
    eventName: 'PostToolUse', toolName: 'Read', output: 'ok', cwd: '/work', sessionId: 's1',
  });
  const optimization = optimizeToolOutput({ toolName: event.toolName, output: event.output, cwd: event.cwd });
  assert.deepEqual(
    createReceipt({ host: 'claude', event, optimization }),
    createReceipt({ host: 'claude', event, optimization }),
  );
});
