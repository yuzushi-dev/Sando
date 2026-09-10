import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const directories = {
  package: ['packages/sando/tests'],
  bundles: ['adapters/claude/sando/tests', 'adapters/codex/sando/tests', 'plugins/sando/tests'],
}[process.argv[2]];

if (!directories) throw new Error('usage: node scripts/test-suite.mjs package|bundles');

const files = directories.flatMap((directory) => fs.readdirSync(path.join(root, directory))
  .filter((file) => file.endsWith('.test.mjs'))
  .sort()
  .map((file) => path.join(root, directory, file)));
const xdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-test-xdg-'));
let result;
try {
  result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: root,
    env: {
      ...process.env,
      DO_NOT_TRACK: '0',
      XDG_CONFIG_HOME: path.join(xdgRoot, 'config'),
      XDG_STATE_HOME: path.join(xdgRoot, 'state'),
    },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(xdgRoot, { recursive: true, force: true });
}
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
