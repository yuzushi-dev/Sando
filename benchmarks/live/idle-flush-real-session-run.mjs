#!/usr/bin/env node
/**
 * Live validation of `cacheIdleFlushMs` (context-transform.mjs) using a REAL, already
 * idle Claude Code transcript instead of a synthetic wait: any transcript with a real
 * gap past the idle-flush threshold is, by the time we replay it today, unambiguously
 * cache-cold on the real API too (the transcript is days/weeks old). Sending it fresh
 * makes both variants below start from zero cache — exactly the condition idle-flush
 * is meant to detect live, just reached by calendar time instead of a stopwatch.
 *
 * Reconstructs the real message history up to the first message after that gap, then
 * sends it live twice:
 *   protected — Sando's transform WITHOUT idleMs (ratio guard only: today's shipped
 *               default before this session's idle-flush addition)
 *   flushed   — Sando's transform WITH idleMs set to the transcript's own recorded gap
 *               (idle-flush enabled: what the guard does now)
 * Both are genuinely cache-cold today, so any cost difference between them is exactly
 * what idle-flush buys over the ratio-only guard — not a cache-hit artifact.
 *
 * Requires --confirm-cost. Cheap: haiku, two calls, real conversation content already
 * sent once for real work.
 *
 * Run: node benchmarks/live/idle-flush-real-session-run.mjs --confirm-cost [transcript.jsonl]
 * With no path, scans ~/.claude/projects for the first transcript whose real idle gap
 * would have left rewrite candidates ratio-protected but idle-flush-eligible.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { transformProviderRequest } from '../../packages/sando/index.mjs';
import { readClaudeOAuthCredential } from './semantic-api-adapter.mjs';
import { IDLE_FLUSH_MS, loadMessages } from '../rewrite-payback-probe.mjs';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-haiku-4-5';
const USER_AGENT = 'claude-cli/2.1.233 (external, cli)';
const MARK = { type: 'ephemeral', ttl: '1h' };

/** Anthropic bills: base input 1x, 1h cache write 2x, cache read 0.1x. */
function billedUnits(usage) {
  return usage.inputTokens + usage.cacheWriteTokens * 2 + usage.cacheReadTokens * 0.1;
}

function usageOf(data) {
  const usage = data?.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

async function callApi({ accessToken, body }) {
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
      'User-Agent': USER_AGENT,
      'x-app': 'cli',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`anthropic api failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return response.json();
}

/** Anthropic requires strict user/assistant alternation; a transcript may log the
 *  same logical turn as consecutive same-role JSONL lines (e.g. a tool_use line and
 *  a following text line). Merge them. */
function mergeConsecutiveRoles(messages) {
  const merged = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) last.content = [...last.content, ...message.content];
    else merged.push({ role: message.role, content: [...message.content], timestamp: message.timestamp });
  }
  return merged;
}

/** The largest real gap in the transcript, if it clears the idle-flush threshold. */
function largestGap(messages) {
  let best = { index: -1, gapMs: 0 };
  for (let index = 1; index < messages.length; index += 1) {
    const a = messages[index - 1].timestamp;
    const b = messages[index].timestamp;
    if (a === null || b === null) continue;
    const gapMs = b - a;
    if (gapMs > best.gapMs) best = { index, gapMs };
  }
  return best.gapMs >= IDLE_FLUSH_MS ? best : null;
}

/** Trim trailing messages to end on a 'user' message (Anthropic requires the last
 *  message to be role 'user'). Truncating at the gap itself would cut away the very
 *  later tool calls that supersede an earlier one — the point of this probe is the
 *  request sent once the conversation has *resumed and continued*, not the first
 *  message back, so keep everything through the end of the transcript instead. */
function trimToUserEnd(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages.slice(0, index + 1);
  }
  return null;
}

function candidateHistory(file, { maxTokens = 130_000 } = {}) {
  const raw = loadMessages(file);
  if (raw.length < 20) return null;
  const merged = mergeConsecutiveRoles(raw);
  const gap = largestGap(merged);
  if (!gap) return null;
  const history = trimToUserEnd(merged);
  if (!history || history.length < 4) return null;
  const anchorTs = merged[gap.index - 1]?.timestamp;
  const lastTs = history[history.length - 1]?.timestamp;
  if (anchorTs === null || lastTs === null || anchorTs === undefined || lastTs === undefined) return null;
  // Real elapsed time from just before the pause through to the final message sent —
  // definitionally >= the raw gap, and the honest idleMs for "this exact request,
  // reconstructed and replayed fresh."
  const idleMs = lastTs - anchorTs;
  if (idleMs < IDLE_FLUSH_MS) return null;
  if (JSON.stringify(history).length / 4 > maxTokens) return null;
  return { history, idleMs, file };
}

function findCandidate(explicitPath) {
  if (explicitPath) {
    const found = candidateHistory(explicitPath);
    if (!found) throw new Error(`${explicitPath} has no idle gap >= ${IDLE_FLUSH_MS / 60_000}min with a well-formed cutoff`);
    return found;
  }
  const root = path.join(os.homedir(), '.claude', 'projects');
  const projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const dir of projectDirs) {
    const dirPath = path.join(root, dir.name);
    for (const entry of fs.readdirSync(dirPath)) {
      if (!entry.endsWith('.jsonl')) continue;
      const found = candidateHistory(path.join(dirPath, entry));
      if (found) return found;
    }
  }
  throw new Error('no transcript found with a usable idle gap');
}

function withBreakpoint(messages) {
  const clone = structuredClone(messages).map(({ role, content }) => ({ role, content }));
  const lastMessage = clone[clone.length - 1];
  lastMessage.content[lastMessage.content.length - 1].cache_control = MARK;
  return clone;
}

/** The real history references whatever tools the original client had declared. The
 *  API validates tool_use blocks against a `tools` array, so stub one permissive
 *  declaration per distinct name actually used — content and behavior don't matter,
 *  we never let the model call anything (max_tokens caps it to a short text reply). */
function stubToolsFor(messages) {
  const names = new Set();
  for (const message of messages) {
    for (const block of message.content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') names.add(block.name);
    }
  }
  return [...names].map((name) => ({
    name,
    description: 'stub',
    input_schema: { type: 'object', additionalProperties: true },
  }));
}

async function main() {
  if (!process.argv.includes('--confirm-cost')) throw new Error('idle-flush live probe requires --confirm-cost');
  const explicitPath = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const candidate = findCandidate(explicitPath);

  const tools = stubToolsFor(candidate.history);
  const protectedResult = transformProviderRequest({
    provider: 'anthropic',
    body: { model: MODEL, messages: withBreakpoint(candidate.history), tools },
    policy: { maxHistoryTokens: 60_000 },
  });
  const flushedResult = transformProviderRequest({
    provider: 'anthropic',
    body: { model: MODEL, messages: withBreakpoint(candidate.history), tools },
    policy: { maxHistoryTokens: 60_000 },
    idleMs: candidate.idleMs,
  });

  const { accessToken } = await readClaudeOAuthCredential();
  const protectedBody = { ...protectedResult.body, max_tokens: 16 };
  const flushedBody = { ...flushedResult.body, max_tokens: 16 };
  const [protectedResponse, flushedResponse] = await Promise.all([
    callApi({ accessToken, body: protectedBody }),
    callApi({ accessToken, body: flushedBody }),
  ]);

  const protectedUsage = usageOf(protectedResponse);
  const flushedUsage = usageOf(flushedResponse);
  const protectedUnits = billedUnits(protectedUsage);
  const flushedUnits = billedUnits(flushedUsage);

  process.stdout.write(`${JSON.stringify({
    schema: 'sando-idle-flush-real-session/v1',
    transcript: candidate.file,
    historyMessages: candidate.history.length,
    idleMs: candidate.idleMs,
    protected: { stats: protectedResult.stats, usage: protectedUsage, billedUnits: protectedUnits },
    flushed: { stats: flushedResult.stats, usage: flushedUsage, billedUnits: flushedUnits },
    savedByIdleFlushPercent: 100 * (protectedUnits - flushedUnits) / protectedUnits,
  }, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`idle-flush live probe: ${error.message}\n`); process.exitCode = 1; });
