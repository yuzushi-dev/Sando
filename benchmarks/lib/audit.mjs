import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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

function currentCommit(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

function defaultEnvironment() {
  return { node: process.version, platform: process.platform, arch: process.arch, cwd: process.cwd() };
}

export function auditMetadata({
  host, variant, prompt, args = [], result = {}, commit, resolvedModel, clientVersion,
  now = new Date().toISOString(), environment, measurement = {}, cwd,
} = {}) {
  if (!['claude', 'codex', 'local'].includes(host) || !['baseline', 'optimized'].includes(variant)) {
    throw new TypeError('invalid audit identity');
  }
  const promptDigest = digestPrompt(prompt);
  const stdout = redactStream(result.stdout);
  const stderr = redactStream(result.stderr);
  return {
    timestamp: now,
    commit: commit ?? currentCommit(cwd),
    promptDigest,
    args: args.map((arg) => arg === prompt ? `<prompt:${promptDigest}>` : redactText(arg)),
    resolvedModel: resolvedModel ?? null,
    clientVersion: clientVersion ?? null,
    environment: environment ?? defaultEnvironment(),
    raw: { stdout: stdout.text, stderr: stderr.text },
    rawTruncated: { stdout: stdout.truncated, stderr: stderr.truncated },
    measurement: {
      mode: measurement.mode ?? 'prompt-level',
      hookEndToEnd: measurement.hookEndToEnd ?? false,
      ...measurement,
    },
  };
}
