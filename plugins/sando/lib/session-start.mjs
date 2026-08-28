import path from 'node:path';

import {
  closeFinishedDays, defaultTelemetryConfigPath, defaultTelemetryStatePaths, isDoNotTrack, markTelemetryAsked,
  readTelemetryConfig, TELEMETRY_DETAILS_URL,
} from './telemetry.mjs';
import { PLUGIN_VERSION } from './version.mjs';

export function runSessionStart({
  env = process.env,
  stdout = process.stdout,
  rootEnv = 'PLUGIN_ROOT',
  spawnImpl,
  configPath,
  statePaths,
} = {}) {
  try {
    if (isDoNotTrack(env)) {
      stdout.write('{}\n');
      return;
    }
    const telemetryConfigPath = configPath ?? defaultTelemetryConfigPath(env);
    const telemetryStatePaths = statePaths ?? defaultTelemetryStatePaths(env);
    const config = readTelemetryConfig(telemetryConfigPath);
    if (config.enabled) {
      closeFinishedDays({
        statePaths: telemetryStatePaths, configPath: telemetryConfigPath, day: new Date().toISOString().slice(0, 10),
        pluginVersion: PLUGIN_VERSION, ...(spawnImpl ? { spawnImpl } : {}),
      });
    }
    if (config.consent_state !== 'unasked' || !markTelemetryAsked(telemetryConfigPath)) {
      stdout.write('{}\n');
      return;
    }
    const pluginRoot = env[rootEnv] || path.resolve(import.meta.dirname, '..');
    const cli = path.join(pluginRoot, 'lib', 'telemetry-cli.mjs');
    stdout.write(`${JSON.stringify({
      systemMessage: 'Sando can send anonymous aggregate telemetry (opt-in, off by default). '
        + 'Reply with exactly `sando telemetry yes` or `sando telemetry no`, '
        + `or run \`node "${cli}" enable\`. Details: ${TELEMETRY_DETAILS_URL}`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
      },
    })}\n`);
  } catch {
    stdout.write('{}\n');
  }
}
