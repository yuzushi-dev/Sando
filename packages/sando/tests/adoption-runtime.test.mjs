import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultAdoptionConfigPath, defaultAdoptionStatePath, enableAdoption } from '../src/adoption.mjs';

const hook = new URL('../src/hook-cli.mjs', import.meta.url).href;

async function fixture(t, { enabled = false, dnt = '0' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-adoption-runtime-'));
  const messages = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      messages.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    DO_NOT_TRACK: dnt,
    SANDO_ADOPTION_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/logs`,
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (enabled) enableAdoption({ configPath: defaultAdoptionConfigPath(env), answer: 'yes', interactive: true });
  function run() {
    return execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { runHookCli } from ${JSON.stringify(hook)}; await runHookCli({host:'claude',env:process.env});`], {
      env,
      input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash',
        tool_response: 'synthetic runtime observation', cwd: root }),
      timeout: 10000,
    });
  }
  return { env, messages, run, statePath: defaultAdoptionStatePath(env) };
}

async function eventually(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'detached runtime uploader did not complete');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('real hook uploads adoption independently of core consent and dedupes after ACK', async (t) => {
  const f = await fixture(t, { enabled: true });
  f.run();
  await eventually(() => f.messages.length === 1 && JSON.parse(fs.readFileSync(f.statePath)).queue.length === 0);
  const envelope = f.messages[0];
  assert.deepEqual(envelope.resourceLogs[0].resource.attributes,
    [{ key: 'service.name', value: { stringValue: 'sando-adoption' } }]);
  assert.equal(envelope.resourceLogs[0].scopeLogs[0].logRecords.length, 1);
  assert.equal(fs.existsSync(path.join(f.env.XDG_CONFIG_HOME, 'sando', 'telemetry.json')), false);
  f.run();
  assert.equal(JSON.parse(fs.readFileSync(f.statePath)).queue.length, 0);
  assert.equal(f.messages.length, 1);
});

for (const condition of [{ enabled: false, dnt: '0' }, { enabled: true, dnt: '1' }]) {
  test(`real hook sends nothing with adoption=${condition.enabled}, DNT=${condition.dnt}`, async (t) => {
    const f = await fixture(t, condition);
    f.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.messages.length, 0);
    assert.equal(fs.existsSync(f.statePath), false);
  });
}
