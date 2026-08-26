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
  for (const file of ['core.mjs', 'routing.mjs', 'active-session.mjs', 'statusline.mjs', 'secret-redaction.mjs', 'provider-usage.mjs', 'telemetry.mjs', 'telemetry-cli.mjs', 'telemetry-flush-entry.mjs', 'session-start.mjs']) {
    await fs.copyFile(path.join(source, file), path.join(root, directory, file));
  }
}
