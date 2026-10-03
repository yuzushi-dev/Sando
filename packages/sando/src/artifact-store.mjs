import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { recoverArtifactContent, recoverArtifactFromWorkspace, validateArtifactHandle } from './artifact-recovery.mjs';
import { cleanupArtifacts, reuseArtifact } from './artifact-lifecycle.mjs';

const MAX_ARTIFACTS = 128;
const MAX_STORED_BYTES = 64 * 1024 * 1024;
const store = new Map();
let storedBytes = 0;

function artifactPresent(target) {
  let stat;
  try { stat = fs.lstatSync(target); } catch { return false; }
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  try { return fs.realpathSync(target) === target; } catch { return false; }
}

export function storeArtifactInWorkspace({ cwd, artifact, workspaceRoot = cwd } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)
    || typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)
    || !artifact || typeof artifact.content !== 'string'
    || typeof artifact.sourceDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(artifact.sourceDigest)) {
    throw new TypeError('workspace artifact input is invalid');
  }
  const cwdRoot = fs.realpathSync(cwd);
  const root = fs.realpathSync(workspaceRoot);
  if (!fs.statSync(root).isDirectory()) throw new TypeError('artifact workspace root is not a directory');
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
    try { fs.linkSync(temporary, destination); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      reuseArtifact(destination, artifact.content);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  cleanupArtifacts(directory, { preserveName: name });
  if (!artifactPresent(destination)) throw new Error('artifact storage limit removed the new artifact');
  return root === cwdRoot ? path.posix.join('.sando/sando', 'artifacts', name) : destination;
}

export function rememberArtifact(artifact) {
  if (!artifact || typeof artifact.ref !== 'string' || typeof artifact.content !== 'string') throw new TypeError('artifact is invalid');
  const bytes = Buffer.byteLength(artifact.content);
  if (bytes > MAX_STORED_BYTES) throw new RangeError('artifact exceeds in-process recovery limit');
  const previous = store.get(artifact.ref);
  if (previous) storedBytes -= previous.bytes;
  store.delete(artifact.ref);
  while (store.size >= MAX_ARTIFACTS || storedBytes + bytes > MAX_STORED_BYTES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    storedBytes -= store.get(oldest).bytes;
    store.delete(oldest);
  }
  store.set(artifact.ref, {
    content: artifact.content,
    digest: artifact.sourceDigest,
    sourceBytes: artifact.sourceBytes ?? artifact.bytes,
    bytes,
  });
  storedBytes += bytes;
}

export function recoverStoredArtifact(options = {}) {
  validateArtifactHandle(options.ref);
  const entry = store.get(options.ref);
  if (!entry) throw new Error('artifact handle is unavailable in this MCP session');
  store.delete(options.ref);
  store.set(options.ref, entry);
  return recoverArtifactContent({ ...options, ...entry });
}

// In-process store first; on a miss, the artifacts hooks wrote under the workspace's .sando
// directory. `cwd` comes from the server, never from the tool arguments. The workspace path
// enforces the hex-prefix length, a single match, no symlinks, and a full SHA-256 check.
const RECOVERY_ARGUMENTS = new Set(['ref', 'startByte', 'endByte', 'startLine', 'endLine', 'maxBytes']);

export function recoverArtifact(options = {}, { cwd } = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('arguments must be an object');
  for (const key of Object.keys(options)) {
    if (!RECOVERY_ARGUMENTS.has(key)) throw new TypeError(`unknown argument: ${key}`);
  }
  try {
    return recoverStoredArtifact(options);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'artifact handle is unavailable in this MCP session') throw error;
    return recoverArtifactFromWorkspace({ ...options, cwd });
  }
}

export function exposeMcpResult(result) {
  if (!result?.artifact) return result;
  rememberArtifact(result.artifact);
  const { content: _content, ...artifact } = result.artifact;
  return { ...result, artifact };
}
