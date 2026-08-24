import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const hook = path.join(root, 'hooks/provider-usage.mjs');

test('standalone Codex Stop hook records usage', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-adapter-usage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, 'transcript.jsonl');
  const storagePath = path.join(directory, 'provider-usage.json');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'turn.completed', turn_id: 'turn-1', timestamp: '2026-08-24T10:00:00.000Z',
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  })}\n`);
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath }),
    encoding: 'utf8', env: { ...process.env, SANDO_PROVIDER_USAGE_PATH: storagePath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(JSON.parse(fs.readFileSync(storagePath, 'utf8')).records.length, 1);
});
