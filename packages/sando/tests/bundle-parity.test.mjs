import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SOURCE = path.join(ROOT, 'packages/sando/src');
const BUNDLES = [
  'adapters/claude/sando/lib',
  'adapters/codex/sando/lib',
  'plugins/sando/lib',
].map((directory) => path.join(ROOT, directory));

test('standalone bundles match canonical routing metadata and behavior', async () => {
  const modules = await Promise.all([SOURCE, ...BUNDLES].map((directory) => import(pathToFileURL(path.join(directory, 'core.mjs')))));
  const input = {
    toolName: 'Read', output: `${'const value = 1;\n'.repeat(180)}`, cwd: '/work',
    lineCount: 180, fileBytes: 180 * 17,
  };
  const expected = modules[0].optimizeToolOutput(input);

  for (const module of modules.slice(1)) assert.deepEqual(module.optimizeToolOutput(input), expected);
});

test('generated bundle core, routing, session, and statusline files match canonical sources', async () => {
  for (const file of ['core.mjs', 'routing.mjs', 'active-session.mjs', 'statusline.mjs', 'provider-usage.mjs', 'telemetry.mjs', 'telemetry-cli.mjs', 'telemetry-flush-entry.mjs', 'session-start.mjs']) {
    const expected = await fs.readFile(path.join(SOURCE, file), 'utf8');
    for (const directory of BUNDLES) assert.equal(await fs.readFile(path.join(directory, file), 'utf8'), expected);
  }
});
