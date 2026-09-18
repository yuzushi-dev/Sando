/**
 * Done-Check Guard for Sando (PostToolUse / Turn-End Hook).
 *
 * Enforces verified completion:
 * - Jev (TypeSafe) evaluates ONLY whether the agent's prose asserts/implies completion.
 * - Sando deterministically enforces whether genuine verification (tests passed after last edit)
 *   actually occurred, completely immune to agent deception or hallucinated claims in prose.
 */

import { TypeSafeClient } from './typesafe-client.mjs';

// Heuristic completion patterns for offline fallback (multilingual EN/IT)
const COMPLETION_RE = /\b(?:done|fixed|resolved|completed|finished|all tests pass|all set|ready|fatto|ho risolto|risolto|completato|pronto)\b/i;
const NEGATIVE_COMPLETION_RE = /\b(?:not\s+(?:done|yet|finished|resolved)|haven['’]t|hasn['’]t|didn['’]t|still|working on|non\s+(?:\w+\s+){0,2}(?:ancora|fatto|completato|risolto|pronto|finito))\b/i;

export function offlineDoneCheck(state) {
  const msg = state.final_message || '';
  const hasNegative = NEGATIVE_COMPLETION_RE.test(msg);
  const hasCompletion = COMPLETION_RE.test(msg);
  const claimsDone = hasCompletion && !hasNegative;

  return {
    claims_done: {
      value: claimsDone ? 0.95 : 0.05,
      confidence: 0.92,
    },
  };
}

/**
 * Evaluates whether an agent's completion claim is verified by observed telemetry.
 *
 * @param {Object} params
 * @param {string} params.finalMessage - The agent's final text response.
 * @param {boolean} params.hasCodeEdits - Whether files were modified in this task.
 * @param {boolean} params.verified - Whether a verification command passed AFTER the last code edit.
 * @param {boolean} [params.verificationExempt=false] - For doc/config changes explicitly exempt.
 * @param {TypeSafeClient} [params.client] - TypeSafe client instance.
 * @returns {Promise<{flagged: boolean, claimsDone: boolean, verified: boolean, notice: string|null, model: string, elapsedMs: number}>}
 */
export async function evaluateDoneClaim({
  finalMessage,
  hasCodeEdits = false,
  verified = false,
  verificationExempt = false,
  client,
}) {
  const tsClient = client || new TypeSafeClient();
  const trimmedMessage = (finalMessage || '').slice(0, 3000);

  // Payload minimization: send only the prose to judge, never the test state
  const state = {
    message: trimmedMessage,
  };

  const questions = {
    claims_done: {
      type: 'noul',
      instructions: 'Does this message state, assert, or imply that the assigned task or bugfix is completed, finished, or resolved?',
      criteria: {
        true: 'Explicitly states or clearly implies the task is done/finished/resolved',
        false: 'Ongoing work, asking a clarifying question, or expressing that work remains',
      },
    },
  };

  const result = await tsClient.evaluate(state, questions, {
    offlineHandler: (st) => offlineDoneCheck({ final_message: st.message }),
  });

  const claimsDoneProbability = Number(result.answers?.claims_done?.value ?? 0);
  const claimsDone = claimsDoneProbability >= 0.70;

  // DETERMINISTIC POLICY GATE:
  // Sando enforces truth grounded in telemetry. The agent cannot bypass this
  // by writing "12 tests pass" in its prose if verified is false.
  const requiresVerification = Boolean(hasCodeEdits) && !verificationExempt;
  const isUnverified = requiresVerification && !verified;
  const flagged = claimsDone && isUnverified;

  const notice = flagged
    ? `[sando done-guard]: Completion claim rejected (probability ${claimsDoneProbability.toFixed(2)}). ` +
      `Code changes were made, but no passing verification command was recorded after the last edit. ` +
      `Execute project tests to confirm the fix before finishing.`
    : null;

  return {
    flagged,
    claimsDone,
    claimsDoneProbability,
    verified: Boolean(verified),
    notice,
    model: result.model,
    elapsedMs: result.elapsedMs,
  };
}
