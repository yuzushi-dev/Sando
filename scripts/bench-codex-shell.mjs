#!/usr/bin/env node
// What L3 would actually deliver. Wrapping every shell command in `sando exec` reaches a >90%
// ceiling, but the wrapper is not free: it prepends a status envelope to every result, including
// the majority that are already under every cap. This measures the net over a corpus of real
// Codex rollouts, against the two things it must beat:
//
//   raw       — today: nothing is routed, every byte reaches the model
//   wrapped   — L3 as `runExec` behaves once the command is forwarded to the router
//
//   node scripts/bench-codex-shell.mjs [rolloutDir]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { optimizeToolOutput } from '../packages/sando/src/core.mjs';

const CMD = /cmd:\s*"((?:[^"\\]|\\.)*)"/;

// Mirrors the envelope `runExec` writes around a captured process (cli.mjs).
function envelope(output) {
  return `[sando exec exit_code=0 signal=none timed_out=false tty=false]\nstdout:\n${output}\nstderr:\n`;
}

function* rollouts(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield full;
    }
  }
}

function* shellResults(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  const calls = new Map();
  for (const line of text.split('\n')) {
    if (!line.includes('"response_item"')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record.payload ?? {};
    if (payload.type === 'custom_tool_call' && payload.name === 'exec') {
      const match = CMD.exec(payload.input ?? '');
      if (!match) continue;
      let command = match[1];
      try { command = JSON.parse(`"${match[1]}"`); } catch {}
      calls.set(payload.call_id, command);
    } else if (payload.type === 'custom_tool_call_output' && calls.has(payload.call_id)) {
      const command = calls.get(payload.call_id);
      const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
      calls.delete(payload.call_id);
      if (output) yield { command, output };
    }
  }
}

const root = path.resolve(process.argv[2] ?? path.join(os.homedir(), '.codex/sessions'));
const cwd = process.cwd();
let results = 0;
let raw = 0;
let wrapped = 0;
let inflated = 0;
let inflatedBy = 0;

for (const file of rollouts(root)) {
  for (const { command, output } of shellResults(file)) {
    results += 1;
    const before = Math.ceil(Buffer.byteLength(output, 'utf8') / 4);
    raw += before;
    let optimized;
    try {
      optimized = optimizeToolOutput({ toolName: 'Bash', output: envelope(output), cwd, toolInput: { command } });
    } catch {
      wrapped += before;
      continue;
    }
    const after = optimized.stats.estimatedInlineTokens;
    wrapped += after;
    if (after > before) { inflated += 1; inflatedBy += after - before; }
  }
}

const percent = (value) => `${(value * 100).toFixed(2)}%`;
const n = (value) => value.toLocaleString('it-IT');
console.log(`corpus                       ${root}`);
console.log(`risultati shell              ${n(results)}`);
console.log(`token oggi (nulla instradato) ${n(raw)}`);
console.log(`token con L3                 ${n(wrapped)}`);
console.log(`NETTO                        ${percent((raw - wrapped) / raw)}  (${n(raw - wrapped)} token)`);
console.log(`risultati peggiorati dall'envelope: ${n(inflated)} (${percent(inflated / results)}), costo ${n(inflatedBy)} token`);
