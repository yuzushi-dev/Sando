import fs from 'node:fs/promises';

export function estimateTokens(value) {
  if (typeof value !== 'string') throw new TypeError('token estimate requires text');
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 4);
}

function keyOf(run) {
  return `${run.scenario}\u0000${run.repetition}`;
}

const MEASUREMENTS = ['local-replay', 'prompt-level', 'end-to-end', 'end-to-end-tools', 'end-to-end-proxy'];
const TOKEN_ACCOUNTING = ['estimate', 'provider-reported'];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digest(value) { return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value); }

function nullableText(value) { return value === null || (typeof value === 'string' && value.length > 0); }

function safeCounter(value) { return Number.isSafeInteger(value) && value >= 0; }

function safeUsd(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }

function safeSum(...values) {
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}

function provenanceValue(run, field) { return Object.hasOwn(run, field) ? run[field] : run.audit[field]; }

function auditResolvedModel(run) { return run.audit.resolvedModel; }

function incompleteProviderEvidence(run) {
  return run.quality === 'fail'
    && run.tokenAccounting === 'provider-reported'
    && run.providerUsage === undefined
    && run.audit?.tokenAccounting?.providerObserved === false;
}

function validateAudit(run) {
  const audit = run.audit;
  if (!record(audit) || !record(audit.measurement) || !record(audit.tokenAccounting)) {
    throw new TypeError('benchmark run requires complete audit evidence');
  }
  for (const field of ['host', 'resolvedModel', 'clientVersion', 'promptDigest', 'scenarioDigest']) {
    if (!Object.hasOwn(audit, field)) {
      throw new TypeError(`benchmark ${field} provenance evidence required`);
    }
    if (Object.hasOwn(run, field) && run[field] !== audit[field]) {
      throw new TypeError(`benchmark audit contradicts ${field} provenance`);
    }
  }
  if (!['claude', 'codex', 'local'].includes(audit.host)
    || !nullableText(audit.resolvedModel) || !nullableText(audit.clientVersion)
    || !digest(audit.promptDigest) || !digest(audit.scenarioDigest)) {
    throw new TypeError('invalid benchmark identity provenance');
  }
  const measurement = audit.measurement;
  if (!Object.hasOwn(measurement, 'mode') || !Object.hasOwn(measurement, 'hookEndToEnd')
    || measurement.mode !== run.measurement
    || typeof measurement.hookEndToEnd !== 'boolean'
    || (['end-to-end', 'end-to-end-tools'].includes(measurement.mode)) !== measurement.hookEndToEnd) {
    throw new TypeError('benchmark audit contradicts measurement provenance');
  }
  const accounting = audit.tokenAccounting;
  if (!Object.hasOwn(accounting, 'source') || !Object.hasOwn(accounting, 'providerObserved')
    || accounting.source !== run.tokenAccounting
    || typeof accounting.providerObserved !== 'boolean'
    || (accounting.providerObserved !== (run.tokenAccounting === 'provider-reported')
      && !incompleteProviderEvidence(run))
    || (run.tokenAccounting === 'estimate' && accounting.formula !== 'ceil(UTF-8 bytes / 4)')) {
    throw new TypeError('benchmark audit contradicts token accounting provenance');
  }
  const { workingTreeDirty, diffDigest, workingTreeProvenance } = audit;
  for (const field of ['commit', 'workingTreeDirty', 'diffDigest', 'workingTreeProvenance']) {
    if (!Object.hasOwn(audit, field)) throw new TypeError(`benchmark ${field} provenance evidence required`);
  }
  if (!nullableText(audit.commit)) throw new TypeError('benchmark audit contains invalid commit provenance');
  if (![true, false, null].includes(workingTreeDirty)) {
    throw new TypeError('benchmark audit contains invalid tree status');
  }
  if (diffDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(diffDigest)) {
    throw new TypeError('benchmark audit contains invalid tree digest');
  }
  if (!['clean', 'dirty-digest', 'unknown'].includes(workingTreeProvenance)) {
    throw new TypeError('benchmark audit contains invalid tree provenance');
  }
  if (workingTreeProvenance === 'clean' && (workingTreeDirty !== false || diffDigest !== null)) {
    throw new TypeError('benchmark audit contradicts clean tree provenance');
  }
  if (workingTreeProvenance === 'dirty-digest' && (workingTreeDirty !== true || diffDigest === null)) {
    throw new TypeError('benchmark audit contradicts dirty tree provenance');
  }
  if (workingTreeProvenance === 'unknown' && (diffDigest !== null || ![true, null].includes(workingTreeDirty))) {
    throw new TypeError('benchmark audit contradicts unknown tree provenance');
  }
}

function validateProviderEvidence(run) {
  const providerUsage = run.providerUsage;
  if (run.tokenAccounting === 'provider-reported') {
    if (incompleteProviderEvidence(run)) return;
    if (!record(providerUsage) || !safeCounter(providerUsage.inputTokens)) {
      throw new TypeError('provider-reported accounting requires provider usage evidence');
    }
    for (const field of ['uncachedInputTokens', 'cacheCreationInputTokens', 'cacheWriteInputTokens', 'cacheReadInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']) {
      if (providerUsage[field] !== undefined && !safeCounter(providerUsage[field])) {
        throw new TypeError('provider usage evidence contains invalid token counts');
      }
    }
    if (providerUsage.totalCostUsd !== undefined && providerUsage.totalCostUsd !== null && !safeUsd(providerUsage.totalCostUsd)) {
      throw new TypeError('provider usage evidence contains invalid cost');
    }
    const cacheWriteField = Object.hasOwn(providerUsage, 'cacheCreationInputTokens') ? 'cacheCreationInputTokens' : 'cacheWriteInputTokens';
    if (['uncachedInputTokens', cacheWriteField, 'cacheReadInputTokens'].every((field) => Object.hasOwn(providerUsage, field))) {
      const inputTokens = safeSum(providerUsage.uncachedInputTokens, providerUsage[cacheWriteField], providerUsage.cacheReadInputTokens);
      if (inputTokens === null || inputTokens !== providerUsage.inputTokens) throw new TypeError('provider usage evidence contains invalid token sums');
    }
    if (Object.hasOwn(providerUsage, 'outputTokens') && Object.hasOwn(providerUsage, 'totalTokens')) {
      const totalTokens = safeSum(providerUsage.inputTokens, providerUsage.outputTokens);
      if (totalTokens === null || totalTokens !== providerUsage.totalTokens) throw new TypeError('provider usage evidence contains invalid token sums');
    }
    if (run.inputTokens !== providerUsage.inputTokens) {
      throw new TypeError('benchmark input tokens contradict provider usage');
    }
    if (providerUsage.resolvedModel !== undefined && providerUsage.resolvedModel !== auditResolvedModel(run)) {
      throw new TypeError('benchmark audit contradicts provider model evidence');
    }
    return;
  }
  if (providerUsage !== undefined && providerUsage !== null) {
    throw new TypeError('estimated accounting contradicts provider usage evidence');
  }
}

function validateRun(run) {
  if (!run || typeof run !== 'object' || typeof run.scenario !== 'string'
    || !Number.isInteger(run.repetition) || !['baseline', 'optimized'].includes(run.variant)
    || !safeCounter(run.inputTokens)) throw new TypeError('invalid benchmark run');
  if (!Object.hasOwn(run, 'measurement') || !MEASUREMENTS.includes(run.measurement)
    || !Object.hasOwn(run, 'tokenAccounting') || !TOKEN_ACCOUNTING.includes(run.tokenAccounting)) {
    throw new TypeError('invalid benchmark provenance');
  }
  validateAudit(run);
  validateProviderEvidence(run);
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
  for (const field of ['host', 'resolvedModel', 'clientVersion', 'scenarioDigest', 'measurement', 'tokenAccounting']) {
    if (provenanceValue(current.baseline, field) !== provenanceValue(current.optimized, field)) {
      throw new Error(`mismatched benchmark ${field} provenance: ${keyOf(current)}`);
    }
  }
  const baselineMeasurement = current.baseline.audit.measurement;
  const optimizedMeasurement = current.optimized.audit.measurement;
  if (baselineMeasurement.mode !== optimizedMeasurement.mode
    || baselineMeasurement.hookEndToEnd !== optimizedMeasurement.hookEndToEnd) {
    throw new Error(`mismatched benchmark audit measurement provenance: ${keyOf(current)}`);
  }
  const baselineAccounting = current.baseline.audit.tokenAccounting;
  const optimizedAccounting = current.optimized.audit.tokenAccounting;
  for (const field of ['source', 'providerObserved', 'formula']) {
    if ((baselineAccounting[field] ?? null) !== (optimizedAccounting[field] ?? null)) {
      throw new Error(`mismatched benchmark token-accounting evidence: ${keyOf(current)}`);
    }
  }
  for (const field of ['commit', 'workingTreeDirty', 'diffDigest', 'workingTreeProvenance']) {
    if (current.baseline.audit[field] !== current.optimized.audit[field]) {
      throw new Error(`mismatched benchmark ${field} provenance: ${keyOf(current)}`);
    }
  }
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

function pairedRunPair(runs) {
  pairDelta(runs);
  const pair = new Map();
  for (const run of runs) {
    const key = keyOf(run);
    const current = pair.get(key) ?? {};
    current[run.variant] = run;
    pair.set(key, current);
  }
  return [...pair.values()][0];
}

function runCounter(run, names) {
  const values = [run, run.providerUsage].filter(record);
  for (const source of values) {
    for (const name of names) if (source[name] !== undefined) return safeCounter(source[name]) ? source[name] : null;
  }
  return null;
}

function runSide(run) {
  const inputTokens = runCounter(run, ['inputTokens']);
  const cacheReadInputTokens = runCounter(run, ['cacheReadInputTokens', 'cachedInputTokens']);
  const observedCacheWriteInputTokens = runCounter(run, ['cacheCreationInputTokens', 'cacheWriteInputTokens']);
  const cacheWriteInputTokens = observedCacheWriteInputTokens ?? (inputTokens === null ? null : 0);
  const uncachedInputTokens = runCounter(run, ['uncachedInputTokens'])
    ?? (inputTokens !== null && cacheReadInputTokens !== null && cacheWriteInputTokens !== null
      ? inputTokens - cacheReadInputTokens - cacheWriteInputTokens : null);
  const outputTokens = runCounter(run, ['outputTokens']);
  const reasoningOutputTokens = runCounter(run, ['reasoningOutputTokens']);
  const totalTokens = runCounter(run, ['totalTokens'])
    ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const modelTurns = runCounter(run, ['modelTurns', 'turns', 'turnCount']);
  const totalToolCalls = runCounter(run, ['totalToolCalls', 'toolCalls']);
  const nativeToolCalls = runCounter(run, ['nativeToolCalls']);
  const sandoMcpCalls = runCounter(run, ['sandoMcpCalls']);
  const mechanicalContextTrimmedBytes = runCounter(run, ['mechanicalContextTrimmedBytes']);
  const billedCostUsd = [run.totalCostUsd, run.providerUsage?.totalCostUsd]
    .find((value) => safeUsd(value)) ?? null;
  return {
    variant: run.variant,
    inputTokens, uncachedInputTokens, cacheReadInputTokens, cacheWriteInputTokens,
    cacheCreationInputTokens: cacheWriteInputTokens,
    outputTokens, reasoningOutputTokens, totalTokens,
    modelTurns, turns: modelTurns,
    totalToolCalls, toolCalls: totalToolCalls, nativeToolCalls, sandoMcpCalls,
    mechanicalContextTrimmedBytes, billedCostUsd: safeUsd(billedCostUsd) ? billedCostUsd : null,
  };
}

function difference(control, treatment, field) {
  if (control[field] === null || treatment[field] === null) return null;
  const value = control[field] - treatment[field];
  return field === 'billedCostUsd' ? Number(value.toFixed(12)) : value;
}

export function buildPairedAccounting(runs) {
  const pair = pairedRunPair(runs);
  const control = runSide(pair.baseline);
  const treatment = runSide(pair.optimized);
  const counterfactual = [pair.baseline, pair.optimized].some((run) =>
    run.measurement === 'local-replay' || run.tokenAccounting === 'estimate');
  const costAvailable = !counterfactual && control.billedCostUsd !== null && treatment.billedCostUsd !== null;
  const billedCostUsd = costAvailable ? Number((control.billedCostUsd - treatment.billedCostUsd).toFixed(12)) : null;
  return {
    schema: 'sando-paired-accounting/v1',
    scenario: pair.baseline.scenario,
    repetition: pair.baseline.repetition,
    control,
    treatment,
    delta: {
      uncachedInputTokens: difference(control, treatment, 'uncachedInputTokens'),
      cacheReadInputTokens: difference(control, treatment, 'cacheReadInputTokens'),
      cacheWriteInputTokens: difference(control, treatment, 'cacheWriteInputTokens'),
      outputTokens: difference(control, treatment, 'outputTokens'),
      reasoningOutputTokens: difference(control, treatment, 'reasoningOutputTokens'),
      totalTokens: difference(control, treatment, 'totalTokens'),
      modelTurns: difference(control, treatment, 'modelTurns'),
      totalToolCalls: difference(control, treatment, 'totalToolCalls'),
      nativeToolCalls: difference(control, treatment, 'nativeToolCalls'),
      sandoMcpCalls: difference(control, treatment, 'sandoMcpCalls'),
      mechanicalContextTrimmedBytes: control.mechanicalContextTrimmedBytes !== null && treatment.mechanicalContextTrimmedBytes !== null
        ? treatment.mechanicalContextTrimmedBytes - control.mechanicalContextTrimmedBytes : null,
      billedCostUsd,
    },
    mechanical: {
      contextTrimmedBytes: treatment.mechanicalContextTrimmedBytes,
      controlContextTrimmedBytes: control.mechanicalContextTrimmedBytes,
      treatmentContextTrimmedBytes: treatment.mechanicalContextTrimmedBytes,
    },
    cost: {
      status: costAvailable ? 'provider-reported' : 'unavailable',
      controlUsd: costAvailable ? control.billedCostUsd : null,
      treatmentUsd: costAvailable ? treatment.billedCostUsd : null,
      billedCostUsd,
    },
    replay: {
      counterfactual,
      providerBilledCost: costAvailable ? 'observed' : 'unavailable',
      providerUsage: counterfactual ? 'not-a-live-billing-comparison' : 'observed-or-unavailable',
    },
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
  const repetitionProvenance = new Map();
  for (const pair of pairs.values()) {
    for (const run of pair) {
      const key = `${run.scenario}\u0000${run.variant}`;
      const fingerprint = [
        provenanceValue(run, 'host'), provenanceValue(run, 'resolvedModel'), provenanceValue(run, 'clientVersion'),
        provenanceValue(run, 'promptDigest'), provenanceValue(run, 'scenarioDigest'),
        run.measurement, run.tokenAccounting,
        run.audit.measurement.mode, run.audit.measurement.hookEndToEnd,
        run.audit.tokenAccounting.source, run.audit.tokenAccounting.providerObserved,
        run.audit.tokenAccounting.formula ?? null,
        run.audit.commit, run.audit.workingTreeDirty, run.audit.diffDigest, run.audit.workingTreeProvenance,
      ];
      const previous = repetitionProvenance.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(fingerprint)) {
        throw new Error(`mismatched benchmark provenance across repetitions: ${key}`);
      }
      repetitionProvenance.set(key, fingerprint);
    }
  }
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
      // Difference of two independently-ranked medians. Kept because every published
      // figure to date used it, so removing it would silently restate history.
      const medianSavedInputTokens = baselineMedianInputTokens - optimizedMedianInputTokens;
      return {
        scenario,
        repetitions: values.length,
        baselineMedianInputTokens,
        optimizedMedianInputTokens,
        medianSavedInputTokens,
        medianSavedPercent: baselineMedianInputTokens === 0 ? 0 : medianSavedInputTokens / baselineMedianInputTokens * 100,
        // Median of the per-repetition paired deltas — what `medianSavedPercent`'s name
        // implies but does not compute. computeDelta already produces these per pair and
        // they were being discarded here. On a near-deterministic fixture the two agree;
        // they diverge on noisy scenarios, where this one is the correct statistic
        // because it never compares a baseline against a different run's optimized value.
        pairedMedianSavedInputTokens: median(values.map((value) => value.savedInputTokens)),
        pairedMedianSavedPercent: median(values.map((value) => value.savedPercent)),
        qualityPassRate: values.filter((value) => value.qualityPass).length / values.length,
      };
    }),
    pairedRuns: deltas.length,
    pairedAccounting: [...pairs.values()].map((pair) => buildPairedAccounting(pair)),
  };
}

export function assertQualityGate({ baseline, optimized }) {
  if (baseline?.quality !== 'pass' || optimized?.quality !== 'pass') throw new Error('correctness gate failed');
  for (const run of [baseline, optimized]) {
    if (run.modelVisibleQuality !== 'pass') throw new Error('model-visible quality evidence missing or failed');
    if (run.artifactResolvable !== true) throw new Error('artifact evidence missing or failed');
    if (run.secretLeak === true) throw new Error('secret gate failed');
    if (run.secretLeak !== false) throw new Error('leak evidence missing or failed');
  }
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
