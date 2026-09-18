import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadSessionTelemetry,
  recordToolEvent,
} from '../src/session-telemetry.mjs';
import {
  handlePostToolUseGuard,
  handleStopGuard,
} from '../src/runtime-guards.mjs';

test('Session telemetry state machine: edit -> test fail -> test pass -> subsequent edit', () => {
  const sessionId = `test-telemetry-${Date.now()}`;

  // Initial state: clean
  let t0 = loadSessionTelemetry(sessionId);
  assert.equal(t0.hasCodeEdits, false);
  assert.equal(t0.testsPassedAfterLastEdit, false);

  // 1. Code edit tool
  recordToolEvent({ sessionId, toolName: 'write_to_file', toolInput: { path: 'app.js' }, exitCode: 0 });
  let t1 = loadSessionTelemetry(sessionId);
  assert.equal(t1.hasCodeEdits, true);
  assert.equal(t1.testsPassedAfterLastEdit, false);

  // 2. Failing test run
  recordToolEvent({ sessionId, toolName: 'Bash', toolInput: 'npm test', exitCode: 1 });
  let t2 = loadSessionTelemetry(sessionId);
  assert.equal(t2.hasCodeEdits, true);
  assert.equal(t2.testsPassedAfterLastEdit, false);

  // 3. Passing test run
  recordToolEvent({ sessionId, toolName: 'Bash', toolInput: 'npm test', exitCode: 0 });
  let t3 = loadSessionTelemetry(sessionId);
  assert.equal(t3.hasCodeEdits, true);
  assert.equal(t3.testsPassedAfterLastEdit, true);

  // 4. Subsequent code edit MUST invalidate the verification
  recordToolEvent({ sessionId, toolName: 'replace_file_content', toolInput: { file: 'app.js' }, exitCode: 0 });
  let t4 = loadSessionTelemetry(sessionId);
  assert.equal(t4.hasCodeEdits, true);
  assert.equal(t4.testsPassedAfterLastEdit, false);
});

test('handleStopGuard respects telemetry truth and flags unverified completion claims', async () => {
  const sessionId = `test-stop-guard-${Date.now()}`;
  const env = { SANDO_TYPESAFE_GUARDS: '1' };

  // Step 1: Code was modified
  recordToolEvent({ sessionId, toolName: 'edit_file', toolInput: { file: 'main.py' }, exitCode: 0 });

  // Agent tries to claim completion while verified is false
  const unverifiedRes = await handleStopGuard({
    host: 'codex',
    input: {
      session_id: sessionId,
      final_message: 'Ho completato il refactoring e tutti i 15 test passano!',
    },
    env,
  });
  assert.equal(unverifiedRes.flagged, true);
  assert.match(unverifiedRes.notice, /Completion claim rejected/);

  // Step 2: Now tests actually run and pass
  recordToolEvent({ sessionId, toolName: 'Bash', toolInput: 'pytest tests/', exitCode: 0 });

  const verifiedRes = await handleStopGuard({
    host: 'codex',
    input: {
      session_id: sessionId,
      final_message: 'Ho completato il refactoring e tutti i 15 test passano!',
    },
    env,
  });
  assert.equal(verifiedRes.flagged, false);
  assert.equal(verifiedRes.notice, null);
});

test('handlePostToolUseGuard triggers Tier 1 deterministic fast-path on identical retries', async () => {
  const sessionId = `test-post-tool-${Date.now()}`;
  const env = { SANDO_TYPESAFE_GUARDS: '1' };

  const event = { toolName: 'bash', toolInput: 'make build', output: 'gcc: fatal error', exitCode: 1 };
  const input = { session_id: sessionId };

  await handlePostToolUseGuard({ host: 'codex', event, input, env });
  await handlePostToolUseGuard({ host: 'codex', event, input, env });
  const res3 = await handlePostToolUseGuard({ host: 'codex', event, input, env });

  assert.equal(res3.stuck, true);
  assert.equal(res3.tier, 'deterministic');
  assert.equal(res3.elapsedMs, 0);
  assert.match(res3.notice, /3 consecutive identical failures detected/);
});
