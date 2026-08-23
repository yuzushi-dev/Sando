import assert from 'node:assert/strict';
import test from 'node:test';

import { createReceipt, normalizeEvent, optimizeToolOutput } from '../src/core.mjs';
import { planToolRoute } from '../src/routing.mjs';

test('records the eligible structural Read route in the result', () => {
  const result = optimizeToolOutput({
    toolName: 'Read',
    output: 'const value = 1;\n',
    cwd: '/work',
    lineCount: 180,
    fileBytes: 180 * 1024,
  });

  assert.equal(result.route, 'summary');
  assert.equal(result.reason, 'sando-read-summarize');
  assert.equal(result.policyVersion, 'sando-routing/v1');
});

test('does not summarize a Read with an explicit selection', () => {
  assert.equal(planToolRoute({
    toolName: 'Read', selector: true, lineCount: 180, fileBytes: 180 * 1024,
  }).route, 'passthrough');
});

test('summarizes only proven large non-prose Reads', () => {
  assert.deepEqual(planToolRoute({
    toolName: 'read', lineCount: 180, fileBytes: 180 * 1024,
  }), {
    route: 'summary',
    modelVisible: 'elided-structure',
    source: 'sando-read-summarize',
    limits: { minTotalLines: 100, maxSummaryBytes: 2 * 1024 * 1024, maxSummaryLines: 20_000 },
  });

  for (const input of [
    { lineCount: 180 },
    { lineCount: 180, fileBytes: 0 },
    { lineCount: 180, fileBytes: -1 },
    { lineCount: 180, fileBytes: Number.NaN },
    { lineCount: 180, fileBytes: Number.POSITIVE_INFINITY },
    { lineCount: 180, fileBytes: '184320' },
    { lineCount: 180, fileBytes: null },
    { lineCount: 99 },
    { lineCount: 20_001 },
    { lineCount: 180, fileBytes: 2 * 1024 * 1024 + 1 },
    { lineCount: 180, fileBytes: 180 * 1024, prose: true },
    { lineCount: 180, fileBytes: 180 * 1024, raw: true },
  ]) {
    assert.equal(planToolRoute({ toolName: 'Read', ...input }).route, 'passthrough');
  }

  assert.equal(planToolRoute({
    toolName: 'Read', lineCount: 180, fileBytes: 180 * 1024, prose: true, summarizeProse: true,
  }).route, 'summary');
  assert.equal(planToolRoute({
    toolName: 'Read', lineCount: 180, fileBytes: 180 * 1024, summarizeEnabled: false,
  }).route, 'passthrough');
});

test('routes Grep through bounded structured matches', () => {
  assert.deepEqual(planToolRoute({ toolName: 'Grep' }), {
    route: 'structured',
    modelVisible: 'bounded-matches',
    source: 'sando-grep',
    limits: {
      files: 20,
      matchesPerFile: 20,
      singleFileMatches: 200,
      internalTotalMatches: 2_000,
      nativeMaxFileBytes: 4 * 1024 * 1024,
      timeoutMs: 30_000,
      maxColumns: 512,
    },
  });
  assert.equal(planToolRoute({ toolName: 'grep', grepScope: 'single-file' }).limits.matchesPerFile, 200);
});

test('routes high-volume Bash through an artifact-backed bounded view', () => {
  const output = `HEAD\n${'middle\n'.repeat(8_000)}TAIL`;
  const result = optimizeToolOutput({
    toolName: 'Bash', output, cwd: '/work',
    policy: { maxInlineBytes: 131_072, maxColumns: 768 },
  });

  assert.equal(result.route, 'artifact');
  assert.equal(result.reason, 'sando-output-meta');
  assert.ok(result.artifact);
  assert.equal(result.artifact.content, output);
  assert.ok(Buffer.byteLength(result.inline) <= 40 * 1024 + 128);
});

test('keeps Bash at the OMP spill boundary generic', () => {
  assert.equal(planToolRoute({ toolName: 'Bash', outputBytes: 50 * 1024 }).route, 'passthrough');
  assert.equal(planToolRoute({ toolName: 'Bash', outputBytes: 50 * 1024 + 1 }).route, 'artifact');
});

test('caps structured Grep columns at the native bound', () => {
  const result = optimizeToolOutput({
    toolName: 'Grep', output: 'x'.repeat(600), cwd: '/work',
    policy: { maxInlineBytes: 4096, maxColumns: 768 },
  });

  assert.equal(result.route, 'structured');
  assert.ok(result.artifact);
  assert.ok(result.inline.split('\n').some((line) => line.endsWith('~')));
});

test('unknown tools retain generic bounded fallback and receipts preserve routing metadata', () => {
  const event = normalizeEvent({
    hook_event_name: 'PostToolUse', tool_name: 'CustomTool', tool_response: 'ok', cwd: '/work', session_id: 's1',
  });
  const optimization = optimizeToolOutput({ toolName: event.toolName, output: event.output, cwd: event.cwd });
  const receipt = createReceipt({ host: 'claude', event, optimization });

  assert.equal(optimization.route, 'passthrough');
  assert.equal(optimization.reason, 'spike-default');
  assert.equal(optimization.policyVersion, 'sando-routing/v1');
  assert.equal(receipt.route, optimization.route);
  assert.equal(receipt.reason, optimization.reason);
  assert.equal(receipt.policyVersion, optimization.policyVersion);
});
