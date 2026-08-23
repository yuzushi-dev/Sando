import assert from 'node:assert/strict';
import test from 'node:test';

import { auditMetadata, digestPrompt, redactStream } from '../lib/audit.mjs';

test('audit metadata is reproducible, redacts streams, and declares measurement mode', () => {
  const prompt = 'benchmark prompt';
  const audit = auditMetadata({
    host: 'codex', variant: 'optimized', prompt, args: ['exec', prompt],
    result: { stdout: 'status=ok\\nAPI_KEY=sk-test-01234567890123456789', stderr: 'password=hunter2' },
    commit: 'abc123', resolvedModel: 'codex-test',
    now: '2026-08-23T12:00:00.000Z',
    environment: { node: 'v22-test' },
  });
  assert.equal(audit.promptDigest, digestPrompt(prompt));
  assert.equal(audit.timestamp, '2026-08-23T12:00:00.000Z');
  assert.equal(audit.commit, 'abc123');
  assert.equal(audit.resolvedModel, 'codex-test');
  assert.deepEqual(audit.args, ['exec', `<prompt:${audit.promptDigest}>`]);
  assert.equal(audit.raw.stdout.includes('sk-test'), false);
  assert.equal(audit.raw.stderr.includes('hunter2'), false);
  assert.equal(audit.measurement.mode, 'prompt-level');
  assert.equal(audit.measurement.hookEndToEnd, false);
  assert.equal(redactStream('x'.repeat(10), 5).truncated, true);
});
