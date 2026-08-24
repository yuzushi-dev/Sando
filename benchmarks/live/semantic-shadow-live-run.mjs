#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadScenario } from '../lib/replay.mjs';
import { runSemanticShadow } from '../lib/semantic-shadow.mjs';
import {
  createCliSemanticCompleter,
  DEFAULT_SEMANTIC_MODELS,
  discoverSemanticProviders,
  selectSemanticProvider,
} from './semantic-cli-adapter.mjs';
import { createApiSemanticCompleter, DEFAULT_API_MODEL } from './semantic-api-adapter.mjs';
import { createCodexApiSemanticCompleter, DEFAULT_CODEX_API_MODEL } from './semantic-codex-api-adapter.mjs';

const API_COMPLETERS = {
  claude: { create: createApiSemanticCompleter, defaultModel: DEFAULT_API_MODEL },
  codex: { create: createCodexApiSemanticCompleter, defaultModel: DEFAULT_CODEX_API_MODEL },
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(ROOT, 'benchmarks', 'fixtures');
const DEFAULT_SCENARIOS = [
  'api-response', 'ci-log', 'dependency-tree', 'docker-build', 'git-history',
  'monorepo-search', 'read-large', 'read-structural', 'terminal-noise', 'test-failure',
];

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function hasOption(name) {
  return process.argv.includes(`--${name}`);
}

function looksLikeError(text) {
  return /(?:^|\n)\s*(?:error|failed|failure|FAIL)\b|\bERR!\b|\berror\s*:/i.test(text);
}

function validatePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

async function main() {
  if (!hasOption('confirm-cost')) throw new Error('live semantic shadow requires --confirm-cost');
  const transport = option('transport', 'cli');
  if (transport !== 'cli' && transport !== 'api') throw new Error('--transport must be cli or api');
  const requestedProvider = option('provider', transport === 'api' ? 'claude' : 'auto');
  if (transport === 'api' && !API_COMPLETERS[requestedProvider]) {
    throw new Error(`--transport api only supports --provider ${Object.keys(API_COMPLETERS).join('|')}`);
  }
  const requestedModel = option('model');
  const minInputTokens = validatePositiveInteger(option('min-input-tokens', '1000'), '--min-input-tokens');
  const timeoutMs = validatePositiveInteger(option('timeout-ms', '120000'), '--timeout-ms');
  const maxBudgetUsd = Number(option('max-budget-usd', '0.05'));
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) throw new Error('--max-budget-usd must be positive');
  const fixturesDir = path.resolve(option('fixtures-dir', FIXTURES));
  const selectedScenario = option('scenario');
  const selectedNames = selectedScenario ? selectedScenario.split(',').map((name) => name.trim()) : null;
  if (selectedNames?.some((name) => !/^[A-Za-z0-9_-]+$/.test(name))) throw new Error('--scenario must be a comma-separated list of fixture ids');
  if (fixturesDir !== FIXTURES && !selectedNames) throw new Error('--scenario is required when --fixtures-dir is set');
  const names = selectedNames ?? DEFAULT_SCENARIOS;

  const availability = transport === 'cli' ? discoverSemanticProviders() : null;
  const selection = transport === 'api'
    ? { provider: requestedProvider, fallback: false }
    : selectSemanticProvider({ requested: requestedProvider, ...availability });
  const model = requestedModel ?? (transport === 'api' ? API_COMPLETERS[selection.provider].defaultModel : DEFAULT_SEMANTIC_MODELS[selection.provider]);
  const scenarios = await Promise.all(names.map((name) => loadScenario(path.join(fixturesDir, `${name}.json`))));
  const normalized = scenarios.map((scenario) => ({
    ...scenario,
    events: scenario.events.map((event) => ({
      ...event,
      isError: event.isError === true || (event.isError !== false && looksLikeError(event.output)),
    })),
  }));
  const complete = transport === 'api'
    ? API_COMPLETERS[selection.provider].create({ model, timeoutMs })
    : createCliSemanticCompleter({
      provider: selection.provider,
      model,
      cwd: ROOT,
      timeoutMs,
      maxBudgetUsd,
      availability,
    });
  const result = await runSemanticShadow({
    scenarios: normalized,
    complete,
    provider: selection.provider,
    model,
    mode: transport === 'api' ? 'live-api-shadow' : 'live-cli-shadow',
    repetitions: 1,
    policy: { minInputTokens, timeoutMs },
  });
  const reportedModels = [...new Set(result.runs.map((run) => run.providerUsage?.resolvedModel).filter(Boolean))];
  const resolvedModels = reportedModels.length ? reportedModels : [model];
  const report = {
    ...result,
    schema: transport === 'api' ? 'sando-semantic-shadow-api/v1' : 'sando-semantic-shadow-cli/v1',
    generatedAt: new Date().toISOString(),
    measurement: 'provider-reported-compactor',
    tokenAccounting: 'provider-reported',
    transport,
    providerRequested: requestedProvider,
    providerFallback: selection.fallback,
    requestedModel: model,
    resolvedModels,
    modelResolution: reportedModels.length ? 'provider-reported' : (transport === 'api' ? 'requested-api-argument' : 'requested-cli-argument'),
    note: 'Shadow-only: semantic summaries are validated and measured but never applied to the provider request.',
    inputs: {
      conversations: normalized.length,
      scenarios: normalized.map((scenario) => scenario.id),
      minInputTokens,
      timeoutMs,
      maxBudgetUsd: transport === 'cli' && selection.provider === 'claude' ? maxBudgetUsd : null,
    },
  };
  const destinationTag = transport === 'api' ? `${selection.provider}-api` : selection.provider;
  const destination = path.resolve(option('out', path.join(ROOT, 'benchmarks', 'results', `semantic-shadow-${destinationTag}-latest.json`)));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ destination, provider: selection.provider, model, resolvedModels, summary: report.summary }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`semantic-shadow-live: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
