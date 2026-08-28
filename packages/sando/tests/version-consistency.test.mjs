import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const VERSION_SOURCES = [
  ['package.json', ['version']],
  ['packages/sando/package.json', ['version']],
  ['adapters/claude/sando/.claude-plugin/plugin.json', ['version']],
  ['adapters/claude/sando/.claude-plugin/marketplace.json', ['plugins', 0, 'version']],
  ['plugins/sando/.codex-plugin/plugin.json', ['version']],
  ['plugins/sando/.agents/plugins/marketplace.json', ['metadata', 'version']],
];

function readField(relativePath, fieldPath) {
  return fieldPath.reduce((value, key) => value[key], JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8')));
}

test('all local Sando release metadata uses the package version', () => {
  const [canonicalPath, canonicalField] = VERSION_SOURCES[1];
  const canonical = readField(canonicalPath, canonicalField);
  const observed = VERSION_SOURCES.map(([relativePath, fieldPath]) => ({
    path: relativePath,
    version: readField(relativePath, fieldPath),
  }));

  assert.deepEqual(observed, observed.map((entry) => ({ ...entry, version: canonical })));
});

test('telemetry entrypoints use the shared runtime version module', () => {
  const entrypoints = [
    'packages/sando/src/hook-cli.mjs',
    'packages/sando/src/proxy.mjs',
    'packages/sando/src/session-start.mjs',
    'adapters/claude/sando/lib/session-start.mjs',
    'adapters/codex/sando/lib/session-start.mjs',
    'plugins/sando/lib/session-start.mjs',
    'packages/sando/src/mcp-server.mjs',
    'adapters/claude/sando/lib/mcp-server.mjs',
    'adapters/claude/sando/lib/mcp-entry.mjs',
    'adapters/codex/sando/lib/mcp-server.mjs',
    'adapters/codex/sando/lib/mcp-entry.mjs',
    'plugins/sando/lib/mcp-server.mjs',
    'plugins/sando/lib/mcp-entry.mjs',
  ];

  for (const relativePath of entrypoints) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.match(source, /from ['"]\.\/version\.mjs['"]/);
    assert.doesNotMatch(source, /PLUGIN_VERSION\s*=\s*['"]/);
  }
});
