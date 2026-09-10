import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  codexSandboxKey,
  spawnCodexSandboxedProcess,
} from '../../../adapters/codex/sando/lib/mcp-tools.mjs';

function sandboxMeta(root, writable = true) {
  return {
    'codex/sandbox-state-meta': {
      sandboxCwd: pathToFileURL(root).href,
      codexLinuxSandboxExe: null,
      permissionProfile: {
        type: 'managed',
        file_system: { type: 'restricted', entries: [
          { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
          { path: { type: 'special', value: { kind: 'project_roots' } }, access: writable ? 'write' : 'read' },
        ] },
        network: 'restricted',
      },
      useLegacyLandlock: false,
    },
  };
}

test('Codex Slice child is launched through the managed sandbox without a shell', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-slice-codex-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let invocation;
  const child = { marker: true };
  const actual = spawnCodexSandboxedProcess({
    command: '/tmp/slice-backend',
    args: [project, '--mcp'],
    cwd: project,
    meta: sandboxMeta(root),
    spawnImpl(command, args, options) { invocation = { command, args, options }; return child; },
  });

  assert.equal(actual, child);
  assert.deepEqual(invocation.args.slice(0, 2), ['sandbox', '--sandbox-state-json']);
  assert.equal(invocation.args[3], '--');
  assert.deepEqual(invocation.args.slice(4), ['/tmp/slice-backend', project, '--mcp']);
  assert.equal(invocation.options.cwd, project);
  assert.equal(invocation.args.includes('/bin/sh'), false);
});

test('Codex Slice sandbox rejects missing metadata and roots outside sandbox cwd', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-slice-codex-reject-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => codexSandboxKey(), /requires Codex sandbox metadata/);
  assert.throws(() => spawnCodexSandboxedProcess({
    command: '/tmp/slice-backend', args: ['/tmp/outside', '--mcp'], cwd: '/tmp', meta: sandboxMeta(root), spawnImpl() {},
  }), /cwd escapes sandbox cwd/);
});

test('Codex Slice process identity changes with sandbox permissions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-slice-codex-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.notEqual(codexSandboxKey(sandboxMeta(root)), codexSandboxKey(sandboxMeta(root, false)));
});
