import path from 'node:path';

import {
  closeFinishedDays, defaultTelemetryConfigPath, defaultTelemetryStatePaths, isDoNotTrack, readTelemetryConfig, TELEMETRY_DETAILS_URL,
} from './telemetry.mjs';
import { PLUGIN_VERSION } from './version.mjs';

export function runSessionStart({
  env = process.env,
  stdout = process.stdout,
  rootEnv = 'PLUGIN_ROOT',
  spawnImpl,
  configPath = defaultTelemetryConfigPath(env),
  statePaths = defaultTelemetryStatePaths(env),
} = {}) {
  try {
    const config = readTelemetryConfig(configPath);
    if (config.enabled && !isDoNotTrack(env)) {
      closeFinishedDays({
        statePaths, configPath, day: new Date().toISOString().slice(0, 10),
        pluginVersion: PLUGIN_VERSION, ...(spawnImpl ? { spawnImpl } : {}),
      });
    }
    if (isDoNotTrack(env) || config.prompted_consent_version > 0) {
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
