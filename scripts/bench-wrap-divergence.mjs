#!/usr/bin/env node
// Differential harness: does `sando exec -- bash -lc '<cmd>'` preserve the semantics of running
// '<cmd>' natively? Output is *meant* to differ (that is the bound), so equality is checked on the
// invariants a session actually depends on:
//
//   exitCode      the value `&&` / `||` chains branch on
//   exitSignal    death by signal, native vs wrapped
//   stderrReach   whether text the command sent to stderr still reaches the caller at all
//   sideEffects   the working tree after the run, hashed
//   recoverable   native stdout+stderr bytes retrievable from what the wrap emitted
//
// Corpus is real recorded Codex commands, not invented ones.
//
//   node bench-wrap-divergence.mjs [rolloutDir] [--limit N] [--json]

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO, 'plugins/sando/bin/sando');
const CMD = /cmd:\s*"((?:[^"\\]|\\.)*)"/;

// ─── corpus extraction (same rollout shape as scripts/bench-codex-shell.mjs) ───

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

function* shellCommands(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (!line.includes('"custom_tool_call"')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record.payload ?? {};
    if (payload.type !== 'custom_tool_call' || payload.name !== 'exec') continue;
    const match = CMD.exec(payload.input ?? '');
    if (!match) continue;
    let command = match[1];
    try { command = JSON.parse(`"${match[1]}"`); } catch {}
    if (command) yield command;
  }
}

// ─── safety filter ───
//
// The harness EXECUTES these commands, so the filter is deliberately paranoid: an allowlist of
// read-only programs, and a rejection of anything that writes, deletes, escalates, reaches the
// network, or could block. A command is only run if EVERY program it invokes is allowlisted.

const READ_ONLY_PROGRAMS = new Set([
  'cat', 'head', 'tail', 'grep', 'rg', 'sed', 'awk', 'ls', 'find', 'wc', 'sort', 'uniq', 'cut',
  'tr', 'echo', 'printf', 'basename', 'dirname', 'realpath', 'stat', 'file', 'du', 'df', 'date',
  'pwd', 'env', 'which', 'test', 'true', 'false', 'seq', 'yes', 'jq', 'node', 'diff', 'md5sum',
  'sha256sum', 'nl', 'tee', 'xargs', 'column', 'fold', 'rev', 'comm', 'join', 'paste', 'expand',
]);

const FORBIDDEN = [
  /\brm\b/, /\bmv\b/, /\bcp\b/, /\bchmod\b/, /\bchown\b/, /\bmkdir\b/, /\btouch\b/, /\bln\b/,
  /\bsudo\b/, /\bsu\b/, /\bdd\b/, /\bkill\b/, /\bpkill\b/, /\bnpm\b/, /\bnpx\b/, /\bpip\b/,
  /\bgit\s+(push|commit|checkout|reset|clean|rebase|merge)\b/, /\bcurl\b/, /\bwget\b/, /\bssh\b/,
  /\bscp\b/, /\bnc\b/, /\bapt\b/, /\bdocker\b/, /\bsystemctl\b/, /\bcrontab\b/, /\bmake\b/,
  /\bcargo\b/, /\bgo\s+(build|run|install)\b/, /\bpytest\b/, /\bcodex\b/, /\bclaude\b/,
  />/, /\bsando\b/, /\bread\b/, /\bsleep\b/, /\$\(/, /`/, /\bexec\b/, /\bsource\b/, /\.\s/,
];

/** Programs a command invokes: the first word of the command and of each pipeline/list segment. */
function invokedPrograms(command) {
  return command
    .split(/\|\||&&|;|\||\n/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const withoutEnv = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
      return withoutEnv.split(/\s+/)[0]?.split('/').pop() ?? '';
    });
}

function isSafe(command) {
  if (command.length > 400 || command.includes('\0') || command.includes('\n')) return false;
  if (FORBIDDEN.some((pattern) => pattern.test(command))) return false;
  const programs = invokedPrograms(command);
  if (!programs.length) return false;
  return programs.every((program) => READ_ONLY_PROGRAMS.has(program));
}

// ─── fixture: an identical tree for each arm, so side effects are comparable ───

// The corpus commands reference real repository paths, so a synthetic tree would make most of
// them fail with ENOENT and the comparison would be between two ways of failing. The fixture is a
// copy of the Sando checkout's tracked files: the commands find what they were written to read.
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-divergence-'));
  execFileSync('bash', ['-c', `git -C ${JSON.stringify(REPO)} archive HEAD | tar -x -C ${JSON.stringify(dir)}`], { stdio: 'pipe' });
  // A few generic names the corpus reaches for that are not tracked here.
  fs.writeFileSync(path.join(dir, 'big.txt'), Array.from({ length: 5000 }, (_, i) => `line ${i} lorem ipsum dolor sit amet`).join('\n'));
  return dir;
}

/** Hash of the whole tree: relative path, size and content of every regular file. */
function treeHash(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full);
      if (relative === '.sando') continue;
      if (entry.isDirectory()) { hash.update(`d:${relative}\n`); walk(full); }
      else if (entry.isFile()) { hash.update(`f:${relative}:`); hash.update(fs.readFileSync(full)); hash.update('\n'); }
      else hash.update(`o:${relative}\n`);
    }
  };
  walk(dir);
  return hash.digest('hex');
}

// ─── the two arms ───

function runNative(command, cwd) {
  const result = spawnSync('bash', ['-lc', command], { cwd, encoding: 'buffer', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return {
    exitCode: result.status,
    exitSignal: result.signal ?? null,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

function runWrapped(command, cwd) {
  const result = spawnSync(CLI, ['exec', '--', 'bash', '-lc', command], { cwd, encoding: 'buffer', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return {
    exitCode: result.status,
    exitSignal: result.signal ?? null,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

/** Recover the full bytes the wrap stored, if it issued an artifact handle. */
function recoverArtifact(wrappedStdout, cwd) {
  const ref = /sando:sha256:[0-9a-f]{16,64}/.exec(wrappedStdout.toString('utf8'));
  if (!ref) return null;
  try {
    return execFileSync(CLI, ['artifact', 'get', '--root', cwd, '--ref', ref[0]], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
}

// ─── comparison ───

function compare(command, nativeDir, wrappedDir, baseline) {
  const native = runNative(command, nativeDir);
  const wrapped = runWrapped(command, wrappedDir);
  // A command the 30s harness timeout killed has no exit code to compare; counting it as a
  // divergence would report the harness's own limit as a product defect.
  const timedOut = native.exitCode === null || wrapped.exitCode === null;

  const nativeTree = treeHash(nativeDir);
  const wrappedTree = treeHash(wrappedDir);
  const wrappedText = wrapped.stdout.toString("utf8");

  // The two arms run in differently-named temp dirs, so a command that prints its own cwd
  // (`pwd`, `realpath`, `find` with absolute roots) would look divergent for a reason that has
  // nothing to do with the wrap. Both names collapse to the same placeholder first.
  const normalize = (text) => text.split(nativeDir).join('%FIXTURE%').split(wrappedDir).join('%FIXTURE%');

  const nativeStdout = normalize(native.stdout.toString('utf8'));
  const nativeStderr = normalize(native.stderr.toString('utf8'));
  const recovered = recoverArtifact(wrapped.stdout, wrappedDir);
  const haystack = normalize(`${wrappedText}\n${recovered ?? ''}`);

  // A sample of native stdout must still be reachable — either inline or via the artifact.
  const sample = nativeStdout.split('\n').filter((line) => line.trim().length > 12).slice(0, 3);
  const reachable = sample.length === 0 || sample.every((line) => haystack.includes(line.trim()));

  const stderrReach = nativeStderr.trim().length === 0
    || haystack.includes(nativeStderr.trim().split('\n')[0].trim());

  const checks = {
    exitCode: timedOut || native.exitCode === wrapped.exitCode,
    exitSignal: timedOut || native.exitSignal === wrapped.exitSignal,
    sideEffects: nativeTree === wrappedTree,
    treeUnchanged: nativeTree === baseline && wrappedTree === baseline,
    stdoutReachable: reachable,
    stderrReach,
    artifactIssued: recovered !== null,
  };

  return {
    command,
    checks,
    nativeExit: native.exitCode,
    wrappedExit: wrapped.exitCode,
    timedOut,
    nativeBytes: native.stdout.length + native.stderr.length,
    wrappedBytes: wrapped.stdout.length,
  };
}

// ─── probes ───
//
// The corpus is real traffic, which is exactly why it cannot find everything: the safety filter
// that makes it executable also excludes the shapes most likely to break. These probes target the
// three places reading cli.mjs said the wrap and the native run must differ, so the evidence
// covers them whether or not the corpus happens to contain one.

const PROBES = [
  { name: 'stdin-passthrough', command: 'cat', stdin: 'hello-from-stdin\n', expect: 'stdout carries the piped stdin' },
  { name: 'exit-code-plain', command: 'exit 42', expect: 'exit 42 propagates' },
  { name: 'exit-code-sigterm', command: 'kill -TERM $$', expect: 'SIGTERM reports 143, not a generic failure' },
  { name: 'exit-code-sigkill', command: 'kill -KILL $$', expect: 'SIGKILL reports 137, the OOM killer signature' },
  { name: 'binary-output', command: 'head -c 200 /dev/urandom', expect: 'binary bytes survive' },
  { name: 'stderr-only', command: 'echo to-stderr 1>&2', expect: 'stderr text reaches the caller' },
  { name: 'large-output', command: 'seq 1 20000', expect: 'bounded but fully recoverable' },
];

function runProbes() {
  const dir = makeFixture();
  const rows = [];
  for (const probe of PROBES) {
    const native = spawnSync('bash', ['-lc', probe.command], { cwd: dir, input: Buffer.from(probe.stdin ?? ''), encoding: 'buffer', timeout: 30_000 });
    const wrapped = spawnSync(CLI, ['exec', '--', 'bash', '-lc', probe.command], { cwd: dir, input: Buffer.from(probe.stdin ?? ''), encoding: 'buffer', timeout: 30_000 });
    const nativeOut = Buffer.concat([native.stdout ?? Buffer.alloc(0), native.stderr ?? Buffer.alloc(0)]);
    const wrappedText = (wrapped.stdout ?? Buffer.alloc(0)).toString('utf8');
    const recovered = recoverArtifact(wrapped.stdout ?? Buffer.alloc(0), dir) ?? '';
    const haystack = `${wrappedText}\n${recovered}`;

    // Native exit code as a shell reports it: signal death is 128 + signum.
    const nativeExit = native.signal ? 128 + (os.constants.signals[native.signal] ?? 0) : native.status;

    const printable = nativeOut.toString('utf8').split('\n').map((l) => l.trim()).filter((l) => l.length > 4);
    const contentReaches = printable.length === 0 || printable.slice(0, 2).every((line) => haystack.includes(line));

    rows.push({
      probe: probe.name,
      expect: probe.expect,
      nativeExit,
      wrappedExit: wrapped.status,
      exitMatches: nativeExit === wrapped.status,
      contentReaches,
      pass: nativeExit === wrapped.status && contentReaches,
    });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return rows;
}

// ─── run ───

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const limitFlag = args.indexOf('--limit');
const limit = limitFlag === -1 ? Infinity : Number(args[limitFlag + 1]);
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit');
const root = path.resolve(positional[0] ?? path.join(os.homedir(), '.codex/sessions'));

const seen = new Set();
let total = 0;
let filtered = 0;
for (const file of rollouts(root)) {
  for (const command of shellCommands(file)) {
    total += 1;
    if (seen.has(command)) continue;
    if (!isSafe(command)) { filtered += 1; continue; }
    seen.add(command);
  }
}

const corpus = [...seen].slice(0, limit);

// One fixture per arm, reused: a fresh git-archive extraction per command would dominate the
// runtime. `treeUnchanged` is checked every iteration, and a fixture that a command did modify is
// rebuilt before the next one so a single mutation cannot pollute the rest of the run.
let nativeDir = makeFixture();
let wrappedDir = makeFixture();
const baseline = treeHash(nativeDir);
const probes = runProbes();
const results = [];
for (const [index, command] of corpus.entries()) {
  results.push(compare(command, nativeDir, wrappedDir, baseline));
  if (!results.at(-1).checks.treeUnchanged) {
    fs.rmSync(nativeDir, { recursive: true, force: true });
    fs.rmSync(wrappedDir, { recursive: true, force: true });
    nativeDir = makeFixture();
    wrappedDir = makeFixture();
  }
  if (!asJson && (index + 1) % 100 === 0) process.stderr.write(`  … ${index + 1}/${corpus.length}\n`);
}
fs.rmSync(nativeDir, { recursive: true, force: true });
fs.rmSync(wrappedDir, { recursive: true, force: true });

const INVARIANTS = ['exitCode', 'exitSignal', 'sideEffects', 'treeUnchanged', 'stdoutReachable', 'stderrReach'];
const tally = Object.fromEntries(INVARIANTS.map((key) => [key, results.filter((r) => r.checks[key]).length]));
const divergent = results.filter((r) => INVARIANTS.some((key) => !r.checks[key]));

if (asJson) {
  console.log(JSON.stringify({
    corpus: root, commandsSeen: total, distinctSafe: seen.size, filteredUnsafe: filtered,
    tested: results.length, tally, divergent, probes,
  }, null, 2));
} else {
  console.log(`corpus                  ${root}`);
  console.log(`comandi shell visti     ${total}`);
  console.log(`distinti ed eseguibili  ${seen.size}  (scartati come non sicuri: ${filtered})`);
  console.log(`testati                 ${results.length}`);
  console.log('');
  for (const key of INVARIANTS) {
    const passed = tally[key];
    const mark = passed === results.length ? 'OK  ' : 'FAIL';
    console.log(`  ${mark} ${key.padEnd(16)} ${passed}/${results.length}`);
  }
  console.log('');
  console.log(`artifact emesso         ${results.filter((r) => r.checks.artifactIssued).length}/${results.length}`);
  console.log('');
  console.log('probe mirati (shape che il filtro di sicurezza esclude dal corpus):');
  for (const row of probes) {
    console.log(`  ${row.pass ? 'OK  ' : 'FAIL'} ${row.probe.padEnd(20)} exit ${String(row.nativeExit).padEnd(4)}-> ${String(row.wrappedExit).padEnd(4)} contenuto=${row.contentReaches ? 'raggiungibile' : 'PERSO'}  ${row.expect}`);
  }
  console.log(`comandi divergenti      ${divergent.length}`);
  for (const result of divergent.slice(0, 25)) {
    const failed = INVARIANTS.filter((key) => !result.checks[key]);
    console.log(`    [${failed.join(', ')}] exit ${result.nativeExit}->${result.wrappedExit}  ${result.command.slice(0, 90)}`);
  }
}
