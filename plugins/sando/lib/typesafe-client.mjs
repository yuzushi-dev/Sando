/**
 * TypeSafe AI (Jev System One) Client for Sando.
 *
 * Provides sub-second structured evaluations with strict fail-open semantics,
 * robust secret redaction across state and questions, and leak-free timeout handling.
 */

import fs from 'node:fs';
import path from 'node:path';

let authWarned = false;

const REDACTION_PATTERNS = [
  /\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /postgres(?:ql)?:\/\/[^@\s]+@[^\s/]+/gi,
  /(?:key|token|secret|password|passwd)\s*[:=]\s*['"][^'"]+['"]/gi,
];

export function redactValue(val) {
  if (typeof val === 'string') {
    let result = val;
    for (const pattern of REDACTION_PATTERNS) {
      result = result.replaceAll(pattern, '[REDACTED]');
    }
    return result;
  }
  if (Array.isArray(val)) return val.map(redactValue);
  if (val !== null && typeof val === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(val)) {
      result[k] = redactValue(v);
    }
    return result;
  }
  return val;
}

function resolveApiKey() {
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    return process.env.TYPESAFE_API_KEY.trim();
  }
  const home = process.env.HOME || '';
  const authFile = path.join(home, '.config', 'typesafe', 'auth.json');
  try {
    if (fs.existsSync(authFile)) {
      const data = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      const key = data.api_key || data.key || data.token;
      if (typeof key === 'string' && key.trim()) return key.trim();
    }
  } catch {}
  return null;
}

export class TypeSafeClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || resolveApiKey();
    this.baseUrl = (options.baseUrl || 'https://api.typesafe.ai/v1').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs || 350;
    this.offlineFallback = options.offlineFallback !== false;
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async evaluate(state, questions, options = {}) {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const safeState = redactValue(state);
    const safeQuestions = redactValue(questions);

    // Hard wall-clock ceiling to guarantee fail-open under any circumstance
    const hardLimitMs = timeoutMs + 150;

    const evaluationPromise = this._executeEvaluate(safeState, safeQuestions, timeoutMs, options, startTime);
    const hardTimeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          ok: false,
          answers: {},
          model: 'timeout-fallback',
          elapsedMs: Date.now() - startTime,
          error: `TypeSafe request exceeded hard limit of ${hardLimitMs}ms`,
          offline: true,
        });
      }, hardLimitMs);
    });

    return Promise.race([evaluationPromise, hardTimeoutPromise]);
  }

  async _executeEvaluate(safeState, safeQuestions, timeoutMs, options, startTime) {
    if (!this.apiKey) {
      if (options.offlineHandler) {
        try {
          const answers = options.offlineHandler(safeState, safeQuestions);
          return {
            ok: true,
            answers,
            model: 'offline-heuristic',
            elapsedMs: Date.now() - startTime,
            offline: true,
          };
        } catch (err) {
          return {
            ok: false,
            answers: {},
            model: 'offline-heuristic',
            elapsedMs: Date.now() - startTime,
            error: String(err),
            offline: true,
          };
        }
      }
      return {
        ok: false,
        answers: {},
        model: 'none',
        elapsedMs: Date.now() - startTime,
        error: 'No TYPESAFE_API_KEY configured and no offline handler provided',
        offline: true,
      };
    }

    const payload = {
      state: safeState,
      questions: safeQuestions,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(`${this.baseUrl}/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'User-Agent': 'sando-typesafe-guard/1.0',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!resp.ok) {
        if ((resp.status === 401 || resp.status === 403) && !authWarned) {
          authWarned = true;
          console.error(`[sando typesafe]: API key rejected (HTTP ${resp.status}). Check TYPESAFE_API_KEY.`);
        }
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      // Fix B5: Reading the JSON response body MUST be protected by the timer
      const data = await resp.json();
      return {
        ok: true,
        answers: data.answers || {},
        model: data.model || 'jev-1',
        elapsedMs: Date.now() - startTime,
        offline: false,
      };
    } catch (err) {
      if (this.offlineFallback && options.offlineHandler) {
        try {
          const answers = options.offlineHandler(safeState, safeQuestions);
          return {
            ok: true,
            answers,
            model: 'offline-fallback-heuristic',
            elapsedMs: Date.now() - startTime,
            error: `Live request failed (${err.message}), fell back to offline handler`,
            offline: true,
          };
        } catch {}
      }
      return {
        ok: false,
        answers: {},
        model: 'jev-1',
        elapsedMs: Date.now() - startTime,
        error: `TypeSafe request failed: ${err.message}`,
        offline: false,
      };
    } finally {
      // Fix B5: Always clear the timer in finally so it cannot leak or stall
      clearTimeout(timer);
    }
  }
}
