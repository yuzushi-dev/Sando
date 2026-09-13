import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function safeDirectory(target) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('history artifact directory is unsafe');
  if (!stat) fs.mkdirSync(target, { mode: 0o700 });
}

function storedBytes(directory, destination) {
  let total = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.txt$/.test(name)) continue;
    const target = path.join(directory, name);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) {
      throw new Error('history artifact directory contains an unsafe entry');
    }
    if (target !== destination) total += stat.size;
  }
  return total;
}

export function prepareHistoryArtifact({ root, content } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('history archive root must be an absolute path');
  if (typeof content !== 'string') throw new TypeError('history artifact content is invalid');
  const canonicalRoot = fs.realpathSync(root);
  if (!fs.statSync(canonicalRoot).isDirectory()) throw new TypeError('history archive root is not a directory');
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_ARTIFACT_BYTES) throw new RangeError('history artifact exceeds recovery limit');
  const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const ref = `sando:${digest}`;
  const artifactPath = path.join(canonicalRoot, '.sando', 'sando', 'artifacts', `${digest.slice('sha256:'.length)}.txt`);
  const lines = content.split('\n').length;
  const firstPageEnd = Math.min(80, lines);
  return {
    root: canonicalRoot,
    content,
    bytes,
    digest,
    ref,
    marker: `[sando archived result ${ref}; ${bytes}B, ${lines} lines; use rtk grep -n on archive ${shellQuote(artifactPath)}; full exact text: use native Read on the archive file; optional first page: sando artifact get --root ${shellQuote(canonicalRoot)} --ref ${ref} --start-line 1 --end-line ${firstPageEnd} --max-bytes 8192; bounded, continue with valid line ranges up to ${lines}]`,
  };
}

export function persistHistoryArtifact(artifact) {
  if (!artifact || typeof artifact.root !== 'string' || typeof artifact.content !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') || artifact.ref !== `sando:${artifact.digest}`) {
    throw new TypeError('history artifact is invalid');
  }
  const stateRoot = path.join(artifact.root, '.sando');
  const privateRoot = path.join(stateRoot, 'sando');
  const directory = path.join(privateRoot, 'artifacts');
  for (const target of [stateRoot, privateRoot, directory]) safeDirectory(target);
  const name = `${artifact.digest.slice('sha256:'.length)}.txt`;
  const destination = path.join(directory, name);
  if (storedBytes(directory, destination) + artifact.bytes > MAX_ARCHIVE_BYTES) {
    throw new Error('history artifact archive is full');
  }
  const temporary = path.join(directory, `.${name}.${process.pid}.${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, artifact.content, { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, destination); }
    catch (error) {
      if (error?.code !== 'EEXIST' || fs.readFileSync(destination, 'utf8') !== artifact.content) throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  fs.chmodSync(destination, 0o600);
  return artifact;
}
