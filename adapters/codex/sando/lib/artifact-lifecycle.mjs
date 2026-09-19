import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

export function reuseArtifact(destination, expectedContent) {
  const { O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (!Number.isInteger(O_NOFOLLOW) || !Number.isInteger(O_NONBLOCK)) {
    throw new Error('artifact storage requires no-follow open support');
  }
  const flags = fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
  const handle = fs.openSync(destination, flags);
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('artifact file is unsafe');
    if (fs.readFileSync(handle, 'utf8') !== expectedContent) throw new Error('artifact content differs');
    fs.fchmodSync(handle, 0o600);
  } finally {
    fs.closeSync(handle);
  }
}

function validNumber(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`);
  return value;
}

function safeArtifact(directory, name) {
  if (!/^[a-f0-9]{64}\.txt$/.test(name)) return null;
  const target = path.join(directory, name);
  let link;
  try { link = fs.lstatSync(target); } catch { return null; }
  if (!link.isFile() || link.isSymbolicLink()) return null;
  let resolved;
  try { resolved = fs.realpathSync(target); } catch { return null; }
  if (resolved !== target) return null;
  let stat;
  try { stat = fs.statSync(target); } catch { return null; }
  return { target, name, bytes: stat.size, mtimeMs: stat.mtimeMs };
}

export function cleanupArtifacts(
  directory,
  {
    now = Date.now(), ttlMs = DEFAULT_ARTIFACT_TTL_MS,
    maxBytes = DEFAULT_ARTIFACT_MAX_BYTES, preserveName = null,
  } = {},
) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('artifact directory is invalid');
  validNumber(now, 'now');
  validNumber(ttlMs, 'ttlMs');
  validNumber(maxBytes, 'maxBytes');
  if (preserveName !== null && !/^[a-f0-9]{64}\.txt$/.test(preserveName)) {
    throw new TypeError('preserveName is invalid');
  }
  const directoryStat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('artifact directory is unsafe');

  const entries = fs.readdirSync(directory).map((name) => safeArtifact(directory, name)).filter(Boolean);
  const expired = entries.filter((entry) => now - entry.mtimeMs >= ttlMs);
  const keep = entries.filter((entry) => !expired.includes(entry));
  let totalBytes = keep.reduce((total, entry) => total + entry.bytes, 0);
  const removals = [...expired, ...keep.sort((left, right) => {
    if (left.name === preserveName) return 1;
    if (right.name === preserveName) return -1;
    return left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name);
  })];
  let removed = 0;
  let removedBytes = 0;
  for (const entry of removals) {
    if (expired.includes(entry) || totalBytes > maxBytes) {
      try {
        const current = safeArtifact(directory, entry.name);
        if (!current || current.target !== entry.target) continue;
        fs.rmSync(current.target);
        removed += 1;
        removedBytes += current.bytes;
        if (!expired.includes(entry)) totalBytes -= current.bytes;
      } catch { /* cleanup is best-effort and never follows unresolved targets */ }
    }
  }
  return { removed, removedBytes, retainedBytes: Math.max(0, totalBytes) };
}
