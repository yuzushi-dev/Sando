import { estimateTokens, createSemanticCompactor } from '../../packages/sando/index.mjs';

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function quality(text, requiredFacts = []) {
  return requiredFacts.every((fact) => text.includes(fact));
}

function normalizeFacts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('requiredFacts must be an array');
  return value.map((fact) => typeof fact === 'string' ? fact : fact?.value).filter((fact) => {
    if (typeof fact !== 'string' || fact.length === 0) throw new TypeError('requiredFacts must contain values');
    return true;
  });
}

export async function runSemanticShadow({
  scenarios,
  complete,
  deterministic,
  repetitions = 1,
  policy,
  provider = 'openai-responses',
  model = 'fixture-oracle',
  mode = 'provider-free-oracle',
} = {}) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) throw new TypeError('scenarios are required');
  if (typeof complete !== 'function') throw new TypeError('complete callback is required');
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new TypeError('repetitions must be positive');
  const compact = createSemanticCompactor({ complete, policy });
  const runs = [];

  for (const scenario of scenarios) {
    if (!scenario || typeof scenario.id !== 'string' || !Array.isArray(scenario.events)) {
      throw new TypeError('invalid semantic shadow scenario');
    }
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (const event of scenario.events) {
        if (!event || typeof event.output !== 'string' || typeof event.id !== 'string') {
          throw new TypeError('invalid semantic shadow event');
        }
        const deterministicText = typeof deterministic === 'function'
          ? await deterministic(event)
          : event.output;
        if (typeof deterministicText !== 'string') throw new TypeError('deterministic transform must return text');
        const deterministicTokens = estimateTokens(deterministicText);
        const requiredFacts = normalizeFacts(event.requiredFacts);
        const result = await compact({
          provider,
          model,
          toolName: event.toolName ?? 'unknown',
          text: deterministicText,
          historical: event.current !== true,
          isError: event.isError === true,
          requiredFacts,
        });
        const semanticText = result.status === 'candidate' ? result.summary : deterministicText;
        const semanticTokens = estimateTokens(semanticText);
        const compactorInputTokens = result.compactorInputTokens ?? 0;
        const compactorOutputTokens = result.compactorOutputTokens ?? 0;
        const compactorTokens = compactorInputTokens + compactorOutputTokens;
        runs.push({
          scenario: scenario.id,
          repetition,
          event: event.id,
          status: result.status,
          reason: result.reason ?? null,
          cacheHit: result.cacheHit === true,
          deterministicTokens,
          semanticTokens,
          compactorInputTokens,
          compactorOutputTokens,
          compactorTokens,
          providerUsage: result.providerUsage ?? null,
          totalWithCompactorTokens: semanticTokens + compactorTokens,
          netSavedTokens: deterministicTokens - semanticTokens - compactorTokens,
          latencyMs: result.latencyMs ?? 0,
          quality: quality(semanticText, requiredFacts),
        });
      }
    }
  }

  const candidates = runs.filter((run) => run.status === 'candidate').length;
  const candidateRuns = runs.filter((run) => run.status === 'candidate');
  const fallbacks = runs.filter((run) => run.status === 'fallback').length;
  const cacheHits = runs.filter((run) => run.cacheHit).length;
  const compactorTokens = runs.reduce((sum, run) => sum + run.compactorTokens, 0);
  const compactorInputTokens = runs.reduce((sum, run) => sum + run.compactorInputTokens, 0);
  const compactorOutputTokens = runs.reduce((sum, run) => sum + run.compactorOutputTokens, 0);
  const deterministicTokens = runs.reduce((sum, run) => sum + run.deterministicTokens, 0);
  const semanticTokens = runs.reduce((sum, run) => sum + run.semanticTokens, 0);
  const totalWithCompactorTokens = runs.reduce((sum, run) => sum + run.totalWithCompactorTokens, 0);
  const netSavedTokens = runs.reduce((sum, run) => sum + run.netSavedTokens, 0);
  const latencies = runs.map((run) => run.latencyMs);
  return {
    schema: 'sando-semantic-shadow/v1',
    mode,
    provider,
    model,
    runs,
    summary: {
      events: runs.length,
      candidates,
      candidateRate: candidates / runs.length,
      cacheHits,
      cacheHitRate: cacheHits / Math.max(1, candidates),
      fallbacks,
      fallbackRate: fallbacks / runs.length,
      factRecall: candidates === 0 ? null : candidateRuns.filter((run) => run.quality).length / candidates,
      deterministicTokens,
      semanticTokens,
      compactorTokens,
      compactorInputTokens,
      compactorOutputTokens,
      totalWithCompactorTokens,
      netSavedTokens,
      netSavedPercent: deterministicTokens === 0 ? 0 : netSavedTokens / deterministicTokens * 100,
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
    },
  };
}
