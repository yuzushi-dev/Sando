import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'packages/sando/src');
const bundles = [
  'adapters/claude/sando/lib',
  'adapters/codex/sando/lib',
  'plugins/sando/lib',
];

for (const directory of bundles) {
  for (const file of ['core.mjs', 'routing.mjs', 'active-session.mjs', 'statusline.mjs', 'metrics.mjs', 'redaction-profile.mjs', 'redaction-config.mjs', 'secret-redaction.mjs', 'adaptive-control.mjs', 'paired-accounting.mjs', 'provider-usage.mjs', 'accounting-cli.mjs', 'exec-capture.mjs', 'context-transform.mjs', 'history-budget.mjs', 'history-dedupe.mjs', 'history-shake.mjs', 'history-structure.mjs', 'proxy.mjs', 'proxy-metrics.mjs', 'telemetry.mjs', 'telemetry-cli.mjs', 'telemetry-flush-entry.mjs', 'session-start.mjs', 'user-prompt-submit.mjs', 'version.mjs']) {
    await fs.copyFile(path.join(source, file), path.join(root, directory, file));
  }
}
