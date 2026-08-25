import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTurns,
  cumulativeText,
  computeAmortization,
  findBreakEvenTurn,
  findBaselineInfeasibleTurn,
  pickAnchorFacts,
  computeRecall,
  wrapSemanticPrompt,
  runSessionAmortization,
} from '../live/session-amortization-run.mjs';

function ev(id, output) {
  return { id, toolName: 'test', output, isError: false };
}

test('buildTurns chunks events into fixed-size turns in order', () => {
  const events = [ev('a', 'A'), ev('b', 'B'), ev('c', 'C'), ev('d', 'D')];
  const turns = buildTurns(events, 2, 2);
  assert.deepEqual(turns, ['A\n---\nB', 'C\n---\nD']);
});

test('buildTurns rejects too few turns, non-positive eventsPerTurn, or not enough events', () => {
  const events = [ev('a', 'A'), ev('b', 'B')];
  assert.throws(() => buildTurns(events, 1, 2), TypeError);
  assert.throws(() => buildTurns(events, 2, 0), TypeError);
  assert.throws(() => buildTurns(events, 2, 2), /need 4 events/);
});

test('cumulativeText joins turns up to and including the given index', () => {
  const turns = ['t0', 't1', 't2'];
  assert.equal(cumulativeText(turns, 0), 't0');
  assert.equal(cumulativeText(turns, 1), 't0\n---\nt1');
  assert.equal(cumulativeText(turns, 2), 't0\n---\nt1\n---\nt2');
});

test('findBreakEvenTurn returns the first turn where compacted drops below baseline', () => {
  assert.equal(findBreakEvenTurn([10, 25, 45, 70], [10, 30, 40, 60]), 2);
  assert.equal(findBreakEvenTurn([10, 20], [15, 25]), null);
});

test('computeAmortization shares pre-compaction cost and adds compaction overhead once', () => {
  const turnTexts = ['t0', 't1', 't2', 't3'];
  const compactAtTurn = 2;
  const baselineUsages = [
    { inputTokens: 10, outputTokens: 1 },
    { inputTokens: 20, outputTokens: 1 },
    { inputTokens: 30, outputTokens: 1 },
    { inputTokens: 40, outputTokens: 1 },
  ];
  const compactionUsage = { inputTokens: 25, outputTokens: 5 };
  const compactedUsages = [
    { inputTokens: 12, outputTokens: 1 },
    { inputTokens: 14, outputTokens: 1 },
  ];

  const result = computeAmortization({ turnTexts, compactAtTurn, baselineUsages, compactionUsage, compactedUsages });

  assert.deepEqual(result.baselineCumulative, [11, 32, 63, 104]);
  // shared prefix (11, 32) + compaction (30, not pushed as its own entry) + compacted turns (13, 15)
  assert.deepEqual(result.compactedCumulative, [11, 32, 75, 90]);
  assert.equal(result.baselineTotal, 104);
  assert.equal(result.compactedTotal, 90);
  assert.equal(result.netSavedTokens, 14);
  assert.equal(result.breakEvenTurn, 3);
});

test('computeAmortization tracks fresh/cache-read/cache-write tokens separately, not folded into the raw total', () => {
  const turnTexts = ['t0', 't1'];
  const compactAtTurn = 1;
  const baselineUsages = [
    { inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { inputTokens: 100, outputTokens: 1, cacheReadTokens: 90, cacheWriteTokens: 0 },
  ];
  const compactionUsage = { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 10 };
  const compactedUsages = [{ inputTokens: 20, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }];

  const result = computeAmortization({ turnTexts, compactAtTurn, baselineUsages, compactionUsage, compactedUsages });

  // raw total is unaffected by the cache fields (back-compat with existing metric)
  assert.equal(result.baselineTotal, 101 + 101);
  const lastBaseline = result.baselineCumulativeBreakdown.at(-1);
  assert.equal(lastBaseline.cacheReadTokens, 90);
  assert.equal(lastBaseline.freshInputTokens, 100 + (100 - 90));
  const lastCompacted = result.compactedCumulativeBreakdown.at(-1);
  assert.equal(lastCompacted.cacheWriteTokens, 10);
});

test('pickAnchorFacts spreads up to k meaningful lines across the whole text, not just first/last', () => {
  const text = [
    'changed src/core/index.mjs',
    'plain filler line one',
    'Error: cannot read property',
    'plain filler line two',
    'fixed issue in module 42',
    'plain filler line three',
    'commit 9a8b7c6d5e4',
  ].join('\n');
  const facts = pickAnchorFacts(text, 3);
  assert.equal(facts.length, 3);
  assert.ok(facts.every((f) => !f.startsWith('plain filler')));
});

test('pickAnchorFacts returns fewer than k when the text has fewer meaningful lines, never throws', () => {
  const facts = pickAnchorFacts('just plain prose with no signal', 5);
  assert.deepEqual(facts, []);
});

test('computeRecall reports the fraction of anchor facts found verbatim in the haystack', () => {
  assert.equal(computeRecall(['fact a', 'fact b', 'fact c', 'fact d'], 'contains fact a and fact c only'), 0.5);
  assert.equal(computeRecall([], 'anything'), 1);
  assert.equal(computeRecall(['missing'], 'nope'), 0);
});

test('runSessionAmortization computes factRecall from anchor facts picked out of the torso against the summary output', async () => {
  const turnTexts = ['changed src/core/index.mjs and Error: bad state', 't1', 't2', 't3'];
  const compactAtTurn = 1;
  const turnCompleter = async () => ({ usage: { inputTokens: 1, outputTokens: 1 } });
  const summaryCompleter = async () => ({
    summary: 'summary verbatim: changed src/core/index.mjs and Error: bad state',
    preservedFacts: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const result = await runSessionAmortization({ turnTexts, compactAtTurn, turnCompleter, summaryCompleter, anchorFactCount: 4 });
  assert.ok(result.anchorFacts.length > 0);
  assert.ok(result.factRecall > 0 && result.factRecall <= 1);
});

test('wrapSemanticPrompt names the sando-semantic-summary/v1 schema explicitly, not just the shared system prompt', () => {
  const wrapped = wrapSemanticPrompt('some raw content');
  assert.ok(wrapped.includes('sando-semantic-summary/v1'));
  assert.ok(wrapped.includes('some raw content'));
});

test('runSessionAmortization honors interTurnDelayMs between provider calls (cache-TTL reproducibility)', async () => {
  const turnTexts = ['t0', 't1', 't2'];
  const compactAtTurn = 1;
  const callTimestamps = [];
  const turnCompleter = async () => {
    callTimestamps.push(Date.now());
    return { usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const summaryCompleter = async () => {
    callTimestamps.push(Date.now());
    return { summary: 's', preservedFacts: [], usage: { inputTokens: 1, outputTokens: 1 } };
  };
  await runSessionAmortization({ turnTexts, compactAtTurn, turnCompleter, summaryCompleter, interTurnDelayMs: 20 });
  for (let i = 1; i < callTimestamps.length; i += 1) {
    assert.ok(callTimestamps[i] - callTimestamps[i - 1] >= 15, `gap ${i} was ${callTimestamps[i] - callTimestamps[i - 1]}ms`);
  }
});

test('findBaselineInfeasibleTurn flags the first turn whose cumulative estimate exceeds the context window', () => {
  const turnTexts = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
  const estimate = (text) => text.length;
  assert.equal(findBaselineInfeasibleTurn(turnTexts, 1000, estimate), null);
  assert.equal(findBaselineInfeasibleTurn(turnTexts, 50, estimate), 1);
});

test('computeAmortization validates array lengths and range of compactAtTurn', () => {
  const turnTexts = ['t0', 't1'];
  assert.throws(() => computeAmortization({
    turnTexts, compactAtTurn: 0, baselineUsages: [], compactionUsage: { inputTokens: 0, outputTokens: 0 }, compactedUsages: [],
  }), TypeError);
  assert.throws(() => computeAmortization({
    turnTexts,
    compactAtTurn: 1,
    baselineUsages: [{ inputTokens: 1, outputTokens: 0 }],
    compactionUsage: { inputTokens: 0, outputTokens: 0 },
    compactedUsages: [],
  }), TypeError);
});

test('runSessionAmortization reuses shared-prefix cost and only diverges after compactAtTurn', async () => {
  const turnTexts = ['t0', 't1', 't2', 't3'];
  const compactAtTurn = 2;
  const turnPrompts = [];
  const summaryPrompts = [];

  const turnCompleter = async ({ prompt }) => {
    turnPrompts.push(prompt);
    return { usage: { inputTokens: prompt.length, outputTokens: 1 } };
  };
  const summaryCompleter = async ({ prompt }) => {
    summaryPrompts.push(prompt);
    return { summary: 'SUMMARY', preservedFacts: [], usage: { inputTokens: prompt.length, outputTokens: 5 } };
  };

  const result = await runSessionAmortization({ turnTexts, compactAtTurn, turnCompleter, summaryCompleter });

  // 4 baseline turn calls + 2 post-compaction turn calls = 6 turnCompleter calls
  assert.equal(turnPrompts.length, 6);
  assert.equal(summaryPrompts.length, 1);
  // every prompt is wrapped with the schema instruction (see wrapSemanticPrompt)
  assert.ok(summaryPrompts[0].endsWith('t0\n---\nt1'));
  assert.ok(summaryPrompts[0].includes('sando-semantic-summary/v1'));
  // post-compaction prompts carry the summary text, not the raw pre-compaction turns
  assert.ok(turnPrompts[4].includes('SUMMARY\n---\nt2'));
  assert.ok(!turnPrompts[4].includes('t0'));
  assert.equal(result.compactionUsage.inputTokens, summaryPrompts[0].length);
  assert.equal(result.summaryText, 'SUMMARY');
  assert.equal(result.baselineCumulative.length, 4);
  assert.equal(result.compactedCumulative.length, 4);
});

test('runSessionAmortization rejects out-of-range compactAtTurn', async () => {
  const turnTexts = ['t0', 't1'];
  const noop = async () => ({ usage: { inputTokens: 0, outputTokens: 0 }, summary: '' });
  await assert.rejects(() => runSessionAmortization({ turnTexts, compactAtTurn: 0, turnCompleter: noop, summaryCompleter: noop }), TypeError);
  await assert.rejects(() => runSessionAmortization({ turnTexts, compactAtTurn: 2, turnCompleter: noop, summaryCompleter: noop }), TypeError);
});
