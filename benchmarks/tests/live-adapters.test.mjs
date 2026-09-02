import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeArgs,
  buildCodexArgs,
  formatChildFailure,
  hasOkStatus,
  parseClaudeUsage,
  parseCodexUsage,
} from '../live/adapters.mjs';
import * as liveRunner from '../live/run-live.mjs';
import { parseModelProbeResult } from '../live/e2e-run.mjs';
import { buildCodexE2EEnv, buildCodexToolArgs, CODEX_TOOL_MEASUREMENT } from '../live/codex-e2e-run.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('live runner permits the requested fifteen paired cycles', () => {
  assert.equal(liveRunner.MAX_REPETITIONS, 15);
  assert.equal(liveRunner.validateRepetitions('15'), 15);
  assert.throws(() => liveRunner.validateRepetitions('16'), /1\.\.15/);
});

function liveRun(variant, evidence = {}) {
  return {
    host: 'claude',
    scenario: 'terminal-noise',
    repetition: 0,
    variant,
    measurement: 'prompt-level',
    tokenAccounting: 'provider-reported',
    inputTokens: variant === 'baseline' ? 100 : 60,
    outputTokens: 4,
    totalTokens: variant === 'baseline' ? 104 : 64,
    providerUsage: { inputTokens: variant === 'baseline' ? 100 : 60 },
    audit: {
      host: 'claude',
      resolvedModel: 'claude-test',
      clientVersion: 'test',
      promptDigest: `sha256:${(variant === 'baseline' ? '1' : '2').repeat(64)}`,
      scenarioDigest: `sha256:${'3'.repeat(64)}`,
      commit: null,
      workingTreeDirty: null,
      diffDigest: null,
      workingTreeProvenance: 'unknown',
      measurement: { mode: 'prompt-level', hookEndToEnd: false },
      tokenAccounting: { source: 'provider-reported', providerObserved: true },
    },
    quality: 'pass',
    modelVisibleQuality: null,
    artifactResolvable: null,
    secretLeak: null,
    ...evidence,
  };
}

async function reportWithRuns(runs) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sando-live-'));
  return liveRunner.writeReport({
    destination: path.join(directory, 'live.json'),
    host: 'claude',
    clientVersion: 'test',
    scenario: { id: 'terminal-noise' },
    runs,
  });
}

test('failure reports preserve repository Git provenance outside repository cwd', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sando-live-'));
  const previousCwd = process.cwd();
  try {
    process.chdir(outside);
    const failed = liveRunner.failureRun({
      host: 'claude',
      scenario: { id: 'terminal-noise' },
      repetition: 0,
      variant: 'baseline',
      prompt: 'prompt',
      args: ['--print', 'prompt'],
      result: { stdout: '', stderr: 'provider failed' },
      clientVersion: 'test',
      message: 'provider failed',
    });
    const commit = execFileSync('git', ['-C', REPOSITORY_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = Boolean(execFileSync('git', ['-C', REPOSITORY_ROOT, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }).trim());
    assert.equal(failed.audit.commit, commit);
    assert.equal(failed.audit.workingTreeDirty, dirty);
    assert.equal(failed.audit.workingTreeProvenance, dirty ? 'dirty-digest' : 'clean');
  } finally {
    process.chdir(previousCwd);
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('failed live runs remain reportable when provider usage is unavailable', async () => {
  const failed = liveRunner.failureRun({
    host: 'codex',
    scenario: { id: 'terminal-noise' },
    repetition: 0,
    variant: 'baseline',
    prompt: 'prompt',
    args: ['exec', 'prompt'],
    result: { stdout: '', stderr: 'provider unavailable' },
    clientVersion: 'codex-test',
    message: 'provider unavailable',
  });
  const output = await reportWithRuns([failed]);
  assert.equal(output.status, 'blocked');
  assert.equal(output.runs[0].error, 'provider unavailable');
  assert.equal(output.runs[0].audit.tokenAccounting.providerObserved, false);
});

test('unlimited Claude budget bypasses the per-call budget requirement', () => {
  const runner = path.join(REPOSITORY_ROOT, 'benchmarks/live/run-live.mjs');
  let error;
  try {
    execFileSync(process.execPath, [
      runner,
      '--host', 'claude',
      '--unlimited-budget',
      '--confirm-cost',
      '--repetitions', '0',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (caught) {
    error = caught;
  }
  assert.match(error?.stderr ?? '', /--repetitions must be 1\.\.15/);
});

test('blocks prompt-level live reports without model, artifact, and leak evidence', async () => {
  const output = await reportWithRuns([liveRun('baseline'), liveRun('optimized')]);
  assert.equal(output.status, 'blocked');
  assert.equal(output.failure.status, 'blocked');
  assert.equal(output.summary.pairedRuns, 1);
  assert.equal(output.summary.scenarios[0].medianSavedInputTokens, 40);
  assert.match(output.audit.note, /Prompt-level live data cannot establish modelVisibleQuality, artifactResolvable, or secretLeak evidence/);
});

test('passes a live report only when every pair has explicit quality evidence', async () => {
  const evidence = { modelVisibleQuality: 'pass', artifactResolvable: true, secretLeak: false };
  const output = await reportWithRuns([liveRun('baseline', evidence), liveRun('optimized', evidence)]);
  assert.equal(output.status, 'passed');
  assert.equal(output.failure, undefined);
});

test('blocks a live report when any baseline/optimized pair lacks evidence', async () => {
  const evidence = { modelVisibleQuality: 'pass', artifactResolvable: true, secretLeak: false };
  const output = await reportWithRuns([
    liveRun('baseline', evidence), liveRun('optimized', evidence),
    { ...liveRun('baseline', evidence), repetition: 1 },
    { ...liveRun('optimized'), repetition: 1 },
  ]);
  assert.equal(output.status, 'blocked');
  assert.match(output.failure.message, /model-visible quality evidence/);
});

test('parses Claude reported usage including cache counters', () => {
  assert.deepEqual(parseClaudeUsage(JSON.stringify({
    type: 'result',
    subtype: 'success',
    model: 'claude-test',
    usage: { input_tokens: 120, cache_creation_input_tokens: 20, cache_read_input_tokens: 40, output_tokens: 8, reasoning_output_tokens: 3, total_cost_usd: 0.12 },
  })), {
    inputTokens: 180,
    uncachedInputTokens: 120,
    cacheCreationInputTokens: 20,
    cacheReadInputTokens: 40,
    outputTokens: 8,
    totalTokens: 188,
    reasoningOutputTokens: 3,
    totalCostUsd: 0.12,
    resolvedModel: 'claude-test',
  });
});

test('does not use Claude interim usage without a terminal result', () => {
  assert.equal(parseClaudeUsage(JSON.stringify({
    type: 'assistant',
    message: { usage: { input_tokens: 12, output_tokens: 3 } },
  })), null);
});

test('uses only direct usage on the terminal Claude result', () => {
  assert.deepEqual(parseClaudeUsage(JSON.stringify({
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 42, output_tokens: 7 },
    result: { type: 'result', usage: { input_tokens: 999, output_tokens: 999 } },
  })), {
    inputTokens: 42,
    uncachedInputTokens: 42,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 7,
    totalTokens: 49,
  });
});

test('requires a successful Claude result terminal', () => {
  assert.equal(parseClaudeUsage(JSON.stringify({
    type: 'result', subtype: 'error', usage: { input_tokens: 42, output_tokens: 7 },
  })), null);
  assert.equal(parseClaudeUsage(JSON.stringify({
    is_final: true, usage: { input_tokens: 42, output_tokens: 7 },
  })), null);
  assert.equal(parseClaudeUsage([
    JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 42, output_tokens: 7 } }),
    JSON.stringify({ type: 'assistant', message: { content: 'trailing event' } }),
  ].join('\n')), null);
});

test('rejects unsafe or contradictory Claude usage counters', () => {
  const base = { type: 'result', subtype: 'success', usage: { input_tokens: 42, output_tokens: 7 } };
  for (const usage of [
    { ...base.usage, cache_read_input_tokens: -1 },
    { ...base.usage, cache_creation_input_tokens: 1.5 },
    { ...base.usage, cache_read_input_tokens: Number.MAX_SAFE_INTEGER },
    { ...base.usage, total_tokens: 48 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: Number.MAX_SAFE_INTEGER },
  ]) assert.equal(parseClaudeUsage(JSON.stringify({ ...base, usage })), null, JSON.stringify(usage));
});

test('does not fall back to nested Claude usage when terminal usage is absent', () => {
  assert.equal(parseClaudeUsage(JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: { usage: { input_tokens: 42, output_tokens: 7 } },
  })), null);
});

test('parses Claude usage from JSONL provider output', () => {
  assert.deepEqual(parseClaudeUsage([
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 12, output_tokens: 3 } } }),
    JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 42, output_tokens: 7 } }),
  ].join('\n')), {
    inputTokens: 42,
    uncachedInputTokens: 42,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 7,
    totalTokens: 49,
  });
});

test('keeps valid Claude usage when a verbose diagnostic line is malformed', () => {
  const output = [
    JSON.stringify({ type: 'assistant', message: { content: [] } }),
    '{verbose diagnostic}',
    JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 42, output_tokens: 7 } }),
  ].join('\n');
  assert.equal(parseClaudeUsage(output, { tolerateMalformed: true })?.totalTokens, 49);
});

test('extracts Claude canonicalModel from modelUsage entries', () => {
  assert.equal(parseClaudeUsage(JSON.stringify({
    type: 'result',
    subtype: 'success',
    modelUsage: { 'claude-opus-5': { canonicalModel: 'claude-opus-5', inputTokens: 1 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  })).resolvedModel, 'claude-opus-5');
});

test('parses Claude probe JSON after a client diagnostic prefix', () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'diagnostic from a plugin\n{"status":"ok","facts":["HEAD","TAIL"]}',
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  assert.deepEqual(parseModelProbeResult(stdout), {
    status: 'ok', facts: ['HEAD', 'TAIL'],
    usage: {
      inputTokens: 10, uncachedInputTokens: 10, cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0, outputTokens: 2, totalTokens: 12,
    },
  });
});

test('parses Codex usage only from the final direct turn.completed record', () => {
  assert.deepEqual(parseCodexUsage([
    JSON.stringify({ type: 'item.completed', item: { text: 'done' } }),
    JSON.stringify({ type: 'turn.completed', model: 'codex-test', usage: { input_tokens: 90, cached_input_tokens: 30, cache_write_input_tokens: 5, output_tokens: 7, reasoning_output_tokens: 2, total_tokens: 97, total_cost_usd: 0.07 } }),
  ].join('\n')), {
    inputTokens: 90,
    uncachedInputTokens: 55,
    cacheCreationInputTokens: 5,
    cacheWriteInputTokens: 5,
    cacheReadInputTokens: 30,
    outputTokens: 7,
    reasoningOutputTokens: 2,
    totalTokens: 97,
    totalCostUsd: 0.07,
    resolvedModel: 'codex-test',
  });
});

test('rejects interim, nested, unrelated, trailing, and malformed Codex usage', () => {
  const usage = { input_tokens: 90, cached_input_tokens: 30, output_tokens: 7, total_tokens: 97 };
  assert.equal(parseCodexUsage(JSON.stringify({ type: 'turn.started', usage })), null);
  assert.equal(parseCodexUsage(JSON.stringify({ type: 'turn.completed', usage: { nested: usage } })), null);
  assert.equal(parseCodexUsage([
    JSON.stringify({ type: 'item.completed', usage }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n')), null);
  assert.equal(parseCodexUsage([
    JSON.stringify({ type: 'turn.completed', usage }),
    JSON.stringify({ type: 'item.completed', item: { text: 'trailing event' } }),
  ].join('\n')), null);
  assert.equal(parseCodexUsage([
    JSON.stringify({ type: 'item.completed', item: { text: 'done' } }),
    '{malformed',
    JSON.stringify({ type: 'turn.completed', usage }),
  ].join('\n')), null);
});

test('extracts Claude terminal assistant response before exact status validation', () => {
  const envelope = {
    type: 'result',
    subtype: 'success',
    result: JSON.stringify({ status: 'ok' }),
  };
  assert.equal(hasOkStatus(JSON.stringify(envelope, null, 2), 'claude'), true);
  for (const result of [
    JSON.stringify({ status: 'ok', extra: true }),
    JSON.stringify({ nested: { status: 'ok' } }),
    JSON.stringify({ status: 'error' }),
  ]) assert.equal(hasOkStatus(JSON.stringify({ ...envelope, result }), 'claude'), false, result);
  assert.equal(hasOkStatus(JSON.stringify({ status: 'ok' }), 'claude'), false);
});

test('extracts the final Codex agent message before exact status validation', () => {
  const first = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'not-final' }) } });
  const terminal = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 90, cached_input_tokens: 30, output_tokens: 7, total_tokens: 97 } });
  const output = [
    first,
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'ok' }) } }),
    terminal,
  ].join('\n');
  assert.equal(hasOkStatus(output, 'codex'), true);
  for (const invalid of [
    [first, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'ok', extra: true }) } }), terminal].join('\n'),
    [first, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', metadata: { text: JSON.stringify({ status: 'ok' }) } } }), terminal].join('\n'),
    `${output}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'ok' }) } })}`,
    `${output}\n{malformed`,
  ]) assert.equal(hasOkStatus(invalid, 'codex'), false, invalid);
});

test('formats child failures from stderr and stdout without credential-shaped values', () => {
  assert.equal(
    formatChildFailure('claude', 'baseline', { code: 1, signal: null, stderr: '', stdout: 'API_KEY=sk-test-012345678901234567890' }),
    'claude baseline failed (1): API_KEY=[REDACTED]',
  );
});

test('builds isolated print commands without shell interpolation', () => {
  const claude = buildClaudeArgs({ prompt: 'a prompt', model: 'haiku' });
  assert.ok(claude.includes('--print'));
  assert.ok(claude.includes('--no-session-persistence'));
  assert.equal(claude.at(-1), 'a prompt');
  const codex = buildCodexArgs({ prompt: 'a prompt' });
  assert.deepEqual(codex.slice(0, 3), ['exec', '--ephemeral', '--ignore-user-config']);
  assert.equal(codex.at(-1), 'a prompt');
});

test('supports an explicit Codex model argument without implying output rewrite', () => {
  const codex = buildCodexArgs({ prompt: 'a prompt', model: 'codex-test' });
  assert.deepEqual(codex.slice(0, 2), ['exec', '--model']);
  assert.ok(codex.includes('--model'));
  assert.equal(codex.at(-1), 'a prompt');
});

test('builds paired Codex tool commands with MCP only in the optimized arm', () => {
  const baseline = buildCodexToolArgs({ prompt: 'run it', model: 'codex-test', optimized: false, serverPath: '/tmp/sando/mcp/server.mjs' });
  const optimized = buildCodexToolArgs({ prompt: 'run it', model: 'codex-test', optimized: true, serverPath: '/tmp/sando/mcp/server.mjs' });
  assert.equal(baseline.includes('mcp_servers.sando.command="node"'), false);
  assert.ok(baseline.includes('--approve-for-me'));
  assert.ok(optimized.includes('mcp_servers.sando.command="node"'));
  assert.ok(optimized.includes('mcp_servers.sando.args=["/tmp/sando/mcp/server.mjs"]'));
  assert.equal(optimized.at(-1), 'run it');
  assert.equal(CODEX_TOOL_MEASUREMENT, 'end-to-end-tools');
});

test('passes the receipt directory to the optimized MCP server through Codex config', () => {
  const receiptDirectory = '/tmp/sando receipts';
  const optimized = buildCodexToolArgs({
    prompt: 'run it', model: 'codex-test', optimized: true, route: 'mcp',
    serverPath: '/tmp/sando/mcp/server.mjs', receiptDirectory,
  });

  const optimizedAll = buildCodexToolArgs({
    prompt: 'run it', model: 'codex-test', optimized: true, route: 'all',
    serverPath: '/tmp/sando/mcp/server.mjs', receiptDirectory,
  });
  const baseline = buildCodexToolArgs({
    prompt: 'run it', model: 'codex-test', optimized: false, route: 'mcp',
    serverPath: '/tmp/sando/mcp/server.mjs', receiptDirectory,
  });
  const optimizedCli = buildCodexToolArgs({ prompt: 'run it', model: 'codex-test', optimized: true, route: 'cli', receiptDirectory });

  const receiptOverride = `mcp_servers.sando.env.SANDO_EXEC_RECEIPT_DIR=${JSON.stringify(receiptDirectory)}`;
  assert.ok(optimized.includes(receiptOverride));
  assert.ok(optimizedAll.includes(receiptOverride));
  assert.equal(baseline.includes(receiptOverride), false);
  assert.equal(optimizedCli.includes(receiptOverride), false);
});

test('keeps receipt env propagation scoped to optimized MCP routes', () => {
  const baseEnv = { SANDO_EXEC_RECEIPT_DIR: '/inherited/receipt', SANDO_POLICY: 'old' };
  const receiptDirectory = '/tmp/sando-receipts';

  const optimizedMcp = buildCodexE2EEnv({ variant: 'optimized', route: 'mcp', baseEnv, receiptDirectory });
  const optimizedAll = buildCodexE2EEnv({ variant: 'optimized', route: 'all', baseEnv, receiptDirectory });
  const optimizedCli = buildCodexE2EEnv({ variant: 'optimized', route: 'cli', baseEnv, receiptDirectory });
  const baselineMcp = buildCodexE2EEnv({ variant: 'baseline', route: 'mcp', baseEnv, receiptDirectory });

  assert.equal(optimizedMcp.SANDO_EXEC_RECEIPT_DIR, receiptDirectory);
  assert.equal(optimizedAll.SANDO_EXEC_RECEIPT_DIR, receiptDirectory);
  assert.equal(Object.hasOwn(optimizedCli, 'SANDO_EXEC_RECEIPT_DIR'), false);
  assert.equal(Object.hasOwn(baselineMcp, 'SANDO_EXEC_RECEIPT_DIR'), false);
});

test('builds paired Codex CLI commands with hooks enabled and no MCP server', () => {
  const baseline = buildCodexToolArgs({ prompt: 'run it', model: 'codex-test', optimized: false, route: 'cli' });
  const optimized = buildCodexToolArgs({ prompt: 'run it', model: 'codex-test', optimized: true, route: 'cli' });
  assert.equal(baseline.includes('--ignore-user-config'), false);
  assert.ok(baseline.includes('--dangerously-bypass-hook-trust'));
  assert.deepEqual(optimized, baseline);
  assert.equal(optimized.some((arg) => arg.includes('mcp_servers')), false);
});

test('builds paired Codex all-strategy commands with hooks and MCP only in optimized arm', () => {
  const baseline = buildCodexToolArgs({ prompt: 'run it', model: 'codex-test', optimized: false, route: 'all', serverPath: '/tmp/sando/mcp/server.mjs' });
  const optimized = buildCodexToolArgs({ prompt: 'run it', model: 'codex-test', optimized: true, route: 'all', serverPath: '/tmp/sando/mcp/server.mjs' });
  assert.equal(baseline.includes('--ignore-user-config'), false);
  assert.ok(baseline.includes('--dangerously-bypass-hook-trust'));
  assert.equal(baseline.some((arg) => arg.includes('mcp_servers')), false);
  assert.ok(optimized.includes('mcp_servers.sando.command="node"'));
  assert.ok(optimized.includes('mcp_servers.sando.args=["/tmp/sando/mcp/server.mjs"]'));
});
