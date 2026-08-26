#!/usr/bin/env node
// SessionStart hook: informational only, never blocks, never prompts, never
// makes a network call. Shows a one-line nudge toward `telemetry-cli.mjs enable`
// until the owner has made any telemetry decision (enable or disable) at least
// once; after that, readTelemetryConfig's prompted_consent_version silences it.

import { defaultTelemetryConfigPath, readTelemetryConfig } from '../lib/telemetry.mjs';

function main() {
  try {
    const config = readTelemetryConfig(defaultTelemetryConfigPath());
    if (config.prompted_consent_version > 0) {
      process.stdout.write(`${JSON.stringify({})}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        systemMessage: 'Sando can send anonymous aggregate telemetry (opt-in, off by default). '
          + 'Run `node "${CLAUDE_PLUGIN_ROOT}/lib/telemetry-cli.mjs" enable` to turn it on. Details: TELEMETRY.md',
      },
    })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({})}\n`);
  }
}

main();
