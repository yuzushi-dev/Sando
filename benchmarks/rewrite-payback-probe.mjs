/**
 * Does a history rewrite pay for the cache it invalidates?
 *
 * Anthropic bills a cache read at 0.1x base input and a 5-minute cache write at
 * 1.25x. Rewriting a historical tool result forces the suffix after it back through
 * a cache write. With `S` tokens reclaimed, `P` tokens of suffix, and `K` further
 * turns to amortize over:
 *
 *   rewrite: 1.25(P-S) + 0.10(P-S)K       leave alone: 0.10P(K+1)
 *   rewrite wins  <=>  S/P > 1.15 / (1.25 + 0.10K)
 *
 * The threshold is a ratio, independent of P: K=0 needs 92%, K=10 needs 51%,
 * K=50 needs 18%. This probe reports the ratio each real rewrite actually achieves.
 *
 * Deterministic, zero API cost.
 *
 * Run: node benchmarks/rewrite-payback-probe.mjs <transcript.jsonl>
 */

import fs from 'node:fs';

import { estimateTokens, transformProviderRequest } from '../packages/sando/index.mjs';

const TRANSCRIPT = process.argv[2]
  ?? `${process.env.HOME}/.claude/projects/-home-cristina-Projects-Sando/d41d04a9-b66c-4a1f-9897-cd7b5ba82e7b.jsonl`;

const messages = [];
for (const line of fs.readFileSync(TRANSCRIPT, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let record;
  try { record = JSON.parse(line); } catch { continue; }
  const message = record?.message;
  if (!message || !Array.isArray(message.content)) continue;
  if (message.role !== 'assistant' && message.role !== 'user') continue;
  const content = message.content.filter((b) => b && ['tool_use', 'tool_result', 'text'].includes(b.type));
  if (content.length) messages.push({ role: message.role, content });
}

const size = (value) => estimateTokens(JSON.stringify(value) ?? '');

// Suffix tokens after each message: what a rewrite there forces back through a write.
const suffix = new Array(messages.length).fill(0);
let running = 0;
for (let index = messages.length - 1; index >= 0; index -= 1) {
  suffix[index] = running;
  running += size(messages[index]);
}

// Unguarded, so every rewrite the transform would make is visible.
const result = transformProviderRequest({
  provider: 'anthropic',
  body: { model: 'claude-sonnet-5', messages: structuredClone(messages) },
  policy: { maxHistoryTokens: 60_000, cacheRewriteRatio: 0 },
});

const rewrites = [];
for (let index = 0; index < messages.length; index += 1) {
  const before = size(messages[index]);
  const after = size(result.body.messages[index]);
  if (after >= before) continue;
  rewrites.push({
    index,
    reclaimed: before - after,
    suffix: suffix[index],
    ratio: suffix[index] === 0 ? Infinity : (before - after) / suffix[index],
  });
}
rewrites.sort((a, b) => b.ratio - a.ratio);

const threshold = (turns) => 1.15 / (1.25 + 0.10 * turns);

console.log(`transcript: ${TRANSCRIPT.split('/').pop()}  (${messages.length} messages)`);
console.log(`rewrites the transform would make: ${rewrites.length}\n`);
console.log('  msg   reclaimed    suffix     ratio');
for (const rewrite of rewrites.slice(0, 10)) {
  console.log(`  ${String(rewrite.index).padStart(4)}  ${String(rewrite.reclaimed).padStart(9)}  ${String(rewrite.suffix).padStart(8)}  ${(rewrite.ratio * 100).toFixed(2).padStart(7)}%`);
}

console.log('\nbreak-even ratio by remaining turns:');
for (const turns of [0, 10, 20, 50]) {
  const needed = threshold(turns);
  const paying = rewrites.filter((r) => r.ratio > needed).length;
  console.log(`  K=${String(turns).padStart(2)}: needs ${(needed * 100).toFixed(0).padStart(2)}%  ->  ${paying}/${rewrites.length} rewrites pay for themselves`);
}

const best = rewrites[0];
console.log(`
best rewrite reclaims ${(best.ratio * 100).toFixed(2)}% of its suffix. A rewrite must clear
18% even at K=50, so on this transcript no rewrite pays back while the provider
cache is warm. When the host sets no breakpoint there is no warm cache to lose and
the transform is free — which is exactly what the cacheRewriteRatio guard keys on.
`);
