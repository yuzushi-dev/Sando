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
  assert.match(result.inline, /\[sando\] display redacted; Sando did not sanitize source files$/);
  assert.deepEqual(result.disclosure.redaction, {
    count: 1, scope: 'display', sourceModifiedBySando: false,
  });
  assert.equal(result.artifact.content, `TEAM_DB_URL=[REDACTED]\n${'x'.repeat(600)}`);
  assert.match(result.redactionProfileDigest, /^sha256:[a-f0-9]{64}$/);
  const event = normalizeEvent({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: `TEAM_DB_URL=postgres://fixture-secret\n${'x'.repeat(600)}`, cwd,
  });
  const receipt = createReceipt({ host: 'claude', event, optimization: result });
  assert.equal(receipt.redactionProfileDigest, result.redactionProfileDigest);
});

test('display redaction discloses masking without changing source bytes', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-display-redaction-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const source = [
    'password=alpha-secret',
    'Authorization: Bearer synthetic-bearer-value',
    'api_key=synthetic-api-value',
  ].join('\n');
  const sourcePath = path.join(cwd, 'raw.log');
  fs.writeFileSync(sourcePath, source);
  const before = fs.readFileSync(sourcePath);

  const { optimizeToolOutput } = await core();
  const result = optimizeToolOutput({
    toolName: 'Read', output: fs.readFileSync(sourcePath, 'utf8'), cwd,
    toolInput: { path: sourcePath, start_line: 1, end_line: 3 },
    policy: { mode: 'apply', maxInlineBytes: 512, redact: true },
  });

  assert.doesNotMatch(result.inline, /alpha-secret|synthetic-bearer-value|synthetic-api-value/);
  assert.equal((result.inline.match(/\[sando\] display redacted/g) ?? []).length, 1);
  assert.match(result.inline, /\[sando\] display redacted; Sando did not sanitize source files$/);
  assert.deepEqual(result.disclosure.redaction, {
    count: 3, scope: 'display', sourceModifiedBySando: false,
  });
  assert.deepEqual(fs.readFileSync(sourcePath), before);
});

test('display disclosure is based on actual substitutions across edge cases', async () => {
  const { optimizeToolOutput } = await core();
  const optimize = (output, overrides = {}) => optimizeToolOutput({
    toolName: 'Bash', output, cwd: '/work',
    policy: { mode: 'apply', maxInlineBytes: 512, redact: true, ...overrides },
  });

  for (const unchanged of ['ordinary output', 'password=[REDACTED]']) {
    const result = optimize(unchanged);
    assert.equal(result.inline, unchanged);
    assert.equal(result.disclosure.redaction, undefined);
  }

  const repeated = optimize('password=first-secret password=second-secret');
  assert.equal(repeated.disclosure.redaction.count, 2);
  assert.equal((repeated.inline.match(/\[sando\] display redacted/g) ?? []).length, 1);

  const ansiHidden = optimize('api_\u001b[31mkey=ansi-hidden-value');
  assert.doesNotMatch(ansiHidden.inline, /ansi-hidden-value/);
  assert.equal(ansiHidden.disclosure.redaction.count, 1);

  const disabled = optimize('password=visible-secret', { redact: false });
  assert.match(disabled.inline, /visible-secret/);
  assert.doesNotMatch(disabled.inline, /display redacted/);
  assert.equal(disabled.disclosure.redaction, undefined);

  const observed = optimizeToolOutput({
    toolName: 'Bash', output: 'password=observed-secret', cwd: '/work',
    policy: { mode: 'observe', maxInlineBytes: 512, redact: true },
  });
  assert.equal(observed.stats.mode, 'observe');
  assert.doesNotMatch(observed.inline, /observed-secret/);
  assert.match(observed.inline, /display redacted/);

  const rawRead = optimizeToolOutput({
    toolName: 'Read', output: 'password=raw-secret', cwd: '/work', raw: true,
    toolInput: { path: 'raw.log', raw: true },
    policy: { mode: 'apply', maxInlineBytes: 512, redact: true },
  });
  assert.doesNotMatch(rawRead.inline, /raw-secret/);
  assert.match(rawRead.inline, /display redacted/);
});

test('display disclosure is reserved inside the exact 64-byte inline budget', async () => {
  const { optimizeToolOutput } = await core();
  const result = optimizeToolOutput({
    toolName: 'Bash', output: 'password=boundary-secret', cwd: '/work',
    policy: { mode: 'apply', maxInlineBytes: 64, headBytes: 32, tailBytes: 16, redact: true },
  });

  assert.ok(Buffer.byteLength(result.inline) <= 64);
  assert.match(result.inline, /\[sando\] display redacted; Sando did not sanitize source files$/);
  assert.equal(result.stats.inlineBytes, Buffer.byteLength(result.inline));
  assert.equal(result.stats.estimatedInlineTokens, Math.ceil(Buffer.byteLength(result.inline) / 4));
  assert.equal(result.disclosure.bytes.visible, Buffer.byteLength(result.inline));
  assert.throws(() => optimizeToolOutput({
    toolName: 'Bash', output: 'password=too-small', cwd: '/work',
    policy: { mode: 'apply', maxInlineBytes: 63, redact: true },
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

// A test runner that prints one summary block per suite puts the first block's totals in the
// middle of its own output. Eliding them leaves a plausible partial count — a model reads the
// surviving block and reports it as the whole run, with nothing marking the omission.
test('middle elision keeps test-runner totals, not just the last block', async () => {
  const { optimizeToolOutput } = await core();
  const noise = Array.from({ length: 400 }, (_, index) => `ok ${index + 1} - a check whose name mentions error and failure`).join('\n');
  const block = (tests, pass) => `# tests ${tests}\n# suites 0\n# pass ${pass}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0`;
  const output = `${block(482, 472)}\n${noise}\n${block(100, 100)}`;

  const result = optimizeToolOutput({
    toolName: 'Bash', output, cwd: '/work', toolInput: { command: 'npm test' },
    policy: { mode: 'apply', maxInlineBytes: 2048, headBytes: 700, tailBytes: 700, redact: true },
  });

  assert.match(result.inline, /middle elided/);
  assert.match(result.inline, /# tests 482/);
  assert.match(result.inline, /# pass 472/);
});
