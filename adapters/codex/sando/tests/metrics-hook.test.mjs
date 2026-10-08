import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const hooks = [
  path.join(root, 'hooks/post-tool-use.mjs'),
  path.resolve(root, '../../../plugins/sando/hooks/post-tool-use.mjs'),
];

for (const hook of hooks) {
  test(`Codex hook appends metrics without reading history: ${hook}`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-metrics-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const metricsPath = path.join(directory, 'metrics.json');
    const snapshot = Buffer.from(`${JSON.stringify({
      schema: 'sando-metrics/v1', version: 1, timezone: 'UTC', records: [],
    }, null, 2)}\n`);
    fs.writeFileSync(metricsPath, snapshot, { mode: 0o600 });
    const runner = path.join(directory, 'run-hook.mjs');
    fs.writeFileSync(runner, `
      import fs from 'node:fs';
      const originalReadFileSync = fs.readFileSync;
      fs.readFileSync = function (file, ...args) {
        if (String(file) === process.env.SANDO_METRICS_PATH) throw new Error('full metrics read');
        return originalReadFileSync.call(this, file, ...args);
      };
      await import(${JSON.stringify(pathToFileURL(hook).href)});
    `);
    const result = spawnSync(process.execPath, [runner], {
      cwd: directory,
      input: JSON.stringify({
        hook_event_name: 'PostToolUse', event_id: 'codex-fast-metrics', tool_name: 'Read',
        tool_response: 'small output', cwd: directory,
      }),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SANDO_METRICS_PATH: metricsPath,
        DO_NOT_TRACK: '1',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(metricsPath), snapshot);
    const lines = fs.readFileSync(`${metricsPath}.journal`, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).host, 'codex');
  });
}
