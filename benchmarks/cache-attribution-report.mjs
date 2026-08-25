/**
 * Diagnose recorded provider usage: not just how often the cache missed, but why.
 *
 * Deterministic — reads committed result files only. No network, no API cost.
 *
 * Reports cache-write volume alongside hit rate, because hit rate alone is the wrong
 * instrument: a divergence behind the last breakpoint still forces a re-prefill while
 * the hit is scored against the prefix that did match, and writes bill at 1.25x-2x
 * base input against 0.1x for reads.
 *
 * Run: node benchmarks/cache-attribution-report.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

import { attributeSession } from '../packages/sando/index.mjs';

const DIR = path.join(import.meta.dirname, 'results');

/**
 * session-amortization-run.mjs appends one turn at a time and sets no cache_control
 * anywhere, so the history is modelled as append-only and the body as unmarked. That
 * is what the harness actually does — mismodelling it as rewritten would manufacture
 * a `history-rewritten` verdict the data does not support.
 */
function amortizationTurns(usages, startedAt = '2026-08-25T08:00:00.000Z') {
  const messages = [];
  return usages.map((usage, index) => {
    messages.push({ role: 'user', content: `turn-${index}` });
    return {
      at: new Date(Date.parse(startedAt) + index * 30_000).toISOString(),
      usage: {
        cachedInputTokens: usage.cacheReadTokens || 0,
        cacheWriteInputTokens: usage.cacheWriteTokens || 0,
        inputTokens: usage.freshInputTokens || usage.inputTokens || 0,
      },
      tools: [],
      system: [],
      messages: [...messages],
      body: { messages: [...messages] },
    };
  });
}

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.includes('session-amortization')) : [];
if (files.length === 0) {
  console.log('no session-amortization results on disk (they are gitignored)');
  process.exit(0);
}

for (const file of files) {
  let json;
  try { json = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch { continue; }

  for (const branch of ['baselineUsages', 'compactedUsages']) {
    const usages = json[branch];
    if (!Array.isArray(usages) || usages.length === 0) continue;

    const summary = attributeSession(amortizationTurns(usages));
    console.log(`\n### ${file}  ·  ${branch}`);
    console.log(`  ${summary.hits}/${summary.turns} hits` +
      `  (${(summary.hitRate * 100).toFixed(1)}%)` +
      `   read=${summary.cacheReadTokens}  write=${summary.cacheWriteTokens}  fresh=${summary.freshInputTokens}`);

    const causes = Object.entries(summary.causes).filter(([, count]) => count > 0);
    if (causes.length) {
      console.log(`  causes: ${causes.map(([cause, count]) => `${cause}=${count}`).join('  ')}`);
    }
    for (const [index, turn] of summary.perTurn.entries()) {
      const verdict = turn.hit ? `hit  read=${turn.cacheReadTokens}` : `MISS ${turn.cause}`;
      console.log(`    turn ${index}: ${verdict}`);
    }
  }
}

console.log(`
--- reading this ---
`.trimStart() + `A dominant \`no-breakpoint\` verdict means the harness never asked the provider to
cache: Sando sets no cache_control anywhere, so nothing could have been cached
regardless of what the history transform did. That is a different defect from
\`history-rewritten\`, which would mean a transform invalidated an otherwise-warm
prefix — and the two call for opposite fixes.
`);
