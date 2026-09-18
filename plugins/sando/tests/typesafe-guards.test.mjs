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

test('evaluateDoneClaim: agent cannot deceive Sando by writing "tests pass" when telemetry is false', async () => {
  const offlineClient = new TypeSafeClient({ apiKey: null });

  // Scenario 1: Deceptive prose claiming tests pass, but Sando telemetry recorded verified = false
  const resDeceptive = await evaluateDoneClaim({
    finalMessage: "I fixed the bug completely and all 15 unit tests pass with 100% success!",
    hasCodeEdits: true,
    verified: false,
    client: offlineClient,
  });
  assert.equal(resDeceptive.claimsDone, true);
  assert.equal(resDeceptive.flagged, true);
  assert.match(resDeceptive.notice, /no passing verification command was recorded after the last edit/);

  // Scenario 2: Same prose, but Sando telemetry recorded genuine verified = true
  const resVerified = await evaluateDoneClaim({
    finalMessage: "I fixed the bug completely and all 15 unit tests pass with 100% success!",
    hasCodeEdits: true,
    verified: true,
    client: offlineClient,
  });
  assert.equal(resVerified.claimsDone, true);
  assert.equal(resVerified.flagged, false);
  assert.equal(resVerified.notice, null);

  // Scenario 3: Agent admits ongoing work (English & Italian negations)
  const resOngoingEn = await evaluateDoneClaim({
    finalMessage: "I haven't done the final migration yet, still debugging.",
    hasCodeEdits: true,
    verified: false,
    client: offlineClient,
  });
  assert.equal(resOngoingEn.claimsDone, false);
  assert.equal(resOngoingEn.flagged, false);

  const resOngoingIt = await evaluateDoneClaim({
    finalMessage: "Non ho ancora completato i test di carico.",
    hasCodeEdits: true,
    verified: false,
    client: offlineClient,
  });
  assert.equal(resOngoingIt.claimsDone, false);
  assert.equal(resOngoingIt.flagged, false);
});

test('StuckGuard Tier 1 fast-path: identical commands trigger deterministically with 0ms overhead', async () => {
  const tmpFile = path.join(os.tmpdir(), `test-stuck-tier1-${Date.now()}.json`);
  const guard = new StuckGuard({ storagePath: tmpFile, failureThreshold: 3, client: new TypeSafeClient({ apiKey: null }) });

  await guard.recordToolResult({ tool: 'Bash', input: 'python run.py', output: 'Crash', exitCode: 1 });
  await guard.recordToolResult({ tool: 'Bash', input: 'python run.py', output: 'Crash', exitCode: 1 });
  const res3 = await guard.recordToolResult({ tool: 'bash', input: 'python run.py', output: 'Crash', exitCode: 1 });

  // Must trigger via Tier 1 deterministic fast-path
  assert.equal(res3.stuck, true);
  assert.equal(res3.tier, 'deterministic');
  assert.equal(res3.elapsedMs, 0);
  assert.equal(res3.model, 'deterministic-fast-path');
  assert.match(res3.notice, /3 consecutive identical failures detected/);

  // 4th retry: must deduplicate notice
  const res4 = await guard.recordToolResult({ tool: 'bash', input: 'python run.py', output: 'Crash', exitCode: 1 });
  assert.equal(res4.stuck, true);
  assert.equal(res4.tier, 'deduplicated');
  assert.equal(res4.notice, null);

  // Read-only tool execution does NOT clear failure streak
  await guard.recordToolResult({ tool: 'grep', input: 'grep error log.txt', output: 'log', exitCode: 0 });
  const sessionData = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  assert.equal(sessionData.failures.length, 4);

  // Successful mutating command clears the streak
  await guard.recordToolResult({ tool: 'bash', input: 'echo "fixed" > file.txt', output: '', exitCode: 0 });
  const clearedData = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  assert.equal(clearedData.failures.length, 0);

  fs.rmSync(tmpFile, { force: true });
});

test('StuckGuard distinguishes different commands sharing prefix', async () => {
  const tmpFile = path.join(os.tmpdir(), `test-stuck-prefix-${Date.now()}.json`);
  const guard = new StuckGuard({ storagePath: tmpFile, failureThreshold: 3, client: new TypeSafeClient({ apiKey: null }) });

  // Different tests sharing the same long prefix: should NOT trigger stuck loop
  await guard.recordToolResult({ tool: 'Bash', input: 'npm run test:unit --grep FeatureAlpha', output: 'Failed', exitCode: 1 });
  await guard.recordToolResult({ tool: 'Bash', input: 'npm run test:unit --grep FeatureBeta', output: 'Failed', exitCode: 1 });
  const res = await guard.recordToolResult({ tool: 'Bash', input: 'npm run test:unit --grep FeatureGamma', output: 'Failed', exitCode: 1 });

  assert.equal(res.stuck, false);
  fs.rmSync(tmpFile, { force: true });
});
