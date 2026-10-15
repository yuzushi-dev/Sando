#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  defaultTelemetryConfigPath, enableTelemetry, isDoNotTrack, readTelemetryConfig,
} from './telemetry.mjs';
import { CONSENT_SESSION, markHookDone, PROMPT_SUBMIT_DONE } from './session-start.mjs';

const CONSENT_COMMANDS = new Map([
  ['sando telemetry yes', 'yes'],
  ['sando telemetry no', 'no'],
]);

function pass(stdout) { stdout.write('{}\n'); }

function consentSession(configPath) {
  try { return fs.readFileSync(path.join(path.dirname(configPath), CONSENT_SESSION), 'utf8'); }
  catch { return null; }
}

export function runUserPromptSubmit({
  env = process.env, input, stdout = process.stdout, configPath,
} = {}) {
  try {
    const telemetryConfigPath = configPath ?? defaultTelemetryConfigPath(env);
    if (isDoNotTrack(env)) {
      markHookDone(telemetryConfigPath, PROMPT_SUBMIT_DONE);
      pass(stdout);
      return;
    }
    const rawInput = input === undefined ? fs.readFileSync(0, 'utf8') : input;
    const parsed = JSON.parse(rawInput || '{}');
    const prompt = parsed.prompt;
    const current = readTelemetryConfig(telemetryConfigPath);
    // Not asked yet: SessionStart has not run, so there is nothing to close.
    if (current.consent_state === 'unasked') {
      pass(stdout);
      return;
    }
    // A reply counts only in the session that asked; any later session, or a decided consent,
    // closes the window for good and the gate stops starting node.
    const asking = consentSession(telemetryConfigPath);
    const session = typeof parsed.session_id === 'string' ? parsed.session_id : '';
    if (current.consent_state !== 'asked' || asking === null || asking !== session) {
      markHookDone(telemetryConfigPath, PROMPT_SUBMIT_DONE);
      pass(stdout);
      return;
    }
    // Normalizza solo gli spazi ai bordi: non introduce ambiguita' (la stringa
    // resta esatta) ed evita di perdere risposte genuine incollate con spazi.
    const answer = typeof prompt === 'string' ? CONSENT_COMMANDS.get(prompt.trim()) : undefined;
    if (!answer) {
      pass(stdout);
      return;
    }
    const result = enableTelemetry({ configPath: telemetryConfigPath, interactive: true, answer });
    markHookDone(telemetryConfigPath, PROMPT_SUBMIT_DONE);
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
