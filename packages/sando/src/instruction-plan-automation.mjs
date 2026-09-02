import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildInstructionPlan } from './instruction-plan.mjs';
import { PLUGIN_VERSION } from './version.mjs';

export const F2_AUTOMATION_SCHEMA = 'sando-f2-automation/v1';
export const F2_AUTOMATION_VERSION = 1;

const DELTA_FIELDS = Object.freeze([
  'files', 'blocks', 'instructionBytes', 'alwaysOnBlocks', 'alwaysOnBytes',
  'onDemandBlocks', 'onDemandBytes', 'duplicateBlocks', 'duplicateBytes',
  'unknownBlocks', 'unknownBytes', 'proposalCount', 'proposedBytes',
]);
const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 250;
const STALE_LOCK_MS = 30_000;
const RUN_LIMIT = 366;
const RUN_STATUSES = new Set(['recorded', 'unchanged', 'error']);

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`F2 state has invalid ${name}`);
  return value;
}

function signedInteger(value, name) {
  if (!Number.isSafeInteger(value)) throw new Error(`F2 state has invalid ${name}`);
  return value;
}

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return value;
}

function timestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('F2 timestamp is invalid');
  return date.toISOString();
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('F2 state directory is unsafe');
  fs.chmodSync(directory, 0o700);
}

function assertRegularFile(filePath) {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('F2 state file is unsafe');
}

function waitForLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
}

function withLock(lockPath, operation) {
  let handle;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      handle = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(handle, `${process.pid}\n`);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) fs.rmSync(lockPath, { force: true });
      else waitForLock();
    }
  }
  if (handle === undefined) throw new Error('F2 state lock timeout');
  try { return operation(); }
  finally {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  }
}

function atomicWrite(filePath, value) {
  assertRegularFile(filePath);
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filePath);
    renamed = true;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (!renamed) fs.rmSync(temporary, { force: true });
  }
}

function emptyState() {
  return { schema: F2_AUTOMATION_SCHEMA, version: F2_AUTOMATION_VERSION, records: [], runs: [] };
}

function validDigest(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validateSummary(summary) {
  if (!summary || typeof summary !== 'object') throw new Error('F2 state summary is invalid');
  for (const field of DELTA_FIELDS) integer(summary[field], `summary.${field}`);
  return summary;
}

function errorKind(error) {
  if (error?.code === 'ENOENT') return 'missing-root';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission-denied';
  const message = String(error?.message ?? error).toLowerCase();
  if (message.includes('too many')) return 'limits-exceeded';
  if (message.includes('state')) return 'invalid-state';
  return 'scan-failed';
}

function validateRunResult(result) {
  if (!result || typeof result.root !== 'string' || !path.isAbsolute(result.root)
    || !RUN_STATUSES.has(result.status)) throw new Error('F2 run result is invalid');
  integer(result.durationMs, 'run result durationMs');
  if (result.status === 'error') {
    if (typeof result.errorKind !== 'string' || !result.errorKind) throw new Error('F2 run error kind is invalid');
    return result;
  }
  if (!validDigest(result.fingerprint)) throw new Error('F2 run fingerprint is invalid');
  validateSummary(result.summary);
  return result;
}

function validateRun(run) {
  if (!run || typeof run.runId !== 'string' || !run.runId || typeof run.scannedAt !== 'string'
    || Number.isNaN(new Date(run.scannedAt).getTime()) || !Array.isArray(run.results)) {
    throw new Error('F2 run is invalid');
  }
  integer(run.durationMs, 'run durationMs');
  run.results.forEach(validateRunResult);
  return run;
}

function safeRunResult(result) {
  const value = { root: result.root, status: result.status, durationMs: result.durationMs };
  if (result.fingerprint !== undefined) value.fingerprint = result.fingerprint;
  if (result.sandoVersion !== undefined) value.sandoVersion = result.sandoVersion;
  if (result.summary !== undefined) value.summary = result.summary;
  if (result.errorKind !== undefined) value.errorKind = result.errorKind;
  return value;
}

function validateState(state) {
  if (!state || state.schema !== F2_AUTOMATION_SCHEMA || state.version !== F2_AUTOMATION_VERSION
    || !Array.isArray(state.records)) throw new Error('F2 state is invalid');
  for (const record of state.records) {
    if (!record || typeof record.root !== 'string' || !path.isAbsolute(record.root)
      || !validDigest(record.fingerprint) || typeof record.scannedAt !== 'string'
      || Number.isNaN(new Date(record.scannedAt).getTime()) || typeof record.sandoVersion !== 'string') {
      throw new Error('F2 state record is invalid');
    }
    integer(record.durationMs, 'durationMs');
    validateSummary(record.summary);
    if (record.delta !== null) {
      for (const field of DELTA_FIELDS) signedInteger(record.delta[field], `delta.${field}`);
    }
  }
  const runs = state.runs ?? [];
  if (!Array.isArray(runs)) throw new Error('F2 runs are invalid');
  runs.forEach(validateRun);
  return { ...state, runs };
}

export function defaultF2AutomationPath(env = process.env) {
  const configured = env.SANDO_F2_AUTOMATION_PATH;
  if (configured !== undefined) return absolute(configured, 'F2 state path');
  const stateHome = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  absolute(stateHome, 'state directory');
  return path.join(stateHome, 'sando', 'f2', 'automation.json');
}

export function readF2AutomationState(storagePath = defaultF2AutomationPath()) {
  const filePath = absolute(storagePath, 'F2 state path');
  if (!fs.existsSync(filePath)) return emptyState();
  assertRegularFile(filePath);
  try { return validateState(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
  catch (error) {
    if (error?.message?.startsWith('F2 state')) throw error;
    throw new Error('F2 state is invalid');
  }
}

function summaryOf(report) {
  const value = report.summary;
  return {
    files: integer(report.files.length, 'files'),
    blocks: integer(report.blocks.length, 'blocks'),
    instructionBytes: integer(value.instructionBytes, 'instructionBytes'),
    alwaysOnBlocks: integer(value.alwaysOnBlocks, 'alwaysOnBlocks'),
    alwaysOnBytes: integer(value.alwaysOnBytes, 'alwaysOnBytes'),
    onDemandBlocks: integer(value.onDemandBlocks, 'onDemandBlocks'),
    onDemandBytes: integer(value.onDemandBytes, 'onDemandBytes'),
    duplicateBlocks: integer(value.duplicateBlocks, 'duplicateBlocks'),
    duplicateBytes: integer(value.duplicateBytes, 'duplicateBytes'),
    unknownBlocks: integer(value.unknownBlocks, 'unknownBlocks'),
    unknownBytes: integer(value.unknownBytes, 'unknownBytes'),
    proposalCount: integer(report.proposals.length, 'proposalCount'),
    proposedBytes: integer(value.proposedBytes, 'proposedBytes'),
  };
}

function deltaOf(previous, current) {
  if (!previous) return null;
  return Object.fromEntries(DELTA_FIELDS.map((field) => [field, current[field] - previous[field]]));
}

function latestFor(state, root) {
  return [...state.records].reverse().find((record) => record.root === root) ?? null;
}

function rootLabel(value) {
  if (typeof value !== 'string' || !value) throw new Error('F2 root is invalid');
  return path.resolve(value);
}

export function runF2Automation({
  roots,
  statePath = defaultF2AutomationPath(),
  force = false,
  now = new Date(),
  sandoVersion = PLUGIN_VERSION,
} = {}) {
  if (!Array.isArray(roots) || roots.length === 0) throw new Error('at least one F2 root is required');
  if (typeof sandoVersion !== 'string' || !sandoVersion) throw new Error('F2 Sando version is invalid');
  const filePath = absolute(statePath, 'F2 state path');
  const scannedAt = timestamp(now);
  const uniqueRoots = [...new Set(roots.map(rootLabel))];
  ensureDirectory(path.dirname(filePath));

  return withLock(`${filePath}.lock`, () => {
    const state = readF2AutomationState(filePath);
    const runId = randomUUID();
    const runStarted = Date.now();
    const results = [];
    let changed = false;

    for (const inputRoot of uniqueRoots) {
      const started = Date.now();
      try {
        const root = fs.realpathSync(inputRoot);
        const report = buildInstructionPlan({ root, host: 'both' });
        const summary = summaryOf(report);
        const previous = latestFor(state, root);
        const unchanged = previous?.fingerprint === report.provenanceDigest && !force;
        if (unchanged) {
          results.push({ root, status: 'unchanged', fingerprint: report.provenanceDigest, summary,
            durationMs: Math.max(0, Date.now() - started), sandoVersion });
          continue;
        }
        const record = {
          root,
          fingerprint: report.provenanceDigest,
          scannedAt,
          durationMs: Math.max(0, Date.now() - started),
          sandoVersion,
          summary,
          delta: deltaOf(previous?.summary, summary),
        };
        state.records.push(record);
        results.push({ ...record, status: 'recorded' });
        changed = true;
      } catch (error) {
        results.push({
          root: inputRoot,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          errorKind: errorKind(error),
          durationMs: Math.max(0, Date.now() - started),
        });
      }
    }

    const run = {
      runId,
      scannedAt,
      durationMs: Math.max(0, Date.now() - runStarted),
      results: results.map(safeRunResult),
    };
    state.runs.push(run);
    if (state.runs.length > RUN_LIMIT) state.runs = state.runs.slice(-RUN_LIMIT);
    if (changed || state.runs.length > 0) atomicWrite(filePath, state);
    return { schema: F2_AUTOMATION_SCHEMA, version: F2_AUTOMATION_VERSION, scannedAt, results, run, state };
  });
}

function usage() {
  return 'Usage: sando context f2-auto --root DIR [--root DIR ...] [--state PATH] [--force] [--json]\n';
}

function parseArgs(argv) {
  const result = { roots: [], statePath: undefined, force: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--json') result.json = true;
    else if (argument === '--force') result.force = true;
    else if (argument === '--root' || argument === '--state') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      if (argument === '--root') result.roots.push(value);
      else result.statePath = value;
      index += 1;
    } else throw new Error('unknown F2 automation option');
  }
  if (!result.help && result.roots.length === 0) throw new Error('--root is required');
  return result;
}

function formatRun(result) {
  const counts = Object.groupBy(result.results, (item) => item.status);
  const lines = [`Sando F2 auto: recorded=${counts.recorded?.length ?? 0}; unchanged=${counts.unchanged?.length ?? 0}; errors=${counts.error?.length ?? 0}`];
  for (const item of result.results) {
    if (item.status === 'error') lines.push(`- error ${item.root}: ${item.error}`);
    else lines.push(`- ${item.status} ${item.root}: ${item.summary.proposedBytes}B proposed, ${item.summary.unknownBytes}B unknown`);
  }
  return `${lines.join('\n')}\n`;
}

export function runF2AutomationCli({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) { stdout.write(usage()); return null; }
    const result = runF2Automation({
      roots: options.roots,
      statePath: options.statePath === undefined ? defaultF2AutomationPath(env) : path.resolve(options.statePath),
      force: options.force,
    });
    const output = { schema: result.schema, version: result.version, scannedAt: result.scannedAt, results: result.results };
    stdout.write(options.json ? `${JSON.stringify(output, null, 2)}\n` : formatRun(result));
    return result;
  } catch (error) {
    stderr.write(`sando context f2-auto: ${error instanceof Error ? error.message : String(error)}\n${usage()}`);
    process.exitCode = 2;
    return null;
  }
}
