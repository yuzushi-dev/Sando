import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runInstructionPlanCli } from '../src/instruction-plan-cli.mjs';

const ROOT = path.join(import.meta.dirname, 'fixtures/instructions');
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');

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

test('instruction plan CLI emits JSON without raw block content', () => {
  const output = streams();
  const report = runInstructionPlanCli({
    argv: ['context', 'plan-instructions', '--root', ROOT, '--host', 'both', '--json'],
    stdout: output.stdout,
    stderr: output.stderr,
  });
  assert.equal(output.stderrText, '');
  const parsed = JSON.parse(output.stdoutText);
  assert.equal(parsed.provenanceDigest, report.provenanceDigest);
  assert.ok(parsed.proposals.every((proposal) => !Object.hasOwn(proposal.diff.remove, 'content')
    && !Object.hasOwn(proposal.diff.add, 'content')));
  assert.doesNotMatch(output.stdoutText, /For test workflows/);
});

test('instruction plan CLI is preview-only and rejects --apply without writing', () => {
  const output = streams();
  const before = fs.readdirSync(ROOT, { recursive: true }).sort();
  const previousExitCode = process.exitCode;
  try {
    const report = runInstructionPlanCli({
      argv: ['--root', ROOT, '--apply'], stdout: output.stdout, stderr: output.stderr,
    });
    assert.equal(report, null);
    assert.equal(process.exitCode, 2);
    assert.match(output.stderrText, /apply|preview/i);
    assert.deepEqual(fs.readdirSync(ROOT, { recursive: true }).sort(), before);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('installed bundle launchers expose instruction planning', () => {
  for (const launcher of [
    'plugins/sando/bin/sando',
    'adapters/codex/sando/bin/sando',
    'adapters/claude/sando/instruction-plan.mjs',
  ]) {
    const isModule = launcher.endsWith('.mjs');
    const command = isModule ? process.execPath : path.join(REPOSITORY_ROOT, launcher);
    const args = isModule
      ? [path.join(REPOSITORY_ROOT, launcher), 'context', 'plan-instructions']
      : ['context', 'plan-instructions'];
    args.push('--root', ROOT, '--host', 'claude', '--json');
    const result = spawnSync(command, args, {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: { ...process.env, SANDO_POLICY: '{invalid' },
    });
    assert.equal(result.status, 0, `${launcher}: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).schema, 'sando-instruction-plan/v1');
  }
});
