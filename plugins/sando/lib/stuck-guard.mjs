/**
 * Stuck-Loop Detector Guard for Sando (PostToolUse Hook).
 *
 * Breaks retry loops when an agent repeats a failing strategy:
 * - Tier 1: Deterministic fast-path (0ms, 0 API calls) for identical command retries.
 * - Tier 2: TypeSafe Jev semantic evaluation only on ambiguous variations of failing strategies.
 * - Robust security: ownership and symlink validation on /tmp storage, session isolation.
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
    if (fs.existsSync(stateDir)) {
      const stat = fs.lstatSync(stateDir);
      // Defend against symlink hijacking or foreign UID ownership
      if (stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
        const home = process.env.HOME || os.tmpdir();
        const safeDir = path.join(home, '.cache', 'sando', `stuck-${uid}`);
        fs.mkdirSync(safeDir, { recursive: true, mode: 0o700 });
        return safeDir;
      }
    } else {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    }
  } catch {
    const fallbackDir = path.join(os.tmpdir(), `sando-${uid}-${process.pid}`);
    try {
      fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
      return fallbackDir;
    } catch {}
  }
  return stateDir;
}

function resolveSessionId(explicitId) {
  return explicitId
    || process.env.CLAUDE_CODE_SESSION_ID
    || process.env.CODEX_SESSION_ID
    || process.env.TMUX_PANE
    || `session-${process.ppid || process.pid}`;
}

function getStoragePath(sessionId) {
  const safeId = String(sessionId || 'default').replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getSessionStateDir(), `stuck-${safeId}.json`);
}

function loadSessionData(storagePath) {
  try {
    if (fs.existsSync(storagePath)) {
      const content = fs.readFileSync(storagePath, 'utf8');
      const data = JSON.parse(content);
      if (data && typeof data === 'object') {
        const now = Date.now();
        const failures = Array.isArray(data.failures)
          ? data.failures.filter((item) => typeof item?.timestamp === 'number' && (now - item.timestamp) < FAILURE_TTL_MS)
          : [];
        return {
          failures,
          isStuckAlerted: Boolean(data.isStuckAlerted && failures.length >= 3),
        };
      }
    }
  } catch {}
  return { failures: [], isStuckAlerted: false };
}

function saveSessionData(storagePath, sessionData) {
  try {
    const dir = path.dirname(storagePath);
    const tmpPath = path.join(dir, `.tmp-${path.basename(storagePath)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const payload = {
      failures: (sessionData.failures || []).slice(-10),
      isStuckAlerted: Boolean(sessionData.isStuckAlerted),
    };
    fs.writeFileSync(tmpPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
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
    };
  }

  const tools = attempts.map((a) => (a.tool || '').toLowerCase());
  const inputs = attempts.map((a) => normalizeSignature(a.command_summary || a.input));
  const errors = attempts.map((a) => normalizeSignature(a.error_summary || a.error));

  const allSameTool = tools.every((t) => t === tools[0]);
  const inputMatches = inputs.slice(1).filter((inp) => inp === inputs[0]).length;
  const sameInput = inputMatches >= 2;

  const errorMatches = errors.slice(1).filter((err) => err.length > 10 && err === errors[0]).length;
  const sameError = errorMatches >= 2;

  const loopDetected = allSameTool && (sameInput || sameError);
  return {
    same_strategy_loop: { value: loopDetected ? 0.90 : 0.15, confidence: 0.92 },
  };
}

export class StuckGuard {
  constructor(options = {}) {
    this.sessionId = resolveSessionId(options.sessionId);
    this.storagePath = options.storagePath || getStoragePath(this.sessionId);
    this.failureThreshold = options.failureThreshold || 3;
    this.client = options.client || new TypeSafeClient();
  }

  async recordToolResult({ tool, input, output, exitCode }) {
    const isExitFailure = typeof exitCode === 'number' && exitCode !== 0;
    const isFatalException = /^(?:fatal|error|panic|traceback):/im.test(output || '');
    const isFailure = isExitFailure || isFatalException;

    const sessionData = loadSessionData(this.storagePath);
    let failures = sessionData.failures;

    if (!isFailure) {
      // Diagnostic reads (like reading a file or grepping) should NOT reset failure chain
      const isReadOnly = /^(?:read|cat|head|tail|grep|ls|find)/i.test(tool || '')
        || /^(?:cat|head|tail|grep|ls|find)\b/i.test(String(input || ''));

      if (!isReadOnly) {
        // Genuine mutating success resets the failure chain
        saveSessionData(this.storagePath, { failures: [], isStuckAlerted: false });
      }
      return {
        stuck: false,
        riskScore: 0.0,
        notice: null,
      };
    }

    // Record failure with bounded payload
    failures.push({
      tool: (tool || 'tool').toLowerCase(),
      input: typeof input === 'string' ? input.slice(0, 300) : JSON.stringify(input || {}).slice(0, 300),
      error: (output || '').slice(0, 250),
      timestamp: Date.now(),
    });

    sessionData.failures = failures;
    saveSessionData(this.storagePath, sessionData);
    return this.checkStuck(sessionData);
  }

  async checkStuck(sessionDataParam) {
    const sessionData = sessionDataParam || loadSessionData(this.storagePath);
    const failures = sessionData.failures || [];
    const recent = failures.slice(-this.failureThreshold);

    if (recent.length < this.failureThreshold) {
      return {
        stuck: false,
        riskScore: 0.0,
        notice: null,
        tier: 'none',
      };
    }

    // Deduplication: if we already alerted on this active streak, do not spam
    if (sessionData.isStuckAlerted) {
      return {
        stuck: true,
        riskScore: 1.0,
        notice: null, // suppressed duplicate notice
        tier: 'deduplicated',
      };
    }

    // TIER 1: Deterministic Fast-Path (0ms, 0 API calls)
    // Check if tools and inputs are identical
    const tools = recent.map((a) => (a.tool || '').toLowerCase());
    const inputs = recent.map((a) => normalizeSignature(a.input));
    const allSameTool = tools.every((t) => t === tools[0]);
    const allSameInput = inputs.every((inp) => inp === inputs[0]);

    if (allSameTool && allSameInput) {
      sessionData.isStuckAlerted = true;
      saveSessionData(this.storagePath, sessionData);

      return {
        stuck: true,
        riskScore: 1.0,
        notice: `[sando stuck-guard]: ${this.failureThreshold} consecutive identical failures detected on command "${recent[0].input}". Stop retrying. Change approach.`,
        model: 'deterministic-fast-path',
        elapsedMs: 0,
        tier: 'deterministic',
      };
    }

    // TIER 2: Semantic Evaluation with TypeSafe Jev (only on ambiguous strategy variations)
    const state = {
      recent_failures: recent.map((f) => ({
        tool: f.tool,
        command_summary: f.input,
        error_summary: f.error,
      })),
    };

    const questions = {
      same_strategy_loop: {
        type: 'noul',
        instructions: 'Are these consecutive tool failures repeating the same failing strategy without meaningful adaptation?',
        criteria: {
          true: 'Repeating the same approach with minor syntactic variations or retrying a failing command',
          false: 'Genuinely exploring distinct hypotheses or trying fundamentally different diagnostic methods',
        },
      },
    };

    const result = await this.client.evaluate(state, questions, {
      offlineHandler: offlineStuckCheck,
    });

    const risk = Number(result.answers?.same_strategy_loop?.value ?? 0);
    const stuck = risk >= 0.70;

    if (stuck) {
      sessionData.isStuckAlerted = true;
      saveSessionData(this.storagePath, sessionData);
    }

    return {
      stuck,
      riskScore: risk,
      notice: stuck
        ? `[sando stuck-guard]: ${this.failureThreshold} consecutive failures repeating the same strategy (probability ${risk.toFixed(2)}). Stop retrying. Formulate a new hypothesis.`
        : null,
      model: result.model,
      elapsedMs: result.elapsedMs,
      tier: 'semantic',
    };
  }
}
