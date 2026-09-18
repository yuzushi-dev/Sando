/**
 * TypeSafe AI (Jev System One) Client for Sando.
 *
 * Provides sub-second structured evaluations with strict fail-open semantics,
 * robust secret redaction across state and questions, and leak-free timeout handling.
 * Conforms to TypeSafe System One API (POST /v1/systemone with jev-latest).
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
    this.defaultModel = options.model || 'jev-latest';
    this.timeoutMs = options.timeoutMs || 1000;
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
    const hardLimitMs = timeoutMs + 200;
    let hardTimer = null;

    const evaluationPromise = this._executeEvaluate(safeState, safeQuestions, timeoutMs, options, startTime);
    const hardTimeoutPromise = new Promise((resolve) => {
      hardTimer = setTimeout(() => {
        // Fall back to offline handler even if hard network timeout fired
        if (this.offlineFallback && options.offlineHandler) {
          try {
            const answers = options.offlineHandler(safeState, safeQuestions);
            return resolve({
              ok: true,
              answers,
              model: 'timeout-fallback-heuristic',
              elapsedMs: Date.now() - startTime,
              error: `Request reached hard limit (${hardLimitMs}ms); fell back to offline handler`,
              offline: true,
            });
          } catch {}
        }
        resolve({
          ok: false,
          answers: {},
          model: 'timeout-fallback',
          elapsedMs: Date.now() - startTime,
          error: `TypeSafe request exceeded hard limit of ${hardLimitMs}ms`,
          offline: true,
        });
      }, hardLimitMs);
      if (hardTimer.unref) hardTimer.unref();
    });

    try {
      return await Promise.race([evaluationPromise, hardTimeoutPromise]);
    } finally {
      if (hardTimer) clearTimeout(hardTimer);
    }
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
      model: options.model || this.defaultModel,
      questions: safeQuestions,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer.unref) timer.unref();

    try {
      const endpoint = `${this.baseUrl}/systemone`;
      const resp = await fetch(endpoint, {
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

      const data = await resp.json();
      const rawAnswers = data.answers || {};
      const normalizedAnswers = {};

      for (const [qId, qAns] of Object.entries(rawAnswers)) {
        if (!qAns || typeof qAns !== 'object') continue;
        const val = qAns.value !== undefined
          ? qAns.value
          : (qAns.noul !== undefined ? qAns.noul : (qAns.choice !== undefined ? qAns.choice : qAns.score));
        
        normalizedAnswers[qId] = {
          value: val,
          confidence: qAns.confidence !== undefined ? qAns.confidence : (typeof qAns.noul === 'number' ? 1.0 : undefined),
          probabilities: qAns.probabilities || {},
          raw: qAns,
          type: qAns.type,
        };
      }

      return {
        ok: true,
        answers: normalizedAnswers,
        model: data.model || this.defaultModel,
        elapsedMs: Date.now() - startTime,
        offline: false,
        usage: data.usage,
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
        model: this.defaultModel,
        elapsedMs: Date.now() - startTime,
        error: `TypeSafe request failed: ${err.message}`,
        offline: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
