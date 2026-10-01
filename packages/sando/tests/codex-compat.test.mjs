import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CANDIDATE_VERSIONS,
  createIsolatedEnvironment,
  runCompatibilityCheck,
  runHookFixture,
  runShellFixture,
} from '../../../scripts/verify-codex-compat.mjs';
import { prepareSubscriptionEnvironment } from '../../../scripts/codex-subscription-contract.mjs';

const fixtureRoot = path.join(import.meta.dirname, 'codex-compat');
const hookFixtures = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'pre-tool-use.synthetic.json'), 'utf8'));
const shellFixtures = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'shell-cases.synthetic.json'), 'utf8'));
const loopbackCapture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'pre-tool-use.codex-0.159.2.loopback-capture.json'), 'utf8'));

test('Codex compatibility fixtures are explicitly synthetic', () => {
  assert.equal(hookFixtures.provenance, 'synthetic');
  assert.equal(shellFixtures.provenance, 'synthetic');
  assert.match(hookFixtures.notice, /not captures/i);
  assert.match(shellFixtures.notice, /not live Codex evidence/i);
  const stdin = shellFixtures.cases.find((fixture) => fixture.id === 'stdin');
  assert.equal(stdin.stdin, 'input value\n');
  assert.equal(stdin.expectedStdout, 'got:input value\n');
  const signal = shellFixtures.cases.find((fixture) => fixture.id === 'signal');
  assert.equal(signal.signal, 'SIGTERM');
});

test('real Codex loopback capture stays labeled and satisfies the local rewrite contract', (t) => {
  assert.equal(loopbackCapture.provenance, 'real-codex-client-with-synthetic-loopback-provider');
  assert.equal(loopbackCapture.authenticated_provider, false);
  assert.equal(loopbackCapture.hook_trust_bypass, true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-capture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = {
    id: 'codex-0.159.2-loopback-capture',
    input: { ...loopbackCapture.input, cwd: root },
    expected: { kind: 'rewrite', hookEventName: 'PreToolUse' },
  };
  assert.equal(runHookFixture(fixture, root).status, 'passed');
});

test('isolated runner environment is built from an allowlist', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = createIsolatedEnvironment(root, {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    OPENAI_API_KEY: 'must-not-leak',
    CODEX_HOME: '/real/codex/home',
    AWS_SECRET_ACCESS_KEY: 'must-not-leak',
  });

  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.HOME, path.join(root, 'home'));
  assert.equal(env.CODEX_HOME, path.join(root, 'codex'));
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
});

test('synthetic hook payloads satisfy the local PreToolUse contract', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-hook-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const fixture of hookFixtures.cases) {
    const result = runHookFixture(fixture, root);
    assert.equal(result.status, 'passed', `${fixture.id}: ${result.detail}`);
  }
});

test('native and routed shell fixtures preserve declared semantics', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-shell-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const fixture of shellFixtures.cases) {
    const result = runShellFixture(fixture, root);
    assert.equal(result.status, 'passed', `${fixture.id}: ${result.detail}`);
  }
});

test('compatibility report never turns a binary version probe into live proof', () => {
  const report = runCompatibilityCheck({ probe: { command: '/fixture/codex', version: '0.159.2' } });
  assert.equal(report.offline.status, 'passed');
  assert.deepEqual(CANDIDATE_VERSIONS, ['0.159.2', '0.153.4']);
  assert.deepEqual(report.candidates.map(({ version, status }) => [version, status]), [
    ['0.159.2', 'not-run'],
    ['0.153.4', 'not-run'],
  ]);
  assert.equal(report.detectedCodex.liveCompatibilityProof, false);
  assert.equal(report.codexBundle.algorithm, 'sha256-tree-v1');
  assert.ok(report.codexBundle.fileCount > 3);
  assert.match(report.codexBundle.sha256, /^[a-f0-9]{64}$/);
  assert.match(report.candidates[0].reason, /authenticated live proof/i);
});

test('loopback client evidence remains distinct from authenticated provider compatibility', () => {
  const loopbackEvidence = {
    status: 'passed',
    codexVersion: '0.159.2',
    provider: 'synthetic-loopback',
    assertions: { startupObserved: true, rewrittenCommandConsumed: true, executionCount: 1 },
  };
  const report = runCompatibilityCheck({
    probe: { command: '/fixture/codex', version: '0.159.2' },
    loopbackEvidence,
  });
  assert.deepEqual(report.loopbackClient, loopbackEvidence);
  assert.equal(report.candidates[0].status, 'not-run');
  assert.equal(report.candidates[0].authenticatedProvider, 'not-run');
  assert.equal(report.candidates[0].syntheticLoopback, 'passed');
  assert.equal(report.clientBoundary.find(({ scenario }) => scenario === 'startup').status, 'passed');
  assert.equal(report.clientBoundary.find(({ scenario }) => scenario === 'approval-denial').status, 'not-run');
});

test('subscription environment does not inherit API keys and removes its auth copy', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-subscription-helper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const auth = path.join(root, 'auth.json');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  fs.writeFileSync(auth, JSON.stringify({
    auth_mode: 'chatgpt', tokens: { access_token: `e30.${payload}.signature`, refresh_token: 'synthetic' },
    last_refresh: new Date().toISOString(), OPENAI_API_KEY: null, ignored: 'must-not-copy',
  }));
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-must-not-leak';
  try {
    const prepared = await prepareSubscriptionEnvironment({ workspace, arm: 'control', sourceAuthPath: auth });
    assert.equal(prepared.env.OPENAI_API_KEY, undefined);
    assert.equal(fs.existsSync(path.join(prepared.env.CODEX_HOME, 'hooks.json')), false);
    assert.equal(fs.existsSync(prepared.hookLog), false);
    const copied = path.join(prepared.env.CODEX_HOME, 'auth.json');
    assert.equal(fs.existsSync(copied), true);
    const copiedAuth = JSON.parse(fs.readFileSync(copied, 'utf8'));
    assert.deepEqual(Object.keys(copiedAuth).sort(), ['auth_mode', 'last_refresh', 'tokens']);
    assert.equal(prepared.credentialValues().includes('synthetic'), true);
    fs.writeFileSync(copied, JSON.stringify({
      ...copiedAuth, tokens: { ...copiedAuth.tokens, refresh_token: 'rotated-synthetic' },
    }));
    assert.equal(prepared.credentialValues().includes('synthetic'), true);
    assert.equal(prepared.credentialValues().includes('rotated-synthetic'), true);
    fs.writeFileSync(copied, '{"access_token":"credential-fragment"');
    assert.throws(() => prepared.credentialValues(), (error) => {
      assert.equal(error.code, 'AUTH_CREDENTIAL_CAPTURE_FAILED');
      assert.equal(error.message.includes('credential-fragment'), false);
      return true;
    });
    fs.writeFileSync(copied, '{}');
    assert.throws(() => prepared.credentialValues(), { code: 'AUTH_CREDENTIAL_CAPTURE_FAILED' });
    prepared.cleanup();
    assert.equal(fs.existsSync(copied), false);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('subscription preparation rejects missing or insufficient JWT expiry', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-subscription-expiry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const auth = path.join(root, 'auth.json');
  fs.writeFileSync(auth, '{"auth_mode":"chatgpt","tokens":{"access_token":"invalid"}}');
  await assert.rejects(prepareSubscriptionEnvironment({ workspace, arm: 'control', sourceAuthPath: auth }), /expiry/i);
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: `e30.${payload}.signature` } }));
  await assert.rejects(prepareSubscriptionEnvironment({ workspace, arm: 'control', sourceAuthPath: auth, minAuthValidityMs: 120_000 }), /expires too soon/i);
});

test('subscription preparation removes temporary state after an auth-copy failure', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-subscription-workspace-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('sando-codex-subscription-')));
  await assert.rejects(prepareSubscriptionEnvironment({ workspace, arm: 'control', sourceAuthPath: path.join(workspace, 'missing-auth.json') }));
  const malformed = path.join(workspace, 'malformed-auth.json');
  fs.writeFileSync(malformed, '{"access_token":"source-credential-fragment"');
  await assert.rejects(
    prepareSubscriptionEnvironment({ workspace, arm: 'control', sourceAuthPath: malformed }),
    (error) => error.code === 'SUBSCRIPTION_AUTH_INVALID'
      && !error.message.includes('source-credential-fragment'),
  );
  const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('sando-codex-subscription-'));
  assert.deepEqual(after.filter((name) => !before.has(name)), []);
});
