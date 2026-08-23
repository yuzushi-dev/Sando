#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildMetricsReport, defaultMetricsPath, formatMetricsReport, readMetrics } from './metrics.mjs';

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

export function runMetricsCli({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.includes('--help')) {
    stdout.write('Usage: node metrics-cli.mjs [--json] [--path ABSOLUTE_PATH] [--timezone IANA_ZONE] [--session SESSION_ID]\n');
    return null;
  }
  try {
    const storagePath = option(argv, 'path') || defaultMetricsPath(env);
    const timezone = option(argv, 'timezone');
    const state = readMetrics(storagePath, timezone ? { timezone } : {});
    const report = buildMetricsReport(state, {
      sessionId: option(argv, 'session'),
    });
    stdout.write(argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatMetricsReport(report));
    return report;
  } catch (error) {
    stderr.write(`sando metrics: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runMetricsCli();
