import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { probeCodexCapabilities } from '../lib/codex-capabilities.mjs';

test('Codex probe marks tool-output replacement as unavailable', () => {
  const result = probeCodexCapabilities({
    version: 'codex-cli 0.149.0',
    help: 'Commands: mcp Manage external MCP servers for Codex\nplugin Manage Codex plugins',
    mcpHelp: 'Manage external MCP servers for Codex',
    features: 'hooks stable true',
  });

  assert.equal(result.schema, 'sando-codex-capabilities/v1');
  assert.equal(result.mcp.available, true);
  assert.equal(result.mcp.displacesBuiltIns, false);
  assert.deepEqual(result.preToolUse, { available: true, canRewriteInput: true, canRewriteToolOutput: false });
  assert.deepEqual(result.cliRouting, { available: true, routes: ['literal-read', 'literal-grep'], transparent: true });
  assert.deepEqual(result.postToolUse, { available: true, observational: true, feedbackFallback: true, canRewriteToolOutput: false });
  assert.equal(result.preModelToolOutputReplacement, false);
  assert.equal(result.providerSavings, false);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.wrapperMcpTools, { Read: 'impossible', Grep: 'impossible', Bash: 'impossible' });
});

test('bundled capability probes report the same truthful boundary', () => {
  for (const file of ['../capability-probe.mjs', '../../../adapters/codex/sando/capability-probe.mjs']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const probe = JSON.parse(result.stdout);
    assert.equal(probe.preModelToolOutputReplacement, false);
    assert.equal(probe.providerSavings, false);
    assert.equal(probe.status, 'partial');
    assert.deepEqual(probe.cliRouting, { available: true, routes: ['literal-read', 'literal-grep'], transparent: true });
    assert.deepEqual(probe.wrapperMcpTools, { Read: 'impossible', Grep: 'impossible', Bash: 'impossible' });
  }
});
