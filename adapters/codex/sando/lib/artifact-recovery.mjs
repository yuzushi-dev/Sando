import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const ARTIFACT_RECOVERY_SCHEMA = 'sando-artifact-recovery/v1';
export const ARTIFACT_RECOVERY_VERSION = 1;
export const MAX_RECOVERY_BYTES = 1_048_576;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

function digest(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function handleDigest(ref) {
  const match = typeof ref === 'string' && ref.match(/^sando:(sha256:[a-f0-9]{16,64})$/);
  if (!match) throw new TypeError('artifact handle is invalid');
  return match[1];
}

function integer(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new TypeError(`${name} is invalid`);
  return value;
}

function continuation(byte) { return (byte & 0xc0) === 0x80; }

function safeBufferText(buffer, start, end) {
  if (start > 0 && continuation(buffer[start])) throw new RangeError('byte range splits UTF-8');
  if (end < buffer.length && continuation(buffer[end])) throw new RangeError('byte range splits UTF-8');
  return buffer.subarray(start, end).toString('utf8');
}

function prefix(buffer, limit) {
  let end = Math.min(buffer.length, limit);
  while (end > 0 && end < buffer.length && continuation(buffer[end])) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: end < buffer.length };
}

export function recoverArtifactContent({
  ref, content, digest: expectedDigest, sourceBytes, startByte, endByte, startLine, endLine, maxBytes,
} = {}) {
  const handlePrefix = handleDigest(ref).slice('sha256:'.length);
  const handle = ref;
  if (typeof content !== 'string') throw new TypeError('artifact content is invalid');
  const actualDigest = digest(content);
  if (expectedDigest !== undefined && expectedDigest !== actualDigest) throw new Error('artifact digest integrity check failed');
  const full = Buffer.from(content, 'utf8');
  if (!actualDigest.slice('sha256:'.length).startsWith(handlePrefix)) throw new Error('artifact handle does not match content');
  const limit = maxBytesValue(maxBytes);
  const byteMode = startByte !== undefined || endByte !== undefined;
  const lineMode = startLine !== undefined || endLine !== undefined;
  if (byteMode && lineMode) throw new TypeError('artifact range is ambiguous');
  let selected;
  let range;
  if (byteMode) {
    const start = integer(startByte ?? 0, 'startByte');
    const end = integer(endByte ?? full.length, 'endByte');
    if (start > end || end > full.length) throw new RangeError('artifact byte range is invalid');
    selected = safeBufferText(full, start, end);
    range = { type: 'bytes', start, end };
  } else if (lineMode) {
    const start = integer(startLine ?? 1, 'startLine', { positive: true });
    const end = integer(endLine ?? start, 'endLine', { positive: true });
    const lines = content.split('\n');
    if (start > end || start > lines.length || end > lines.length) throw new RangeError('artifact line range is invalid');
    selected = lines.slice(start - 1, end).join('\n');
    range = { type: 'lines', start, end };
  } else {
    selected = content;
    range = { type: 'all' };
  }
  const selectedBuffer = Buffer.from(selected, 'utf8');
  const bounded = prefix(selectedBuffer, limit);
  const totalSourceBytes = integer(sourceBytes ?? full.length, 'sourceBytes');
  if (totalSourceBytes !== full.length) throw new Error('artifact source byte metadata is inconsistent');
  return {
    schema: ARTIFACT_RECOVERY_SCHEMA,
    version: ARTIFACT_RECOVERY_VERSION,
    handle,
    digest: actualDigest,
    content: bounded.text,
    bytes: Buffer.byteLength(bounded.text),
    sourceBytes: totalSourceBytes,
    range,
    truncated: bounded.truncated,
  };
}

function maxBytesValue(value) {
  const result = value ?? 65_536;
  integer(result, 'maxBytes', { positive: true });
  if (result > MAX_RECOVERY_BYTES) throw new RangeError('maxBytes exceeds recovery limit');
  return result;
}

function safeDirectory(target, name) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${name} is unavailable or unsafe`);
}

export function recoverArtifactFromWorkspace({ cwd, ref, ...range } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new TypeError('artifact cwd is invalid');
  const root = fs.realpathSync(cwd);
  if (!fs.statSync(root).isDirectory()) throw new TypeError('artifact cwd is not a directory');
  const stateRoot = path.join(root, '.sando');
  const privateRoot = path.join(stateRoot, 'sando');
  const directory = path.join(privateRoot, 'artifacts');
  safeDirectory(stateRoot, 'artifact state');
  safeDirectory(privateRoot, 'artifact private state');
  safeDirectory(directory, 'artifact directory');
  const digestPrefix = handleDigest(ref).slice('sha256:'.length);
  const candidates = fs.readdirSync(directory)
    .filter((entry) => /^[a-f0-9]{64}\.txt$/.test(entry) && entry.startsWith(digestPrefix));
  if (candidates.length !== 1) throw new Error(candidates.length ? 'artifact handle is ambiguous' : 'artifact handle is unavailable');
  const digestValue = `sha256:${candidates[0].slice(0, -'.txt'.length)}`;
  const target = path.join(directory, candidates[0]);
  const relative = path.relative(directory, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('artifact path escapes directory');
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('artifact handle is unavailable');
    if (stat.size > MAX_ARTIFACT_BYTES) throw new RangeError('artifact exceeds recovery limit');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(descriptor));
    return recoverArtifactContent({ ref, content, digest: digestValue, ...range });
  } catch (error) {
    if (['ELOOP', 'ENOENT'].includes(error?.code)) throw new Error('artifact handle is unavailable', { cause: error });
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
