#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SEMANTIC_SUMMARY_SCHEMA } from '../packages/sando/index.mjs';
import { loadScenario } from './lib/replay.mjs';
import { runSemanticShadow } from './lib/semantic-shadow.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'benchmarks', 'fixtures');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function oracle({ text, requiredFacts }) {
  const preservedFacts = requiredFacts.filter((fact) => text.includes(fact));
  return {
    schema: SEMANTIC_SUMMARY_SCHEMA,
    summary: preservedFacts.join('\n') || text.split('\n').slice(0, 2).join('\n'),
    preservedFacts,
  };
}

function looksLikeError(text) {
  return /(?:^|\n)\s*(?:error|failed|failure|FAIL)\b|\bERR!\b|\berror\s*:/i.test(text);
}

async function main() {
  const repetitions = Number(option('repetitions', '10'));
  const minInputTokens = Number(option('min-input-tokens', '8000'));
  const selected = option('scenario');
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 50) {
    throw new Error('--repetitions must be an integer from 1 to 50');
  }
  if (!Number.isInteger(minInputTokens) || minInputTokens < 1) {
    throw new Error('--min-input-tokens must be a positive integer');
  }
  if (selected && !/^[A-Za-z0-9_-]+$/.test(selected)) throw new Error('--scenario must be a fixture id');
  const names = selected ? [`${selected}.json`] : [
    'read-structural.json', 'tool-suite.json', 'terminal-noise.json', 'monorepo-search.json', 'test-failure.json',
  ];
  const scenarios = await Promise.all(names.map((name) => loadScenario(path.join(FIXTURES, name))));
  const result = await runSemanticShadow({
    scenarios: scenarios.map((scenario) => ({
      ...scenario,
      events: scenario.events.map((event) => ({
        ...event,
        isError: event.isError === true || looksLikeError(event.output),
      })),
    })),
    complete: async (request) => oracle(request),
    repetitions,
    policy: { minInputTokens },
  });
  const report = {
    ...result,
    generatedAt: new Date().toISOString(),
    note: 'Provider-free oracle only. It validates accounting and safety gates; it is not an LLM quality or provider-cost result.',
    inputs: { scenarios: scenarios.map((scenario) => scenario.id), repetitions, minInputTokens },
  };
  const destination = path.resolve(option('out', path.join(ROOT, 'benchmarks', 'results', 'semantic-shadow-latest.json')));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ destination, summary: report.summary }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`semantic-shadow: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
