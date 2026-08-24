import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCHEMA = 'sando-coverage/v1';
const VERSION = 1;
const BUCKETS = ['eligible', 'routed', 'transformed', 'blocked', 'bypassed'];
const WAIT_MS = 10;
const LOCK_ATTEMPTS = 250;
const STALE_LOCK_MS = 30_000;

function emptyState() {
  return {
    schema: SCHEMA,
    version: VERSION,
    counts: Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])),
    byReason: {},
    events: [],
  };
}

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return value;
}

function coveragePath(storagePath, env) {
  if (storagePath !== undefined) return absolute(storagePath, 'coverage path');
  const stateHome = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(absolute(stateHome, 'state directory'), 'sando', 'codex-coverage.json');
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('coverage directory is unsafe');
  fs.chmodSync(directory, 0o700);
}

function waitForLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_MS);
}

function withLock(lockPath, operation) {
  let handle;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      handle = fs.openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) fs.rmSync(lockPath, { force: true });
      else waitForLock();
    }
  }
  if (handle === undefined) throw new Error('coverage lock timeout');
  try { return operation(); }
  finally {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  }
}

function validateState(value) {
  if (!value || typeof value !== 'object' || value.schema !== SCHEMA || value.version !== VERSION
    || !value.counts || typeof value.counts !== 'object' || Array.isArray(value.counts)
    || !value.byReason || typeof value.byReason !== 'object' || Array.isArray(value.byReason)
    || !Array.isArray(value.events)) throw new Error('coverage state is invalid');
  for (const bucket of BUCKETS) {
    if (!Number.isSafeInteger(value.counts[bucket]) || value.counts[bucket] < 0) throw new Error('coverage count is invalid');
  }
  return value;
}

function readState(filePath) {
  if (!fs.existsSync(filePath)) return emptyState();
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('coverage file is unsafe');
  try { return validateState(JSON.parse(fs.readFileSync(filePath, 'utf8'))); }
  catch (error) { throw new Error(error instanceof Error && error.message === 'coverage state is invalid' ? error.message : 'coverage state is invalid'); }
}

function writeState(filePath, state) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function normalizedBuckets(buckets) {
  if (!Array.isArray(buckets) || !buckets.length || buckets.some((bucket) => !BUCKETS.includes(bucket))) {
    throw new Error('coverage buckets are invalid');
  }
  return [...new Set(buckets)];
}

export function defaultCoveragePath(env = process.env) {
  return coveragePath(env.SANDO_COVERAGE_PATH, env);
}

export function readCoverage(storagePath, env = process.env) {
  return readState(coveragePath(storagePath ?? env.SANDO_COVERAGE_PATH, env));
}

export function recordCoverage({ buckets, reason, route = null, toolName = 'Bash', storagePath, env = process.env, now = new Date() } = {}) {
  const selected = normalizedBuckets(buckets);
  if (typeof reason !== 'string' || !/^[a-z0-9-]{1,64}$/.test(reason)) throw new Error('coverage reason is invalid');
  if (route !== null && (typeof route !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(route))) throw new Error('coverage route is invalid');
  if (typeof toolName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(toolName)) throw new Error('coverage tool is invalid');
  const filePath = coveragePath(storagePath ?? env.SANDO_COVERAGE_PATH, env);
  ensureDirectory(path.dirname(filePath));
  return withLock(`${filePath}.lock`, () => {
    const state = readState(filePath);
    for (const bucket of selected) state.counts[bucket] += 1;
    state.byReason[reason] = (state.byReason[reason] || 0) + 1;
    state.events.push({ at: new Date(now).toISOString(), buckets: selected, reason, route, toolName });
    if (state.events.length > 64) state.events.splice(0, state.events.length - 64);
    writeState(filePath, state);
    return state;
  });
}
