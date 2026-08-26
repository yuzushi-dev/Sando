import path from 'node:path';

import { defaultTelemetryConfigPath, readTelemetryConfig, TELEMETRY_DETAILS_URL } from './telemetry.mjs';

export function runSessionStart({
  env = process.env,
  stdout = process.stdout,
  rootEnv = 'PLUGIN_ROOT',
} = {}) {
  try {
    const config = readTelemetryConfig(defaultTelemetryConfigPath(env));
    if (config.prompted_consent_version > 0) {
      stdout.write('{}\n');
      return;
    }
    const pluginRoot = env[rootEnv] || path.resolve(import.meta.dirname, '..');
    const cli = path.join(pluginRoot, 'lib', 'telemetry-cli.mjs');
    stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        systemMessage: 'Sando can send anonymous aggregate telemetry (opt-in, off by default). '
          + `Run \`node "${cli}" enable\` to turn it on. Details: ${TELEMETRY_DETAILS_URL}`,
      },
    })}\n`);
  } catch {
    stdout.write('{}\n');
  }
}
