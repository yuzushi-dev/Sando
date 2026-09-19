import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  defaultAdoptionConfigPath, defaultAdoptionStatePath, enableAdoption, disableAdoption,
  readAdoptionConfig, recordAdoption, toAdoptionOtlp, flushAdoptionQueue, scheduleAdoptionFlush,
} from '../src/adoption.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-adoption-'));
  const env = { XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state') };
  return { env, configPath: defaultAdoptionConfigPath(env), statePath: defaultAdoptionStatePath(env) };
}
const TEST_DAY = new Date(Date.now() - 2 * 86_400_000);
TEST_DAY.setUTCHours(10, 0, 0, 0);
function observed(hours = 0, milliseconds = 0) { return new Date(TEST_DAY.getTime() + hours * 3_600_000 + milliseconds).toISOString(); }

test('adoption defaults off and core consent is insufficient', () => {
  const { env, configPath, statePath } = fixture();
  assert.equal(readAdoptionConfig(configPath).enabled, false);
  assert.equal(recordAdoption({ env, host: 'claude', pluginVersion: '0.6.1', observedAt: observed() }), false);
  assert.equal(fs.existsSync(statePath), false);
});

test('explicit consent creates per-host stable UUIDs and day/version markers', () => {
  const { env, configPath, statePath } = fixture();
  enableAdoption({ configPath, answer: 'yes', now: () => new Date(TEST_DAY) });
  assert.equal(recordAdoption({ env, host: 'claude', pluginVersion: '0.6.1', observedAt: observed() }), true);
  assert.equal(recordAdoption({ env, host: 'claude', pluginVersion: '0.6.1', observedAt: observed(1) }), false);
  assert.equal(recordAdoption({ env, host: 'claude', pluginVersion: '0.6.2', observedAt: observed(2) }), true);
  assert.equal(recordAdoption({ env, host: 'codex', pluginVersion: '0.6.1', observedAt: observed(2) }), true);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.queue.length, 3);
  assert.notEqual(state.identities.claude, state.identities.codex);
  assert.match(state.identities.claude, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(state.queue[0]._timeUnixNano, String(BigInt(TEST_DAY.getTime()) * 1_000_000n));
});

test('version transitions emit A to B to A once each', () => {
  const { env, configPath, statePath } = fixture();
  enableAdoption({ configPath, answer: 'yes' });
  for (const [pluginVersion, observedAt] of [['0.6.1', observed()], ['0.6.2', observed(1)], ['0.6.1', observed(2)]]) {
    assert.equal(recordAdoption({ env, host: 'claude', pluginVersion, observedAt }), true);
  }
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).queue.length, 3);
});

test('malformed adoption state fails closed', () => {
  const { env, configPath, statePath } = fixture();
  enableAdoption({ configPath, answer: 'yes' });
  fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, '{"schema_version":99}');
  assert.throws(() => recordAdoption({ env, host: 'claude', pluginVersion: '0.6.1' }), /state is invalid/);
});

test('uses the bounded backend-compatible version grammar and rejects future observations', () => {
  const { env, configPath } = fixture(); enableAdoption({ configPath, answer: 'yes' });
  assert.equal(recordAdoption({ env, host: 'claude', pluginVersion: '0.6.1-jev', observedAt: new Date() }), true);
  assert.throws(() => recordAdoption({ env, host: 'codex', pluginVersion: '1.2', observedAt: new Date() }), /plugin version/);
  assert.throws(() => recordAdoption({ env, host: 'omp', pluginVersion: '01.2.3', observedAt: new Date() }), /plugin version/);
  assert.throws(() => recordAdoption({ env, host: 'omp', pluginVersion: '0.6.1', observedAt: new Date(Date.now() + 6 * 60_000) }), /future/);
});

test('disable clears adoption identity and queue; DNT blocks recording', () => {
  const { env, configPath, statePath } = fixture();
  enableAdoption({ configPath, answer: 'yes' });
  recordAdoption({ env, host: 'claude', pluginVersion: '0.6.1' });
  disableAdoption({ configPath, statePath });
  assert.equal(readAdoptionConfig(configPath).enabled, false);
  assert.equal(fs.existsSync(statePath), false);
  enableAdoption({ configPath, answer: 'yes' });
  assert.equal(recordAdoption({ env: { ...env, DO_NOT_TRACK: '1' }, host: 'claude', pluginVersion: '0.6.1' }), false);
});

test('OTLP has exact adoption resource, body, seven attributes and original time', () => {
  const { env, configPath } = fixture();
  enableAdoption({ configPath, answer: 'yes' });
  recordAdoption({ env, host: 'omp', pluginVersion: '0.6.1', observedAt: observed(0, 123) });
  const state = JSON.parse(fs.readFileSync(defaultAdoptionStatePath(env), 'utf8'));
  const payload = toAdoptionOtlp(state.queue);
  const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.deepEqual(payload.resourceLogs[0].resource.attributes, [{ key: 'service.name', value: { stringValue: 'sando-adoption' } }]);
  assert.deepEqual(payload.resourceLogs[0].scopeLogs[0].scope, {});
  assert.equal(record.body.stringValue, 'sando.installation_activity');
  assert.equal(record.attributes.length, 7);
  assert.equal(record.timeUnixNano, String(BigInt(TEST_DAY.getTime() + 123) * 1_000_000n));
});

test('flush rechecks consent and rejects redirects', async () => {
  const { env, configPath, statePath } = fixture();
  enableAdoption({ configPath, answer: 'yes' });
  recordAdoption({ env, host: 'claude', pluginVersion: '0.6.1' });
  const calls = [];
  const result = await flushAdoptionQueue({ configPath, statePath, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, headers: { get: () => null } };
  }, endpoint: 'http://127.0.0.1:4318/v1/logs' });
  assert.equal(result.sent, 1);
  assert.equal(calls[0].options.redirect, 'error');
  disableAdoption({ configPath, statePath });
  assert.equal((await flushAdoptionQueue({ configPath, statePath, fetchImpl: async () => { throw new Error('must not send'); } })).sent, 0);
});

test('flush sends exact payload to a private loopback receiver', async () => {
  const { env, configPath, statePath } = fixture(); enableAdoption({ configPath, answer: 'yes' });
  recordAdoption({ env, host: 'claude', pluginVersion: '0.6.1', observedAt: observed() });
  let body;
  const server = http.createServer((request, response) => { const chunks = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => { body = JSON.parse(Buffer.concat(chunks)); response.end('ok'); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    assert.equal((await flushAdoptionQueue({ configPath, statePath, endpoint: `http://127.0.0.1:${port}/v1/logs` })).sent, 1);
    assert.equal(body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.length, 7);
  } finally { server.close(); }
});

test('detached flush scheduling uses a file path and persists a throttle', () => {
  const { env, configPath, statePath } = fixture(); enableAdoption({ configPath, answer: 'yes' });
  recordAdoption({ env, host: 'claude', pluginVersion: '0.6.1' });
  const calls = [];
  const spawnImpl = (...args) => { calls.push(args); return { unref() {} }; };
  assert.equal(scheduleAdoptionFlush({ env, configPath, statePath, spawnImpl }), true);
  assert.equal(scheduleAdoptionFlush({ env, configPath, statePath, spawnImpl }), false);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], process.execPath); assert.equal(calls[0][1][0].startsWith('file:'), false);
});

test('consent generation change stops retry and preserves the reset queue', async () => {
  const { env, configPath, statePath } = fixture(); enableAdoption({ configPath, answer: 'yes' });
  recordAdoption({ env, host: 'claude', pluginVersion: '0.6.1' });
  let calls = 0;
  const result = await flushAdoptionQueue({ configPath, statePath, endpoint: 'http://127.0.0.1:4318/v1/logs', sleep: async () => {}, fetchImpl: async () => {
    calls += 1; disableAdoption({ configPath, statePath }); enableAdoption({ configPath, answer: 'yes' }); recordAdoption({ env, host: 'claude', pluginVersion: '0.6.2' });
    return { ok: false, status: 503, headers: { get: () => null } };
  } });
  assert.equal(result.sent, 0); assert.equal(calls, 1);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')); assert.equal(state.queue.length, 1); assert.equal(state.queue[0].plugin_version, '0.6.2');
});

test('consent generation changes with an identical consent clock', async () => {
  const { env, configPath, statePath } = fixture(); const fixedNow = () => new Date(TEST_DAY);
  enableAdoption({ configPath, answer: 'yes', now: fixedNow }); recordAdoption({ env, host: 'claude', pluginVersion: '0.6.1' }); let calls = 0;
  const result = await flushAdoptionQueue({ configPath, statePath, endpoint: 'http://127.0.0.1:4318/v1/logs', sleep: async () => {}, fetchImpl: async () => { calls += 1; disableAdoption({ configPath, statePath }); enableAdoption({ configPath, answer: 'yes', now: fixedNow }); recordAdoption({ env, host: 'claude', pluginVersion: '0.6.2' }); return { ok: false, status: 503, headers: { get: () => null } }; } });
  assert.equal(result.sent, 0); assert.equal(calls, 1); assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).queue[0].plugin_version, '0.6.2');
});
