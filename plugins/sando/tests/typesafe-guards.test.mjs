import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TypeSafeClient } from '../lib/typesafe-client.mjs';
import { evaluateDoneClaim } from '../lib/done-guard.mjs';
import { StuckGuard } from '../lib/stuck-guard.mjs';

test('TypeSafeClient redacts both state and questions before offline handler', async () => {
  const client = new TypeSafeClient({ apiKey: null, offlineFallback: true });

  const state = { prompt: 'echo token=sk-1234567890abcdefghijklmnop' };
  const questions = {
    safe: { type: 'noul', instructions: 'Is Bearer 1234567890abcdefgh safe?' }
  };

  let capturedState = null;
  let capturedQuestions = null;

  const result = await client.evaluate(state, questions, {
    offlineHandler: (st, qs) => {
      capturedState = st;
      capturedQuestions = qs;
      return { safe: { value: 1.0, confidence: 0.99 } };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.offline, true);
  assert.doesNotMatch(capturedState.prompt, /sk-1234567890/);
  assert.match(capturedState.prompt, /\[REDACTED\]/);
  assert.doesNotMatch(capturedQuestions.safe.instructions, /1234567890abcdefgh/);
  assert.match(capturedQuestions.safe.instructions, /\[REDACTED\]/);
});

test('evaluateDoneClaim word boundaries and negations', async () => {
  // Should NOT flag words like "fattore" or "haven't done"
  const resNegative = await evaluateDoneClaim({
    finalMessage: "I haven't done the final refactor yet. This is an important fattore.",
    hasCodeEdits: true,
    testsRan: false,
    testsPassed: false,
  });
  assert.equal(resNegative.flagged, false);

  // Should flag real completion claim when tests failed
  const resFlagged = await evaluateDoneClaim({
    finalMessage: "The bug is fixed and done! Ready for deploy.",
    hasCodeEdits: true,
    testsRan: true,
    testsPassed: false,
  });
  assert.equal(resFlagged.flagged, true);
  assert.match(resFlagged.notice, /unverified completion claim/);

  // Should NOT flag when tests actually passed
  const resPassed = await evaluateDoneClaim({
    finalMessage: "Bug is fixed and done! All 20 tests pass.",
    hasCodeEdits: true,
    testsRan: true,
    testsPassed: true,
  });
  assert.equal(resPassed.flagged, false);
});

test('StuckGuard returns consistent Promise contract on both branches', async () => {
  const tmpFile = path.join(os.tmpdir(), `test-stuck-contract-${Date.now()}.json`);
  const guard = new StuckGuard({ storagePath: tmpFile });

  // Non-failure returns Promise resolving to stuck: false
  const p1 = guard.recordToolResult({ tool: 'read', input: 'cat f.txt', output: 'content', exitCode: 0 });
  assert.ok(p1 instanceof Promise);
  const r1 = await p1;
  assert.equal(r1.stuck, false);

  // Failure returns Promise resolving to stuck status
  const p2 = guard.recordToolResult({ tool: 'bash', input: 'npm test', output: 'Error: failed', exitCode: 1 });
  assert.ok(p2 instanceof Promise);
  const r2 = await p2;
  assert.equal(r2.stuck, false);

  fs.rmSync(tmpFile, { force: true });
});

test('StuckGuard persists failures across separate instances and compares input strategy', async () => {
  const tmpFile = path.join(os.tmpdir(), `test-stuck-persist-${Date.now()}.json`);
  const opts = { storagePath: tmpFile, failureThreshold: 3 };

  // Instance 1: runs first failing tool
  const g1 = new StuckGuard(opts);
  const r1 = await g1.recordToolResult({ tool: 'Bash', input: 'python fix.py --opt1', output: 'Traceback error', exitCode: 1 });
  assert.equal(r1.stuck, false);

  // Instance 2 (simulating fresh hook CLI process): runs intermediate read-only command (should NOT reset failure chain)
  const g2 = new StuckGuard(opts);
  await g2.recordToolResult({ tool: 'read', input: 'cat fix.py', output: 'code', exitCode: 0 });

  // Instance 3: runs same failing command a 2nd time
  const g3 = new StuckGuard(opts);
  const r2 = await g3.recordToolResult({ tool: 'Bash', input: 'python fix.py --opt1', output: 'Traceback error', exitCode: 1 });
  assert.equal(r2.stuck, false);

  // Instance 4: runs same failing command a 3rd time -> STUCK!
  const g4 = new StuckGuard(opts);
  const r3 = await g4.recordToolResult({ tool: 'Bash', input: 'python fix.py --opt1', output: 'Traceback error', exitCode: 1 });
  assert.equal(r3.stuck, true);
  assert.match(r3.notice, /3 consecutive failures with the same strategy/);

  // Instance 5: genuine successful write/mutation resets state
  const g5 = new StuckGuard(opts);
  const r4 = await g5.recordToolResult({ tool: 'Bash', input: 'git commit -m "fix"', output: '[main 12345]', exitCode: 0 });
  assert.equal(r4.stuck, false);

  // Now a subsequent failure is only 1 failure (not stuck)
  const g6 = new StuckGuard(opts);
  const r5 = await g6.recordToolResult({ tool: 'Bash', input: 'python fix.py', output: 'Traceback', exitCode: 1 });
  assert.equal(r5.stuck, false);

  fs.rmSync(tmpFile, { force: true });
});
