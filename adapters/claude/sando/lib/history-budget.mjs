const INVALID_BUDGET = 'maxHistoryTokens must be a positive safe integer';

export function validateMaxHistoryTokens(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(INVALID_BUDGET);
  return value;
}

export function selectHistoryCandidates({ bodyTokens, maxHistoryTokens, candidates } = {}) {
  validateMaxHistoryTokens(maxHistoryTokens);
  if (!Number.isSafeInteger(bodyTokens) || bodyTokens < 0 || !Array.isArray(candidates)) return [];
  if (BigInt(bodyTokens) * 5n <= BigInt(maxHistoryTokens) * 4n) return [];

  const idCounts = new Map();
  for (const candidate of candidates) {
    if (typeof candidate?.id === 'string' && candidate.id.length > 0) {
      idCounts.set(candidate.id, (idCounts.get(candidate.id) ?? 0) + 1);
    }
  }

  return candidates.filter((candidate) =>
    candidate !== null
    && typeof candidate === 'object'
    && typeof candidate.id === 'string'
    && candidate.id.length > 0
    && idCounts.get(candidate.id) === 1
    && candidate.safe === true
    && candidate.historical === true
    && candidate.error !== true
    && candidate.current !== true
    && Number.isSafeInteger(candidate.position)
    && candidate.position >= 0
    && Number.isSafeInteger(candidate.estimatedTokens)
    && candidate.estimatedTokens > 0)
    .sort((left, right) =>
      left.position - right.position || right.estimatedTokens - left.estimatedTokens);
}
