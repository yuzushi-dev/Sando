/**
 * Stuck-Loop Detector Guard for Sando (PostToolUse Hook).
 *
 * Breaks retry loops when an agent attempts the same failed strategy 3+ times.
 * Includes atomic file-based session persistence, TTL expiration, case-insensitive
 * tool normalization, and robust command comparison.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TypeSafeClient } from './typesafe-client.mjs';

const FAILURE_TTL_MS = 20 * 60 * 1000; // 20 minutes

function getSessionStateDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'shared';
  const stateDir = path.join(os.tmpdir(), `sando-${uid}`);
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch {}
  return stateDir;
}

function getStoragePath(sessionId) {
  const safeId = (sessionId || 'default').replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getSessionStateDir(), `stuck-${safeId}.json`);
}

function loadSessionFailures(storagePath) {
  try {
    if (fs.existsSync(storagePath)) {
      const content = fs.readFileSync(storagePath, 'utf8');
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        const now = Date.now();
        // Discard entries older than TTL
        return data.filter((item) => typeof item?.timestamp === 'number' && (now - item.timestamp) < FAILURE_TTL_MS);
      }
    }
  } catch {}
  return [];
}

function saveSessionFailures(storagePath, failures) {
  try {
    const dir = path.dirname(storagePath);
    const tmpPath = path.join(dir, `.tmp-${path.basename(storagePath)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const validFailures = failures.slice(-10);
    fs.writeFileSync(tmpPath, JSON.stringify(validFailures), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, storagePath);
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
  const tools = attempts.map((a) => (a.tool || '').toLowerCase());
  const inputs = attempts.map((a) => normalizeSignature(a.input));
  const errors = attempts.map((a) => normalizeSignature(a.error));

  const allSameTool = tools.every((t) => t === tools[0]);

  // Full command equality or exact command structure match
  const inputMatches = inputs.slice(1).filter((inp) => inp === inputs[0]).length;
  const sameInput = inputMatches >= 2;

  // Real error signature matches (requiring substantive non-empty match)
  const errorMatches = errors.slice(1).filter((err) => err.length > 10 && err === errors[0]).length;
  const sameError = errorMatches >= 2;

  const loopDetected = allSameTool && (sameInput || sameError);
  const val = loopDetected ? 0.90 : 0.15;

  return {
    same_strategy_loop: { value: val, confidence: 0.92 },
    loop_risk: { value: val, confidence: 0.90 },
  };
}

export class StuckGuard {
  constructor(options = {}) {
    this.sessionId = options.sessionId || process.env.TMUX_PANE || process.env.CLAUDE_CODE_SESSION_ID || 'default';
    this.storagePath = options.storagePath || getStoragePath(this.sessionId);
    this.failureThreshold = options.failureThreshold || 3;
    this.client = options.client || new TypeSafeClient();
  }

  async recordToolResult({ tool, input, output, exitCode }) {
    const isExitFailure = typeof exitCode === 'number' && exitCode !== 0;
    const isFatalException = /^(?:fatal|error|panic|traceback):/im.test(output || '');
    const isFailure = isExitFailure || isFatalException;

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
      tool: (tool || 'tool').toLowerCase(),
      input: typeof input === 'string' ? input.slice(0, 500) : JSON.stringify(input || {}).slice(0, 500),
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
