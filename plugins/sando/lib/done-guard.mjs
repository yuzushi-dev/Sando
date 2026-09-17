/**
 * Done-Check Guard for Sando (Stop Hook / Post-Task Verification).
 *
 * Catches premature or unverified claims of "done" when tests, builds,
 * or lints have not passed after code edits.
 * Supports Italian and English idioms with non-adjacent negation awareness.
 */

import { TypeSafeClient } from './typesafe-client.mjs';

const COMPLETION_RE = /\b(done|fixed|completed|all tests pass|ho risolto|fatto|pronto)\b/i;
const NEGATIVE_COMPLETION_RE = /\b(non|manca|ancora\s+non|incompleto|not|haven't|hasn't|failed\s+to|yet\s+to|undone|partially)\b[\s\w]{0,25}\b(fatto|risolto|completato|pronto|done|fixed|completed|finish|pass)\b|\bnon\s+(?:è|ho|abbiamo)\s+(?:fatto|risolto|pronto)\b/i;

function offlineDoneCheck(state) {
  const finalMessage = state.final_message || '';
  const hasEdit = Boolean(state.has_code_edits);
  const testsPassed = Boolean(state.tests_passed);
  const testsRan = Boolean(state.tests_ran);

  // Check completion markers while respecting English and Italian negations
  const claimsDone = COMPLETION_RE.test(finalMessage) && !NEGATIVE_COMPLETION_RE.test(finalMessage);

  let verified = true;
  let violationScore = 0.0;

  if (claimsDone && hasEdit && (!testsRan || !testsPassed)) {
    verified = false;
    violationScore = testsRan && !testsPassed ? 0.95 : 0.85;
  }

  return {
    claims_done: {
      value: claimsDone ? 1.0 : 0.0,
      confidence: 0.90,
    },
    verified_completion: {
      value: verified ? 1.0 : 0.0,
      confidence: 0.92,
    },
    unverified_done_risk: {
      value: violationScore,
      confidence: 0.90,
    },
  };
}

export async function evaluateDoneClaim({ finalMessage, hasCodeEdits, testsRan, testsPassed, client }) {
  const tsClient = client || new TypeSafeClient();
  const state = {
    final_message: (finalMessage || '').slice(0, 4000),
    has_code_edits: Boolean(hasCodeEdits),
    tests_ran: Boolean(testsRan),
    tests_passed: Boolean(testsPassed),
  };

  const questions = {
    claims_done: {
      type: 'noul',
      instructions: 'Does this message claim or imply that the task/bug is finished or solved?',
    },
    unverified_done_risk: {
      type: 'score',
      instructions: 'Score how unverified this completion claim is (0 = fully verified with passing test evidence, 1 = unverified claim after code change with no test run).',
      criteria: [
        'No completion claimed or evidence is solid',
        'Mild completion claim without explicit verification',
        'Explicit done claim after code edit but no test was run or test failed',
      ],
    },
  };

  const result = await tsClient.evaluate(state, questions, {
    offlineHandler: offlineDoneCheck,
  });

  const risk = Number(result.answers?.unverified_done_risk?.value || 0);
  const flagged = risk >= 0.70;

  return {
    flagged,
    riskScore: risk,
    notice: flagged
      ? '[sando done-guard]: unverified completion claim. Edits were made but no passing test or verification command was observed.'
      : null,
    model: result.model,
    elapsedMs: result.elapsedMs,
  };
}
