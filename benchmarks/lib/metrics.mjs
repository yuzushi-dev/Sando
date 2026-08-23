import fs from 'node:fs/promises';

export function estimateTokens(value) {
  if (typeof value !== 'string') throw new TypeError('token estimate requires text');
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 4);
}

function keyOf(run) {
  return `${run.scenario}\u0000${run.repetition}`;
}

function validateRun(run) {
  if (!run || typeof run !== 'object' || typeof run.scenario !== 'string'
    || !Number.isInteger(run.repetition) || !['baseline', 'optimized'].includes(run.variant)
    || !Number.isFinite(run.inputTokens)) throw new TypeError('invalid benchmark run');
}

export function pairDelta(runs) {
  const pair = new Map();
  for (const run of runs) {
    validateRun(run);
    const key = keyOf(run);
    const current = pair.get(key) ?? { scenario: run.scenario, repetition: run.repetition };
    if (current[run.variant]) throw new Error(`duplicate benchmark run: ${key}`);
    current[run.variant] = run;
    pair.set(key, current);
  }
  if (pair.size !== 1) throw new Error('pairDelta requires exactly one pair');
  const current = [...pair.values()][0];
  if (!current.baseline || !current.optimized) throw new Error(`unpaired benchmark run: ${keyOf(current)}`);
  const baselineInputTokens = current.baseline.inputTokens;
  const optimizedInputTokens = current.optimized.inputTokens;
  const savedInputTokens = baselineInputTokens - optimizedInputTokens;
  return {
    scenario: current.scenario,
    repetition: current.repetition,
    baselineInputTokens,
    optimizedInputTokens,
    savedInputTokens,
    savedPercent: baselineInputTokens === 0 ? 0 : savedInputTokens / baselineInputTokens * 100,
    qualityPass: current.optimized.quality === 'pass',
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeRuns(runs) {
  const pairs = new Map();
  for (const run of runs) {
    validateRun(run);
    const key = keyOf(run);
    const current = pairs.get(key) ?? [];
    current.push(run);
    pairs.set(key, current);
  }
  const deltas = [...pairs.values()].map((pair) => pairDelta(pair));
  const scenarios = new Map();
  for (const delta of deltas) {
    const values = scenarios.get(delta.scenario) ?? [];
    values.push(delta);
    scenarios.set(delta.scenario, values);
  }
  return {
    scenarios: [...scenarios.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([scenario, values]) => {
      const baselineMedianInputTokens = median(values.map((value) => value.baselineInputTokens));
      const optimizedMedianInputTokens = median(values.map((value) => value.optimizedInputTokens));
      const medianSavedInputTokens = baselineMedianInputTokens - optimizedMedianInputTokens;
      return {
        scenario,
        repetitions: values.length,
        baselineMedianInputTokens,
        optimizedMedianInputTokens,
        medianSavedInputTokens,
        medianSavedPercent: baselineMedianInputTokens === 0 ? 0 : medianSavedInputTokens / baselineMedianInputTokens * 100,
        qualityPassRate: values.filter((value) => value.qualityPass).length / values.length,
      };
    }),
    pairedRuns: deltas.length,
  };
}

export function assertQualityGate({ baseline, optimized }) {
  if (baseline?.quality !== 'pass' || optimized?.quality !== 'pass') throw new Error('correctness gate failed');
  if (optimized.artifactResolvable === false) throw new Error('artifact gate failed');
  if (optimized.secretLeak === true) throw new Error('secret gate failed');
}

export function evaluateFacts(event, inline, artifact = '') {
  if (typeof inline !== 'string' || typeof artifact !== 'string') throw new TypeError('fact inputs must be text');
  const facts = {};
  for (const rawFact of event?.requiredFacts ?? []) {
    const fact = typeof rawFact === 'string' ? rawFact : rawFact?.value;
    if (typeof fact !== 'string' || !fact) throw new TypeError('invalid required fact');
    const inInline = inline.includes(fact);
    const inArtifact = artifact.includes(fact);
    facts[fact] = {
      inline: inInline,
      artifact: inArtifact,
      modelVisible: inInline,
      recoverable: inInline || inArtifact,
    };
  }
  const values = Object.values(facts);
  return {
    quality: values.every((fact) => fact.recoverable) ? 'pass' : 'fail',
    modelVisibleQuality: values.every((fact) => fact.modelVisible) ? 'pass' : 'fail',
    facts,
  };
}

export async function readJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}
