import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

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

// On Claude the artifact store lives under CLAUDE_PROJECT_DIR when it is set, so a `cd` into a
// subdirectory or worktree does not move it away from where the MCP recovery tool looks.
let projectRoot;

function claudeProjectRoot(env) {
  const configured = env.CLAUDE_PROJECT_DIR;
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) return undefined;
  try {
    const real = fs.realpathSync(configured);
    return fs.statSync(real).isDirectory() ? real : undefined;
  } catch { return undefined; }
}

function artifactPath(cwd, artifact) {
  const cwdRoot = fs.realpathSync(cwd);
  const root = projectRoot ?? cwdRoot;
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
  // Relative to the cwd when the store is there, absolute otherwise (the cwd moved off the root).
  return root === cwdRoot ? path.posix.join('.sando/sando', 'artifacts', name) : destination;
}

// Sando's own MCP tools (artifact recovery, prepare_tool_output, Slice) are never bounded:
// bounding the recovery tool would defeat recovery.
export function isSandoMcpTool(toolName) {
  return /^mcp__(?:plugin_sando_|sando__)/u.test(toolName);
}

// Total inline text one MCP result may deliver. Each block is bounded on its own; when the bounded
// blocks together still exceed this, they are merged into one bounded view with one artifact.
const MCP_AGGREGATE_BYTES = 16 * 1024;

// An MCP tool_response on Claude is an array of content blocks. Each `text` block goes through
// the same optimizer as other tool output, with the recover hint naming sando_artifact_get;
// every other block (image, resource, ...) is passed through untouched. Anything that is not a
// content array (structured objects, strings) is left alone. Returns undefined when nothing changed.
function boundMcpContent({ event, input, policy, env }) {
  const response = input.tool_response;
  if (!Array.isArray(response)) return undefined;
  const redactionProfile = policy.redact ? loadProjectRedactionProfile(event.cwd).profile : undefined;
  const isText = (block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string';
  const optimizeText = (original) => optimizeToolOutput({
    toolName: event.toolName, toolInput: event.toolInput, output: original, cwd: event.cwd,
    policy, redactionProfile, recoveryStyle: 'mcp',
  });
  let changed = false;
  const deliver = (original, optimization) => {
    const text = materialize(optimization, event.cwd, policy.maxInlineBytes).inline;
    if (text === original) return original;
    changed = true;
    const blockEvent = { ...event, output: original };
    const delivered = accountDeliveredValue(optimization, text);
    const receipt = createReceipt({ host: 'claude', event: blockEvent, optimization: delivered, replacement: text });
    try { recordMetrics({ storagePath: defaultMetricsPath(env), host: 'claude', event: blockEvent, optimization: delivered, receipt }); } catch {}
    recordHookTelemetry({ host: 'claude', env, policy, optimization: delivered });
    return text;
  };
  const textBlocks = response.filter(isText);
  const bounded = textBlocks.map((block) => optimizeText(block.text));
  const boundedBytes = bounded.reduce((sum, optimization) => sum + Buffer.byteLength(optimization.inline), 0);
  if (textBlocks.length > 1 && boundedBytes > MCP_AGGREGATE_BYTES) {
    const joined = textBlocks.map((block) => block.text).join('\n');
    const merged = deliver(joined, optimizeText(joined));
    let placed = false;
    return response.flatMap((block) => {
      if (!isText(block)) return [block];
      if (placed) return [];
      placed = true;
      return [{ ...block, text: merged }];
    });
  }
  let index = 0;
  const blocks = response.map((block) => {
    if (!isText(block)) return block;
    const optimization = bounded[index];
    index += 1;
    return { ...block, text: deliver(block.text, optimization) };
  });
  return changed ? blocks : undefined;
}

const WITHHELD_NOTICE = '[sando] output withheld: Sando could not safely process this result';

// Last line of defence on Claude. When Sando fails after the tool ran, the original output is
// already on its way to the model, and exit code 2 on PostToolUse only adds stderr to it. So the
// hook answers with a redacted, hard-truncated copy, or a placeholder when even that is not
// possible. It never lets the raw output through.
function failClosedText(text, { cwd, policy, code }) {
  const reason = `${WITHHELD_NOTICE} (${code ?? 'internal error'}); set SANDO_MODE=observe to pass tool output through unmodified.`;
  try {
    let body = stripVTControlCharacters(text);
    let redactions = 0;
    if (policy.redact) {
      const redacted = loadProjectRedactionProfile(cwd).profile.redact(body);
      body = redacted.text;
      redactions = redacted.count;
    }
    const limit = Math.max(256, Math.min(policy.maxInlineBytes, 4096));
    const truncated = Buffer.byteLength(body) > limit;
    if (truncated) body = Buffer.from(body).subarray(0, limit).toString('utf8');
    return `${body}${truncated ? `\n${reason.replace('withheld', 'truncated')}` : ''}${redactions > 0 ? `\n${DISPLAY_REDACTION_NOTICE}` : ''}`;
  } catch {
    return reason;
  }
}

function failClosedOutput(response, { toolName, cwd, policy, code }) {
  const safe = (text) => failClosedText(text, { cwd, policy, code });
  if (typeof response === 'string') return { updatedToolOutput: safe(response) };
  if (Array.isArray(response) && toolName.startsWith('mcp__')) {
    return { updatedMCPToolOutput: response.map((block) => (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? { ...block, text: safe(block.text) } : block)) };
  }
  if (response && typeof response === 'object' && !Array.isArray(response)
    && typeof response.stdout === 'string' && typeof response.stderr === 'string') {
    return { updatedToolOutput: {
      stdout: safe(response.stdout), stderr: safe(response.stderr),
      interrupted: response.interrupted === true, isImage: response.isImage === true,
    } };
  }
  return undefined;
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
  projectRoot = host === 'claude' ? claudeProjectRoot(env) : undefined;
  let rawInput;
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    rawInput = input;
    const eventName = input.hook_event_name ?? input.hookEventName ?? input.event_name ?? input.eventName;
    if (eventName === 'PostToolUse') {
      const event = normalizeEvent(input);
      if (host === 'claude' && event.toolName.startsWith('mcp__')) {
        if (policy.mode === 'apply' && !isSandoMcpTool(event.toolName)) {
          failureStage = 'mcp';
          const bounded = boundMcpContent({ event, input, policy, env });
          if (bounded) {
            process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
              hookEventName: 'PostToolUse', updatedMCPToolOutput: bounded,
            } })}\n`);
            return;
          }
        }
        process.stdout.write('{}\n');
        return;
      }
      failureStage = 'redaction';
      const redactionProfile = policy.redact ? loadProjectRedactionProfile(event.cwd).profile : undefined;
      failureStage = 'optimization';
      const optimization = optimizeToolOutput({ toolName: event.toolName, toolInput: event.toolInput, output: event.output, cwd: event.cwd, policy, redactionProfile, recoveryStyle: host === 'claude' ? 'mcp' : undefined });
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
      // On Claude in apply mode the model sees `shaped`, or the untouched original when nothing was
      // emitted; account for what was delivered, so unchanged output never claims savings.
      const claudeApply = host === 'claude' && policy.mode === 'apply';
      let deliveredOptimization = shaped !== undefined
        ? accountDeliveredValue(optimization, shaped)
        : claudeApply ? accountDeliveredValue(optimization, event.output) : optimization;
      let fallback;
      if (host === 'codex' && policy.mode === 'apply' && env.SANDO_CODEX_FALLBACK === 'feedback') {
        fallback = buildCodexFallback({ optimization, cwd: event.cwd });
        deliveredOptimization = accountDeliveredValue(optimization, fallback);
      }
      failureStage = 'output';
      const receipt = createReceipt({
        host, event, optimization: deliveredOptimization,
        replacement: fallback ?? shaped ?? (claudeApply ? event.output : undefined),
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
    const detail = error?.code === 'SANDO_REDACTION_CONFIG' ? `invalid redaction config: ${error.message}`
      : error?.code === 'SANDO_OUTPUT_BUDGET' ? `output budget: ${error.message}` : undefined;
    if (detail) process.stderr.write(`sando ${detail}\n`);
    if (host === 'claude' && policy.mode === 'apply'
      && (rawInput?.hook_event_name ?? rawInput?.hookEventName) === 'PostToolUse') {
      try {
        const safe = failClosedOutput(rawInput.tool_response, {
          toolName: String(rawInput.tool_name ?? ''), cwd: rawInput.cwd, policy,
          code: error?.code ?? 'internal error',
        });
        if (safe) {
          process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', ...safe } })}\n`);
          return;
        }
      } catch { /* fall through to the unmodified result */ }
    }
    if (error?.code === 'SANDO_REDACTION_CONFIG') process.exitCode = 2;
    else if (error?.code === 'SANDO_OUTPUT_BUDGET') {
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
    maxInlineBytes: optimization.deliveryBudget ?? maxInlineBytes,
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

function shapeForClaude({ original, optimization, toolName, toolInput, cwd, policy, redactionProfile }) {
  if (typeof original === 'string') {
    return materialize(optimization, cwd, policy.maxInlineBytes).inline;
  }
  if (!original || typeof original !== 'object' || Array.isArray(original)
    || !Object.hasOwn(original, 'stdout') || !Object.hasOwn(original, 'stderr')
    || typeof original.stdout !== 'string' || typeof original.stderr !== 'string'
    || (Object.hasOwn(original, 'interrupted') && typeof original.interrupted !== 'boolean')
    || (Object.hasOwn(original, 'isImage') && typeof original.isImage !== 'boolean')) return undefined;
  let result = { ...original };
  let otherRedactions = 0;
  if (policy.redact) {
    // stdout and stderr are redacted by the optimizer below; everything else goes through the profile here.
    const redacted = redactionProfile.redactStructured({ ...original, stdout: '', stderr: '' });
    result = { ...redacted.value, stdout: original.stdout, stderr: original.stderr };
    otherRedactions = redacted.count;
  }
  if (typeof original.stdout === 'string') {
    result.stdout = materialize(
      optimizeToolOutput({ toolName, toolInput, output: original.stdout, cwd, policy, redactionProfile, recoveryStyle: 'mcp' }),
      cwd, policy.maxInlineBytes,
    ).inline;
  }
  if (typeof original.stderr === 'string') {
    result.stderr = materialize(
      optimizeToolOutput({ toolName, toolInput, output: original.stderr, cwd, policy, redactionProfile, recoveryStyle: 'mcp' }),
      cwd, policy.maxInlineBytes,
    ).inline;
  }
  if (otherRedactions > 0 && !result.stdout.endsWith(DISPLAY_REDACTION_NOTICE)) {
    result.stdout = `${result.stdout}\n${DISPLAY_REDACTION_NOTICE}`;
  }
  return result;
}
