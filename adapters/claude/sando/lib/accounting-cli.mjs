#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { buildProviderUsageReport, defaultProviderUsagePath, readProviderUsage } from './provider-usage.mjs';
import { aggregateApiRequestCosts, loadPricingProfile } from './pricing.mjs';

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

export function formatAccountingReport(report) {
  const lines = report.inputTokens === undefined ? [] : [
    'provider accounting',
    `input: ${report.inputTokens}`,
    `fresh input: ${report.freshInputTokens}`,
    `cache read: ${report.cachedInputTokens}`,
    `cache write: ${report.cacheWriteInputTokens}`,
    `output: ${report.outputTokens}`,
    `reasoning: ${report.reasoningOutputTokens}`,
    `turns: ${report.turnCount}`,
    `weighted estimate: ${report.weightedCost.costUnits} cost units`,
    `reported cost: ${report.cost.totalCostUsd === null ? report.cost.status : `$${report.cost.totalCostUsd.toFixed(6)} (${report.cost.status})`}`,
  ];
  if (report.cost && report.cost.effectiveRateUsdPerMillionTokens !== null) {
    lines.push(`blended effective rate: $${report.cost.effectiveRateUsdPerMillionTokens.toFixed(2)}/M tokens`);
  }
  if (report.apiCost) {
    const cost = report.apiCost;
    lines.push(`API estimate profile: ${cost.profileId}`, `API data: ${cost.status} (${cost.pricedRequestCount} priced, ${cost.unpricedRequestCount} unpriced)`,
      `estimated API cost: ${cost.estimatedApiCostUsd === null ? 'indeterminate' : `$${cost.estimatedApiCostUsd.toFixed(6)}`}`,
      `supported API cost subtotal: $${cost.supportedEstimatedApiCostUsd.toFixed(6)}`,
      `provider-reported API cost: ${cost.providerReportedCostUsd === null ? 'unavailable' : `$${cost.providerReportedCostUsd.toFixed(6)}`}`,
      cost.limitation);
  }
  return `${lines.join('\n')}\n`;
}

export function runAccountingCli({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.includes('--help')) {
    stdout.write('Usage: node accounting-cli.mjs [--json] [--path ABSOLUTE_PATH] [--session SESSION_ID] [--profile PROFILE_ID --requests ABSOLUTE_JSONL_PATH]\n');
    return null;
  }
  try {
    const values = new Set(['--path', '--session', '--profile', '--requests']);
    const flags = new Set(['--json']);
    const seen = new Set();
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (seen.has(arg) || (!values.has(arg) && !flags.has(arg))) throw new Error('invalid accounting arguments');
      seen.add(arg);
      if (values.has(arg) && (!argv[++index] || argv[index].startsWith('--'))) throw new Error('missing accounting option value');
    }
    const profileId = option(argv, 'profile');
    const requestsPath = option(argv, 'requests');
    if (Boolean(profileId) !== Boolean(requestsPath)) throw new Error('--profile and --requests must be supplied together');
    const storagePath = option(argv, 'path') || defaultProviderUsagePath(env);
    const report = requestsPath && !option(argv, 'path') ? {}
      : buildProviderUsageReport(readProviderUsage(storagePath), { sessionId: option(argv, 'session') });
    if (requestsPath) {
      if (!path.isAbsolute(requestsPath)) throw new Error('API request usage path must be absolute');
      const requests = fs.readFileSync(requestsPath, 'utf8').split(/\r?\n/).filter((line) => line.trim())
        .map((line) => {
          try { return JSON.parse(line); } catch { throw new Error('invalid API usage JSONL'); }
        });
      report.apiCost = aggregateApiRequestCosts(requests, loadPricingProfile(profileId), { sessionId: option(argv, 'session') });
    }
    stdout.write(argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatAccountingReport(report));
    return report;
  } catch (error) {
    stderr.write(`sando accounting: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runAccountingCli();
