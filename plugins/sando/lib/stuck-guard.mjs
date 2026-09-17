/**
 * Stuck-Loop Detector Guard for Sando (PostToolUse Hook).
 *
 * Breaks retry loops when an agent attempts the same failed strategy 3+ times.
 * Includes file-based session persistence across ephemeral hook invocations,
 * homogeneous async return contracts, and multi-field strategy comparisons.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TypeSafeClient } from './typesafe-client.mjs';

function getStoragePath(sessionId) {
  const safeId = (sessionId || 'default').replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `sando-stuck-${safeId}.json`);
}

function loadSessionFailures(storagePath) {
  try {
    if (fs.existsSync(storagePath)) {
      const content = fs.readFileSync(storagePath, 'utf8');
      const data = JSON.parse(content);
      if (Array.isArray(data)) return data;
    }
  } catch {}
  return [];
}

function saveSessionFailures(storagePath, failures) {
  try {
    fs.writeFileSync(storagePath, JSON.stringify(failures.slice(-10)), 'utf8');
  } catch {}
}

function normalizeSignature(text) {
  return (text || '')
    .toLowerCase()
    .replaceAll(/[0-9a-f]{8,}/g, '<hash>')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function offlineStuckCheck(state) {
  const attempts = state.recent_failures || [];
  if (attempts.length < 3) {
    return {
      same_strategy_loop: { value: 0.10, confidence: 0.95 },
      loop_risk: { value: 0.10, confidence: 0.95 },
    };
  }

  // Multi-field comparison of strategy: tools, inputs, and error signatures
  const tools = attempts.map((a) => a.tool);
  const inputs = attempts.map((a) => normalizeSignature(a.input));
  const errors = attempts.map((a) => normalizeSignature(a.error));

  const allSameTool = tools.every((t) => t === tools[0]);
  
  // Check if inputs are identical or high similarity
  const inputMatches = inputs.slice(1).filter((inp) => inp === inputs[0] || inp.slice(0, 30) === inputs[0].slice(0, 30)).length;
  const sameInput = inputMatches >= 2;

  // Check if error signatures are truly matching
  const errorMatches = errors.slice(1).filter((err) => err === errors[0] && err.length > 5).length;
  const sameError = errorMatches >= 2;

  // Fix B2: Loop is flagged only when tool matches AND (input repeats OR same exact error repeats)
  const loopDetected = allSameTool && (sameInput || sameError);
  const val = loopDetected ? 0.90 : 0.15;

  return {
    same_strategy_loop: { value: val, confidence: 0.92 },
    loop_risk: { value: val, confidence: 0.90 },
  };
}

export class StuckGuard {
  constructor(options = {}) {
    this.sessionId = options.sessionId || process.env.TMUX_PANE || 'default';
    this.storagePath = options.storagePath || getStoragePath(this.sessionId);
    this.failureThreshold = options.failureThreshold || 3;
    this.client = options.client || new TypeSafeClient();
  }

  /**
   * Fix B3: Consistently async method returning a homogeneous status object.
   */
  async recordToolResult({ tool, input, output, exitCode }) {
    const isExitFailure = typeof exitCode === 'number' && exitCode !== 0;
    const isFatalException = /^(?:fatal|error|panic|traceback):/im.test(output || '');
    const isFailure = isExitFailure || isFatalException;

    // Fix B4: Load persistent session failures from file
    let failures = loadSessionFailures(this.storagePath);

    if (!isFailure) {
      // Diagnostic reads (like reading a file or grepping) should NOT reset failure chain
      const isReadOnly = /^(?:read|cat|head|tail|grep|ls|find)/i.test(tool || '')
        || /^(?:cat|head|tail|grep|ls|find)\b/i.test(String(input || ''));

      if (!isReadOnly) {
        // Genuine mutating success resets the failure chain
        saveSessionFailures(this.storagePath, []);
      }
      return {
        stuck: false,
        riskScore: 0.0,
        notice: null,
      };
    }

    // Record failure
    failures.push({
      tool: tool || 'tool',
      input: typeof input === 'string' ? input.slice(0, 250) : JSON.stringify(input || {}).slice(0, 250),
      error: (output || '').slice(0, 350),
      timestamp: Date.now(),
    });

    saveSessionFailures(this.storagePath, failures);
    return this.checkStuck(failures);
  }

  async checkStuck(failures) {
    const recent = (failures || loadSessionFailures(this.storagePath)).slice(-this.failureThreshold);
    if (recent.length < this.failureThreshold) {
      return {
        stuck: false,
        riskScore: 0.0,
        notice: null,
      };
    }

    const state = {
      recent_failures: recent,
    };

    const questions = {
      same_strategy_loop: {
        type: 'noul',
        instructions: 'Are these consecutive tool failures repeating the same strategy without meaningful adaptation?',
      },
      loop_risk: {
        type: 'score',
        instructions: 'Score the retry loop severity (0 = new attempt, 1 = identical stuck retry loop).',
        criteria: [
          'Different approaches or gathering new diagnostic information',
          'Slight variation of parameter but same conceptual method',
          'Repetitive retry of failing action with no real hypothesis change',
        ],
      },
    };

    const result = await this.client.evaluate(state, questions, {
      offlineHandler: offlineStuckCheck,
    });

    const risk = Number(result.answers?.same_strategy_loop?.value || 0);
    const stuck = risk >= 0.70;

    return {
      stuck,
      riskScore: risk,
      notice: stuck
        ? `[sando stuck-guard]: ${this.failureThreshold} consecutive failures with the same strategy. Stop retrying. Formulate a new hypothesis before continuing.`
        : null,
      model: result.model,
      elapsedMs: result.elapsedMs,
    };
  }
}
