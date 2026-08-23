#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditMetadata } from './lib/audit.mjs';
import { assertQualityGate, estimateTokens, evaluateFacts, summarizeRuns } from './lib/metrics.mjs';
import { loadScenario, replayScenario } from './lib/replay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'benchmarks', 'fixtures');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function has(name) { return process.argv.includes(`--${name}`); }

function secretLeak(text) {
  return /(?:api[_-]?key|authorization|password|secret)\s*[:=]\s*(?!\[REDACTED\])\S+|\b(?:sk|gh[pousr])-[A-Za-z0-9_-]{12,}/i.test(text);
}

function artifactPath(result) {
  const candidate = result?.artifact?.path ?? result?.artifactPath ?? result?.reference?.path;
  return typeof candidate === 'string' ? candidate : null;
}

async function artifactText(result) {
  if (typeof result?.artifact?.content === 'string') return result.artifact.content;
  const file = artifactPath(result);
  if (!file) return '';
  try { return await fs.readFile(file, 'utf8'); } catch { return ''; }
}

async function main() {
  const core = await import('../packages/sando/src/core.mjs');
  if (typeof core.optimizeToolOutput !== 'function') {
    throw new Error('sando core must export optimizeToolOutput');
  }
  const repetitions = Number(option('repetitions', '3'));
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) {
    throw new Error('--repetitions must be an integer from 1 to 20');
  }
  const selected = option('scenario');
  const fixtureNames = selected ? [`${selected}.json`] : ['read-large.json', 'terminal-noise.json'];
  const runs = [];
  const receipts = [];

  for (const fixtureName of fixtureNames) {
    const scenario = await loadScenario(path.join(FIXTURES, fixtureName));
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const baseline = await replayScenario(scenario, async (event) => ({
        inline: event.output,
        stats: { inlineBytes: Buffer.byteLength(event.output), artifactBytes: 0 },
      }));
      const optimized = await replayScenario(scenario, async (event) => core.optimizeToolOutput({
        toolName: event.toolName,
        output: event.output,
        cwd: ROOT,
        runId: `${scenario.id}-${repetition}`,
        policy: { mode: 'apply' },
      }));
      const eventRuns = [];
      for (const [variant, result] of [['baseline', baseline], ['optimized', optimized]]) {
        for (const receipt of result.receipts) {
          const artifact = await artifactText(receipt);
          const event = scenario.events.find((candidate) => candidate.id === receipt.event);
          const inlineBytes = Buffer.byteLength(receipt.inline);
          const artifactBytes = Buffer.byteLength(artifact);
          const factCheck = evaluateFacts(event, receipt.inline, artifact);
          const record = {
            scenario: scenario.id,
            repetition,
            variant,
            event: receipt.event,
            inputTokens: estimateTokens(receipt.inline),
            inlineBytes,
            artifactBytes,
            quality: factCheck.quality,
            modelVisibleQuality: factCheck.modelVisibleQuality,
            factPresence: factCheck.facts,
            artifactResolvable: variant === 'baseline' || !receipt.artifact || artifact.length > 0,
            secretLeak: variant === 'optimized' && secretLeak(`${receipt.inline}\n${artifact}`),
          };
          eventRuns.push(record);
          receipts.push({ ...record, artifact: receipt.artifact });
        }
      }
      for (const variant of ['baseline', 'optimized']) {
        const records = eventRuns.filter((record) => record.variant === variant);
        const prompt = records.map((record) => record.inline).join('\n\n');
        const audit = auditMetadata({
          host: 'local', variant, prompt, args: [], result: {}, cwd: ROOT,
          measurement: { mode: 'local-replay', hookEndToEnd: false },
        });
        runs.push({
          scenario: scenario.id,
          repetition,
          variant,
          inputTokens: records.reduce((total, record) => total + record.inputTokens, 0),
          inlineBytes: records.reduce((total, record) => total + record.inlineBytes, 0),
          artifactBytes: records.reduce((total, record) => total + record.artifactBytes, 0),
          quality: records.every((record) => record.quality === 'pass') ? 'pass' : 'fail',
          modelVisibleQuality: records.every((record) => record.modelVisibleQuality === 'pass') ? 'pass' : 'fail',
          artifactResolvable: records.every((record) => record.artifactResolvable),
          secretLeak: records.some((record) => record.secretLeak),
          promptDigest: audit.promptDigest,
          audit,
        });
      }
    }
  }

  for (const scenario of new Set(runs.map((run) => run.scenario))) {
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const pair = runs.filter((run) => run.scenario === scenario && run.repetition === repetition);
      const baseline = pair.find((run) => run.variant === 'baseline');
      const optimized = pair.find((run) => run.variant === 'optimized');
      if (!baseline || !optimized) throw new Error(`missing pair for ${scenario}/${repetition}`);
      assertQualityGate({ baseline, optimized });
    }
  }
  const output = {
    schema: 'sando-local-benchmark/v2',
    audit: {
      schema: 'sando-audit/v1',
      timestamp: runs[0]?.audit?.timestamp ?? new Date().toISOString(),
      commit: runs[0]?.audit?.commit ?? null,
      environment: runs[0]?.audit?.environment ?? null,
      measurement: { mode: 'local-replay', hookEndToEnd: false },
      note: 'Provider-free transform estimate; no provider prompt or usage counter was observed.',
    },
    runs, summary: summarizeRuns(runs), receipts,
  };
  const destination = path.resolve(option('out', path.join(ROOT, 'benchmarks', 'results', 'local-latest.json')));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ destination, summary: output.summary }, null, 2)}\n`);
  if (has('json')) process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stderr.write(`benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
