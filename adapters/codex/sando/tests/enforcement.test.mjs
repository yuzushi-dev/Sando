import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { classifyShellCommand } from '../lib/enforcement.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('classifies only proven literal Read and Grep commands', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-enforce-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle\n');

  assert.deepEqual(classifyShellCommand({
    toolName: 'Bash', toolInput: { command: 'cat -- fixture.txt' }, cwd,
  }), { status: 'eligible', route: 'sando_read', path: 'fixture.txt' });
  assert.deepEqual(classifyShellCommand({
    toolName: 'Bash', toolInput: { command: 'rg -F -- needle fixture.txt' }, cwd,
  }), { status: 'eligible', route: 'sando_grep', pattern: 'needle', path: 'fixture.txt' });
});

test('leaves shell syntax and unsafe targets as measured bypasses', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-bypass-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle\n');

  for (const command of [
    'cat fixture.txt | sed -n 1,2p',
    'rg needle .',
    'cat ../fixture.txt',
    'cat missing.txt',
  ]) {
    assert.equal(classifyShellCommand({
      toolName: 'Bash', toolInput: { command }, cwd,
    }).status, 'bypassed', command);
  }
});

test('PreToolUse transparently rewrites an eligible built-in to the local CLI', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-block-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle\n');
  const coveragePath = path.join(cwd, 'coverage.json');
  const result = spawnSync(process.execPath, [path.join(root, 'hooks/pre-tool-use.mjs')], {
    cwd,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'cat -- fixture.txt' }, cwd,
    }),
    encoding: 'utf8',
    env: { ...process.env, SANDO_COVERAGE_PATH: coveragePath },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(output.hookSpecificOutput.updatedInput.command, /bin[\\/]sando/);
  assert.doesNotMatch(output.hookSpecificOutput.updatedInput.command, /MCP/);
  const routed = spawnSync('/bin/sh', ['-c', output.hookSpecificOutput.updatedInput.command], {
    cwd, encoding: 'utf8', env: { ...process.env, SANDO_MODE: 'apply' },
  });
  assert.equal(routed.status, 0, routed.stderr);
  assert.match(routed.stdout, /needle/);
  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  assert.deepEqual(coverage.counts, { eligible: 1, routed: 1, transformed: 1, blocked: 0, bypassed: 0 });
});

test('PreToolUse records an ambiguous shell command as bypass', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-bypass-hook-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const coveragePath = path.join(cwd, 'coverage.json');
  const result = spawnSync(process.execPath, [path.join(root, 'hooks/pre-tool-use.mjs')], {
    cwd,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'cat fixture.txt | sed -n 1,2p' }, cwd,
    }),
    encoding: 'utf8',
    env: { ...process.env, SANDO_COVERAGE_PATH: coveragePath },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  assert.deepEqual(coverage.counts, { eligible: 0, routed: 0, transformed: 0, blocked: 0, bypassed: 1 });
  assert.equal(coverage.byReason['ambiguous-shell'], 1);
});

test('Codex hook manifests install the PreToolUse gate', () => {
  for (const file of ['hooks/hooks.json', '../../../plugins/sando/hooks/hooks.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.equal(manifest.hooks.PreToolUse[0].matcher, '^(Bash|exec_command|shell_command)$');
    assert.match(manifest.hooks.PreToolUse[0].hooks[0].command, /pre-tool-use\.mjs/);
  }
});
