import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureDeliveryEvidence,
  captureRecoveryDeliveryEvidence,
  codexIdentity,
  createBoundedCapture,
  runCodeModeRecoveryContract,
  runLoopbackCodexContract,
  runMcpHostContract,
  startAppServer,
} from '../../../scripts/codex-loopback-contract.mjs';
import { validateOutputContractReport } from '../../../scripts/verify-codex-compat.mjs';
import { buildCodexFallback } from '../src/hook-cli.mjs';

const fixture = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, 'codex-compat/mcp-output.synthetic.json'),
  'utf8',
));

test('MCP output contract fixture is synthetic and contains discriminating markers', () => {
  assert.equal(fixture.provenance, 'synthetic');
  assert.equal(fixture.result.structuredContent.count, 3);
  assert.match(fixture.result.content[0].text, new RegExp(fixture.rawMarker));
  assert.match(fixture.result.structuredContent.label, new RegExp(fixture.rawMarker));
  assert.notEqual(fixture.rawMarker, fixture.replacementMarker);
  assert.deepEqual(Object.keys(fixture.promiseMarkers).sort(), ['rejected', 'resolved', 'withheld']);
  assert.equal(buildCodexFallback({
    optimization: { artifact: null, stats: { redactions: 0 } },
    cwd: '/synthetic',
  }).stopReason, fixture.fallbackMarker);
});

test('delivery evidence hashes actual non-canonical HTTP bytes and locates the exact controlled string span', () => {
  const raw = Buffer.from(`{\n  "input" : [ { "output" : "${fixture.rawMarker}   spaced" } ],\n  "model" : "fixture"\n}\n`);
  const evidence = captureDeliveryEvidence(raw, fixture);
  const canonical = JSON.stringify(JSON.parse(raw));

  assert.equal(evidence.actualBytes, raw.byteLength);
  assert.equal(evidence.sha256, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.notEqual(evidence.sha256, crypto.createHash('sha256').update(canonical).digest('hex'));
  assert.equal(evidence.controlledField.classification, 'raw');
  assert.equal(
    raw.subarray(evidence.controlledField.startByte, evidence.controlledField.endByte).toString('utf8'),
    `"${fixture.rawMarker}   spaced"`,
  );
  assert.equal(
    raw.subarray(evidence.controlledField.startByte, evidence.controlledField.endByte).byteLength,
    evidence.controlledField.byteLength,
  );
  assert.equal(
    crypto.createHash('sha256')
      .update(raw.subarray(evidence.controlledField.startByte, evidence.controlledField.endByte))
      .digest('hex'),
    evidence.controlledField.sha256,
  );
});

test('recovery delivery evidence requires exact text, digest, range, and excludes out-of-range content', () => {
  const expected = {
    content: 'selected redacted line',
    digest: `sha256:${'a'.repeat(64)}`,
    bytes: 22,
    sourceBytes: 900,
    range: { type: 'lines', start: 41, end: 41 },
    outOfRangeMarker: 'SANDO_SYNTHETIC_OUT_OF_RANGE_001',
  };
  const recovery = {
    schema: 'sando-artifact-recovery/v1',
    version: 1,
    handle: `sando:${expected.digest}`,
    digest: expected.digest,
    content: expected.content,
    bytes: expected.bytes,
    sourceBytes: expected.sourceBytes,
    range: expected.range,
    truncated: false,
  };
  const raw = Buffer.from(JSON.stringify({ input: [{ type: 'custom_tool_call_output', output: JSON.stringify(recovery) }] }));

  const exact = captureRecoveryDeliveryEvidence(raw, expected);
  assert.equal(exact.observed, true);
  assert.equal(exact.exactText, true);
  assert.equal(exact.exactDigest, true);
  assert.equal(exact.exactRange, true);
  assert.equal(exact.exactBytes, true);
  assert.equal(exact.outOfRangeMarkerVisible, false);
  assert.equal(exact.satisfied, true);

  const mismatched = captureRecoveryDeliveryEvidence(raw, { ...expected, content: 'different' });
  assert.equal(mismatched.observed, true);
  assert.equal(mismatched.exactText, false);
  assert.equal(mismatched.satisfied, false);
});

test('bounded captures stop retaining bytes at the configured limit without exposing overflow content', () => {
  let overflows = 0;
  const capture = createBoundedCapture(8, () => { overflows += 1; });
  capture.push(Buffer.from('12345678'));
  capture.push(Buffer.from('SECRET_OVERFLOW_VALUE'));
  assert.equal(capture.overflow, true);
  assert.equal(capture.bytes, 8);
  assert.equal(capture.buffer().toString('utf8'), '12345678');
  assert.equal(overflows, 1);
  assert.equal(JSON.stringify(capture.summary()).includes('SECRET_OVERFLOW_VALUE'), false);
});

test('app-server notification retention is sanitized and fails closed at aggregate queue limits', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-app-queue-cap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = 'SANDO_QUEUE_SECRET_001';
  const fake = path.join(root, 'codex');
  fs.writeFileSync(fake, `#!${process.execPath}
process.stdin.once('data', (chunk) => {
  JSON.parse(chunk.toString('utf8').split('\\n')[0]);
  for (let index = 0; index < 12; index += 1) {
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-' + index, secret: ${JSON.stringify(secret)} } } }) + '\\n');
  }
});
`, { mode: 0o700 });
  const app = startAppServer(fake, {
    cwd: root,
    env: process.env,
    limits: { appServerQueueEntries: 3, appServerQueueBytes: 512 },
  });
  const closed = new Promise((resolve) => app.child.once('close', resolve));
  await assert.rejects(app.request('fixture/notifications'), (error) => {
    assert.equal(error.code, 'APP_SERVER_CAPTURE_LIMIT');
    return true;
  });
  await closed;

  assert.ok(app.notifications.length <= 3);
  assert.equal(JSON.stringify(app.notifications).includes(secret), false);
  assert.equal('serverRequests' in app, false);
  const summary = await app.close();
  assert.equal(summary.protocolOverflow, true);
});

test('Codex identity distinguishes wrapper, JavaScript launcher, and native vendor binary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'node_modules/@openai/codex');
  const wrapper = path.join(root, 'codex');
  const launcher = path.join(packageRoot, 'bin/codex.js');
  const native = path.join(packageRoot, 'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(wrapper, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)} "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(launcher, '#!/usr/bin/env node\n// fixture launcher\n', { mode: 0o700 });
  fs.writeFileSync(native, 'fixture native binary\n', { mode: 0o700 });

  const identity = codexIdentity(wrapper, '0.160.0', true);
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.deepEqual(identity, {
    name: 'codex',
    version: '0.160.0',
    available: true,
    wrapperSha256: digest(wrapper),
    launcherSha256: digest(launcher),
    nativeBinarySha256: digest(native),
  });
  assert.equal(new Set([
    identity.wrapperSha256,
    identity.launcherSha256,
    identity.nativeBinarySha256,
  ]).size, 3);
});

test('app-server RPC errors and stderr are reduced to bounded classifications', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-rpc-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = 'SANDO_RPC_SECRET_LIKE_VALUE';
  const fake = path.join(root, 'codex');
  fs.writeFileSync(fake, `#!${process.execPath}
process.stdin.once('data', (chunk) => {
  const message = JSON.parse(chunk.toString('utf8').split('\\n')[0]);
  process.stderr.write(${JSON.stringify(secret)});
  process.stdout.write(JSON.stringify({ id: message.id, error: { code: 500, message: ${JSON.stringify(secret)}, data: ${JSON.stringify(secret)} } }) + '\\n');
});
`, { mode: 0o700 });
  const app = startAppServer(fake, { cwd: root, env: process.env });
  await assert.rejects(app.request('fixture/error'), (error) => {
    assert.equal(error.code, 'APP_SERVER_RPC_FAILED');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  const closed = await app.close();
  assert.equal(JSON.stringify(closed).includes(secret), false);
  assert.equal(closed.stderrObserved, true);
});

test('app-server protocol and stderr overflow closes with bounded evidence', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-app-cap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = 'SANDO_APP_CAPTURE_SECRET';
  const fake = path.join(root, 'codex');
  fs.writeFileSync(fake, `#!${process.execPath}
process.stdin.once('data', () => {
  process.stderr.write(${JSON.stringify(secret)}.repeat(32));
  process.stdout.write(${JSON.stringify(secret)}.repeat(32));
});
`, { mode: 0o700 });
  const app = startAppServer(fake, {
    cwd: root,
    env: process.env,
    limits: { appServerLineBytes: 32, appServerStderrBytes: 32 },
  });
  await assert.rejects(app.request('fixture/overflow'), { code: 'APP_SERVER_CAPTURE_LIMIT' });
  const closed = await app.close();
  assert.equal(closed.protocolOverflow, true);
  assert.equal(closed.stderrOverflow, true);
  assert.equal(JSON.stringify(closed).includes(secret), false);
});

test('missing Codex is a bounded not-run receipt and never leaks spawn text', async () => {
  const leak = 'SANDO_UNAVAILABLE_RAW_LEAK_SENTINEL';
  const report = await runMcpHostContract({ codexPath: `/missing/${leak}/codex` });
  assert.equal(report.status, 'not-run');
  assert.equal(report.client.available, false);
  assert.equal(report.reason, 'codex-binary-unavailable');
  assert.equal(JSON.stringify(report).includes(leak), false);
  assert.doesNotThrow(() => validateOutputContractReport(report));
  const missingReason = structuredClone(report);
  delete missingReason.reason;
  assert.throws(() => validateOutputContractReport(missingReason), /aggregate not-run/);
});

test('Codex capture overflow is failed with bounded process evidence, never not-run', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-capture-overflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = 'SANDO_CAPTURE_OVERFLOW_SECRET';
  const fake = path.join(root, 'codex');
  fs.writeFileSync(fake, `#!${process.execPath}
if (process.argv.includes('--version')) process.stdout.write('codex-cli 0.160.0 ' + ${JSON.stringify(secret)}.repeat(128));
`, { mode: 0o700 });
  const report = await runMcpHostContract({ codexPath: fake, limits: { processStdoutBytes: 32 } });
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'capture-limit-exceeded');
  assert.equal(report.client.available, true);
  for (const receipt of Object.values(report.scenarios)) {
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.reason, 'capture-limit-exceeded');
    assert.equal(receipt.observations.process.termination, 'capture-limit');
  }
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.doesNotThrow(() => validateOutputContractReport(report));
});

test('provider request overflow is failed with bounded receipts', { timeout: 120_000 }, async (t) => {
  const report = await runMcpHostContract({ limits: { providerRequestBytes: 64 } });
  if (report.client.available === false) {
    t.skip(report.reason);
    return;
  }
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'capture-limit-exceeded');
  for (const receipt of Object.values(report.scenarios)) {
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.reason, 'capture-limit-exceeded');
  }
  assert.doesNotThrow(() => validateOutputContractReport(report));
});

test('stock Codex reports fully gated direct MCP, fallback, Code Mode execute/wait, and serialization evidence', { timeout: 120_000 }, async (t) => {
  const report = await runMcpHostContract();
  if (report.status === 'not-run') {
    t.skip(report.reason);
    return;
  }
  assert.doesNotThrow(() => validateOutputContractReport(report));
  assert.equal(report.schema, 'sando-openai-output-contract/v1');
  assert.equal(report.profile, 'full-a1');
  assert.equal(report.reference.commitMatch, 'unknown');
  assert.match(report.client.wrapperSha256, /^[a-f0-9]{64}$/);
  assert.match(report.client.nativeBinarySha256, /^[a-f0-9]{64}$/);
  if (report.client.launcherSha256 === null) {
    assert.equal(report.client.nativeBinarySha256, report.client.wrapperSha256);
  } else {
    assert.match(report.client.launcherSha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(report.authenticatedProvider, false);
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.surfaces, {
    directMcp: 'passed',
    codeModeExecute: 'passed',
    codeModeWait: 'passed',
    serialization: 'passed',
  });

  const {
    directNoHook,
    directCurrentFallback,
    directContinueFalse,
    directBlock,
    codeModeNoHook,
    codeModeExecuteContinueFalse,
    codeModeWaitNoHook,
    codeModeWaitContinueFalse,
    codeModeBlock,
  } = report.scenarios;
  for (const scenario of Object.values(report.scenarios)) {
    assert.equal(scenario.status, 'passed', scenario.scenario.id);
    assert.equal(scenario.observations.executionCount, 1);
    assert.equal(scenario.observations.expectedSatisfied, true);
    assert.match(scenario.delivery.evidenceDigest, /^[a-f0-9]{64}$/);
    assert.ok(scenario.delivery.resultUtf8Bytes > 0);
    assert.notEqual(scenario.delivery.resultUtf8Bytes, scenario.delivery.actualBytes);
    assert.equal(scenario.usage.provider, null);
    assert.equal(scenario.observations.process.exitStatus, 0);
    assert.equal(scenario.observations.process.termination, 'completed');
    assert.equal(scenario.observations.approval.requested, false);
    assert.equal(scenario.observations.cancel.requested, false);
    assert.equal(scenario.recovery.status, 'not-needed');
    assert.equal(scenario.recovery.method, null);
  }
  assert.equal(directNoHook.observations.rawMarkerVisible, true);
  assert.equal(directNoHook.observations.typedValueVisible, true);
  assert.equal(directCurrentFallback.observations.fallbackMarkerVisible, true);
  assert.equal(directCurrentFallback.observations.hookEffect, 'current-fallback');
  assert.equal(directContinueFalse.observations.rawMarkerVisible, false);
  assert.equal(directContinueFalse.observations.replacementMarkerVisible, true);
  assert.equal(directBlock.observations.executionCount, 1);
  assert.equal(directBlock.observations.hookEffect, 'blocked');
  assert.equal(directBlock.observations.rawMarkerVisible, false);
  assert.equal(directBlock.observations.replacementMarkerVisible, true);
  assert.equal(codeModeNoHook.observations.promiseOutcome, 'resolved');
  assert.equal(codeModeNoHook.observations.rawMarkerVisible, true);
  assert.equal(codeModeWaitNoHook.observations.executeWait, 'observed');
  assert.equal(codeModeWaitNoHook.observations.rawMarkerVisible, true);
  assert.equal(codeModeWaitNoHook.observations.isErrorVisible, true);
  assert.equal(codeModeWaitNoHook.delivery.controlledFieldDeltaBytes, 0);

  for (const scenario of [codeModeExecuteContinueFalse, codeModeWaitContinueFalse]) {
    assert.equal(scenario.observations.promiseOutcome, 'resolved');
    assert.equal(scenario.observations.rawMarkerVisible, true);
    assert.equal(scenario.observations.typedValueVisible, true);
    assert.equal(scenario.observations.fallbackMarkerVisible, false);
    assert.equal(scenario.observations.isErrorVisible, true);
    assert.equal(scenario.observations.privateTopMetaVisible, false);
  }
  assert.equal(codeModeWaitContinueFalse.observations.executeWait, 'observed');
  assert.equal(codeModeWaitContinueFalse.delivery.controlledFieldDeltaBytes, 0);
  assert.equal(codeModeBlock.observations.promiseOutcome, 'rejected');
  assert.equal(codeModeBlock.observations.blockBehavior, 'rejected');
  assert.equal(codeModeBlock.observations.rawMarkerVisible, false);
  assert.equal(codeModeBlock.observations.replacementMarkerVisible, false);

  const missing = structuredClone(report);
  delete missing.scenarios.codeModeWaitNoHook;
  assert.throws(() => validateOutputContractReport(missing), /scenario cases/);
  const renamed = structuredClone(report);
  renamed.scenarios.waitControl = renamed.scenarios.codeModeWaitNoHook;
  delete renamed.scenarios.codeModeWaitNoHook;
  assert.throws(() => validateOutputContractReport(renamed), /scenario cases/);

  const serialized = JSON.stringify(report);
  for (const sentinel of [
    fixture.rawMarker,
    fixture.replacementMarker,
    fixture.fallbackMarker,
    ...Object.values(fixture.promiseMarkers),
  ]) assert.equal(serialized.includes(sentinel), false, sentinel);
});

test('--keep retains an empty directory and no raw lifecycle prompt, hook, provider, output, or error text', { timeout: 120_000 }, async (t) => {
  const report = await runLoopbackCodexContract({ keep: true });
  if (report.status === 'not-run') {
    t.skip(report.reason);
    return;
  }
  t.after(() => fs.rmSync(report.root, { recursive: true, force: true }));
  assert.equal(report.status, 'passed');
  assert.deepEqual(fs.readdirSync(report.root), []);
  const serialized = JSON.stringify(report);
  for (const sentinel of ['RUN_CASE', 'MODEL_VISIBLE_TOKEN', 'SANDO_BOUNDED_SENTINEL_001', 'synthetic loopback denial']) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
});

test('real Codex Code Mode recovers the exact redacted artifact line range through the Sando MCP server', { timeout: 120_000 }, async (t) => {
  const report = await runCodeModeRecoveryContract();
  if (report.status === 'not-run') {
    t.skip(report.reason);
    return;
  }

  assert.equal(report.status, 'passed', JSON.stringify(report, null, 2));
  assert.equal(report.client.version, '0.160.0');
  assert.equal(report.provenance.outputTransform, 'real-sando-cli');
  assert.equal(report.provenance.mcpServer, 'real-sando-stdio');
  assert.equal(report.authenticatedProvider, false);
  assert.equal(report.externalNetwork, false);
  assert.equal(report.observations.executionCount, 1);
  assert.equal(report.observations.providerIssuedCount, 1);
  assert.match(report.observations.toolIdentitySha256, /^[a-f0-9]{64}$/u);
  assert.equal(report.observations.delivery.satisfied, true);
  assert.equal(report.observations.delivery.exactText, true);
  assert.equal(report.observations.delivery.exactDigest, true);
  assert.equal(report.observations.delivery.exactRange, true);
  assert.equal(report.observations.delivery.outOfRangeMarkerVisible, false);

  const serialized = JSON.stringify(report);
  for (const sentinel of ['SANDO_SYNTHETIC_OUT_OF_RANGE_001', 'line 320 selected redacted']) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
});

test('Code Mode recovery reports an unavailable client as not-run', async () => {
  const report = await runCodeModeRecoveryContract({
    codexPath: path.join(os.tmpdir(), `missing-codex-recovery-${crypto.randomUUID()}`),
  });
  assert.equal(report.status, 'not-run');
  assert.equal(report.reason, 'codex-binary-unavailable');
  assert.equal(report.client.available, false);
});
