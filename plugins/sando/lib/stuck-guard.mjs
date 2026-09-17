/**
 * Stuck-Loop Detector Guard for Sando (PostToolUse Hook).
 *
 * Breaks retry loops when an agent attempts the same failed strategy 3+ times.
 */

import { TypeSafeClient } from './typesafe-client.mjs';

function offlineStuckCheck(state) {
  const attempts = state.recent_failures || [];
  if (attempts.length < 3) {
    return {
      same_strategy_loop: { value: 0.10, confidence: 0.95 },
      loop_risk: { value: 0.10, confidence: 0.95 },
    };
  }

  // Check if errors or tool calls are similar
  const tools = attempts.map((a) => a.tool);
  const allSameTool = tools.every((t) => t === tools[0]);
  const errorSnippets = attempts.map((a) => (a.error || '').slice(0, 100));
  const similarErrors = errorSnippets[0] && errorSnippets.every((e) => e === errorSnippets[0] || e.length > 0);

  const loopDetected = allSameTool && similarErrors;
  const val = loopDetected ? 0.88 : 0.20;

  return {
    same_strategy_loop: { value: val, confidence: 0.90 },
    loop_risk: { value: val, confidence: 0.90 },
  };
}

export class StuckGuard {
  constructor(options = {}) {
    this.historyLimit = options.historyLimit || 5;
    this.failureThreshold = options.failureThreshold || 3;
    this.recentFailures = [];
    this.client = options.client || new TypeSafeClient();
  }

  recordToolResult({ tool, input, output, exitCode }) {
    const isFailure = (typeof exitCode === 'number' && exitCode !== 0)
      || /error|failed|exception/i.test(output || '');

    if (!isFailure) {
      // Clear or dampen failure chain on successful progress
      this.recentFailures = [];
      return { stuck: false };
    }

    this.recentFailures.push({
      tool,
      input: typeof input === 'string' ? input.slice(0, 200) : JSON.stringify(input || {}).slice(0, 200),
      error: (output || '').slice(0, 300),
      timestamp: Date.now(),
    });

    if (this.recentFailures.length > this.historyLimit) {
      this.recentFailures.shift();
    }

    return this.checkStuck();
  }

  async checkStuck() {
    if (this.recentFailures.length < this.failureThreshold) {
      return { stuck: false };
    }

    const state = {
      recent_failures: this.recentFailures.slice(-this.failureThreshold),
    };

    const questions = {
      same_strategy_loop: {
        type: 'noul',
        instructions: 'Are these consecutive tool failures repeating the same strategy or method without meaningful adaptation?',
      },
      loop_risk: {
        type: 'score',
        instructions: 'Score the severity of the retry loop (0 = genuine new attempt, 1 = identical stuck retry loop).',
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
        ? `[sando stuck-guard]: ${this.failureThreshold} consecutive failures with the same strategy. Stop retrying. Formulate a new hypothesis or inspect relevant files before continuing.`
        : null,
      model: result.model,
      elapsedMs: result.elapsedMs,
    };
  }
}
