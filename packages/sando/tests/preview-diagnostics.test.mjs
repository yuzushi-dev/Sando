import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { optimizeToolOutput } from '../index.mjs';

function noisyLines(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index} ${'x'.repeat(80)}`);
}

test('ANSI cleanup is limited to Bash previews', () => {
  const output = '\x1b[31mERROR\x1b[0m';

  assert.equal(optimizeToolOutput({ toolName: 'Bash', output, cwd: '/work' }).inline, 'ERROR');
  assert.equal(optimizeToolOutput({ toolName: 'Read', output, cwd: '/work', raw: true }).inline, output);
  assert.equal(optimizeToolOutput({ toolName: 'Grep', output, cwd: '/work' }).inline, output);
});

test('ANSI cleanup cannot reassemble an unredacted Bash credential', () => {
  const output = 'Authoriz\x1b[31mation\x1b[0m: Bearer hidden-token';
  const result = optimizeToolOutput({ toolName: 'Bash', output, cwd: '/work' });

  assert.equal(result.inline.includes('hidden-token'), false);
  assert.match(result.inline, /Authorization: Bearer \[REDACTED\]/);
  assert.equal(result.stats.redactions, 1);
  assert.equal(result.stats.inputBytes, Buffer.byteLength(output));
  assert.equal(result.stats.redactedBytes, Buffer.byteLength(result.inline));
});

test('artifact uses the safe payload when ANSI cleanup exposes a credential', () => {
  const output = `Authoriz\x1b[31mation\x1b[0m: Bearer hidden-token\n${'noise\n'.repeat(200)}`;
  const result = optimizeToolOutput({
    toolName: 'Bash', output, cwd: '/work',
    policy: { maxInlineBytes: 256, maxArtifactBytes: 4096 },
  });
  const digest = `sha256:${createHash('sha256').update(result.artifact.content).digest('hex')}`;

  assert.equal(result.artifact.content.includes('hidden-token'), false);
  assert.equal(result.artifact.content.includes('\x1b'), false);
  assert.match(result.artifact.content, /^Authorization: Bearer \[REDACTED\]/);
  assert.equal(result.artifact.bytes, Buffer.byteLength(result.artifact.content));
  assert.equal(result.artifact.sourceBytes, result.artifact.bytes);
  assert.equal(result.artifact.sourceDigest, digest);
  assert.equal(result.artifact.digest, digest);
  assert.equal(result.stats.redactedBytes, result.artifact.bytes);
  assert.equal(result.stats.artifactBytes, result.artifact.bytes);
  assert.equal(result.stats.redactions, 1);
});

test('preview strips ANSI and salvages a redacted diagnostic from the elided middle', () => {
  const output = [
    ...noisyLines('head', 20),
    '\x1b[31mERROR authorization: Bearer secret-value \x1b[0m',
    ...noisyLines('tail', 20),
  ].join('\n');
  const result = optimizeToolOutput({
    toolName: 'Bash', output, cwd: '/work',
    policy: { maxInlineBytes: 512, headBytes: 96, tailBytes: 96, maxArtifactBytes: 8192 },
  });

  assert.ok(Buffer.byteLength(result.inline) <= 512);
  assert.equal(result.inline.includes('\x1b'), false);
  assert.match(result.inline, /ERROR authorization: Bearer \[REDACTED\]/);
  assert.equal(result.artifact.content, output.replace('secret-value', '[REDACTED]'));
  assert.equal(result.artifact.content.includes('\x1b[31m'), true);
});

test('preview salvages diagnostics displaced by the salvage budget', () => {
  const output = [
    'h'.repeat(150),
    'ERROR-MOVED: failed',
    ...noisyLines('middle', 10),
    `ERROR-CENTER: ${'c'.repeat(160)}`,
    ...noisyLines('tail', 10),
  ].join('\n');
  const result = optimizeToolOutput({
    toolName: 'Bash', output, cwd: '/work',
    policy: { maxInlineBytes: 512, headBytes: 96, tailBytes: 96, maxArtifactBytes: 8192 },
  });

  assert.match(result.inline, /ERROR-MOVED: failed/);
  assert.match(result.inline, /ERROR-CENTER:/);
  assert.ok(Buffer.byteLength(result.inline) <= 512);
});

test('preview salvages at most eight diagnostic lines', () => {
  const diagnostics = Array.from({ length: 11 }, (_, index) => `ERROR-DIAG-${index}: failed`);
  const output = [
    ...noisyLines('head', 30),
    ...diagnostics,
    ...noisyLines('tail', 30),
  ].join('\n');
  const result = optimizeToolOutput({
    toolName: 'Bash', output, cwd: '/work',
    policy: { maxInlineBytes: 4096, headBytes: 512, tailBytes: 512, maxArtifactBytes: 16384 },
  });

  assert.deepEqual(
    [...result.inline.matchAll(/ERROR-DIAG-(\d+):/g)].map((match) => Number(match[1])),
    Array.from({ length: 8 }, (_, index) => index),
  );
  assert.ok(Buffer.byteLength(result.inline) <= 4096);
  assert.equal(result.artifact.content, output);
});

test('preview prioritizes a fatal line after warning spam', () => {
  const warnings = Array.from({ length: 10 }, (_, index) => `WARNING-${index}: noisy`);
  const output = [
    ...noisyLines('head', 30),
    ...warnings,
    'FATAL: linker failed',
    ...noisyLines('tail', 30),
  ].join('\n');
  const result = optimizeToolOutput({
    toolName: 'Bash', output, cwd: '/work',
    policy: { maxInlineBytes: 4096, headBytes: 512, tailBytes: 512, maxArtifactBytes: 16384 },
  });

  assert.match(result.inline, /FATAL: linker failed/);
  assert.equal([...result.inline.matchAll(/WARNING-\d+:/g)].length, 7);
  assert.ok(Buffer.byteLength(result.inline) <= 4096);
});

test('preview caps salvaged diagnostic lines by UTF-8 bytes', () => {
  const diagnostic = `ERROR: ${'é'.repeat(400)}`;
  const output = [
    ...noisyLines('head', 30),
    diagnostic,
    ...noisyLines('tail', 30),
  ].join('\n');
  const result = optimizeToolOutput({
    toolName: 'Bash', output, cwd: '/work',
    policy: { maxInlineBytes: 4096, headBytes: 512, tailBytes: 512, maxArtifactBytes: 16384 },
  });
  const salvaged = result.inline.split('\n').find((line) => line.startsWith('ERROR:'));

  assert.equal(Buffer.byteLength(salvaged), 256);
  assert.equal(salvaged.endsWith('~'), true);
  assert.equal(salvaged.includes('\uFFFD'), false);
  assert.ok(Buffer.byteLength(result.inline) <= 4096);
  assert.equal(result.artifact.content, output);
});
