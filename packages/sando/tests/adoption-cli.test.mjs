import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAdoptionCli } from '../src/adoption-cli.mjs';

function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-adoption-cli-')); return { XDG_CONFIG_HOME: `${root}/config`, XDG_STATE_HOME: `${root}/state` }; }
function io() { let stdout = ''; let stderr = ''; return { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, get stdoutText() { return stdout; }, get stderrText() { return stderr; } }; }

test('CLI enable explains persistent pseudonym and respects injected DNT', async () => {
  const env = fixture(); const output = io();
  const blocked = await runAdoptionCli({ argv: ['enable'], env: { ...env, DO_NOT_TRACK: '1' }, interactive: true, prompt: async () => { throw new Error('must not prompt'); }, ...output });
  assert.equal(blocked.exitCode, 1);
  const result = await runAdoptionCli({ argv: ['enable'], env, interactive: true, prompt: async (message) => { assert.match(message, /persistent.*ID/i); assert.match(message, /395 days/i); return 'yes'; }, ...output });
  assert.equal(result.enabled, true); assert.match(output.stdoutText, /adoption enabled/);
  const dntZero = fixture(); const zero = await runAdoptionCli({ argv: ['enable'], env: { ...dntZero, DO_NOT_TRACK: '0' }, interactive: true, prompt: async () => 'yes', ...io() });
  assert.equal(zero.enabled, true);
});

test('CLI flush passes injected DNT and invalid commands return nonzero', async () => {
  const env = fixture(); const output = io();
  const invalid = await runAdoptionCli({ argv: ['wat'], env, ...output, interactive: false });
  assert.equal(invalid.exitCode, 1);
  const blocked = await runAdoptionCli({ argv: ['flush'], env: { ...env, DO_NOT_TRACK: '1' }, ...output });
  assert.equal(blocked.sent, 0);
});
