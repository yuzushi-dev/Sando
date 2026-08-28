import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runPreToolUse } from '../lib/enforcement.mjs';
import { appendProviderUsage } from '../lib/provider-usage.mjs';

function providerRecord({ sessionId, arm, inputTokens, turnId = 'turn-1' }) {
  return {
    eventKey: `usage:${sessionId}:${arm}`,
    schema: 'sando-provider-usage/v1', version: 1,
    host: 'codex', source: 'test', sessionId, turnId,
    at: '2026-08-28T10:00:00.000Z', inputTokens,
    cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0,
    reasoningOutputTokens: 0, totalTokens: inputTokens,
    arm, experimentId: 'fixture',
  };
}

function shellInput(cwd) {
  return { tool_name: 'Bash', tool_input: { command: 'cat -- fixture.txt' }, cwd };
}

test('keeps an eligible route enabled while adaptive evidence is insufficient', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-adaptive-open-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'ok\n');

  const result = runPreToolUse(shellInput(cwd), {
    SANDO_PROVIDER_USAGE_PATH: path.join(cwd, 'provider-usage.json'),
    SANDO_ADAPTIVE_EXPERIMENT: 'fixture',
  });

  assert.match(result.hookSpecificOutput.updatedInput.command, /bin[\\/]sando/);
});

test('bypasses an eligible route after apply cost or turns regress', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-adaptive-backoff-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'ok\n');
  const storagePath = path.join(cwd, 'provider-usage.json');
  const coveragePath = path.join(cwd, 'coverage.json');
  const records = [
    ['control-1', 'control', 100], ['control-2', 'control', 100], ['control-3', 'control', 100],
    ['apply-1', 'apply', 160], ['apply-2', 'apply', 160], ['apply-3', 'apply', 160],
  ].map(([sessionId, arm, inputTokens]) => providerRecord({ sessionId, arm, inputTokens }));
  appendProviderUsage({ storagePath, records });

  const result = runPreToolUse(shellInput(cwd), {
    SANDO_PROVIDER_USAGE_PATH: storagePath,
    SANDO_ADAPTIVE_EXPERIMENT: 'fixture',
    SANDO_COVERAGE_PATH: coveragePath,
  });

  assert.deepEqual(result, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(coveragePath, 'utf8')).counts, {
    eligible: 0, routed: 0, transformed: 0, blocked: 0, bypassed: 1,
  });
});

test('control arm never routes through Sando', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-adaptive-control-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'ok\n');

  const result = runPreToolUse(shellInput(cwd), {
    SANDO_ADAPTIVE_ARM: 'control',
    SANDO_PROVIDER_USAGE_PATH: path.join(cwd, 'provider-usage.json'),
  });

  assert.deepEqual(result, {});
});

test('does not ingest a partial transcript during PreToolUse', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-adaptive-partial-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'ok\n');
  const transcriptPath = path.join(cwd, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'event_msg', timestamp: '2026-08-28T10:00:00.000Z', payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, total_tokens: 101 },
    } },
  }));
  const storagePath = path.join(cwd, 'provider-usage.json');

  const result = runPreToolUse({ ...shellInput(cwd), transcript_path: transcriptPath, session_id: 'current' }, {
    SANDO_PROVIDER_USAGE_PATH: storagePath,
    SANDO_ADAPTIVE_EXPERIMENT: 'fixture',
  });

  assert.match(result.hookSpecificOutput.updatedInput.command, /bin[\\/]sando/);
  assert.equal(fs.existsSync(storagePath), false);
});

test('fails closed when adaptive evidence is unavailable or the arm is invalid', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-adaptive-unavailable-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'ok\n');
  const storagePath = path.join(cwd, 'provider-usage.json');
  fs.writeFileSync(storagePath, '{');

  assert.deepEqual(runPreToolUse(shellInput(cwd), {
    SANDO_PROVIDER_USAGE_PATH: storagePath,
    SANDO_ADAPTIVE_EXPERIMENT: 'fixture',
  }), {});
  assert.deepEqual(runPreToolUse(shellInput(cwd), {
    SANDO_PROVIDER_USAGE_PATH: path.join(cwd, 'missing.json'),
    SANDO_ADAPTIVE_ARM: 'invalid',
  }), {});
});
