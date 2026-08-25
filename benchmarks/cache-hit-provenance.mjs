/**
 * Which recorded run produced the "1 cache hit in 20 calls" figure, and what is the
 * cache hit rate on each measured path?
 *
 * Reads only committed-on-disk result files. No network, no API cost.
 *
 * The two result families use different schemas, which is itself the disambiguator:
 *   - session-amortization-*.json  -> usage entries keyed `cacheReadTokens`
 *   - live-proxy-*.json            -> usage entries keyed `cacheReadInputTokens`
 *
 * IMPORTANT: count per-CALL usage records only. The amortization schema also carries
 * `*CumulativeBreakdown[]` arrays that re-state the same running totals per turn, so a
 * naive recursive walk counts one real cache hit three times and reports 3/44 instead of
 * 1/20. Per-call records live in baselineUsages / compactedUsages / compactionUsage.
 *
 * Run: node benchmarks/cache-hit-provenance.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, 'results');

function countUsages(node, key, acc = { calls: 0, hits: 0, hitValues: [] }) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const v of node) countUsages(v, key, acc);
    return acc;
  }
  if (Object.hasOwn(node, key)) {
    acc.calls += 1;
    if ((node[key] || 0) > 0) {
      acc.hits += 1;
      acc.hitValues.push(node[key]);
    }
  }
  for (const v of Object.values(node)) countUsages(v, key, acc);
  return acc;
}

function report(label, files, key) {
  let calls = 0;
  let hits = 0;
  console.log(`\n### ${label}  (usage key: ${key})`);
  for (const f of files) {
    let json;
    try { json = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    const r = countUsages(json, key);
    if (r.calls === 0) continue;
    calls += r.calls;
    hits += r.hits;
    const detail = r.hitValues.length ? `  [${r.hitValues.join(', ')}]` : '';
    console.log(`  ${f.padEnd(46)} ${String(r.hits).padStart(3)}/${String(r.calls).padEnd(3)}${detail}`);
  }
  const pct = calls ? (100 * hits / calls).toFixed(1) : '0.0';
  console.log(`  ${'TOTAL'.padEnd(46)} ${String(hits).padStart(3)}/${String(calls).padEnd(3)}  = ${pct}% hit rate`);
  return { calls, hits };
}

const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));

function reportAmortization(files) {
  let calls = 0;
  let hits = 0;
  console.log('\n### session-amortization runs  (history transform NOT in path)  (per-call usage only)');
  for (const f of files) {
    let json;
    try { json = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    // per-call records only — NOT the *CumulativeBreakdown arrays, which restate totals
    const perCall = [
      ...(json.baselineUsages || []),
      ...(json.compactedUsages || []),
      ...(json.compactionUsage ? [json.compactionUsage] : []),
    ];
    const hitValues = perCall.map((u) => u.cacheReadTokens || 0).filter((v) => v > 0);
    calls += perCall.length;
    hits += hitValues.length;
    const detail = hitValues.length ? `  [${hitValues.join(', ')}]` : '';
    console.log(`  ${f.padEnd(46)} ${String(hitValues.length).padStart(3)}/${String(perCall.length).padEnd(3)}${detail}`);
  }
  const pct = calls ? (100 * hits / calls).toFixed(1) : '0.0';
  console.log(`  ${'TOTAL'.padEnd(46)} ${String(hits).padStart(3)}/${String(calls).padEnd(3)}  = ${pct}% hit rate`);
  return { calls, hits };
}

const amort = reportAmortization(all.filter((f) => f.includes('session-amortization')));

const proxy = report(
  'live-proxy runs  (history transform ACTIVE)',
  all.filter((f) => f.startsWith('live-proxy-')),
  'cacheReadInputTokens',
);

console.log(`
--- conclusion ---
The "1 cache hit in 20 calls" figure is the amortization total: ${amort.hits}/${amort.calls}.
Those runs come from benchmarks/live/session-amortization-run.mjs, which imports neither
proxy.mjs nor context-transform.mjs — so the history transform was not in that path.

The proxy path, where the transform IS active, records ${proxy.hits}/${proxy.calls} hits.
The difference is who builds the request: proxy-e2e-run.mjs drives the real Claude Code /
Codex CLI (which places its own cache_control breakpoints); session-amortization-run.mjs
calls the provider API directly, and Sando sets no breakpoints of its own.
`);
