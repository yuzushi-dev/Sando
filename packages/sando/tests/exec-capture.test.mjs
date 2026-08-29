import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { captureProcess, textOrBinary } from '../src/exec-capture.mjs';

test('captures stdout and stderr independently without stopping a capped child', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('x'.repeat(1000)); setTimeout(() => process.stderr.write('stderr-marker'), 10)"], {
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = await captureProcess(child, { maxBytes: 16, timeoutMs: 1000 });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutBytes, 16);
  assert.equal(result.stderr.toString(), 'stderr-marker');
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, false);
});

test('truncated UTF-8 output keeps the valid prefix', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('x'.repeat(255) + '€')"], {
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = await captureProcess(child, { maxBytes: 256, timeoutMs: 1000 });
  const decoded = textOrBinary(result.stdout, { truncated: result.stdoutTruncated });

  assert.equal(result.stdoutTruncated, true);
  assert.equal(decoded.binary, false);
  assert.equal(decoded.utf8Truncated, true);
  assert.equal(decoded.text, 'x'.repeat(255));
});

test('timeout escalates a child that ignores SIGTERM', async () => {
  const child = spawn('sh', ['-c', "trap '' TERM; while :; do :; done"], {
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = await captureProcess(child, { maxBytes: 16, timeoutMs: 30 });

  assert.equal(result.timedOut, true);
  assert.equal(result.exitSignal, 'SIGKILL');
});
