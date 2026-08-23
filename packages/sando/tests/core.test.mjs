import assert from 'node:assert/strict';
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

test('optimizeToolOutput bounds inline output and returns a complete redacted artifact', async () => {
  const { optimizeToolOutput } = await core();
  const result = optimizeToolOutput({
    toolName: 'Bash',
    output: `Authorization: Bearer secret-value\n${'x'.repeat(600)}`,
    cwd: '/work',
    policy: { mode: 'apply', maxInlineBytes: 256, maxArtifactBytes: 320, redact: true },
  });

  assert.ok(Buffer.byteLength(result.inline) <= 256);
  assert.match(result.inline, /sando:sha256:/);
  assert.equal(result.inline.includes('secret-value'), false);
  assert.equal(result.artifact.content.includes('secret-value'), false);
  assert.equal(result.artifact.content, `Authorization: Bearer [REDACTED]\n${'x'.repeat(600)}`);
  assert.equal(result.artifact.truncated, false);
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
    assert.ok(line.startsWith('artifact ') || Buffer.byteLength(line) <= 12 || /middle elided/i.test(line));
  }
  assert.equal(result.artifact.content.includes('HEAD-FACT'), true);
  assert.equal(result.artifact.content.includes('TAIL-FACT'), true);
  assert.equal(result.artifact.content.includes('ERROR: tail failure'), true);
  assert.equal(result.artifact.content.includes('middle-noise'), true);
  assert.equal(result.artifact.sourceBytes, Buffer.byteLength(`HEAD-FACT\n${'middle-noise\n'.repeat(20)}TAIL-FACT\nERROR: tail failure`));
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
