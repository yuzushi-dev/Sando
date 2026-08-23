#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { auditMetadata } from '../lib/audit.mjs';
import { estimateTokens, summarizeRuns } from '../lib/metrics.mjs';
import { loadScenario } from '../lib/replay.mjs';
import { buildClaudeArgs, buildCodexArgs, formatChildFailure, hasOkStatus, parseClaudeUsage, parseCodexUsage } from './adapters.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function requireConfirmation() {
  if (!process.argv.includes('--confirm-cost')) throw new Error('live benchmark requires --confirm-cost');
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout: Buffer.concat(stdout).toString('utf8'), stderr: `${Buffer.concat(stderr).toString('utf8')}\n${error.message}` });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

function promptFor(context) {
  return [
    'This is a token accounting benchmark.',
    'Do not call tools. If the supplied context is non-empty, reply exactly with JSON: {"status":"ok"}.',
    'Supplied context:',
    context,
  ].join('\n\n');
}

async function writeReport({ destination, host, clientVersion, scenario, runs, failure }) {
  const firstAudit = runs.find((run) => run.audit)?.audit;
  const resolvedModel = runs.find((run) => run.audit?.resolvedModel)?.audit.resolvedModel ?? null;
  const output = {
    schema: 'sando-live-benchmark/v2',
    status: failure ? 'failed' : 'passed',
    host,
    clientVersion,
    model: resolvedModel ?? option('model', 'default'),
    scenario: scenario.id,
    audit: {
      schema: 'sando-audit/v1',
      generatedAt: new Date().toISOString(),
      commit: firstAudit?.commit ?? null,
      environment: firstAudit?.environment ?? null,
      clientVersion,
      modelRequested: option('model', 'default'),
      resolvedModel,
      measurement: { mode: 'prompt-level', hookEndToEnd: false },
      note: 'This run measures provider usage for a prepared prompt. It does not prove transparent hook rewriting.',
    },
    runs,
    summary: failure ? null : summarizeRuns(runs),
    ...(failure ? { failure } : {}),
  };
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

function failureRun({ host, scenario, repetition, variant, prompt, args, result, clientVersion, message }) {
  return {
    host, scenario: scenario.id, repetition, variant,
    inputTokens: 0, uncachedInputTokens: 0, cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0,
    promptEstimate: estimateTokens(prompt), responseBytes: Buffer.byteLength(result.stdout ?? ''),
    latencyMs: 0, quality: 'fail',
    promptDigest: auditMetadata({ host, variant, prompt, args, result, clientVersion }).promptDigest,
    audit: auditMetadata({
      host, variant, prompt, args, result, clientVersion,
      measurement: { mode: 'prompt-level', hookEndToEnd: false, reason: 'Live run failed before a valid provider usage/quality result.' },
    }),
    error: message,
  };
}

async function main() {
  requireConfirmation();
  const host = option('host');
  if (!['claude', 'codex'].includes(host)) throw new Error('--host must be claude or codex');
  if (host === 'claude' && !option('max-budget-usd')) throw new Error('Claude live benchmark requires --max-budget-usd');
  const repetitions = Number(option('repetitions', '2'));
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('--repetitions must be 1..10');
  const scenario = await loadScenario(path.join(ROOT, 'benchmarks', 'fixtures', option('scenario', 'terminal-noise') + '.json'));
  const destination = path.resolve(option('out', path.join(ROOT, 'benchmarks', 'results', `live-${host}.json`)));
  const requestedClientVersion = option('client-version');
  const versionProbe = requestedClientVersion ? null : await runCommand(host, ['--version'], 10_000);
  const clientVersion = requestedClientVersion
    ?? versionProbe?.stdout.trim().split('\n').find(Boolean)
    ?? 'unresolved';
  const core = await import('../../packages/sando/src/core.mjs');
  if (typeof core.optimizeToolOutput !== 'function') throw new Error('sando core must export optimizeToolOutput');
  const runs = [];

  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    for (const variant of ['baseline', 'optimized']) {
      const contexts = [];
      for (const event of scenario.events) {
        const result = variant === 'baseline' ? { inline: event.output } : await core.optimizeToolOutput({
          toolName: event.toolName,
          output: event.output,
          cwd: ROOT,
          runId: `live-${scenario.id}-${repetition}`,
          policy: { mode: 'apply' },
        });
        if (!result || typeof result.inline !== 'string') throw new Error(`no inline output for ${event.id}`);
        contexts.push(result.inline);
      }
      const prompt = promptFor(contexts.join('\n\n'));
      const args = host === 'claude'
        ? buildClaudeArgs({ prompt, model: option('model'), maxBudgetUsd: option('max-budget-usd') })
        : buildCodexArgs({ prompt, model: option('model') });
      if (host === 'claude' && variant === 'optimized' && option('claude-plugin-dir')) {
        args.splice(-1, 0, '--plugin-dir', path.resolve(option('claude-plugin-dir')));
      }
      const started = Date.now();
      const result = await runCommand(host, args, Number(option('timeout-ms', '120000')));
      if (result.code !== 0) {
        const message = formatChildFailure(host, variant, result);
        const failed = failureRun({ host, scenario, repetition, variant, prompt, args, result, clientVersion, message });
        runs.push(failed);
        await writeReport({ destination, host, clientVersion, scenario, runs, failure: { variant, repetition, message, audit: failed.audit } });
        throw new Error(message);
      }
      let usage;
      try { usage = host === 'claude' ? parseClaudeUsage(result.stdout) : parseCodexUsage(result.stdout); }
      catch (error) {
        const message = `${host} ${variant} usage parse failed: ${error instanceof Error ? error.message : String(error)}`;
        const failed = failureRun({ host, scenario, repetition, variant, prompt, args, result, clientVersion, message });
        runs.push(failed);
        await writeReport({ destination, host, clientVersion, scenario, runs, failure: { variant, repetition, message, audit: failed.audit } });
        throw new Error(message);
      }
      if (!usage) {
        const message = `${host} ${variant} returned no usage counters`;
        const failed = failureRun({ host, scenario, repetition, variant, prompt, args, result, clientVersion, message });
        runs.push(failed);
        await writeReport({ destination, host, clientVersion, scenario, runs, failure: { variant, repetition, message, audit: failed.audit } });
        throw new Error(message);
      }
      const quality = hasOkStatus(result.stdout) ? 'pass' : 'fail';
      if (quality !== 'pass') {
        const message = `${host} ${variant} failed the response quality check`;
        const failed = failureRun({ host, scenario, repetition, variant, prompt, args, result, clientVersion, message });
        runs.push(failed);
        await writeReport({ destination, host, clientVersion, scenario, runs, failure: { variant, repetition, message, audit: failed.audit } });
        throw new Error(message);
      }
      const audit = auditMetadata({
        host, variant, prompt, args, result, cwd: ROOT,
        resolvedModel: usage.resolvedModel ?? (option('model') || null),
        clientVersion,
        measurement: {
          mode: 'prompt-level',
          hookEndToEnd: false,
          reason: 'The prompt contains prepared context and disables tool calls; provider usage is not a hook lifecycle measurement.',
        },
      });
      runs.push({
        host,
        scenario: scenario.id,
        repetition,
        variant,
        inputTokens: usage.inputTokens,
        uncachedInputTokens: usage.uncachedInputTokens ?? usage.inputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        promptEstimate: estimateTokens(prompt),
        responseBytes: Buffer.byteLength(result.stdout),
        latencyMs: Date.now() - started,
        quality,
        promptDigest: audit.promptDigest,
        audit,
      });
    }
  }

  const output = await writeReport({ destination, host, clientVersion, scenario, runs });
  process.stdout.write(`${JSON.stringify({ destination, summary: output.summary }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`live benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
