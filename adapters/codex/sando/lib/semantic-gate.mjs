import {
  listSemanticJudgmentCandidates,
  restoreSemanticJudgmentCandidates,
} from './context-transform.mjs';

const DEFAULT_LOSS_THRESHOLD = 0.7;

function lossThreshold(value) {
  if (value === undefined) return DEFAULT_LOSS_THRESHOLD;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('lossThreshold must be a number between 0 and 1');
  }
  return value;
}

export function createSemanticGate({ judge, lossThreshold: threshold } = {}) {
  if (typeof judge !== 'function') throw new TypeError('judge must be a function');
  const selectedThreshold = lossThreshold(threshold);

  return async function gate({ provider, originalBody, transformedBody, model } = {}) {
    const candidates = listSemanticJudgmentCandidates({
      provider, originalBody, transformedBody, model,
    });
    const restoreIds = [];
    const stats = {
      candidates: candidates.length,
      judged: 0,
      losses: 0,
      preserved: 0,
      restored: 0,
      fallbacks: 0,
      skipped: 0,
      lossThreshold: selectedThreshold,
    };

    for (const candidate of candidates) {
      let result;
      try {
        result = await judge(candidate);
      } catch {
        stats.fallbacks += 1;
        continue;
      }
      if (result?.status === 'judged') {
        stats.judged += 1;
        if (result.verdict === 'loss') {
          stats.losses += 1;
          if (Number.isFinite(result.lossProbability) && result.lossProbability >= selectedThreshold) {
            restoreIds.push(candidate.id);
          }
        } else if (result.verdict === 'preserved') {
          stats.preserved += 1;
        } else {
          stats.fallbacks += 1;
        }
      } else if (result?.status === 'skipped') {
        stats.skipped += 1;
      } else {
        stats.fallbacks += 1;
      }
    }

    const body = restoreSemanticJudgmentCandidates({
      provider, originalBody, transformedBody, ids: restoreIds,
    });
    stats.restored = restoreIds.length;
    return { body, stats };
  };
}
