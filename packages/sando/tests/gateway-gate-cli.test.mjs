import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GATE_EVIDENCE_SCHEMA } from '../index.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');

test('gateway gate CLI reports insufficient evidence without writing files or exposing raw fields', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-gateway-gate-'));
  try {
    const input = path.join(directory, 'evidence.json');
    fs.writeFileSync(input, JSON.stringify({
      schema: GATE_EVIDENCE_SCHEMA,
      version: 1,
      hosts: [],
      prompt: 'fixture prompt must not be echoed',
    }));
    const before = fs.readdirSync(directory).sort();
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'packages/sando/src/gateway-gate-cli.mjs'),
      'context', 'gateway-gate', '--input', input, '--json',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'insufficient-evidence');
    assert.doesNotMatch(result.stdout, /fixture prompt/);
    assert.deepEqual(fs.readdirSync(directory).sort(), before);
    for (const launcher of [
      'plugins/sando/bin/sando',
      'adapters/codex/sando/bin/sando',
      'adapters/claude/sando/gateway-gate.mjs',
    ]) {
      const moduleLauncher = launcher.endsWith('.mjs');
      const command = moduleLauncher ? process.execPath : path.join(ROOT, launcher);
      const args = moduleLauncher
        ? [path.join(ROOT, launcher), 'context', 'gateway-gate']
        : ['context', 'gateway-gate'];
      args.push('--input', input, '--json');
      const launched = spawnSync(command, args, {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, SANDO_POLICY: '{invalid' },
      });
      assert.equal(launched.status, 0, `${launcher}: ${launched.stderr}`);
      assert.equal(JSON.parse(launched.stdout).status, 'insufficient-evidence');
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
