import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  F2_AUTOMATION_SCHEMA,
  runF2Automation,
  runF2AutomationCli,
} from '../src/instruction-plan-automation.mjs';

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

function fixtureProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-f2-auto-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), [
    '# Project policy',
    '',
    'Never deploy without explicit user confirmation.',
    '',
    'For test workflows, run npm test before handoff.',
    '',
  ].join('\n'));
  return root;
}

function statePath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-f2-auto-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'automation.json');
}

test('records a content-free summary for a real instruction plan', (t) => {
  const root = fixtureProject(t);
  const storagePath = statePath(t);
  const result = runF2Automation({
    roots: [root],
    statePath: storagePath,
    now: new Date('2026-08-31T12:00:00.000Z'),
    sandoVersion: 'test-version',
  });

  assert.equal(result.schema, F2_AUTOMATION_SCHEMA);
  assert.equal(result.results[0].status, 'recorded');
  assert.equal(result.state.records.length, 1);
  assert.equal(result.state.runs.length, 1);
  assert.equal(result.state.runs[0].results[0].status, 'recorded');
  assert.equal(result.state.records[0].sandoVersion, 'test-version');
  assert.ok(result.state.records[0].summary.proposedBytes > 0);
  assert.equal(Object.hasOwn(result.state.records[0], 'report'), false);
  assert.doesNotMatch(fs.readFileSync(storagePath, 'utf8'), /For test workflows/);
  assert.equal(fs.statSync(path.dirname(storagePath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600);
});

test('deduplicates unchanged fingerprints and records a numeric delta after a change', (t) => {
  const root = fixtureProject(t);
  const storagePath = statePath(t);
  const first = runF2Automation({ roots: [root], statePath: storagePath, now: new Date('2026-08-31T12:00:00.000Z') });
  const unchanged = runF2Automation({ roots: [root], statePath: storagePath, now: new Date('2026-09-01T12:00:00.000Z') });

  assert.equal(first.results[0].status, 'recorded');
  assert.equal(unchanged.results[0].status, 'unchanged');
  assert.equal(unchanged.state.records.length, 1);
  assert.equal(unchanged.state.runs.length, 2);
  assert.equal(unchanged.state.runs[1].results[0].status, 'unchanged');

  fs.appendFileSync(path.join(root, 'AGENTS.md'), '\nFor release checks, run npm run check.\n');
  const changed = runF2Automation({ roots: [root], statePath: storagePath, now: new Date('2026-09-02T12:00:00.000Z') });

  assert.equal(changed.results[0].status, 'recorded');
  assert.equal(changed.state.records.length, 2);
  assert.notEqual(changed.state.records[0].fingerprint, changed.state.records[1].fingerprint);
  assert.ok(changed.state.records[1].delta.instructionBytes > 0);
});

test('persists negative deltas when a project shrinks and remains readable', (t) => {
  const root = fixtureProject(t);
  const storagePath = statePath(t);
  runF2Automation({ roots: [root], statePath: storagePath, now: new Date('2026-08-31T12:00:00.000Z') });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Never deploy without explicit user confirmation.\n');

  const reduced = runF2Automation({ roots: [root], statePath: storagePath, now: new Date('2026-09-01T12:00:00.000Z') });
  const later = runF2Automation({ roots: [root], statePath: storagePath, now: new Date('2026-09-02T12:00:00.000Z') });

  assert.ok(reduced.state.records[1].delta.instructionBytes < 0);
  assert.equal(later.results[0].status, 'unchanged');
});

test('reports a root error without aborting the automation batch', (t) => {
  const storagePath = statePath(t);
  const result = runF2Automation({
    roots: ['/tmp/sando-f2-auto-root-that-does-not-exist'],
    statePath: storagePath,
  });

  assert.equal(result.results[0].status, 'error');
  assert.match(result.results[0].error, /root|directory|ENOENT/i);
  assert.equal(result.state.runs.length, 1);
  assert.equal(result.state.runs[0].results[0].errorKind, 'missing-root');
});

test('CLI accepts repeated roots, JSON output, and force snapshots', (t) => {
  const root = fixtureProject(t);
  const storagePath = statePath(t);
  const output = streams();
  const first = runF2AutomationCli({
    argv: ['--root', root, '--state', storagePath, '--json'],
    stdout: output.stdout,
    stderr: output.stderr,
  });

  assert.equal(output.stderrText, '');
  assert.equal(JSON.parse(output.stdoutText).results[0].status, 'recorded');
  assert.equal(first.results[0].status, 'recorded');

  const forced = runF2AutomationCli({
    argv: ['--root', root, '--state', storagePath, '--force'],
    stdout: output.stdout,
    stderr: output.stderr,
  });
  assert.equal(forced.results[0].status, 'recorded');
});
