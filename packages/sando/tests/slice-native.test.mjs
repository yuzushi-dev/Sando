import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createSliceBridge } from '../src/slice.mjs';

const binary = process.env.SANDO_SLICE_TEST_BINARY;
const live = { skip: binary ? false : 'set SANDO_SLICE_TEST_BINARY to test a real native backend' };

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-slice-native-'));
  const file = path.join(root, 'sample.mjs');
  fs.writeFileSync(file, 'export function greet(name) { return `Hello ${name}`; }\n\nexport function caller() { return greet("world"); }\n');
  const bridge = createSliceBridge({ env: {
    SANDO_SLICE_BINARY: binary, SANDO_SLICE_ROOT: root, SANDO_SLICE_WRITE: '1',
  } });
  t.after(() => { bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = async (verb, args) => {
    const result = await bridge.call(`sando_slice_${verb}`, args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  return { root, file, call, bridge };
}

test('native Slice replaces the fetched span and inserts after an exported definition', live, async (t) => {
  const { file, call } = workspace(t);
  const found = await call('find_symbol', { symbol: 'greet' });
  const body = await call('fetch_body', { handle: found.symbol.handle });
  const replacement = body.body.replace('Hello', 'Ciao');
  const receipt = await call('replace_symbol_body', { handle: found.symbol.handle, new_body: replacement });
  assert.equal(receipt.applied, 'replace_symbol_body');
  assert.equal(fs.readFileSync(file, 'utf8'), 'export function greet(name) { return `Ciao ${name}`; }\n\nexport function caller() { return greet("world"); }\n');

  const caller = await call('find_symbol', { symbol: 'caller' });
  const inserted = await call('insert_after_symbol', {
    handle: caller.symbol.handle, text: 'export function added() { return 2; }',
  });
  assert.equal(inserted.applied, 'insert_after_symbol');
  assert.match(fs.readFileSync(file, 'utf8'), /export function added\(\)/);
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('native Slice rejects a stale handle without overwriting external changes', live, async (t) => {
  const { file, call, bridge } = workspace(t);
  const found = await call('find_symbol', { symbol: 'greet' });
  fs.appendFileSync(file, '// external change\n');
  const external = fs.readFileSync(file, 'utf8');
  await assert.rejects(bridge.call('sando_slice_replace_symbol_body', {
    handle: found.symbol.handle, new_body: 'function greet() { return 0; }',
  }), /stale edit handle/);
  assert.equal(fs.readFileSync(file, 'utf8'), external);
});

test('native Slice refuses a target replaced by a symlink', live, async (t) => {
  const { root, file, call, bridge } = workspace(t);
  const found = await call('find_symbol', { symbol: 'greet' });
  const original = fs.readFileSync(file, 'utf8');
  const target = path.join(root, 'preserved.txt');
  fs.renameSync(file, target);
  fs.symlinkSync(target, file);
  await assert.rejects(bridge.call('sando_slice_replace_symbol_body', {
    handle: found.symbol.handle, new_body: 'function greet() { return 0; }',
  }));
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});

test('native Slice redacts quoted project credentials without breaking JSON', live, async (t) => {
  const { root, file, bridge } = workspace(t);
  fs.mkdirSync(path.join(root, '.sando'));
  fs.writeFileSync(path.join(root, '.sando/redaction.json'), JSON.stringify({
    schema: 'sando-redaction/v1', rules: [{ type: 'assignment-key', key: 'session_code' }],
  }));
  fs.writeFileSync(file, 'function greet() { const session_code = "private-value"; return session_code; }\n');
  const found = await bridge.call('sando_slice_find_symbol', { symbol: 'greet' });
  const handle = JSON.parse(found.content[0].text).symbol.handle;
  const fetched = await bridge.call('sando_slice_fetch_body', { handle });
  const body = JSON.parse(fetched.content[0].text).body;
  assert.doesNotMatch(JSON.stringify(fetched), /private-value/);
  assert.match(body, /\[REDACTED\]/);
  assert.equal(fetched._sando_redaction.source_round_trip, false);
  await assert.rejects(bridge.call('sando_slice_replace_symbol_body', {
    handle, new_body: body,
  }), /not round-trippable/);
  assert.match(fs.readFileSync(file, 'utf8'), /private-value/);
});
