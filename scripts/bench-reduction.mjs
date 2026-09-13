#!/usr/bin/env node
// Measures what Sando removes from a tool result, over a corpus anyone already has: the files of
// a real repository. Synthetic fixtures make the optimizer look better than it is (a repetitive
// log truncates to almost nothing), so the corpus here is whatever the target tree actually
// contains, at whatever mix of sources, logs and data it actually has.
//
// What this measures: the append-time surface, one result at a time. It does NOT measure what a
// session costs -- that depends on the tool mix and on prompt-cache economics, and is not a
// number this script can produce.
//
//   node scripts/bench-reduction.mjs [path] [--min-bytes N] [--all-files] [--json]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { optimizeToolOutput } from '../packages/sando/src/core.mjs';

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.sando', '.sando_smoke_state', 'dist', 'build', 'coverage', '__pycache__', '.venv']);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const CONTEXT_WINDOW_TOKENS = 200_000;

function parseArgs(argv) {
  const options = { target: process.cwd(), minBytes: 1024, json: false, allFiles: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--all-files') options.allFiles = true;
    else if (argv[i] === '--min-bytes') { options.minBytes = Number(argv[i + 1]); i += 1; }
    else positional.push(argv[i]);
  }
  if (positional.length) options.target = path.resolve(positional[0]);
  if (!Number.isInteger(options.minBytes) || options.minBytes < 1) throw new Error('--min-bytes requires a positive integer');
  return options;
}

// Tracked files are the corpus by default: untracked and ignored paths differ from machine to
// machine, so including them means nobody reproduces anybody else's number. Inside a git
// checkout the corpus is exactly what the commit contains.
function trackedFiles(root) {
  try {
    const listing = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const files = listing.split('\0').filter(Boolean).map((entry) => path.join(root, entry));
    return files.length ? files : null;
  } catch {
    return null;
  }
}

function* walk(root) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRECTORIES.has(entry.name)) pending.push(full); continue; }
      if (entry.isFile()) yield full;
    }
  }
}

// A NUL byte in the first 8 KB is the usual heuristic for "not text". Reading a binary as UTF-8
// would charge the corpus a replacement-character cost that no real tool result pays.
function readTextFile(file, size) {
  const handle = fs.openSync(file, 'r');
  try {
    const probe = Buffer.alloc(Math.min(8192, size));
    fs.readSync(handle, probe, 0, probe.length, 0);
    if (probe.includes(0)) return null;
  } finally {
    fs.closeSync(handle);
  }
  return fs.readFileSync(file, 'utf8');
}

function emptyBucket() {
  return { files: 0, reduced: 0, inputTokens: 0, inlineTokens: 0 };
}

function run({ target, minBytes, allFiles }) {
  const byExtension = new Map();
  const totals = emptyBucket();
  const ratios = [];
  const perFile = [];
  const tracked = allFiles ? null : trackedFiles(target);
  const corpus = tracked ?? walk(target);

  for (const file of corpus) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile() || stat.size < minBytes || stat.size > MAX_FILE_BYTES) continue;

    let content;
    try { content = readTextFile(file, stat.size); } catch { continue; }
    if (content === null) continue;

    const relative = path.relative(target, file).split(path.sep).join('/');
    const result = optimizeToolOutput({
      toolName: 'Read', output: content, cwd: target, toolInput: { file_path: relative },
    });

    // estimatedInlineTokens covers the whole payload that reaches the model, disclosure line
    // included, so the envelope is charged against the saving rather than hidden.
    const before = result.stats.estimatedInputTokens;
    const after = result.stats.estimatedInlineTokens;
    const extension = path.extname(relative).toLowerCase() || '(none)';
    const bucket = byExtension.get(extension) ?? emptyBucket();

    bucket.files += 1;
    bucket.inputTokens += before;
    bucket.inlineTokens += after;
    totals.files += 1;
    totals.inputTokens += before;
    totals.inlineTokens += after;
    if (after < before) { bucket.reduced += 1; totals.reduced += 1; }
    ratios.push(before > 0 ? (before - after) / before : 0);
    perFile.push({ before, after });

    byExtension.set(extension, bucket);
  }

  ratios.sort((a, b) => a - b);
  const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0;
  return {
    byExtension, totals, median, ratios,
    capacity: capacity(perFile, CONTEXT_WINDOW_TOKENS),
    source: tracked ? 'git ls-files' : 'directory walk',
  };
}

// How many of these files can be read before a context window is full. This is the claim that
// matters more than the percentage: not that reading is cheaper, but that more of the repository
// fits before the session runs out of room. Files are consumed in `git ls-files` order, so the
// count is deterministic for a given commit.
function capacity(perFile, windowTokens) {
  const fill = (key) => {
    let used = 0;
    for (const [index, entry] of perFile.entries()) {
      used += entry[key];
      if (used > windowTokens) return index;
    }
    return perFile.length;
  };
  const without = fill('before');
  const With = fill('after');
  // When the whole corpus fits, the window never filled: the count is bounded by how many files
  // exist, not by how many fit, so the ratio understates the gain.
  return { windowTokens, without, with: With, corpusFiles: perFile.length, windowFilled: With < perFile.length };
}

function rho(bucket) {
  return bucket.inputTokens > 0 ? (bucket.inputTokens - bucket.inlineTokens) / bucket.inputTokens : 0;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function report({ byExtension, totals, median, source, capacity: room }, options) {
  if (!totals.files) {
    console.log(`No text file of at least ${options.minBytes} bytes under ${options.target}.`);
    return;
  }
  const rows = [...byExtension.entries()]
    .sort((a, b) => b[1].inputTokens - a[1].inputTokens)
    .slice(0, 12);

  console.log(`corpus: ${options.target} (${source})`);
  console.log(`files >= ${options.minBytes} B: ${totals.files}\n`);
  console.log('| extension | files | reduced | tokens in | tokens out | rho |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const [extension, bucket] of rows) {
    console.log(`| ${extension} | ${bucket.files} | ${bucket.reduced} | ${bucket.inputTokens} | ${bucket.inlineTokens} | ${percent(rho(bucket))} |`);
  }
  console.log(`| **all** | **${totals.files}** | **${totals.reduced}** | **${totals.inputTokens}** | **${totals.inlineTokens}** | **${percent(rho(totals))}** |`);
  console.log(`\ntoken-weighted rho: ${percent(rho(totals))}`);
  console.log(`fires on:           ${percent(totals.reduced / totals.files)} of files (${totals.reduced}/${totals.files})`);
  console.log(`median file rho:    ${percent(median)}`);
  const cap = room.windowFilled
    ? `${room.with} files`
    : `all ${room.with} files, without filling the window`;
  console.log(`\nreads before a ${room.windowTokens.toLocaleString('en-US')}-token context fills:`);
  console.log(`  without sando: ${room.without} files`);
  console.log(`  with sando:    ${cap}`);
  console.log('\nReduction is per-result, append-time. The capacity figure counts independent reads');
  console.log('against a bare window: it is a ceiling on how much fits, not a session cost or a');
  console.log('billing figure -- prompts, replies and cache economics are not modelled here.');
}

const options = parseArgs(process.argv.slice(2));
const measured = run(options);
if (options.json) {
  console.log(JSON.stringify({
    corpus: options.target,
    corpusSource: measured.source,
    minBytes: options.minBytes,
    files: measured.totals.files,
    reducedFiles: measured.totals.reduced,
    inputTokens: measured.totals.inputTokens,
    inlineTokens: measured.totals.inlineTokens,
    weightedRho: rho(measured.totals),
    fireRate: measured.totals.reduced / measured.totals.files,
    medianRho: measured.median,
    capacity: measured.capacity,
    byExtension: Object.fromEntries([...measured.byExtension].map(([key, value]) => [key, { ...value, rho: rho(value) }])),
  }, null, 2));
} else {
  report(measured, options);
}
