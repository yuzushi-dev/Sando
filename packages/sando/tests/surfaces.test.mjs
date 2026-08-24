import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');

test('Sando surfaces use the renamed package and plugin paths', () => {
  const packageJson = json('packages/sando/package.json');
  assert.equal(packageJson.name, '@sando/core');
  assert.ok(fs.existsSync(path.join(root, 'plugins/sando/.codex-plugin/plugin.json')));
  assert.ok(fs.existsSync(path.join(root, 'adapters/claude/sando/.claude-plugin/plugin.json')));
  assert.ok(fs.existsSync(path.join(root, 'adapters/codex/sando/.mcp.json')));
});

function json(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

test('copied bundles run without the repository package source', (t) => {
  const cache = fs.mkdtempSync('/tmp/sando-cache-');
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  for (const [name, hookRelative] of [
    ['plugin', 'hooks/post-tool-use.mjs'],
    ['claude', 'hooks/post-tool-use.mjs'],
    ['codex', 'hooks/post-tool-use.mjs'],
  ]) {
    const source = path.join(root, name === 'plugin' ? 'plugins/sando' : `adapters/${name}/sando`);
    const destination = path.join(cache, name);
    fs.cpSync(source, destination, { recursive: true });
    const hook = path.join(destination, hookRelative);
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'cache-ok', cwd: destination }),
      encoding: 'utf8',
      env: {
        ...process.env,
        SANDO_MODE: name === 'claude' ? 'apply' : 'observe',
        SANDO_METRICS_PATH: path.join(cache, `${name}.metrics.json`),
      },
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    if (name === 'claude') assert.equal(output.hookSpecificOutput.updatedToolOutput, 'cache-ok');
    else assert.deepEqual(output, {});
    assert.ok(fs.existsSync(path.join(cache, `${name}.metrics.json`)));
  }
});

test('copied bundles expose a standalone JSON metrics report launcher', (t) => {
  const cache = fs.mkdtempSync('/tmp/sando-report-cache-');
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  for (const [name, hookRelative] of [
    ['plugin', 'hooks/post-tool-use.mjs'],
    ['claude', 'hooks/post-tool-use.mjs'],
    ['codex', 'hooks/post-tool-use.mjs'],
  ]) {
    const source = path.join(root, name === 'plugin' ? 'plugins/sando' : `adapters/${name}/sando`);
    const destination = path.join(cache, name);
    fs.cpSync(source, destination, { recursive: true });
    const storagePath = path.join(cache, `${name}.json`);
    const event = {
      hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'reportable',
      cwd: destination, event_id: `${name}-event`, session_id: `${name}-session`,
    };
    const hook = spawnSync(process.execPath, [path.join(destination, hookRelative)], {
      input: JSON.stringify(event), encoding: 'utf8',
      env: { ...process.env, SANDO_MODE: 'observe', SANDO_METRICS_PATH: storagePath },
    });
    assert.equal(hook.status, 0, `${name}: ${hook.stderr}`);
    const report = spawnSync(process.execPath, [path.join(destination, 'metrics.mjs'), '--json', '--path', storagePath], {
      encoding: 'utf8', env: { ...process.env, SANDO_METRICS_PATH: storagePath },
    });
    assert.equal(report.status, 0, `${name}: ${report.stderr}`);
    const json = JSON.parse(report.stdout);
    assert.equal(json.schema, 'sando-report/v1');
    assert.equal(json.cumulative.eventCount, 1);
    assert.equal(json.currentSession.id, `${name}-session`);
  }
});

test('Codex and Claude manifests keep hooks in companion files', () => {
  const codex = json('plugins/sando/.codex-plugin/plugin.json');
  assert.equal(codex.name, 'sando');
  assert.equal(Object.hasOwn(codex, 'hooks'), false);
  assert.equal(codex.mcpServers, './.mcp.json');
  const claude = json('adapters/claude/sando/.claude-plugin/plugin.json');
  assert.equal(claude.name, 'sando');
  for (const file of [
    'plugins/sando/hooks/hooks.json',
    'adapters/claude/sando/hooks/hooks.json',
    'adapters/codex/sando/hooks/hooks.json',
  ]) assert.ok(json(file).hooks.PostToolUse.length > 0);
});

test('Codex MCP config resolves its server from the installed plugin root', () => {
  const config = json('plugins/sando/.mcp.json');
  const server = config.mcpServers.sando;
  assert.deepEqual(server.args, ['mcp/server.mjs']);
  assert.equal(server.cwd, '.');
  assert.ok(fs.existsSync(path.resolve(root, 'plugins/sando', server.cwd, server.args[0])));
});

test('public adapter and plugin text uses neutral branding', () => {
  for (const file of [
    'plugins/sando/.codex-plugin/plugin.json',
    'plugins/sando/README.md',
    'adapters/claude/sando/.claude-plugin/plugin.json',
    'adapters/claude/sando/README.md',
    'adapters/codex/sando/README.md',
  ]) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(content, /Sando|sando/);
  }
});

test('PostToolUse hook is fail-open except for invalid policy input', () => {
  const hook = path.join(root, 'plugins/sando/hooks/post-tool-use.mjs');
  const valid = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'ok', cwd: root }),
    encoding: 'utf8', env: { ...process.env, SANDO_MODE: 'observe' },
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), {});

  const malformed = spawnSync(process.execPath, [hook], { input: '{', encoding: 'utf8' });
  assert.equal(malformed.status, 0);
  assert.deepEqual(JSON.parse(malformed.stdout), {});

  const invalidPolicy = spawnSync(process.execPath, [hook], {
    input: '{}', encoding: 'utf8', env: { ...process.env, SANDO_POLICY: '{"mode":"unsafe"}' },
  });
  assert.equal(invalidPolicy.status, 2);
});

test('Claude apply updates tool output and persists bounded artifacts', (t) => {
  const cwd = fs.mkdtempSync('/tmp/sando-claude-');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const hook = path.join(root, 'adapters/claude/sando/hooks/post-tool-use.mjs');
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'secret=hidden\n' + 'x'.repeat(600), cwd,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      SANDO_POLICY: JSON.stringify({ mode: 'apply', maxInlineBytes: 256, maxArtifactBytes: 320, redact: true }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(output.hookSpecificOutput.updatedToolOutput, /\.sando\/sando\/artifacts\/[^\s]+\.txt/);
  assert.equal(output.hookSpecificOutput.updatedToolOutput.includes('hidden'), false);
  const relative = output.hookSpecificOutput.updatedToolOutput.match(/\.sando\/sando\/artifacts\/[^\s]+\.txt/)[0];
  const artifact = path.join(cwd, relative);
  assert.ok(fs.statSync(artifact).isFile());
  assert.ok(fs.statSync(artifact).size > 320);
  assert.equal(fs.statSync(artifact).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(artifact, 'utf8'), `secret=[REDACTED]\n${'x'.repeat(600)}`);
});

test('Claude apply preserves the shape of oversized Bash output', (t) => {
  const cwd = fs.mkdtempSync('/tmp/sando-claude-bash-');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const hook = path.join(root, 'adapters/claude/sando/hooks/post-tool-use.mjs');
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_response: { stdout: 'secret=hidden\n' + 'x'.repeat(600), stderr: '', interrupted: false, isImage: false }, cwd,
    }),
    encoding: 'utf8',
    env: { ...process.env, SANDO_POLICY: JSON.stringify({ mode: 'apply', maxInlineBytes: 256, maxArtifactBytes: 320, redact: true }) },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).hookSpecificOutput.updatedToolOutput;
  assert.equal(typeof output, 'object');
  assert.equal(typeof output.stdout, 'string');
  assert.equal(output.stderr, '');
  assert.equal(output.isImage, false);
  assert.equal(output.stdout.includes('hidden'), false);
});

test('Codex fallback emits feedback and continue false, never a transparent rewrite', () => {
  const hook = path.join(root, 'adapters/codex/sando/hooks/post-tool-use.mjs');
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'codex fallback', cwd: root }),
    encoding: 'utf8',
    env: {
      ...process.env,
      SANDO_POLICY: JSON.stringify({ mode: 'apply' }),
      SANDO_CODEX_FALLBACK: 'feedback',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, false);
  assert.match(output.stopReason, /fallback/i);
  assert.match(output.systemMessage, /not rewritten/i);
  assert.equal(Object.hasOwn(output, 'updatedToolOutput'), false);
});

test('MCP server exposes bounded read, grep, and sandboxed exec tools', async (t) => {
  const server = spawn(process.execPath, [path.join(root, 'plugins/sando/mcp/server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());
  let buffer = '';
  const messages = [];
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  const request = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
  request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'prepare_tool_output', arguments: { toolName: 'Read', output: 'ok', cwd: root } } });
  request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'sando_read', arguments: { path: 'packages/sando/package.json', cwd: root } } });
  request({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'sando_grep', arguments: { pattern: 'sando', path: 'packages/sando/package.json', cwd: root } } });

  const deadline = Date.now() + 2_000;
  while (messages.length < 5 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(messages.length, 5);
  assert.equal(messages[0].result.serverInfo.name, 'sando');
  assert.deepEqual(messages[1].result.tools.map((tool) => tool.name), ['prepare_tool_output', 'sando_read', 'sando_grep', 'sando_exec']);
  assert.ok(messages[1].result.tools.slice(0, 3).every((tool) => tool.annotations.readOnlyHint));
  assert.equal(messages[1].result.tools[3].name, 'sando_exec');
  assert.equal(messages[1].result.tools[3].annotations.readOnlyHint, false);
  assert.equal(messages[2].result.structuredContent.inline, 'ok');
  assert.match(messages[3].result.structuredContent.inline, /\"name\"/);
  assert.match(messages[4].result.structuredContent.inline, /package\.json:/);
});
