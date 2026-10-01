import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { createReceipt, normalizeEvent, normalizePolicy, optimizeToolOutput } from './core.mjs';
import { DISPLAY_REDACTION_NOTICE, finalizeResultDelivery } from './result-disclosure.mjs';
import { cleanupArtifacts, reuseArtifact } from './artifact-lifecycle.mjs';
import { loadProjectRedactionProfile } from './redaction-config.mjs';
import { recordAdoption, scheduleAdoptionFlush } from './adoption.mjs';
import { defaultMetricsPath, recordMetrics } from './metrics.mjs';
import {
  closeFinishedDays, defaultTelemetryConfigPath, defaultTelemetryStatePaths, incrementCounter, isDoNotTrack, readTelemetryConfig, recordActiveDay, recordFailure,
} from './telemetry.mjs';
import { PLUGIN_VERSION } from './version.mjs';

function todayUtc() { return new Date().toISOString().slice(0, 10); }

function artifactPresent(target) {
  let stat;
  try { stat = fs.lstatSync(target); } catch { return false; }
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  try { return fs.realpathSync(target) === target; } catch { return false; }
}

/** Only counts (never content, paths, or IDs). */
function recordHookTelemetry({ host, env, policy, optimization }) {
  try {
    const configPath = defaultTelemetryConfigPath(env);
    const config = readTelemetryConfig(configPath);
    if (!config.enabled || isDoNotTrack(env)) return;
    const statePaths = defaultTelemetryStatePaths(env);
    recordActiveDay({ statePaths, day: todayUtc(), pluginVersion: PLUGIN_VERSION, host });
    incrementCounter({
      statePaths,
      day: todayUtc(),
      pluginVersion: PLUGIN_VERSION,
      event: 'hook_summary',
      host,
      mode: policy.mode === 'apply' ? 'enforce' : policy.mode === 'dry-run' ? 'dry_run' : 'observe',
      deltas: {
        toolCalls: 1,
        redactions: optimization.stats.redactions,
        cappedOutputs: optimization.artifact ? 1 : 0,
        bytesSaved: Math.max(0, optimization.stats.inputBytes - optimization.stats.inlineBytes),
        inputTokensSaved: Math.max(0, optimization.stats.estimatedInputTokens - optimization.stats.estimatedInlineTokens),
      },
    });
    closeFinishedDays({ statePaths, configPath, day: todayUtc(), pluginVersion: PLUGIN_VERSION });
  } catch { /* telemetry is best-effort and must never affect hook output */ }
}

function recordHookFailure({ host, env, failureStage }) {
  try {
    const configPath = defaultTelemetryConfigPath(env);
    const config = readTelemetryConfig(configPath);
    if (!config.enabled || isDoNotTrack(env)) return;
    const statePaths = defaultTelemetryStatePaths(env);
    const day = todayUtc();
    recordActiveDay({ statePaths, day, pluginVersion: PLUGIN_VERSION, host });
    recordFailure({ statePaths, day, pluginVersion: PLUGIN_VERSION, event: 'hook_failure_summary', host, failureStage });
    closeFinishedDays({ statePaths, configPath, day, pluginVersion: PLUGIN_VERSION });
  } catch { /* telemetry is best-effort and must never affect hook output */ }
}

function hookPolicy(env, host) {
  const policy = env.SANDO_POLICY
    ? JSON.parse(env.SANDO_POLICY)
    : { mode: env.SANDO_MODE || (host === 'claude' ? 'apply' : 'observe') };
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
  cleanupArtifacts(directory);
  const name = `${artifact.sourceDigest.slice('sha256:'.length)}.txt`;
  const destination = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.${process.pid}.${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, artifact.content, { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, destination); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      reuseArtifact(destination, artifact.content);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  cleanupArtifacts(directory, { preserveName: name });
  if (!artifactPresent(destination)) throw new Error('artifact storage limit removed the new artifact');
  return path.posix.join('.sando/sando', 'artifacts', name);
}

export function runHookCli({ host, env = process.env } = {}) {
  let policy;
  try {
    policy = hookPolicy(env, host);
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
      if (host === 'claude' && event.toolName.startsWith('mcp__')) {
        process.stdout.write('{}\n');
        return;
      }
      failureStage = 'redaction';
      const redactionProfile = policy.redact ? loadProjectRedactionProfile(event.cwd).profile : undefined;
      failureStage = 'optimization';
      const optimization = optimizeToolOutput({ toolName: event.toolName, toolInput: event.toolInput, output: event.output, cwd: event.cwd, policy, redactionProfile });
      let shaped;
      failureStage = 'artifact';
      if (host === 'claude' && policy.mode === 'apply') {
        shaped = shapeForClaude({
          original: event.output,
          optimization,
          toolName: event.toolName,
          toolInput: event.toolInput,
          cwd: event.cwd, redactionProfile,
          policy,
        });
      }
      let deliveredOptimization = shaped === undefined
        ? optimization : accountDeliveredValue(optimization, shaped);
      let fallback;
      if (host === 'codex' && policy.mode === 'apply' && env.SANDO_CODEX_FALLBACK === 'feedback') {
        fallback = buildCodexFallback({ optimization, cwd: event.cwd });
        deliveredOptimization = accountDeliveredValue(optimization, fallback);
      }
      failureStage = 'output';
      const receipt = createReceipt({
        host, event, optimization: deliveredOptimization,
        replacement: fallback ?? shaped,
      });
      try {
        recordMetrics({ storagePath: defaultMetricsPath(env), host, event, optimization: deliveredOptimization, receipt });
      } catch {}
      recordHookTelemetry({ host, env, policy, optimization: deliveredOptimization });
      try { recordAdoption({ env, host }); scheduleAdoptionFlush({ env }); } catch { /* adoption must never affect hook output */ }
      if (fallback) {
        process.stdout.write(`${JSON.stringify(fallback)}\n`);
        return;
      }
      if (host === 'claude' && policy.mode === 'apply') {
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
    } else if (error?.code === 'SANDO_OUTPUT_BUDGET') {
      process.stderr.write(`sando output budget: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
  }
  process.stdout.write('{}\n');
}

function materialize(optimization, cwd, maxInlineBytes) {
  const inline = optimization.artifact
    ? optimization.inline.replace(optimization.artifact.ref, artifactPath(cwd, optimization.artifact))
    : optimization.inline;
  return finalizeResultDelivery(optimization, {
    inline,
    maxInlineBytes,
  });
}

function accountDeliveredValue(optimization, value) {
  const inline = typeof value === 'string' ? value : JSON.stringify(value);
  const inlineBytes = Buffer.byteLength(inline);
  return {
    ...optimization,
    inline,
    stats: { ...optimization.stats, inlineBytes, estimatedInlineTokens: inlineBytes === 0 ? 0 : Math.ceil(inlineBytes / 4) },
    ...(optimization.disclosure ? { disclosure: {
      ...optimization.disclosure,
      bytes: { ...optimization.disclosure.bytes, visible: inlineBytes },
    } } : {}),
  };
}

export function buildCodexFallback({ optimization, cwd }) {
  const reference = optimization.artifact ? artifactPath(cwd, optimization.artifact) : 'inline output';
  const disclosure = optimization.stats?.redactions > 0 ? `\n${DISPLAY_REDACTION_NOTICE}` : '';
  return {
    continue: false,
    stopReason: 'Sando fallback: Codex cannot transparently rewrite tool output',
    systemMessage: `Sando fallback prepared ${reference}; tool output was not rewritten.${disclosure}`,
  };
}

function redactStructuredForDisplay(value, profile) {
  if (typeof value === 'string') {
    const redacted = profile.redact(value);
    if (redacted.count === 0 || redacted.text.endsWith(DISPLAY_REDACTION_NOTICE)) return redacted.text;
    return `${redacted.text}\n${DISPLAY_REDACTION_NOTICE}`;
  }
  if (Array.isArray(value)) return value.map((item) => redactStructuredForDisplay(item, profile));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStructuredForDisplay(item, profile)]));
  }
  return value;
}

function shapeForClaude({ original, optimization, toolName, toolInput, cwd, policy, redactionProfile }) {
  if (typeof original === 'string') {
    return materialize(optimization, cwd, policy.maxInlineBytes).inline;
  }
  if (!original || typeof original !== 'object' || Array.isArray(original)
    || !Object.hasOwn(original, 'stdout') || !Object.hasOwn(original, 'stderr')
    || typeof original.stdout !== 'string' || typeof original.stderr !== 'string'
    || (Object.hasOwn(original, 'interrupted') && typeof original.interrupted !== 'boolean')
    || (Object.hasOwn(original, 'isImage') && typeof original.isImage !== 'boolean')) return undefined;
  const result = policy.redact ? redactStructuredForDisplay(original, redactionProfile) : { ...original };
  if (typeof original.stdout === 'string') {
    result.stdout = materialize(
      optimizeToolOutput({ toolName, toolInput, output: original.stdout, cwd, policy, redactionProfile }),
      cwd, policy.maxInlineBytes,
    ).inline;
  }
  if (typeof original.stderr === 'string') {
    result.stderr = materialize(
      optimizeToolOutput({ toolName, toolInput, output: original.stderr, cwd, policy, redactionProfile }),
      cwd, policy.maxInlineBytes,
    ).inline;
  }
  return result;
}
