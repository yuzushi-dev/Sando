#!/usr/bin/env node

import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import {
  defaultTelemetryConfigPath, defaultTelemetryStatePaths,
  disableTelemetry, enableTelemetry, flushQueue, previewNextUpload, statusTelemetry,
} from './telemetry.mjs';

const USAGE = 'Usage: sando telemetry <status|enable|disable [--purge]|preview|flush>\n';
const CONSENT_PROMPT = 'Enable anonymous telemetry? Full details at: TELEMETRY.md [y/N] ';

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
      if (!interactive) {
        stderr.write('sando telemetry: enable requires an interactive session\n');
        return enableTelemetry({ configPath, interactive: false });
      }
      const answer = await prompt(CONSENT_PROMPT);
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
    if (command === 'preview') {
      const config = statusTelemetry(configPath);
      const preview = previewNextUpload({ statePaths, endpoint: config.endpoint });
      stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
      return preview;
    }
    if (command === 'flush') {
      const config = statusTelemetry(configPath);
      if (!config.enabled) {
        stdout.write('telemetry is disabled; nothing to flush.\n');
        return { sent: 0 };
      }
      const result = await flushQueue({ statePaths, endpoint: config.endpoint });
      stdout.write(`flushed ${result.sent} row(s).\n`);
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
