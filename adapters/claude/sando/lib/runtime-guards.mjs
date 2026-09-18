/**
 * Runtime Hook Dispatcher for Sando Guards (Stuck-Loop & Done-Check).
 *
 * Integrates StuckGuard on PostToolUse and DoneGuard on Stop:
 * - Maintains session telemetry across tool executions (edits invalidate verifications).
 * - Executes Tier 1 fast-path (0ms) and Tier 2 TypeSafe Jev semantic evaluation.
 * - Strict fail-open: never blocks the host process on unexpected guard errors.
 */

import fs from 'node:fs';

import { StuckGuard } from './stuck-guard.mjs';
import { evaluateDoneClaim } from './done-guard.mjs';
import { loadSessionTelemetry, recordToolEvent } from './session-telemetry.mjs';

export function isGuardsEnabled(env = process.env) {
  return /^(1|true|yes)$/i.test(env.SANDO_TYPESAFE_GUARDS || '');
}

export function extractLastAssistantMessage(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    if (fs.existsSync(transcriptPath)) {
      const content = fs.readFileSync(transcriptPath, 'utf8').trim();
      if (!content) return '';
      // Try JSON Lines format
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.role === 'assistant' || entry.type === 'assistant') {
            if (typeof entry.content === 'string') return entry.content;
            if (Array.isArray(entry.content)) {
              const textBlock = entry.content.find((b) => b.type === 'text');
              if (textBlock?.text) return textBlock.text;
            }
          }
        } catch {}
      }
    }
  } catch {}
  return '';
}

export async function handlePostToolUseGuard({ host, event, input, env = process.env }) {
  const sessionId = input.session_id ?? input.sessionId ?? env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_SESSION_ID ?? 'default';

  // Always track empirical telemetry across tool events
  try {
    recordToolEvent({
      sessionId,
      toolName: event.toolName,
      toolInput: event.toolInput,
      exitCode: event.exitCode ?? 0,
    });
  } catch {}

  // Check Stuck-Guard if enabled
  if (isGuardsEnabled(env) || /^(1|true|yes)$/i.test(env.SANDO_STUCK_GUARD || '')) {
    try {
      const stuckGuard = new StuckGuard({ sessionId });
      const res = await stuckGuard.recordToolResult({
        tool: event.toolName,
        input: event.toolInput,
        output: event.output,
        exitCode: event.exitCode,
      });
      return res;
    } catch {
      // Fail-open: guard failure must never block tool execution
    }
  }

  return { stuck: false, riskScore: 0, notice: null };
}

export async function handleStopGuard({ host, input, env = process.env }) {
  if (!isGuardsEnabled(env) && !/^(1|true|yes)$/i.test(env.SANDO_DONE_GUARD || '')) {
    return { flagged: false, notice: null };
  }

  const sessionId = input.session_id ?? input.sessionId ?? env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_SESSION_ID ?? 'default';
  const telemetry = loadSessionTelemetry(sessionId);

  // If no code was modified, DoneGuard is not required
  if (!telemetry.hasCodeEdits) {
    return { flagged: false, notice: null };
  }

  let finalMessage = input.final_message ?? input.last_assistant_message ?? '';
  if (!finalMessage && input.transcript_path) {
    finalMessage = extractLastAssistantMessage(input.transcript_path);
  }

  if (!finalMessage) {
    return { flagged: false, notice: null };
  }

  try {
    const res = await evaluateDoneClaim({
      finalMessage,
      hasCodeEdits: telemetry.hasCodeEdits,
      verified: telemetry.testsPassedAfterLastEdit,
    });
    return res;
  } catch {
    // Fail-open
    return { flagged: false, notice: null };
  }
}
