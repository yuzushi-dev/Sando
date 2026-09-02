import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
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
const GENERATED_MODULES = [
  'core.mjs', 'routing.mjs', 'active-session.mjs', 'statusline.mjs', 'metrics.mjs',
  'redaction-profile.mjs', 'redaction-config.mjs', 'secret-redaction.mjs', 'adaptive-control.mjs',
  'paired-accounting.mjs', 'provider-usage.mjs', 'accounting-cli.mjs', 'canary.mjs',
  'context-footprint.mjs', 'context-classifier.mjs', 'context-capture.mjs', 'context-audit-cli.mjs',
  'instruction-plan.mjs', 'instruction-plan-cli.mjs', 'f1-telemetry.mjs', 'f4-telemetry.mjs',
  'result-disclosure.mjs', 'artifact-recovery.mjs', 'artifact-store.mjs', 'artifact-cli.mjs',
  'gateway-gate.mjs', 'gateway-gate-cli.mjs', 'lazy-mcp-gateway.mjs', 'lazy-mcp-gateway-stdio.mjs',
  'history-disclosure.mjs', 'exec-capture.mjs', 'context-transform.mjs', 'history-budget.mjs',
  'history-dedupe.mjs', 'history-shake.mjs', 'history-structure.mjs', 'proxy.mjs', 'proxy-metrics.mjs',
  'telemetry.mjs', 'telemetry-cli.mjs', 'telemetry-flush-entry.mjs', 'session-start.mjs',
  'user-prompt-submit.mjs', 'version.mjs',
];

test('standalone bundles match canonical routing metadata and behavior', async () => {
  const modules = await Promise.all([SOURCE, ...BUNDLES].map((directory) => import(pathToFileURL(path.join(directory, 'core.mjs')))));
  const input = {
    toolName: 'Read', output: `${'const value = 1;\n'.repeat(180)}`, cwd: '/work',
    lineCount: 180, fileBytes: 180 * 17,
  };
  const expected = modules[0].optimizeToolOutput(input);

  for (const module of modules.slice(1)) assert.deepEqual(module.optimizeToolOutput(input), expected);
});

test('all generated bundle modules match canonical sources', async () => {
  for (const file of GENERATED_MODULES) {
    const expected = await fs.readFile(path.join(SOURCE, file), 'utf8');
    for (const directory of BUNDLES) assert.equal(await fs.readFile(path.join(directory, file), 'utf8'), expected);
  }
});

test('all installed hook bundles emit the contracted hook telemetry shape', () => {
  for (const [directory, host] of [['adapters/claude/sando', 'claude'], ['adapters/codex/sando', 'codex'], ['plugins/sando', 'codex']]) {
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'sando-bundle-hook-'));
    const configPath = path.join(root, 'config', 'sando', 'telemetry.json');
    const statePath = path.join(root, 'state', 'sando', 'telemetry-counters.json');
    fsSync.mkdirSync(path.dirname(configPath), { recursive: true });
    fsSync.writeFileSync(configPath, JSON.stringify({
      schema_version: 1, enabled: true, prompted_consent_version: 1, consent_version: 1,
      consented_at: '2026-08-25T00:00:00.000Z', endpoint: 'http://127.0.0.1:1/v1/logs',
    }));
    execFileSync(process.execPath, [path.join(ROOT, directory, 'hooks/post-tool-use.mjs')], {
      input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: 'plain output', cwd: root }),
      env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), SANDO_MODE: 'observe' },
    });
    const state = JSON.parse(fsSync.readFileSync(statePath, 'utf8'));
    const summary = Object.values(state.counters).find((row) => row.event === 'hook_summary');
    assert.equal(summary.host, host);
    assert.equal(summary.mode, 'observe');
  }
});
