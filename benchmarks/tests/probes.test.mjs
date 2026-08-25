import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROBES = [
  'cache-attribution-report.mjs',
  'cache-control-survival-probe.mjs',
  'cache-hit-provenance.mjs',
  'prefix-divergence-probe.mjs',
  'rewrite-payback-probe.mjs',
];

const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

test('every probe parses and is registered as an npm script', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const registered = new Set(Object.values(scripts));

  for (const probe of PROBES) {
    const file = path.join(ROOT, 'benchmarks', probe);
    assert.ok(fs.existsSync(file), `${probe} is missing`);
    assert.equal(run(['--check', file]).status, 0, `${probe} does not parse`);
    assert.ok(registered.has(`node benchmarks/${probe}`),
      `${probe} has no npm script — it will not be discoverable`);
  }
});

test('probes import Sando by relative path so they run from any checkout', () => {
  // An absolute import silently ties a probe to one machine. This caught a real one.
  for (const probe of PROBES) {
    const source = fs.readFileSync(path.join(ROOT, 'benchmarks', probe), 'utf8');
    for (const match of source.matchAll(/^import[^;]*from\s+'([^']+)'/gm)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'),
        `${probe} imports '${specifier}' — must be relative, not absolute`);
    }
    assert.ok(!/\/home\/[a-z]+\//i.test(source), `${probe} contains a hardcoded home path`);
  }
});

test('the zero-argument probes run clean', () => {
  // These read only committed files, so they must work with no setup. Guards against
  // a probe that silently depends on a gitignored result file being present.
  for (const probe of ['cache-control-survival-probe.mjs', 'cache-hit-provenance.mjs', 'cache-attribution-report.mjs']) {
    const result = run([path.join(ROOT, 'benchmarks', probe)]);
    assert.equal(result.status, 0, `${probe} exited ${result.status}: ${result.stderr}`);
    assert.ok(result.stdout.length > 0, `${probe} produced no output`);
  }
});

test('transcript probes explain themselves instead of crashing when given no input', () => {
  for (const probe of ['prefix-divergence-probe.mjs', 'rewrite-payback-probe.mjs']) {
    const result = run([path.join(ROOT, 'benchmarks', probe)]);
    assert.equal(result.status, 2, `${probe} should exit 2 without arguments`);
    assert.match(result.stderr, /usage:/i, `${probe} should print usage`);
  }
});

test('the cache_control survival probe reports every marker surviving', () => {
  // The transform must not drop a breakpoint the host placed. If this regresses, the
  // probe says LOST and this test fails with it.
  const result = run([path.join(ROOT, 'benchmarks', 'cache-control-survival-probe.mjs')]);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /\*\*\* LOST \*\*\*/, 'a cache_control marker was dropped');
  assert.doesNotMatch(result.stdout, /SILENT NO-OP/, 'a rewrite counter incremented without changing the body');
});
