/**
 * TypeSafe AI (Jev System One) Client for Sando.
 *
 * Provides sub-second structured evaluations with strict fail-open semantics
 * and automatic secret redaction.
 */

import fs from 'node:fs';
import path from 'node:path';

function redactObject(obj) {
  if (typeof obj === 'string') {
    // Basic redaction of common credential shapes
    return obj
      .replaceAll(/ghp_[A-Za-z0-9_]{36}/g, '[REDACTED_GH_TOKEN]')
      .replaceAll(/(?:bearer\s+|token=)[A-Za-z0-9._-]{20,}/gi, '[REDACTED_TOKEN]')
      .replaceAll(/postgres(?:ql)?:\/\/[^@\s]+@[^\s/]+/gi, 'postgresql://[REDACTED_DSN]');
  }
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj !== null && typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = redactObject(v);
    }
    return result;
  }
  return obj;
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
    const safeState = redactObject(state);

    if (!this.apiKey) {
      if (options.offlineHandler) {
        try {
          const answers = options.offlineHandler(safeState, questions);
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
      questions,
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
      clearTimeout(timer);

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      const data = await resp.json();
      return {
        ok: true,
        answers: data.answers || {},
        model: data.model || 'jev-1',
        elapsedMs: Date.now() - startTime,
        offline: false,
      };
    } catch (err) {
      clearTimeout(timer);
      if (this.offlineFallback && options.offlineHandler) {
        try {
          const answers = options.offlineHandler(safeState, questions);
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
    }
  }
}
