import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { runContextAuditCli } from '../src/context-audit-cli.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const FIXTURE = path.join(import.meta.dirname, 'fixtures/context-footprint/claude-anthropic.json');

function streams() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; },
  };
}

test('context audit CLI emits the complete report as JSON', () => {
  const output = streams();
  const report = runContextAuditCli({
    argv: ['--host', 'claude', '--input', FIXTURE, '--json'],
    stdout: output.stdout,
    stderr: output.stderr,
  });

  assert.equal(output.stderrText, '');
  assert.equal(JSON.parse(output.stdoutText).provenanceDigest, report.provenanceDigest);
  assert.doesNotMatch(output.stdoutText, /fixture-secret|private\/project/);
});

test('context audit CLI reports unavailable when no capture is supplied', () => {
  const output = streams();
  const report = runContextAuditCli({ argv: ['--host', 'codex'], stdout: output.stdout, stderr: output.stderr });

  assert.equal(report.observation.status, 'unavailable');
  assert.match(output.stdoutText, /unavailable/i);
  assert.equal(output.stderrText, '');
});

test('context audit CLI rejects malformed input without writing files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-context-cli-'));
  const input = path.join(directory, 'capture.json');
  fs.writeFileSync(input, '{');
  const output = streams();
  const previousExitCode = process.exitCode;
  try {
    const report = runContextAuditCli({ argv: ['--host', 'claude', '--input', input], stdout: output.stdout, stderr: output.stderr });
    assert.equal(report, null);
    assert.equal(process.exitCode, 2);
    assert.match(output.stderrText, /invalid JSON|capture/i);
    assert.deepEqual(fs.readdirSync(directory), ['capture.json']);
  } finally {
    process.exitCode = previousExitCode;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('context audit JSON is byte-identical across CLI executions', () => {
  const args = [process.execPath, path.join(ROOT, 'packages/sando/src/context-audit-cli.mjs'), 'context', 'audit', '--host', 'claude', '--input', FIXTURE, '--json'];
  const first = spawnSync(args[0], args.slice(1), { cwd: ROOT, encoding: 'utf8' });
  const second = spawnSync(args[0], args.slice(1), { cwd: ROOT, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
});

test('context audit CLI rejects a capture for a different host', () => {
  const output = streams();
  const previousExitCode = process.exitCode;
  try {
    const report = runContextAuditCli({
      argv: ['--host', 'codex', '--input', FIXTURE], stdout: output.stdout, stderr: output.stderr,
    });
    assert.equal(report, null);
    assert.equal(process.exitCode, 2);
    assert.match(output.stderrText, /host/i);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('installed bundle launchers expose context audit', () => {
  for (const launcher of [
    'plugins/sando/bin/sando',
    'adapters/codex/sando/bin/sando',
    'adapters/claude/sando/context-audit.mjs',
  ]) {
    const result = spawnSync(launcher.endsWith('.mjs') ? process.execPath : path.join(ROOT, launcher), launcher.endsWith('.mjs')
      ? [path.join(ROOT, launcher), 'context', 'audit', '--host', 'claude', '--input', FIXTURE, '--json']
      : ['context', 'audit', '--host', 'claude', '--input', FIXTURE, '--json'], {
      cwd: ROOT, encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${launcher}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).schema, 'sando-context-footprint/v1');
  }
});

test('context audit launcher does not depend on the output policy', () => {
  const launcher = path.join(ROOT, 'plugins/sando/bin/sando');
  const result = spawnSync(launcher, ['context', 'audit', '--host', 'codex'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, SANDO_POLICY: '{invalid' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /body: unavailable/);
});
