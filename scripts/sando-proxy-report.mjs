#!/usr/bin/env node
/**
 * Summarizes `benchmarks/live` proxy usage recorded by proxy-metrics.mjs during real,
 * everyday use (via `npm run proxy`). Every real request through the proxy logs one
 * line: the mechanical token reduction Sando made and, when parseable from the
 * provider's response, the real billed usage (including cache read/write tokens).
 *
 * There is no live A/B here (only the optimized body is ever sent to the real
 * provider), so this cannot report "percent saved vs. an unsent baseline" — it
 * reports what actually happened: mechanical tokens removed, and how often the
 * provider's own cache was hit, missed, or already cold (idle-flushed).
 *
 * Run: node scripts/sando-proxy-report.mjs [path/to/proxy-requests.jsonl]
 */

import fs from 'node:fs';

import { defaultProxyMetricsPath } from '../packages/sando/src/proxy-metrics.mjs';

const storagePath = process.argv[2] ?? defaultProxyMetricsPath();

let lines;
try { lines = fs.readFileSync(storagePath, 'utf8').split('\n').filter((line) => line.trim()); }
catch {
  process.stdout.write(`No proxy metrics recorded yet at ${storagePath}.\n`);
  process.exit(0);
}

const records = lines.map((line) => JSON.parse(line)).filter((record) => record.schema === 'sando-proxy-metrics/v1');
if (records.length === 0) {
  process.stdout.write(`${storagePath} has no sando-proxy-metrics/v1 records.\n`);
  process.exit(0);
}

let mechanicalSaved = 0;
let cacheHits = 0;
let cacheMisses = 0;
let idleFlushed = 0;
let protectedSkips = 0;
let withUsage = 0;

for (const record of records) {
  const stats = record.stats ?? {};
  mechanicalSaved += (stats.estimatedInputTokens ?? 0) - (stats.estimatedOutputTokens ?? 0);
  if (stats.cacheIdleFlushed) idleFlushed += 1;
  protectedSkips += stats.cacheProtectedSkips ?? 0;
  const usage = record.usage;
  if (usage) {
    withUsage += 1;
    if ((usage.cache_read_input_tokens ?? 0) > 0) cacheHits += 1;
    else if (usage.cache_creation_input_tokens !== undefined) cacheMisses += 1;
  }
}

process.stdout.write(`${JSON.stringify({
  storagePath,
  requests: records.length,
  mechanicalTokensSaved: mechanicalSaved,
  averageMechanicalTokensSavedPerRequest: Math.round(mechanicalSaved / records.length),
  requestsWithProviderUsage: withUsage,
  cacheHits,
  cacheMisses,
  cacheHitRate: withUsage ? cacheHits / withUsage : null,
  idleFlushActivations: idleFlushed,
  ratioGuardSkips: protectedSkips,
}, null, 2)}\n`);
