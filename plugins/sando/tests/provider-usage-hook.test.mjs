import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const hook = path.join(root, 'hooks/provider-usage.mjs');

test('Codex Stop hook records transcript usage once', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-usage-hook-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'event_msg', timestamp: '2026-08-24T10:00:00.000Z', payload: {
      type: 'token_count', info: { last_token_usage: {
        input_tokens: 90, cached_input_tokens: 30, output_tokens: 7, total_tokens: 97,
      } },
    },
  })}\n`);
  const storagePath = path.join(directory, 'provider-usage.json');
  const input = {
    hook_event_name: 'Stop', session_id: 'codex-session', turn_id: 'turn-1', transcript_path: transcriptPath,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify(input), encoding: 'utf8',
      env: {
        ...process.env,
        SANDO_PROVIDER_USAGE_PATH: storagePath,
        SANDO_ADAPTIVE_ARM: 'apply',
        SANDO_ADAPTIVE_EXPERIMENT: 'hook-fixture',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
  const state = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].host, 'codex');
  assert.equal(state.records[0].arm, 'apply');
  assert.equal(state.records[0].experimentId, 'hook-fixture');
});
