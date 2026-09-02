import assert from 'node:assert/strict';
import test from 'node:test';

import { countBucket, byteBucket, FAILURE_STAGES, isDoNotTrack, serializeEvent, validateEvent } from '../src/telemetry.mjs';
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
