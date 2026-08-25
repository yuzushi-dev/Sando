#!/usr/bin/env node

import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import {
  TELEMETRY_DISCLOSURE, defaultTelemetryConfigPath, defaultTelemetryStatePaths,
  disableTelemetry, enableTelemetry, statusTelemetry,
} from './telemetry.mjs';

const USAGE = 'Usage: sando telemetry <status|enable|disable [--purge]|preview|flush>\n';

async function defaultPrompt(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(message); } finally { rl.close(); }
}

export async function runTelemetryCli({
  argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr,
  configPath = defaultTelemetryConfigPath(env), statePaths = defaultTelemetryStatePaths(env),
  interactive = Boolean(process.stdin.isTTY), prompt = defaultPrompt,
} = {}) {
  const [command, ...rest] = argv;
  try {
    if (command === 'status') {
      const config = statusTelemetry(configPath);
      stdout.write(`telemetry: ${config.enabled ? 'enabled' : 'disabled'}\n`);
      return config;
    }
    if (command === 'enable') {
      stdout.write(`${TELEMETRY_DISCLOSURE}\n`);
      if (!interactive) {
        stderr.write('sando telemetry: enable requires an interactive session\n');
        return enableTelemetry({ configPath, interactive: false });
      }
      const answer = await prompt('Enable anonymous aggregate telemetry? [y/N] ');
      const result = enableTelemetry({
        configPath, interactive: true,
        answer: /^(y|yes)$/i.test((answer ?? '').trim()) ? 'yes' : answer,
      });
      stdout.write(result.enabled ? 'telemetry enabled.\n' : 'telemetry not enabled.\n');
      return result;
    }
    if (command === 'disable') {
      const result = disableTelemetry({ configPath, statePaths, purge: rest.includes('--purge') });
      stdout.write('telemetry disabled.\n');
      return result;
    }
    stdout.write(USAGE);
    return null;
  } catch (error) {
    stderr.write(`sando telemetry: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runTelemetryCli();
}
