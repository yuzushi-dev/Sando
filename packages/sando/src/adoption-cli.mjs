#!/usr/bin/env node
import readline from 'node:readline/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultAdoptionConfigPath, defaultAdoptionStatePath, disableAdoption, enableAdoption, readAdoptionConfig, flushAdoptionQueue } from './adoption.mjs';

const PROMPT = 'Enable separate adoption telemetry? It stores one random persistent pseudonymous ID per host and sends daily date/version activity to measure active installations, retention, inactivity, and reactivation. Raw observations are retained up to 395 days. Details: TELEMETRY.md [y/N] ';
function doNotTrack(env) { return env.DO_NOT_TRACK !== undefined && env.DO_NOT_TRACK !== '' && env.DO_NOT_TRACK !== '0'; }
export async function runAdoptionCli({ argv = process.argv.slice(2), env = process.env, interactive = Boolean(process.stdin.isTTY), prompt, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command] = argv;
  const configPath = defaultAdoptionConfigPath(env); const statePath = defaultAdoptionStatePath(env);
  if (command === 'status') { const result = readAdoptionConfig(configPath); stdout.write(`adoption: ${result.enabled ? 'enabled' : 'disabled'}\n`); return result; }
  if (command === 'disable') { const result = disableAdoption({ configPath, statePath }); stdout.write('adoption disabled.\n'); return result; }
  if (command === 'flush') { const result = await flushAdoptionQueue({ configPath, statePath, endpoint: env.SANDO_ADOPTION_ENDPOINT, env }); stdout.write(`adoption flushed: ${result.sent}\n`); return result; }
  if (command !== 'enable') { stderr.write('usage: adoption <status|enable|disable|flush>\n'); return { ...readAdoptionConfig(configPath), exitCode: 1 }; }
  if (!interactive || doNotTrack(env)) { stderr.write(doNotTrack(env) ? 'adoption: disabled by DO_NOT_TRACK\n' : 'adoption: enable requires an interactive session\n'); return { ...readAdoptionConfig(configPath), exitCode: 1 }; }
  const ask = prompt ?? (async (message) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(message); } finally { rl.close(); } });
  const result = enableAdoption({ configPath, answer: await ask(PROMPT), interactive: true, env });
  stdout.write(result.enabled ? 'adoption enabled.\n' : 'adoption not enabled.\n'); return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result = await runAdoptionCli(); if (result.exitCode) process.exitCode = result.exitCode; } catch (error) { process.stderr.write(`adoption: ${error.message}\n`); process.exitCode = 1; }
}
