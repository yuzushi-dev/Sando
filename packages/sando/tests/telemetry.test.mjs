import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countBucket, byteBucket, closeDay, coverageRatioBucket, recordCoverage, COVERAGE_REASONS,
  FAILURE_STAGES, isDoNotTrack, serializeEvent, validateEvent,
} from '../src/telemetry.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_VERSION } from '../src/version.mjs';

function hookEvent(overrides = {}) {
  return {
    schema_version: 2,
    event: 'hook_summary',
    day_utc: '2026-08-25',
    plugin_version: PLUGIN_VERSION,
    host: 'claude',
    mode: 'enforce',
    tool_calls_bucket: '6_to_20',
    capped_outputs_bucket: 'zero',
    bytes_saved_bucket: '16_to_64k',
    input_tokens_saved_bucket: '4_to_16k',
    ...overrides,
  };
}

function proxyEvent(overrides = {}) {
  return {
    schema_version: 2,
    event: 'proxy_summary',
    day_utc: '2026-08-25',
    plugin_version: PLUGIN_VERSION,
    provider: 'openai',
    mode: 'enforce',
    rewrites_applied_bucket: '2_to_5',
    rewrites_skipped_cache_bucket: 'one',
    input_tokens_saved_bucket: '16_to_64k',
    ...overrides,
  };
}

test('countBucket maps counts to the fixed enum', () => {
  assert.equal(countBucket(0), 'zero');
  assert.equal(countBucket(1), 'one');
  assert.equal(countBucket(2), '2_to_5');
  assert.equal(countBucket(5), '2_to_5');
  assert.equal(countBucket(6), '6_to_20');
  assert.equal(countBucket(20), '6_to_20');
  assert.equal(countBucket(21), '21_to_100');
  assert.equal(countBucket(100), '21_to_100');
  assert.equal(countBucket(101), 'gt_100');
  assert.throws(() => countBucket(-1), /invalid/);
  assert.throws(() => countBucket(1.5), /invalid/);
});

test('byteBucket maps byte counts to the fixed enum', () => {
  assert.equal(byteBucket(0), 'lt_4k');
  assert.equal(byteBucket(4095), 'lt_4k');
  assert.equal(byteBucket(4096), '4_to_16k');
  assert.equal(byteBucket(16384), '16_to_64k');
  assert.equal(byteBucket(65536), '64_to_256k');
  assert.equal(byteBucket(262144), '256k_to_1m');
  assert.equal(byteBucket(1048576), 'gte_1m');
  assert.throws(() => byteBucket(-1), /invalid/);
});

test('DO_NOT_TRACK treats only non-empty values other than 0 as enabled', () => {
  assert.equal(isDoNotTrack({}), false);
  assert.equal(isDoNotTrack({ DO_NOT_TRACK: '' }), false);
  assert.equal(isDoNotTrack({ DO_NOT_TRACK: '0' }), false);
  assert.equal(isDoNotTrack({ DO_NOT_TRACK: '1' }), true);
});

test('validateEvent accepts a well-formed hook_summary event', () => {
  assert.doesNotThrow(() => validateEvent(hookEvent()));
});

test('validateEvent accepts a well-formed proxy_summary event', () => {
  assert.doesNotThrow(() => validateEvent(proxyEvent()));
});

test('validateEvent accepts failure summaries and the dry_run mode', () => {
  assert.equal(FAILURE_STAGES.length, 8);
  assert.doesNotThrow(() => validateEvent({
    schema_version: 2, event: 'hook_failure_summary', day_utc: '2026-08-25', plugin_version: PLUGIN_VERSION,
    host: 'codex', failure_stage: 'input',
  }));
  assert.doesNotThrow(() => validateEvent({
    schema_version: 2, event: 'proxy_failure_summary', day_utc: '2026-08-25', plugin_version: PLUGIN_VERSION,
    provider: 'unknown', failure_stage: 'input',
  }));
  assert.doesNotThrow(() => validateEvent(hookEvent({ mode: 'dry_run' })));
});

test('validateEvent accepts the privacy-preserving active_day marker', () => {
  assert.doesNotThrow(() => validateEvent({
    schema_version: 2, event: 'active_day', day_utc: '2026-08-25', plugin_version: PLUGIN_VERSION, host: 'claude',
  }));
});

test('validateEvent rejects an unknown event type', () => {
  assert.throws(() => validateEvent(hookEvent({ event: 'operation_summary' })), /event/);
});

test('validateEvent rejects an unknown enum value', () => {
  assert.throws(() => validateEvent(hookEvent({ host: 'gemini' })), /host/);
  assert.throws(() => validateEvent(hookEvent({ mode: 'apply' })), /mode/);
  assert.throws(() => validateEvent(hookEvent({ redactions_bucket: 'one' })), /unknown field/);
  assert.throws(() => validateEvent(proxyEvent({ provider: 'claude' })), /provider/);
  assert.throws(() => validateEvent(proxyEvent({ host: 'claude' })), /unknown field/);
  assert.throws(() => validateEvent(proxyEvent({ prompt_cache_hit: 'yes' })), /unknown field/);
});

test('validateEvent rejects unknown fields', () => {
  assert.throws(() => validateEvent(hookEvent({ session_id: 'abc' })), /unknown field/);
});

test('validateEvent rejects fields mixed across event shapes', () => {
  assert.throws(() => validateEvent(hookEvent({ rewrites_applied_bucket: 'one' })), /unknown field/);
});

test('validateEvent rejects nested objects and arrays', () => {
  assert.throws(() => validateEvent(hookEvent({ plugin_version: { major: 0, minor: 5 } })), /plugin_version/);
  assert.throws(() => validateEvent(hookEvent({ tool_calls_bucket: ['zero'] })), /tool_calls_bucket/);
});

test('validateEvent rejects strings over 32 characters', () => {
  assert.throws(() => validateEvent(hookEvent({ plugin_version: PLUGIN_VERSION.padEnd(33, '0') })), /plugin_version/);
});

test('validateEvent accepts stable patch plugin versions and rejects prereleases', () => {
  assert.doesNotThrow(() => validateEvent(hookEvent({ plugin_version: '0.5.1' })));
  assert.throws(() => validateEvent(hookEvent({ plugin_version: '0.5.0-rc1' })), /plugin_version/);
  assert.throws(() => validateEvent(hookEvent({ plugin_version: '0.5.x' })), /plugin_version/);
});

test('validateEvent rejects a day_utc with a time component', () => {
  assert.throws(() => validateEvent(hookEvent({ day_utc: '2026-08-25T00:00:00Z' })), /day_utc/);
});

test('serializeEvent produces a payload at most 2 KiB and round-trips through validateEvent', () => {
  const event = hookEvent();
  const serialized = serializeEvent(event);
  assert.ok(Buffer.byteLength(serialized) <= 2048);
  assert.doesNotThrow(() => validateEvent(JSON.parse(serialized)));
});

test('serializeEvent rejects an event that fails validation', () => {
  assert.throws(() => serializeEvent(hookEvent({ host: 'gemini' })), /host/);
});

// A day that bounds heavily on the few commands it recognises produces the same reduction buckets
// as a day that bounds everything. Without the ratio the two are indistinguishable on the wire,
// which is how a 2.8% coverage went unnoticed while the reduction numbers looked healthy.
test('coverage ratio separates a day that reached almost nothing from one that reached almost all', () => {
  assert.equal(coverageRatioBucket(1276, 1276 + 43945), '1_to_10pct');
  assert.equal(coverageRatioBucket(43945, 1276 + 43945), 'gt_90pct');
  assert.equal(coverageRatioBucket(0, 500), 'zero');
  assert.equal(coverageRatioBucket(0, 0), 'zero');
  assert.equal(coverageRatioBucket(4, 1000), 'lt_1pct');
  assert.equal(coverageRatioBucket(300, 1000), '10_to_50pct');
  assert.equal(coverageRatioBucket(700, 1000), '50_to_90pct');
  assert.throws(() => coverageRatioBucket(5, 1), /invalid counts/);
  assert.throws(() => coverageRatioBucket(-1, 10), /invalid counts/);
});

test('coverage counters close into one row that carries the share, not just the counts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-coverage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePaths = { counters: path.join(dir, 'counters.json'), queue: path.join(dir, 'queue.jsonl') };

  for (let i = 0; i < 3; i += 1) recordCoverage({ statePaths, day: '2026-09-13', host: 'codex', routed: true });
  for (let i = 0; i < 60; i += 1) recordCoverage({ statePaths, day: '2026-09-13', host: 'codex', routed: false, reason: 'ambiguous-shell' });
  for (let i = 0; i < 20; i += 1) recordCoverage({ statePaths, day: '2026-09-13', host: 'codex', routed: false, reason: 'compound-feeds-pipeline' });
  recordCoverage({ statePaths, day: '2026-09-13', host: 'codex', routed: false, reason: 'a-reason-this-build-never-heard-of' });

  const [row, ...rest] = closeDay({ statePaths, day: '2026-09-13', pluginVersion: '0.5.0' });
  assert.equal(rest.length, 0, 'one row per day and host');
  assert.equal(row.coverage_ratio_bucket, '1_to_10pct');
  assert.equal(row.top_bypass_reason, 'ambiguous-shell');
  assert.ok(COVERAGE_REASONS.includes(row.top_bypass_reason));
  assert.deepEqual(validateEvent(row), row);
  assert.deepEqual(Object.keys(row).sort(), [
    'bypassed_bucket', 'coverage_ratio_bucket', 'day_utc', 'event', 'host',
    'plugin_version', 'routed_bucket', 'schema_version', 'top_bypass_reason',
  ]);
});

test('an unknown bypass reason is reported as other, never as free text', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-coverage-unknown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePaths = { counters: path.join(dir, 'counters.json'), queue: path.join(dir, 'queue.jsonl') };
  recordCoverage({ statePaths, day: '2026-09-14', host: 'codex', routed: false, reason: 'invented-by-a-later-build' });
  const [row] = closeDay({ statePaths, day: '2026-09-14', pluginVersion: '0.5.0' });
  assert.equal(row.top_bypass_reason, 'other');
  assert.equal(JSON.stringify(row).includes('invented-by-a-later-build'), false);
});
