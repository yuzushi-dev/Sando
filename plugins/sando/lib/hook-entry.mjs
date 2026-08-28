import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { createReceipt, normalizeEvent, normalizePolicy, optimizeToolOutput } from './core.mjs';
import { defaultMetricsPath, recordMetrics } from './metrics.mjs';
import { loadProjectRedactionProfile } from './redaction-config.mjs';
import {
  closeFinishedDays, defaultTelemetryConfigPath, defaultTelemetryStatePaths, incrementCounter, isDoNotTrack, readTelemetryConfig, recordActiveDay, recordFailure,
} from './telemetry.mjs';
import { PLUGIN_VERSION } from './version.mjs';

function todayUtc() { return new Date().toISOString().slice(0, 10); }

function recordHookTelemetry({ host, env, policy, optimization }) {
  try {
    const configPath = defaultTelemetryConfigPath(env);
    const config = readTelemetryConfig(configPath);
    if (!config.enabled || isDoNotTrack(env)) return;
    const statePaths = defaultTelemetryStatePaths(env);
    const day = todayUtc();
    recordActiveDay({ statePaths, day, pluginVersion: PLUGIN_VERSION, host });
    incrementCounter({
      statePaths, day, event: 'hook_summary', host,
      mode: policy.mode === 'apply' ? 'enforce' : policy.mode === 'dry-run' ? 'dry_run' : 'observe',
      deltas: {
        toolCalls: 1, redactions: optimization.stats.redactions,
        cappedOutputs: optimization.artifact ? 1 : 0,
        bytesSaved: Math.max(0, optimization.stats.inputBytes - optimization.stats.inlineBytes),
        inputTokensSaved: Math.max(0, optimization.stats.estimatedInputTokens - optimization.stats.estimatedInlineTokens),
      },
    });
    closeFinishedDays({ statePaths, configPath, day, pluginVersion: PLUGIN_VERSION });
  } catch { /* telemetry is best-effort */ }
}

function recordHookFailure({ host, env, failureStage }) {
  try {
    const configPath = defaultTelemetryConfigPath(env);
    const config = readTelemetryConfig(configPath);
    if (!config.enabled || isDoNotTrack(env)) return;
    const statePaths = defaultTelemetryStatePaths(env);
    const day = todayUtc();
    recordActiveDay({ statePaths, day, pluginVersion: PLUGIN_VERSION, host });
    recordFailure({ statePaths, day, event: 'hook_failure_summary', host, failureStage });
    closeFinishedDays({ statePaths, configPath, day, pluginVersion: PLUGIN_VERSION });
  } catch { /* telemetry is best-effort */ }
}

function hookPolicy(env) {
  const policy = env.SANDO_POLICY
    ? JSON.parse(env.SANDO_POLICY)
    : { mode: env.SANDO_MODE || 'observe' };
  if (/^(1|true|yes)$/i.test(env.SANDO_OBSERVE_ONLY || '')) policy.mode = 'observe';
  return normalizePolicy(policy);
}

function artifactPath(cwd, artifact) {
  const root = fs.realpathSync(cwd);
  const stateRoot = path.join(root, '.sando');
  const privateRoot = path.join(stateRoot, 'sando');
  const directory = path.join(privateRoot, 'artifacts');
  for (const target of [stateRoot, privateRoot, directory]) {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('artifact directory is unsafe');
    if (!stat) fs.mkdirSync(target, { mode: 0o700 });
  }
  const name = `${artifact.sourceDigest.slice('sha256:'.length)}.txt`;
  const destination = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.${process.pid}.${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, artifact.content, { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, destination); }
    catch (error) {
      if (error?.code !== 'EEXIST' || fs.readFileSync(destination, 'utf8') !== artifact.content) throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  fs.chmodSync(destination, 0o600);
  return path.posix.join('.sando/sando', 'artifacts', name);
}

export function runHookCli({ host, env = process.env } = {}) {
  let policy;
  try {
    policy = hookPolicy(env);
  } catch (error) {
    recordHookFailure({ host, env, failureStage: 'policy' });
    process.stderr.write(`sando invalid policy: ${error instanceof Error ? error.message : 'invalid input'}\n`);
    process.exitCode = 2;
    return;
  }
  let failureStage = 'input';
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const eventName = input.hook_event_name ?? input.hookEventName ?? input.event_name ?? input.eventName;
    if (eventName === 'PostToolUse') {
      const event = normalizeEvent(input);
      failureStage = 'redaction';
      const redactionProfile = policy.redact ? loadProjectRedactionProfile(event.cwd).profile : undefined;
      failureStage = 'optimization';
      const optimization = optimizeToolOutput({ toolName: event.toolName, toolInput: event.toolInput, output: event.output, cwd: event.cwd, policy, redactionProfile });
      failureStage = 'output';
      const receipt = createReceipt({ host, event, optimization });
      try { recordMetrics({ storagePath: defaultMetricsPath(env), host, event, optimization, receipt }); } catch {}
      recordHookTelemetry({ host, env, policy, optimization });
      if (host === 'claude' && policy.mode === 'apply') {
        failureStage = 'artifact';
        const shaped = shapeForClaude({
          original: event.output,
          optimization,
          toolName: event.toolName,
          toolInput: event.toolInput,
          cwd: event.cwd,
          policy,
          redactionProfile,
        });
        if (shaped !== undefined) {
          process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
            hookEventName: 'PostToolUse', updatedToolOutput: shaped,
          } })}\n`);
          return;
        }
      }
    }
  } catch (error) {
    recordHookFailure({ host, env, failureStage });
    if (error?.code === 'SANDO_REDACTION_CONFIG') {
      process.stderr.write(`sando invalid redaction config: ${error.message}\n`);
      process.exitCode = 2;
    }
  }
  process.stdout.write('{}\n');
}

function materialize(optimization, cwd) {
  if (!optimization.artifact) return optimization.inline;
  return optimization.inline.replace(optimization.artifact.ref, artifactPath(cwd, optimization.artifact));
}

function shapeForClaude({ original, optimization, toolName, toolInput, cwd, policy, redactionProfile }) {
  if (typeof original === 'string') return materialize(optimization, cwd);
  if (!original || typeof original !== 'object' || Array.isArray(original)
    || !Object.hasOwn(original, 'stdout') || !Object.hasOwn(original, 'stderr')) return undefined;
  const result = policy.redact ? redactionProfile.redactStructured(original).value : { ...original };
  if (typeof original.stdout === 'string') {
    result.stdout = materialize(optimizeToolOutput({ toolName, toolInput, output: original.stdout, cwd, policy, redactionProfile }), cwd);
  }
  if (typeof original.stderr === 'string') {
    result.stderr = materialize(optimizeToolOutput({ toolName, toolInput, output: original.stderr, cwd, policy, redactionProfile }), cwd);
  }
  return result;
}
