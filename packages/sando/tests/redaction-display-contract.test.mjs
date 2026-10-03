import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ADAPTER = path.resolve(import.meta.dirname, '../../../adapters/codex/sando/cli.mjs');
const MCP_SERVER = path.resolve(import.meta.dirname, '../../../adapters/codex/sando/mcp/server.mjs');
const NOTICE = '[sando] display redacted; Sando did not sanitize source files';
const VALUES = ['alpha-secret', 'synthetic-bearer-value', 'synthetic-api-value'];

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function runAdapter(args, cwd, maxInlineBytes = 4096) {
  return spawnSync(process.execPath, [ADAPTER, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      DO_NOT_TRACK: '1',
      SANDO_POLICY: JSON.stringify({ mode: 'apply', maxInlineBytes, redact: true }),
    },
  });
}

function verifyFile(target) {
  const script = `
    const fs = require('node:fs');
    const text = fs.readFileSync(process.argv[1], 'utf8');
    const values = JSON.parse(process.argv[2]);
    process.stdout.write(JSON.stringify({
      originalValuesPresent: values.filter((value) => text.includes(value)).length,
      placeholderCount: (text.match(/\\[REDACTED(?: [^\\]]+)?\\]/g) || []).length,
      bytes: Buffer.byteLength(text),
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script, target, JSON.stringify(VALUES)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const long of [false, true]) test(`Codex adapter distinguishes masked reads from sanitized filesystem bytes (${long ? 'artifact' : 'inline'})`, (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-redaction-contract-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const source = [
    `password=${VALUES[0]}`,
    `Authorization: Bearer ${VALUES[1]}`,
    `api_key=${VALUES[2]}`,
  ].join('\n') + (long ? '\nsafe diagnostic line\n'.repeat(600) : '');
  const rawPath = path.join(cwd, 'raw.log');
  const copiedPath = path.join(cwd, 'copied.log');
  const sanitizedPath = path.join(cwd, 'sanitized.log');
  fs.writeFileSync(rawPath, source);
  const sourceHash = hash(fs.readFileSync(rawPath));

  const displayed = runAdapter(['read', '--', 'raw.log'], cwd);
  assert.equal(displayed.status, 0, displayed.stderr);
  assert.doesNotMatch(displayed.stdout, new RegExp(VALUES.join('|')));
  assert.match(displayed.stdout, new RegExp(`${NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`));
  assert.equal(hash(fs.readFileSync(rawPath)), sourceHash);
  if (long) assert.match(displayed.stdout, /\[sando\] artifact /);

  const copyScript = 'require("node:fs").copyFileSync(process.argv[1], process.argv[2])';
  const copied = runAdapter(['exec', '--', process.execPath, '-e', copyScript, rawPath, copiedPath], cwd);
  assert.equal(copied.status, 0, copied.stderr);
  const maskedCopy = runAdapter(['read', '--', 'copied.log'], cwd);
  assert.doesNotMatch(maskedCopy.stdout, new RegExp(VALUES.join('|')));
  assert.deepEqual(verifyFile(copiedPath), {
    originalValuesPresent: 3, placeholderCount: 0, bytes: Buffer.byteLength(source),
  });

  const sanitizeScript = `
    const fs = require('node:fs');
    const input = fs.readFileSync(process.argv[1], 'utf8');
    const values = JSON.parse(process.argv[3]);
    fs.writeFileSync(process.argv[2], values.reduce((text, value) => text.replaceAll(value, '[REDACTED]'), input));
  `;
  const sanitized = runAdapter([
    'exec', '--', process.execPath, '-e', sanitizeScript,
    rawPath, sanitizedPath, JSON.stringify(VALUES),
  ], cwd);
  assert.equal(sanitized.status, 0, sanitized.stderr);
  assert.deepEqual(verifyFile(sanitizedPath), {
    originalValuesPresent: 0, placeholderCount: 3,
    bytes: Buffer.byteLength(source) - VALUES.reduce((sum, value) => sum + Buffer.byteLength(value), 0) + (3 * Buffer.byteLength('[REDACTED]')),
  });
  assert.equal(hash(fs.readFileSync(rawPath)), sourceHash);
});

test('Codex adapter keeps disclosure last for artifact-routed masked reads', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-redaction-artifact-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'long.log'), [
    `password=${VALUES[0]}`,
    'safe diagnostic line\n'.repeat(600),
    `api_key=${VALUES[2]}`,
  ].join('\n'));

  const displayed = runAdapter(['read', '--', 'long.log'], cwd, 512);
  assert.equal(displayed.status, 0, displayed.stderr);
  assert.doesNotMatch(displayed.stdout, new RegExp(VALUES.join('|')));
  assert.match(displayed.stdout, /\[sando\] artifact \.sando\/sando\/artifacts\/[a-f0-9]+\.txt/);
  assert.match(displayed.stdout, new RegExp(`${NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`));
  assert.equal((displayed.stdout.match(/\[sando\] display redacted/g) ?? []).length, 1);
});

test('bounded MCP envelopes preserve display-redaction disclosure and recovery metadata', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-redaction-mcp-envelope-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'long.log'), [
    `password=${VALUES[0]}`,
    `Authorization: Bearer ${VALUES[1]}`,
    'safe diagnostic line\n'.repeat(600),
    `api_key=${VALUES[2]}`,
  ].join('\n'));
  const maxEnvelopeBytes = 3_200;
  const request = {
    jsonrpc: '2.0', id: 'redaction-envelope', method: 'tools/call', params: {
      name: 'sando_read', arguments: {
        path: 'long.log', cwd,
        policy: { maxInlineBytes: 900, maxArtifactBytes: 32_768, maxEnvelopeBytes, redact: true },
      },
    },
  };
  const result = spawnSync(process.execPath, [MCP_SERVER], { input: Buffer.from(`${JSON.stringify(request)}\n`) });
  assert.equal(result.status, 0, result.stderr.toString('utf8'));
  assert.ok(result.stdout.length <= maxEnvelopeBytes, `${result.stdout.length} exceeds ${maxEnvelopeBytes}`);
  const message = JSON.parse(result.stdout.toString('utf8'));
  const exposed = message.result.structuredContent;
  assert.equal(message.result.isError, false);
  assert.equal(message.result.content[0].text, exposed.inline);
  assert.doesNotMatch(result.stdout.toString('utf8'), new RegExp(VALUES.join('|')));
  assert.match(exposed.inline, new RegExp(`${NOTICE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  assert.equal(exposed.disclosure.redaction.scope, 'display');
  assert.equal(exposed.disclosure.redaction.sourceModifiedBySando, false);
  assert.match(exposed.artifact.ref, /^sando:sha256:/);
});
