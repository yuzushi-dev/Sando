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

test('TypeSafeClient falls back to offlineHandler on hard timeout', async () => {
  const client = new TypeSafeClient({
    apiKey: 'mock-key',
    baseUrl: 'http://127.0.0.1:19999', // unreachable endpoint
    timeoutMs: 30, // very short timeout
    offlineFallback: true,
  });

  const result = await client.evaluate({ test: 1 }, { q: { type: 'noul' } }, {
    offlineHandler: () => ({ q: { value: 1.0, confidence: 0.88 } }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.offline, true);
  assert.equal(result.answers.q.value, 1.0);
});

test('evaluateDoneClaim word boundaries and Italian negations', async () => {
  // English negation
  const resEn = await evaluateDoneClaim({
    finalMessage: "I haven't done the final refactor yet. This is an important fattore.",
    hasCodeEdits: true,
    testsRan: false,
    testsPassed: false,
  });
  assert.equal(resEn.flagged, false);

  // Italian negation
  const resIt = await evaluateDoneClaim({
    finalMessage: "Non ho ancora fatto la migrazione del database.",
    hasCodeEdits: true,
    testsRan: false,
    testsPassed: false,
  });
  assert.equal(resIt.flagged, false);

  // Real completion claim with failing tests
  const resFlagged = await evaluateDoneClaim({
    finalMessage: "Ho risolto il bug! Tutto fatto.",
    hasCodeEdits: true,
    testsRan: true,
    testsPassed: false,
  });
  assert.equal(resFlagged.flagged, true);
  assert.match(resFlagged.notice, /unverified completion claim/);

  // Real completion claim with passing tests
  const resPassed = await evaluateDoneClaim({
    finalMessage: "Bug is fixed and done! All 20 tests pass.",
    hasCodeEdits: true,
    testsRan: true,
    testsPassed: true,
  });
  assert.equal(resPassed.flagged, false);
});

test('StuckGuard distinguishes different commands sharing prefix', async () => {
  const tmpFile = path.join(os.tmpdir(), `test-stuck-prefix-${Date.now()}.json`);
  const guard = new StuckGuard({ storagePath: tmpFile, failureThreshold: 3 });

  // Different tests sharing the same long prefix: should NOT trigger stuck loop
  await guard.recordToolResult({ tool: 'Bash', input: 'npm run test:unit --grep FeatureAlpha', output: 'Failed', exitCode: 1 });
  await guard.recordToolResult({ tool: 'Bash', input: 'npm run test:unit --grep FeatureBeta', output: 'Failed', exitCode: 1 });
  const res = await guard.recordToolResult({ tool: 'Bash', input: 'npm run test:unit --grep FeatureGamma', output: 'Failed', exitCode: 1 });

  assert.equal(res.stuck, false);
  fs.rmSync(tmpFile, { force: true });
});

test('StuckGuard persists across instances, supports case-insensitive tools, and triggers on identical retry', async () => {
  const tmpFile = path.join(os.tmpdir(), `test-stuck-full-${Date.now()}.json`);
  const opts = { storagePath: tmpFile, failureThreshold: 3 };

  // Run 1 with 'Bash'
  const g1 = new StuckGuard(opts);
  await g1.recordToolResult({ tool: 'Bash', input: 'python run.py', output: 'Traceback (most recent call last)', exitCode: 1 });

  // Run 2 with 'bash' (case-insensitive)
  const g2 = new StuckGuard(opts);
  await g2.recordToolResult({ tool: 'bash', input: 'python run.py', output: 'Traceback (most recent call last)', exitCode: 1 });

  // Run 3 with 'BASH' -> stuck!
  const g3 = new StuckGuard(opts);
  const res3 = await g3.recordToolResult({ tool: 'BASH', input: 'python run.py', output: 'Traceback (most recent call last)', exitCode: 1 });

  assert.equal(res3.stuck, true);
  assert.match(res3.notice, /3 consecutive failures with the same strategy/);

  fs.rmSync(tmpFile, { force: true });
});
