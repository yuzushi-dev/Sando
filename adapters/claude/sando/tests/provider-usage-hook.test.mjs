import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const hook = path.join(root, 'hooks/provider-usage.mjs');

function run(hookInput, directory) {
  const storagePath = path.join(directory, 'provider-usage.json');
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(hookInput), encoding: 'utf8',
    env: { ...process.env, SANDO_PROVIDER_USAGE_PATH: storagePath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  return JSON.parse(fs.readFileSync(storagePath, 'utf8'));
}

test('Claude Stop hook records transcript usage once', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-usage-hook-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'assistant', uuid: 'assistant-1', timestamp: '2026-08-24T10:00:00.000Z',
    message: { usage: { input_tokens: 100, cache_read_input_tokens: 30, output_tokens: 7 } },
  })}\n`);
  const input = {
    hook_event_name: 'Stop', session_id: 'claude-session', turn_id: 'turn-1', transcript_path: transcriptPath,
  };
  const first = run(input, directory);
  const second = run(input, directory);
  assert.equal(first.records.length, 1);
  assert.deepEqual(second.records, first.records);
  assert.equal(second.records[0].host, 'claude');
});
