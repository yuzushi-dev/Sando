import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let output = '';
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

export function digestPrompt(prompt) {
  if (typeof prompt !== 'string') throw new TypeError('prompt must be a string');
  return `sha256:${createHash('sha256').update(prompt).digest('hex')}`;
}

function redactText(value) {
  return String(value ?? '')
    .replace(/((?:api[_-]?key|authorization|password|secret|private[_-]?key)\s*[:=]\s*)(?!\[REDACTED\])\S+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|gh[pousr])-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
}

export function redactStream(value, maxBytes = 32_768) {
  const redacted = redactText(value);
  return { text: truncateUtf8(redacted, maxBytes), truncated: Buffer.byteLength(redacted) > maxBytes };
}

function gitTopLevel(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}

function currentCommit(root = process.cwd()) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

function frame(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length).update(bytes);
}

function sameStat(left, right) {
  return ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs']
    .every((field) => String(left[field]) === String(right[field]));
}

function modeOf(stat) {
  return (Number(stat.mode) & 0o7777).toString(8).padStart(4, '0');
}

function gitOutput(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
  });
}

function baselineEntry(root, relative) {
  const sources = [
    { args: ['ls-files', '--stage', '-z', '--', relative], tree: false },
    { args: ['ls-tree', '-r', '-z', 'HEAD', '--', relative], tree: true },
  ];
  for (const source of sources) {
    let output;
    try { output = gitOutput(root, source.args); } catch { continue; }
    const records = output.toString('utf8').split('\0').filter(Boolean);
    if (records.length > 1) throw new Error('ambiguous Git baseline entry');
    if (!records.length) continue;
    const separator = records[0].indexOf('\t');
    if (separator < 0) throw new Error('invalid Git baseline entry');
    const fields = records[0].slice(0, separator).split(' ');
    const mode = fields[0];
    const object = fields[source.tree ? 2 : 1];
    if (!mode || !object || !/^\d{6}$/.test(mode)) throw new Error('invalid Git baseline entry');
    if (!['100644', '100755', '120000'].includes(mode)) throw new Error('unsupported Git baseline entry');
    const value = gitOutput(root, ['cat-file', 'blob', object]);
    return {
      type: mode === '120000' ? 'symlink' : 'file',
      mode: mode.slice(-4),
      value,
    };
  }
  throw new Error('missing Git baseline entry');
}

function workingTreeEntry(root, relative, deleted) {
  const absolute = path.join(root, relative);
  let before;
  try {
    before = fs.lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!deleted) throw new Error('racy missing entry');
    const entry = baselineEntry(root, relative);
    return { ...entry, type: 'deleted' };
  }
  if (before.isSymbolicLink()) {
    const value = fs.readlinkSync(absolute, 'buffer');
    const after = fs.lstatSync(absolute, { bigint: true });
    if (!sameStat(before, after)) throw new Error('racy symlink entry');
    return { type: 'symlink', mode: modeOf(before), value };
  }
  if (!before.isFile()) throw new Error('unsupported working-tree entry');
  const value = fs.readFileSync(absolute);
  const after = fs.lstatSync(absolute, { bigint: true });
  if (!sameStat(before, after)) throw new Error('racy file entry');
  return { type: 'file', mode: modeOf(before), value };
}

function statusPaths(status) {
  const fields = status.split('\0').filter(Boolean);
  const paths = new Map();
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record.length < 3) throw new Error('invalid Git status entry');
    const code = record.slice(0, 2);
    paths.set(record.slice(3), code.includes('D'));
    if (code.includes('R') || code.includes('C')) {
      const original = fields[++index];
      if (!original) throw new Error('invalid Git rename entry');
      paths.set(original, code.includes('R'));
    }
  }
  return [...paths.entries()]
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([relative, deleted]) => ({ relative, deleted }));
}

function workingTreeProvenance(root = process.cwd()) {
  try {
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '-z'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    if (!status) return { dirty: false, diffDigest: null, status: 'clean' };

    try {
      const digest = createHash('sha256');
      frame(digest, 'sando-working-tree/v1');
      for (const { relative, deleted } of statusPaths(status)) {
        const entry = workingTreeEntry(root, relative, deleted);
        frame(digest, relative);
        frame(digest, entry.type);
        frame(digest, entry.mode);
        frame(digest, entry.value);
      }
      return { dirty: true, diffDigest: `sha256:${digest.digest('hex')}`, status: 'dirty-digest' };
    } catch {
      return { dirty: true, diffDigest: null, status: 'unknown' };
    }
  } catch {
    return { dirty: null, diffDigest: null, status: 'unknown' };
  }
}

function defaultEnvironment() {
  return { node: process.version, platform: process.platform, arch: process.arch, cwd: process.cwd() };
}

export function auditMetadata({
  host, variant, prompt, args = [], result = {}, commit, resolvedModel, clientVersion,
  scenarioDigest, now = new Date().toISOString(), environment, measurement = {}, cwd,
} = {}) {
  if (!['claude', 'codex', 'local'].includes(host) || !['baseline', 'optimized'].includes(variant)) {
    throw new TypeError('invalid audit identity');
  }
  const promptDigest = digestPrompt(prompt);
  const stdout = redactStream(result.stdout);
  const stderr = redactStream(result.stderr);
  const root = gitTopLevel(cwd) ?? cwd ?? process.cwd();
  const provenance = workingTreeProvenance(root);
  const normalizedMeasurement = {
    mode: measurement.mode ?? 'prompt-level',
    hookEndToEnd: measurement.hookEndToEnd ?? false,
    ...measurement,
  };
  const endToEnd = ['end-to-end', 'end-to-end-tools'].includes(normalizedMeasurement.mode);
  if (!['local-replay', 'prompt-level', 'end-to-end', 'end-to-end-tools'].includes(normalizedMeasurement.mode)
    || typeof normalizedMeasurement.hookEndToEnd !== 'boolean'
    || endToEnd !== normalizedMeasurement.hookEndToEnd) {
    throw new TypeError('invalid measurement metadata');
  }
  return {
    host,
    variant,
    timestamp: now,
    commit: commit ?? currentCommit(root),
    workingTreeDirty: provenance.dirty,
    diffDigest: provenance.diffDigest,
    workingTreeProvenance: provenance.status,
    promptDigest,
    scenarioDigest: scenarioDigest ?? null,
    args: args.map((arg) => arg === prompt ? `<prompt:${promptDigest}>` : redactText(arg)),
    resolvedModel: resolvedModel ?? null,
    clientVersion: clientVersion ?? null,
    environment: environment ?? defaultEnvironment(),
    raw: { stdout: stdout.text, stderr: stderr.text },
    rawTruncated: { stdout: stdout.truncated, stderr: stderr.truncated },
    measurement: normalizedMeasurement,
  };
}
