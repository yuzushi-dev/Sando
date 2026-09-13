import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('standalone proxy rejects a relative archive root before listening', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../../plugins/sando/proxy.mjs', import.meta.url))], {
    env: {
      PATH: process.env.PATH,
      SANDO_UPSTREAM_URL: 'http://127.0.0.1:1',
      SANDO_PROXY_TRANSFORM: '1',
      SANDO_HISTORY_ARCHIVE_ROOT: 'relative-archive',
      SANDO_CONTEXT_POLICY: JSON.stringify({ strategies: { recoverableArchive: true } }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; child.kill('SIGTERM'); });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(() => clearTimeout(timer));
  assert.equal(stdout, '', 'unsafe archive configuration must not start the listener');
  assert.equal(code, 2);
  assert.match(stderr, /archive.*(?:absolute|invalid)|absolute.*archive/i);
});
