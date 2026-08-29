#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildProviderUsageReport, defaultProviderUsagePath, readProviderUsage } from './provider-usage.mjs';

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

export function formatAccountingReport(report) {
  const lines = [
    'provider accounting',
    `input: ${report.inputTokens}`,
    `fresh input: ${report.freshInputTokens}`,
    `cache read: ${report.cachedInputTokens}`,
    `cache write: ${report.cacheWriteInputTokens}`,
    `output: ${report.outputTokens}`,
    `reasoning: ${report.reasoningOutputTokens}`,
    `turns: ${report.turnCount}`,
    `weighted estimate: ${report.weightedCost.costUnits} cost units`,
    `provider cost: ${report.cost.status === 'provider-reported' ? `$${report.cost.totalCostUsd.toFixed(6)}` : report.cost.status}`,
  ];
  if (report.cost.effectiveRateUsdPerMillionTokens !== null) {
    lines.push(`blended effective rate: $${report.cost.effectiveRateUsdPerMillionTokens.toFixed(2)}/M tokens`);
  }
  return `${lines.join('\n')}\n`;
}

export function runAccountingCli({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.includes('--help')) {
    stdout.write('Usage: node accounting-cli.mjs [--json] [--path ABSOLUTE_PATH] [--session SESSION_ID]\n');
    return null;
  }
  try {
    const storagePath = option(argv, 'path') || defaultProviderUsagePath(env);
    const report = buildProviderUsageReport(readProviderUsage(storagePath), { sessionId: option(argv, 'session') });
    stdout.write(argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatAccountingReport(report));
    return report;
  } catch (error) {
    stderr.write(`sando accounting: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runAccountingCli();
