import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA = 'sando-active-session/v1';
const VERSION = 1;
const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 250;
const STALE_LOCK_MS = 30_000;

export const ACTIVE_SESSION_SCHEMA = SCHEMA;
export const ACTIVE_SESSION_VERSION = VERSION;

function text(value) { return typeof value === 'string' && value.length > 0; }
function pane(value) { return text(value) && /^%\d+$/.test(value); }
function pid(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function emptyState() { return { schema: SCHEMA, version: VERSION, entries: [] }; }

function resolvePath(storagePath) {
  if (typeof storagePath !== 'string' || !path.isAbsolute(storagePath)) {
    throw new Error('active session path must be absolute');
  }
  return storagePath;
}

function validateState(value) {
  if (!value || typeof value !== 'object' || value.schema !== SCHEMA
    || value.version !== VERSION || !Array.isArray(value.entries)) {
    throw new Error('active session state is invalid');
  }
  const panes = new Set();
  for (const entry of value.entries) {
    if (!pane(entry.paneId) || !text(entry.sessionId) || pid(entry.panePid) === null
      || typeof entry.updatedAt !== 'string' || Number.isNaN(Date.parse(entry.updatedAt))) {
      throw new Error('active session entry is invalid');
    }
    if (panes.has(entry.paneId)) throw new Error('active session state contains duplicate panes');
    panes.add(entry.paneId);
  }
  return value;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('active session directory is unsafe');
  fs.chmodSync(directory, 0o700);
}

function waitForLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
}

function withLock(lockPath, operation) {
  let handle;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try { handle = fs.openSync(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) fs.rmSync(lockPath, { force: true });
      else waitForLock();
    }
  }
  if (handle === undefined) throw new Error('active session lock timeout');
  try { return operation(); }
  finally { fs.closeSync(handle); fs.rmSync(lockPath, { force: true }); }
}

function atomicWrite(filePath, value) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, filePath); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  fs.chmodSync(filePath, 0o600);
}

export function defaultActiveSessionPath(env = process.env) {
  const configured = env.SANDO_ACTIVE_SESSION_PATH;
  if (configured !== undefined) return resolvePath(configured);
  const stateHome = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  if (!path.isAbsolute(stateHome)) throw new Error('state directory must be absolute');
  return path.join(stateHome, 'sando', 'active-sessions.json');
}

export function readActiveSessions(storagePath = defaultActiveSessionPath()) {
  const filePath = resolvePath(storagePath);
  if (!fs.existsSync(filePath)) return emptyState();
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('active session file is unsafe');
  return validateState(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function currentTmuxPanePid(paneId, env = process.env) {
  if (!pane(paneId)) return null;
  const configured = pid(env.SANDO_CODEX_PANE_PID);
  if (configured !== null) return configured;
  try {
    return pid(execFileSync('tmux', ['display-message', '-p', '-t', paneId, '#{pane_pid}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch {
    return null;
  }
}

export function recordActiveSession({ sessionId, paneId, panePid, storagePath = defaultActiveSessionPath(), now = new Date() } = {}) {
  if (!text(sessionId) || !pane(paneId) || pid(panePid) === null) return false;
  const filePath = resolvePath(storagePath);
  ensureDirectory(path.dirname(filePath));
  return withLock(`${filePath}.lock`, () => {
    const state = readActiveSessions(filePath);
    const entry = { paneId, panePid: pid(panePid), sessionId, updatedAt: new Date(now).toISOString() };
    const index = state.entries.findIndex((candidate) => candidate.paneId === paneId);
    if (index === -1) state.entries.push(entry);
    else state.entries[index] = entry;
    atomicWrite(filePath, state);
    return true;
  });
}

export function activeSessionForPane({ paneId, panePid, storagePath = defaultActiveSessionPath() } = {}) {
  if (!pane(paneId) || pid(panePid) === null) return undefined;
  try {
    const entry = readActiveSessions(storagePath).entries.find((candidate) => candidate.paneId === paneId);
    return entry && entry.panePid === pid(panePid) ? entry : undefined;
  } catch {
    return undefined;
  }
}
