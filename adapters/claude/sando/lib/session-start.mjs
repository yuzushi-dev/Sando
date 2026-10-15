import fs from 'node:fs';
import path from 'node:path';

import {
  closeFinishedDays, defaultTelemetryConfigPath, defaultTelemetryStatePaths, isDoNotTrack, markTelemetryAsked,
  readTelemetryConfig, TELEMETRY_DETAILS_URL,
} from './telemetry.mjs';
import { PLUGIN_VERSION } from './version.mjs';

// The consent question is the only reason SessionStart and UserPromptSubmit exist, and it is asked
// once. After that each hook leaves a marker beside telemetry.json, and the shell gate in hooks.json
// answers `{}` without starting node: hosts list plugin hooks but cannot run one only once.
export const SESSION_START_DONE = 'session-start.done';
export const PROMPT_SUBMIT_DONE = 'user-prompt-submit.done';
// Holds the id of the session that asked, the only one whose reply is accepted.
export const CONSENT_SESSION = 'consent-session';

export function markHookDone(configPath, marker) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(configPath), marker), '');
  } catch { /* the hook stays on and keeps answering correctly, only slower */ }
}

// The hook wrapper reads stdin and passes it in; called without it there is no session to record.
function sessionId(input) {
  try {
    const id = JSON.parse(input || '{}').session_id;
    return typeof id === 'string' ? id : '';
  } catch { return ''; }
}

export function runSessionStart({
  env = process.env,
  stdout = process.stdout,
  rootEnv = 'PLUGIN_ROOT',
  spawnImpl,
  configPath,
  statePaths,
  input,
} = {}) {
  try {
    const telemetryConfigPath = configPath ?? defaultTelemetryConfigPath(env);
    if (isDoNotTrack(env)) {
      markHookDone(telemetryConfigPath, SESSION_START_DONE);
      markHookDone(telemetryConfigPath, PROMPT_SUBMIT_DONE);
      stdout.write('{}\n');
      return;
    }
    const telemetryStatePaths = statePaths ?? defaultTelemetryStatePaths(env);
    const config = readTelemetryConfig(telemetryConfigPath);
    if (config.enabled) {
      closeFinishedDays({
        statePaths: telemetryStatePaths, configPath: telemetryConfigPath, day: new Date().toISOString().slice(0, 10),
        pluginVersion: PLUGIN_VERSION, ...(spawnImpl ? { spawnImpl } : {}),
      });
    }
    if (config.consent_state !== 'unasked' || !markTelemetryAsked(telemetryConfigPath)) {
      // Answered or asked in an earlier version: nothing left for either hook to do.
      if (readTelemetryConfig(telemetryConfigPath).consent_state !== 'unasked') {
        markHookDone(telemetryConfigPath, SESSION_START_DONE);
        markHookDone(telemetryConfigPath, PROMPT_SUBMIT_DONE);
      }
      stdout.write('{}\n');
      return;
    }
    try {
      fs.writeFileSync(path.join(path.dirname(telemetryConfigPath), CONSENT_SESSION), sessionId(input));
    } catch { /* without it the reply is ignored and telemetry stays off */ }
    markHookDone(telemetryConfigPath, SESSION_START_DONE);
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
