#!/usr/bin/env node

import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import {
  defaultTelemetryConfigPath, defaultTelemetryStatePaths,
  disableTelemetry, enableTelemetry, flushQueue, isDoNotTrack, previewNextUpload, statusTelemetry, TELEMETRY_DETAILS_URL,
} from './telemetry.mjs';

const USAGE = 'Usage: sando telemetry <status|enable|disable [--purge]|preview|flush>\n';
const CONSENT_PROMPT = `Enable anonymous telemetry? Full details at: ${TELEMETRY_DETAILS_URL} [y/N] `;

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
      if (isDoNotTrack(env)) {
        stdout.write('telemetry: disabled by DO_NOT_TRACK\n');
        return { ...config, enabled: false };
      }
      stdout.write(`telemetry: ${config.enabled ? 'enabled' : 'disabled'}\n`);
      return config;
    }
    if (command === 'enable') {
      if (isDoNotTrack(env)) {
        stderr.write('sando telemetry: DO_NOT_TRACK is set; telemetry remains disabled\n');
        return { ...statusTelemetry(configPath), enabled: false, exitCode: 1 };
      }
      if (!interactive) {
        stderr.write('sando telemetry: enable requires an interactive session\n');
        return { ...statusTelemetry(configPath), exitCode: 1 };
      }
      const current = statusTelemetry(configPath);
      if (current.enabled) {
        stdout.write('telemetry already enabled.\n');
        return current;
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
      if (isDoNotTrack(env)) {
        stdout.write('telemetry disabled by DO_NOT_TRACK; nothing to flush.\n');
        return { sent: 0 };
      }
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
  const result = await runTelemetryCli();
  if (result?.exitCode) process.exitCode = result.exitCode;
}
