/**
 * Prefix-divergence probe for Sando's transformProviderRequest.
 *
 * Question (deterministic, zero API cost): when the conversation grows by one turn,
 * does the transformed request body stay byte-identical over the region that was
 * already sent last turn — or does the first divergence point jump BACKWARD into
 * already-cached territory?
 *
 * Anthropic caches a cumulative hash up to each cache_control breakpoint, so any byte
 * change at index i invalidates everything from i onward. The metric that matters is
 * therefore: first index at which turn N's serialization differs from turn N-1's,
 * and how many tokens sit before that index.
 *
 * Raw material: a real Claude Code transcript (real Read/Bash/Grep calls with real
 * arguments), because the repo's own fixtures carry toolName "ToolResult" and no input,
 * which cannot trigger the supersede or dedupe paths under test.
 */

import fs from 'node:fs';
import { transformProviderRequest } from '/home/cristina/Projects/Sando/packages/sando/src/context-transform.mjs';

const TRANSCRIPT = process.argv[2];
const MAX_TURNS = Number(process.argv[3] ?? 60);
const MAX_HISTORY_TOKENS = process.argv[4] ? Number(process.argv[4]) : null;

// ---- rebuild an Anthropic messages[] from the transcript -------------------

const lines = fs.readFileSync(TRANSCRIPT, 'utf8').split('\n').filter(Boolean);
const messages = [];
for (const line of lines) {
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  const m = rec?.message;
  if (!m || !Array.isArray(m.content)) continue;
  if (m.role !== 'assistant' && m.role !== 'user') continue;
  // keep only blocks the transform actually looks at, plus text for realism
  const content = m.content.filter((b) =>
    b && ['tool_use', 'tool_result', 'text'].includes(b.type));
  if (content.length === 0) continue;
  messages.push({ role: m.role, content });
}

// keep only up to MAX_TURNS messages that carry a tool_use or tool_result
const useful = [];
for (const msg of messages) {
  useful.push(msg);
  const toolMsgs = useful.filter((x) =>
    x.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result')).length;
  if (toolMsgs >= MAX_TURNS) break;
}

const toolCount = useful.filter((x) =>
  x.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result')).length;
console.log(`transcript: ${TRANSCRIPT.split('/').pop()}`);
console.log(`rebuilt ${useful.length} messages (${toolCount} carry tool blocks)\n`);

// ---- estimate tokens the same way Sando does (bytes/4) --------------------

const est = (v) => Math.ceil(Buffer.byteLength(JSON.stringify(v)) / 4);

// ---- replay: grow the conversation one message at a time ------------------

const policy = MAX_HISTORY_TOKENS === null ? {} : { maxHistoryTokens: MAX_HISTORY_TOKENS };
let prev = null;
let prevTurnIndex = 0;
const rows = [];

for (let n = 2; n <= useful.length; n += 1) {
  const body = { model: 'claude-sonnet-4-5', messages: structuredClone(useful.slice(0, n)) };
  const out = transformProviderRequest({ provider: 'anthropic', body, policy });
  const cur = out.body.messages.map((m) => JSON.stringify(m));

  if (prev) {
    // first index where this turn's serialization differs from last turn's,
    // over the region that existed last turn
    const bound = Math.min(prev.length, cur.length);
    let diverge = bound;
    for (let i = 0; i < bound; i += 1) {
      if (prev[i] !== cur[i]) { diverge = i; break; }
    }
    const movedBack = diverge < prevTurnIndex;
    const tokensBefore = est(out.body.messages.slice(0, diverge));
    const tokensAfter = est(out.body.messages.slice(diverge));
    rows.push({ n, diverge, prevLen: prev.length, tokensBefore, tokensAfter, movedBack,
                reasons: out.reasons.join(',') });
    prevTurnIndex = diverge;
  }
  prev = cur;
}

// ---- report ---------------------------------------------------------------

const churn = rows.filter((r) => r.diverge < r.prevLen);
const backward = rows.filter((r) => r.movedBack);

console.log('turns where the already-sent region was REWRITTEN (cache-invalidating):');
if (churn.length === 0) console.log('  none — every turn only appended.\n');
for (const r of churn) {
  console.log(`  turn ${String(r.n).padStart(3)}: diverged at msg ${String(r.diverge).padStart(3)}`
    + ` of ${String(r.prevLen).padStart(3)} already sent`
    + ` | ~${String(r.tokensBefore).padStart(6)} tok still cacheable`
    + ` | ~${String(r.tokensAfter).padStart(6)} tok re-billed`
    + ` | ${r.reasons}`);
}

console.log(`\nsummary`);
console.log(`  replayed turns              : ${rows.length}`);
console.log(`  turns that rewrote history  : ${churn.length}`);
console.log(`  divergence jumped backward  : ${backward.length}`);
if (churn.length) {
  const worst = churn.reduce((a, b) => (b.tokensAfter > a.tokensAfter ? b : a));
  const totalRebilled = churn.reduce((s, r) => s + r.tokensAfter, 0);
  console.log(`  worst single event          : turn ${worst.n}, ~${worst.tokensAfter} tok re-billed`);
  console.log(`  cumulative re-billed tokens : ~${totalRebilled}`);
  console.log(`    (would have been ~${Math.round(totalRebilled * 0.1)} tok-equivalent at the 0.1x cache-read rate)`);
}
