import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONTEXT_FOOTPRINT_SCHEMA,
  buildContextFootprintReport,
  detectToolSearchState,
  serializeContextFootprint,
} from '../index.mjs';

const FIXTURE_ROOT = path.join(import.meta.dirname, 'fixtures/context-footprint');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, name), 'utf8'));
}

test('attributes an observed Claude request without exposing content or paths', () => {
  const capture = fixture('claude-anthropic.json');
  const report = buildContextFootprintReport(capture);
  const bodyBytes = Buffer.byteLength(capture.body.content, 'utf8');

  assert.equal(report.schema, CONTEXT_FOOTPRINT_SCHEMA);
  assert.equal(report.host, 'claude');
  assert.equal(report.requestFormat, 'anthropic');
  assert.equal(report.observation.status, 'observed');
  assert.equal(report.attribution.status, 'complete');
  assert.equal(report.attribution.bodyBytes, bodyBytes);
  assert.equal(report.attribution.observedBytes, bodyBytes);
  assert.equal(report.attribution.unknownBytes, 0);
  assert.equal(report.categories['project-instructions'].bytes, Buffer.byteLength(capture.segments[1].content));
  assert.equal(report.tokenAccounting.estimated.source, 'mechanical-estimate');
  assert.equal(report.tokenAccounting.providerReported.inputTokens, 900);
  assert.equal(report.tokenAccounting.providerReported.totalCostUsd, 0.012);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /fixture-secret|private\/project|AGENTS\.md/);
  assert.match(report.provenanceDigest, /^sha256:[a-f0-9]{64}$/);
});

test('supports Claude and Codex capture formats with explicit tool-search states', () => {
  const cases = [
    ['claude-anthropic.json', 'claude', 'anthropic', 'enabled'],
    ['codex-openai-responses.json', 'codex', 'openai-responses', 'disabled'],
    ['codex-cli.json', 'codex', 'codex-cli', 'unavailable'],
  ];

  for (const [name, host, requestFormat, state] of cases) {
    const report = buildContextFootprintReport(fixture(name));
    assert.equal(report.host, host);
    assert.equal(report.requestFormat, requestFormat);
    assert.equal(report.toolSearch.state, state);
  }
});

test('keeps unclassified observed bytes explicit and separate from provider tokens', () => {
  const capture = fixture('codex-openai-responses.json');
  capture.body = { state: 'observed', bytes: Buffer.byteLength(capture.body.content) + 7 };
  delete capture.body.content;
  capture.providerUsage = { inputTokens: 999, outputTokens: 1, totalTokens: 1000 };

  const report = buildContextFootprintReport(capture);

  assert.equal(report.attribution.status, 'partial');
  assert.equal(report.attribution.unknownBytes, 7);
  assert.equal(report.categories.unknown.bytes, 7);
  assert.equal(report.tokenAccounting.providerReported.inputTokens, 999);
  assert.notEqual(report.tokenAccounting.estimated.totalTokens, 999);
});

test('reports unavailable host bodies instead of inventing attribution', () => {
  const report = buildContextFootprintReport({
    schema: 'sando-context-capture/v1', host: 'claude', requestFormat: 'anthropic',
    body: { state: 'unavailable' }, segments: [{ category: 'skills', bytes: 100 }],
    providerUsage: { inputTokens: 1000, outputTokens: 1, totalTokens: 1001 },
  });

  assert.equal(report.observation.status, 'unavailable');
  assert.equal(report.attribution.status, 'unavailable');
  assert.equal(report.attribution.bodyBytes, null);
  assert.equal(report.categories, null);
  assert.equal(report.tokenAccounting.estimated.totalTokens, null);
  assert.equal(report.tokenAccounting.providerReported.inputTokens, 1000);
});

test('allows an unavailable capture to omit an unobservable request format', () => {
  const report = buildContextFootprintReport({
    schema: 'sando-context-capture/v1', host: 'codex', body: { state: 'unavailable' },
  });
  assert.equal(report.requestFormat, null);
});

test('detects all tool-search states and treats ambiguous evidence as indeterminate', () => {
  for (const state of ['enabled', 'disabled', 'unavailable', 'indeterminate']) {
    assert.equal(detectToolSearchState({ state }), state);
  }
  assert.equal(detectToolSearchState({ enabled: true }), 'enabled');
  assert.equal(detectToolSearchState({ enabled: false }), 'disabled');
  assert.equal(detectToolSearchState(undefined), 'indeterminate');
  assert.equal(detectToolSearchState({}), 'indeterminate');

  const capture = fixture('codex-openai-responses.json');
  for (const [evidence, state] of [
    [{ state: 'enabled' }, 'enabled'],
    [{ state: 'disabled' }, 'disabled'],
    [{ state: 'unavailable' }, 'unavailable'],
    [{}, 'indeterminate'],
  ]) {
    capture.toolSearch = evidence;
    assert.equal(buildContextFootprintReport(capture).toolSearch.state, state);
  }
});

test('serializes the same capture deterministically and does not write files', () => {
  const capture = fixture('claude-anthropic.json');
  const first = buildContextFootprintReport(capture);
  const second = buildContextFootprintReport(capture);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-footprint-'));
  try {
    assert.equal(serializeContextFootprint(first), serializeContextFootprint(second));
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects unsupported hosts and impossible attribution sums', () => {
  assert.throws(() => buildContextFootprintReport({
    schema: 'sando-context-capture/v1', host: 'local', requestFormat: 'anthropic',
    body: { state: 'observed', bytes: 1 }, segments: [],
  }), /host/);
  assert.throws(() => buildContextFootprintReport({
    schema: 'sando-context-capture/v1', host: 'claude', requestFormat: 'anthropic',
    body: { state: 'observed', bytes: 1 }, segments: [{ category: 'skills', bytes: 2 }],
  }), /exceed|attribution/i);
});

test('rejects overlapping or fabricated segment content', () => {
  assert.throws(() => buildContextFootprintReport({
    schema: 'sando-context-capture/v1', host: 'claude', requestFormat: 'anthropic',
    body: { state: 'observed', content: 'same' },
    segments: [
      { category: 'host-instructions', content: 'same' },
      { category: 'project-instructions', content: 'same' },
    ],
  }), /segment.*body|overlap|attribution/i);
  assert.throws(() => buildContextFootprintReport({
    schema: 'sando-context-capture/v1', host: 'claude', requestFormat: 'anthropic',
    body: { state: 'observed', content: 'real' },
    segments: [{ category: 'skills', content: 'fake' }],
  }), /segment.*body|attribution/i);
});

test('preserves and validates provider cache-read evidence', () => {
  const base = {
    schema: 'sando-context-capture/v1', host: 'claude', body: { state: 'unavailable' },
  };
  const report = buildContextFootprintReport({
    ...base,
    providerUsage: { inputTokens: 10, cacheReadInputTokens: 3, cacheWriteInputTokens: 2 },
  });
  assert.equal(report.tokenAccounting.providerReported.cacheReadInputTokens, 3);
  assert.throws(() => buildContextFootprintReport({
    ...base,
    providerUsage: { inputTokens: 10, cacheReadInputTokens: 9, cacheWriteInputTokens: 2 },
  }), /cache counters/);
});
