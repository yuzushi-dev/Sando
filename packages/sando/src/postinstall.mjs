#!/usr/bin/env node
// npm postinstall: one-time, local-only consent prompt. No network calls here —
// upload happens later, only if enabled, from the hook/proxy paths. Must never
// fail or hang an `npm install`: every path resolves, every error is swallowed.

import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import { CONSENT_VERSION, defaultTelemetryConfigPath, enableTelemetry, readTelemetryConfig } from './telemetry.mjs';

const CONSENT_PROMPT = 'Enable anonymous telemetry? Full details at: TELEMETRY.md [y/N] ';

export async function runPostinstall({
  env = process.env, stdin = process.stdin, stdout = process.stdout,
  readlineFactory = () => readline.createInterface({ input: stdin, output: stdout }),
} = {}) {
  try {
    if (env.SANDO_SKIP_TELEMETRY_PROMPT) return;
    if (!stdin.isTTY || !stdout.isTTY) return; // CI, --ignore-scripts consumers, piped installs, etc.

    const configPath = defaultTelemetryConfigPath(env);
    const current = readTelemetryConfig(configPath);
    if (current.prompted_consent_version >= CONSENT_VERSION) return; // never re-ask on reinstall/upgrade

    const rl = readlineFactory();
    let answer;
    try {
      answer = await rl.question(CONSENT_PROMPT);
    } finally {
      rl.close();
    }
    const result = enableTelemetry({ configPath, interactive: true, answer });
    stdout.write(result.enabled ? 'telemetry enabled.\n' : 'telemetry not enabled.\n');
  } catch {
    // A postinstall script must never fail `npm install`.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPostinstall().finally(() => process.exit(0));
}
