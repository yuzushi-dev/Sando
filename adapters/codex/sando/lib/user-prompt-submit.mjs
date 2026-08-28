#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  defaultTelemetryConfigPath, enableTelemetry, isDoNotTrack, readTelemetryConfig,
} from './telemetry.mjs';

const CONSENT_COMMANDS = new Map([
  ['sando telemetry yes', 'yes'],
  ['sando telemetry no', 'no'],
]);

function pass(stdout) { stdout.write('{}\n'); }

export function runUserPromptSubmit({
  env = process.env, input, stdout = process.stdout, configPath,
} = {}) {
  try {
    if (isDoNotTrack(env)) {
      pass(stdout);
      return;
    }
    const telemetryConfigPath = configPath ?? defaultTelemetryConfigPath(env);
    const rawInput = input === undefined ? fs.readFileSync(0, 'utf8') : input;
    const prompt = JSON.parse(rawInput || '{}').prompt;
    // Normalizza solo gli spazi ai bordi: non introduce ambiguita' (la stringa
    // resta esatta) ed evita di perdere risposte genuine incollate con spazi.
    const answer = typeof prompt === 'string' ? CONSENT_COMMANDS.get(prompt.trim()) : undefined;
    if (!answer) {
      pass(stdout);
      return;
    }
    const current = readTelemetryConfig(telemetryConfigPath);
    if (current.consent_state === 'declined' && answer === 'yes') {
      pass(stdout);
      return;
    }
    const result = enableTelemetry({ configPath: telemetryConfigPath, interactive: true, answer });
    stdout.write(`${JSON.stringify({
      systemMessage: result.enabled ? 'Sando telemetry enabled.' : 'Sando telemetry disabled.',
    })}\n`);
  } catch {
    pass(stdout);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runUserPromptSubmit();
}
