import assert from 'node:assert/strict';
import test from 'node:test';

import { TypeSafeClient } from '../lib/typesafe-client.mjs';
import { evaluateDoneClaim } from '../lib/done-guard.mjs';
import { StuckGuard } from '../lib/stuck-guard.mjs';

test('TypeSafeClient executes offline handler when no API key is set', async () => {
  const client = new TypeSafeClient({ apiKey: null, offlineFallback: true });
  assert.equal(client.isConfigured(), false);

  const state = { prompt: 'echo secret token=12345678901234567890' };
  const questions = {
    safe: { type: 'noul', instructions: 'Is this safe?' }
  };

  let receivedState = null;
  const result = await client.evaluate(state, questions, {
    offlineHandler: (st, qs) => {
      receivedState = st;
      return { safe: { value: 1.0, confidence: 0.99 } };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.offline, true);
  assert.equal(result.answers.safe.value, 1.0);
  // Verify redaction occurred before reaching the handler
  assert.match(receivedState.prompt, /\[REDACTED_TOKEN\]/);
});

test('evaluateDoneClaim flags completion when edits were made but no tests passed', async () => {
  const result = await evaluateDoneClaim({
    finalMessage: 'I have finished and completed the bugfix successfully.',
    hasCodeEdits: true,
    testsRan: true,
    testsPassed: false,
  });

  assert.equal(result.flagged, true);
  assert.ok(result.riskScore >= 0.70);
  assert.match(result.notice, /unverified completion claim/);
});

test('evaluateDoneClaim allows completion when tests ran and passed', async () => {
  const result = await evaluateDoneClaim({
    finalMessage: 'Done! All 15 tests pass now.',
    hasCodeEdits: true,
    testsRan: true,
    testsPassed: true,
  });

  assert.equal(result.flagged, false);
  assert.equal(result.notice, null);
});

test('StuckGuard detects 3 consecutive identical failures', async () => {
  const guard = new StuckGuard({ failureThreshold: 3 });

  // First 2 failures: not stuck yet
  const res1 = await guard.recordToolResult({ tool: 'Bash', input: 'pytest', output: 'ModuleNotFoundError: foo', exitCode: 1 });
  assert.equal(res1.stuck, false);

  const res2 = await guard.recordToolResult({ tool: 'Bash', input: 'pytest', output: 'ModuleNotFoundError: foo', exitCode: 1 });
  assert.equal(res2.stuck, false);

  // 3rd failure with same error: stuck!
  const res3 = await guard.recordToolResult({ tool: 'Bash', input: 'pytest', output: 'ModuleNotFoundError: foo', exitCode: 1 });
  assert.equal(res3.stuck, true);
  assert.match(res3.notice, /3 consecutive failures with the same strategy/);

  // Recovery after successful command:
  const res4 = await guard.recordToolResult({ tool: 'Bash', input: 'pip install foo', output: 'Successfully installed', exitCode: 0 });
  assert.equal(res4.stuck, false);
});
