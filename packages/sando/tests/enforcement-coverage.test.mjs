import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyShellCommand } from '../../../adapters/codex/sando/lib/enforcement.mjs';
import { callMcpTool } from '../../../adapters/codex/sando/lib/mcp-tools.mjs';

// ─── Test fixtures ──────────────────────────────────────────────────────

function withFixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-l1-'));
  fs.writeFileSync(path.join(root, 'file.txt'), 'hello\nworld\n');
  fs.writeFileSync(path.join(root, 'module.ts'), 'const x = 1;\n'.repeat(100));
  fs.writeFileSync(path.join(root, 'app.py'), 'def main():\n  pass\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'index.mjs'), 'export default 1;\n');
  try {
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// These exercise the selective classifier, so the wrap is switched off: with it on every command
// is eligible and the question "does this shape route" stops being answerable. The environment is
// also passed explicitly, so a verdict never depends on what the shell running the tests exports.
// The L3 tests below pass their own env to exercise the wrap instead.
function classify(command, cwd, env = { SANDO_SHELL_WRAP: '0' }) {
  return classifyShellCommand({ toolName: 'Bash', toolInput: { command }, cwd, env });
}

// ─── cat with safe display flags ────────────────────────────────────────

test('L1 cat: bare cat file is still eligible', () => {
  withFixture((root) => {
    const result = classify('cat file.txt', root);
    assert.equal(result.status, 'eligible');
    assert.equal(result.route, 'sando_read');
    assert.equal(result.path, 'file.txt');
  });
});

test('L1 cat: cat with -- separator is eligible', () => {
  withFixture((root) => {
    const result = classify('cat -- file.txt', root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 cat: cat -n file is eligible (line numbers)', () => {
  withFixture((root) => {
    const result = classify('cat -n file.txt', root);
    assert.equal(result.status, 'eligible');
    assert.equal(result.route, 'sando_read');
  });
});

test('L1 cat: cat -b file is eligible (non-blank line numbers)', () => {
  withFixture((root) => {
    const result = classify('cat -b file.txt', root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 cat: cat -ns file is eligible (bundled safe flags)', () => {
  withFixture((root) => {
    const result = classify('cat -ns file.txt', root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 cat: cat -A file is eligible (show-all)', () => {
  withFixture((root) => {
    const result = classify('cat -A file.txt', root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 cat: cat -n -- file is eligible (flag before separator)', () => {
  withFixture((root) => {
    const result = classify('cat -n -- file.txt', root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 cat: cat with unknown flag bypasses', () => {
  withFixture((root) => {
    const result = classify('cat -x file.txt', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'read-shape');
  });
});

test('L1 cat: cat with multiple files bypasses (single-file only)', () => {
  withFixture((root) => {
    const result = classify('cat file.txt module.ts', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'read-shape');
  });
});

test('L1 cat: cat with no file bypasses', () => {
  withFixture((root) => {
    const result = classify('cat -n', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'read-shape');
  });
});

// ─── grep/rg in natural form ────────────────────────────────────────────

test('L1 grep: grep pattern file is eligible', () => {
  withFixture((root) => {
    const result = classify('grep hello file.txt', root);
    assert.equal(result.status, 'eligible');
    assert.equal(result.route, 'sando_grep');
    assert.equal(result.pattern, 'hello');
    assert.equal(result.path, 'file.txt');
  });
});

test('L1 grep: grep -n pattern file is eligible', () => {
  withFixture((root) => {
    const result = classify('grep -n hello file.txt', root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 grep: grep -rn pattern dir is eligible (recursive + search kind)', () => {
  withFixture((root) => {
    const result = classify('grep -rn hello src', root);
    assert.equal(result.status, 'eligible');
    assert.equal(result.route, 'sando_grep');
    assert.equal(result.path, 'src');
  });
});

test('L1 grep: grep -i pattern file is eligible (case-insensitive)', () => {
  withFixture((root) => {
    const result = classify('grep -i hello file.txt', root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 grep: grep -F pattern file is eligible (fixed-strings without --)', () => {
  withFixture((root) => {
    const result = classify('grep -F hello file.txt', root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 grep: grep -F -- pattern file is eligible (old canonical form)', () => {
  withFixture((root) => {
    const result = classify('grep -F -- hello file.txt', root);
    assert.equal(result.status, 'eligible');
    assert.equal(result.route, 'sando_grep');
  });
});

test('L1 grep: rg -F -- pattern file is eligible (rg variant)', () => {
  withFixture((root) => {
    const result = classify('rg -F -- hello file.txt', root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 grep: grep --fixed-strings -- pattern file is eligible (long flag)', () => {
  withFixture((root) => {
    const result = classify('grep --fixed-strings -- hello file.txt', root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 grep: grep --ignore-case pattern file is eligible (long flag)', () => {
  withFixture((root) => {
    const result = classify('grep --ignore-case hello file.txt', root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 grep: grep -inH pattern file is eligible (bundled flags)', () => {
  withFixture((root) => {
    const result = classify('grep -inH hello file.txt', root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 grep: grep with unknown flag bypasses', () => {
  withFixture((root) => {
    const result = classify('grep -m 5 hello file.txt', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'grep-shape');
  });
});

test('L1 grep: grep with unknown long flag bypasses', () => {
  withFixture((root) => {
    const result = classify('grep --color hello file.txt', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'grep-shape');
  });
});

test('L1 grep: grep with no path bypasses', () => {
  withFixture((root) => {
    const result = classify('grep hello', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'grep-shape');
  });
});

test('L1 grep: grep with three operands bypasses (multi-path)', () => {
  withFixture((root) => {
    const result = classify('grep hello file.txt module.ts', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'grep-shape');
  });
});

// ─── sed targeted reads ─────────────────────────────────────────────────

test('L1 sed: sed -n range-print is eligible', () => {
  withFixture((root) => {
    const result = classify("sed -n '1,50p' module.ts", root);
    assert.equal(result.status, 'eligible');
    assert.equal(result.route, 'sando_read');
    assert.equal(result.path, 'module.ts');
  });
});

test('L1 sed: sed -n single-line-print is eligible', () => {
  withFixture((root) => {
    const result = classify("sed -n '10p' module.ts", root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 sed: sed without -n bypasses', () => {
  withFixture((root) => {
    const result = classify("sed 's/foo/bar/g' file.txt", root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'sed-shape');
  });
});

test('L1 sed: sed -n with non-print command bypasses', () => {
  withFixture((root) => {
    const result = classify("sed -n '1,50d' module.ts", root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'sed-shape');
  });
});

// ─── head/tail ──────────────────────────────────────────────────────────

test('L1 head: head file is eligible', () => {
  withFixture((root) => {
    const result = classify('head file.txt', root);
    assert.equal(result.status, 'eligible');
    assert.equal(result.route, 'sando_read');
  });
});

test('L1 head: head -n 200 file is eligible', () => {
  withFixture((root) => {
    const result = classify('head -n 200 module.ts', root);
    assert.equal(result.status, 'eligible');
  });
});

test('L1 head: head -20 file is eligible (old-style)', () => {
  withFixture((root) => {
    const result = classify('head -20 module.ts', root);
    assert.equal(result.status, 'eligible');
  });
});

// `tail` counts from the end of the file and `sando_read` only expresses a range from the start,
// so routing it would answer "the last N lines" with the first lines. It stays unrouted until a
// range anchored to the end exists.
test('L1 tail: tail is never routed, whatever its shape', () => {
  withFixture((root) => {
    for (const command of ['tail file.txt', 'tail -n 100 module.ts', 'tail -f file.txt', 'tail -- file.txt', 'tail -5 file.txt']) {
      const result = classify(command, root);
      assert.equal(result.status, 'bypassed', command);
      assert.equal(result.reason, 'tail-unbounded-from-end', command);
    }
  });
});

test('L1 head: head -c 1000 bypasses (byte mode unsupported)', () => {
  withFixture((root) => {
    const result = classify('head -c 1000 file.txt', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'head-shape');
  });
});

// ─── §3 correctness: pipeline and redirect must bypass ──────────────────

test('§3 CRITICAL: cat f | grep x must bypass (pipeline truncation would silently corrupt results)', () => {
  withFixture((root) => {
    const result = classify('cat file.txt | grep hello', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'compound-feeds-pipeline');
  });
});

test('§3 CRITICAL: grep pattern file > out.txt must bypass (redirect)', () => {
  withFixture((root) => {
    const result = classify('grep hello file.txt > out.txt', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'compound-has-redirect');
  });
});

test('§3 CRITICAL: head file | wc -l must bypass (pipeline)', () => {
  withFixture((root) => {
    const result = classify('head file.txt | wc -l', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'compound-feeds-pipeline');
  });
});

// ─── L2: Compound command routing ───────────────────────────────────────

test('L2 compound: cd dir && cat file routes relative to cwd root', () => {
  withFixture((root) => {
    const result = classify('cd src && cat index.mjs', root);
    assert.equal(result.status, 'eligible');
    assert.equal(result.route, 'sando_read');
    assert.equal(result.path, 'src/index.mjs');
  });
});

test('L2 compound: cd dir; grep pattern file routes relative to cwd root', () => {
  withFixture((root) => {
    const result = classify('cd src; grep export index.mjs', root);
    assert.equal(result.status, 'eligible');
    assert.equal(result.route, 'sando_grep');
    assert.equal(result.pattern, 'export');
    assert.equal(result.path, 'src/index.mjs');
  });
});

test('L2 compound: export VAR=val; cat file.txt routes', () => {
  withFixture((root) => {
    const result = classify('export FOO=1; cat file.txt', root);
    assert.equal(result.status, 'eligible');
    assert.equal(result.route, 'sando_read');
    assert.equal(result.path, 'file.txt');
  });
});

test('L2 compound: cd dir && cat file | wc -l bypasses compound-feeds-pipeline', () => {
  withFixture((root) => {
    const result = classify('cd src && cat index.mjs | wc -l', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'compound-feeds-pipeline');
  });
});

test('L2 compound: cd dir && cat file > out.txt bypasses compound-has-redirect', () => {
  withFixture((root) => {
    const result = classify('cd src && cat index.mjs > out.txt', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'compound-has-redirect');
  });
});

test('L2 compound: cd to outside root bypasses unsafe-cwd', () => {
  withFixture((root) => {
    const result = classify('cd /tmp && cat file.txt', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'unsafe-cwd');
  });
});

// ─── Backward compatibility: unsupported programs still bypass ──────────

test('L1 regression: ls still bypasses as unsupported-shell', () => {
  withFixture((root) => {
    const result = classify('ls', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'unsupported-shell');
  });
});

test('L1 regression: git still bypasses as unsupported-shell', () => {
  withFixture((root) => {
    const result = classify('git status', root);
    assert.equal(result.status, 'bypassed');
    assert.equal(result.reason, 'unsupported-shell');
  });
});

// ─── Shell unwrap: Codex argv-style commands ────────────────────────────

test('L1 unwrap: Codex argv [bash, -lc, grep -n pattern file] routes', () => {
  withFixture((root) => {
    const result = classifyShellCommand({
      toolName: 'Bash',
      toolInput: { command: ['/bin/bash', '-lc', 'grep -n hello file.txt'] },
      cwd: root,
    });
    assert.equal(result.status, 'eligible');
    assert.equal(result.route, 'sando_grep');
  });
});

test('L1 unwrap: Codex argv [bash, -lc, cat -n file] routes', () => {
  withFixture((root) => {
    const result = classifyShellCommand({
      toolName: 'Bash',
      toolInput: { command: ['/bin/bash', '-lc', 'cat -n file.txt'] },
      cwd: root,
    });
    assert.equal(result.status, 'eligible');
    assert.equal(result.route, 'sando_read');
  });
});

test('L2 unwrap: Codex argv [bash, -lc, cd src && cat index.mjs] routes', () => {
  withFixture((root) => {
    const result = classifyShellCommand({
      toolName: 'Bash',
      toolInput: { command: ['/bin/bash', '-lc', 'cd src && cat index.mjs'] },
      cwd: root,
    });
    assert.equal(result.status, 'eligible');
    assert.equal(result.route, 'sando_read');
    assert.equal(result.path, 'src/index.mjs');
  });
});

// Classifying `head`/`sed` as routable is only half the contract: the line bound has to survive
// into the rewritten command and into the read itself. Without that, a request for 20 lines is
// answered with the whole file -- more context than the unrouted command would have cost, and
// different content.
test('L1 bounds: head and sed carry their line range into the classification', () => {
  withFixture((root) => {
    assert.deepEqual(pick(classify('head -n 20 module.ts', root)), { startLine: 1, endLine: 20 });
    assert.deepEqual(pick(classify('head -5 module.ts', root)), { startLine: 1, endLine: 5 });
    assert.deepEqual(pick(classify('head module.ts', root)), { startLine: 1, endLine: 10 });
    assert.deepEqual(pick(classify("sed -n '30,80p' module.ts", root)), { startLine: 30, endLine: 80 });
    assert.deepEqual(pick(classify("sed -n '42p' module.ts", root)), { startLine: 42, endLine: 42 });
  });
});

function pick(result) {
  assert.equal(result.status, 'eligible');
  return { startLine: result.startLine, endLine: result.endLine };
}

test('L1 bounds: a bounded read returns exactly the requested lines', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-bounds-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const lines = Array.from({ length: 500 }, (_, index) => `line-${index + 1}`);
  fs.writeFileSync(path.join(cwd, 'sample.mjs'), `${lines.join('\n')}\n`);

  const head = callMcpTool('sando_read', { path: 'sample.mjs', cwd, startLine: 1, endLine: 20 });
  assert.equal(head.inline, lines.slice(0, 20).join('\n'));

  const middle = callMcpTool('sando_read', { path: 'sample.mjs', cwd, startLine: 30, endLine: 32 });
  assert.equal(middle.inline, 'line-30\nline-31\nline-32');

  // An unbounded read of the same file still returns everything, so the bound is what narrows it.
  const whole = callMcpTool('sando_read', { path: 'sample.mjs', cwd });
  assert.ok(whole.inline.length > head.inline.length * 10);

  assert.throws(() => callMcpTool('sando_read', { path: 'sample.mjs', cwd, startLine: 0 }), /positive integer/);
  assert.throws(() => callMcpTool('sando_read', { path: 'sample.mjs', cwd, startLine: 9, endLine: 2 }), /precede/);
});

// ─── L3: wrapping whatever the selective routes refuse ──────────────────────

// The wrap is the only route that reaches a build, a test run or a `git diff` — the shapes that
// hold most of the context. It must stay off unless asked for, and must never take a command the
// specific routes already handle better.
test('L3: the wrap takes what the selective routes refuse, and SANDO_SHELL_WRAP=0 gives it back', () => {
  withFixture((root) => {
    for (const command of ['npm test', 'git diff', 'cat a | grep b', 'node x.js > out.txt']) {
      const on = classifyShellCommand({ toolName: 'Bash', toolInput: { command }, cwd: root, env: {} });
      assert.equal(on.status, 'eligible', command);
      assert.equal(on.route, 'sando_exec', command);
      assert.equal(on.command, command);
      const off = classifyShellCommand({ toolName: 'Bash', toolInput: { command }, cwd: root, env: { SANDO_SHELL_WRAP: '0' } });
      assert.equal(off.status, 'bypassed', command);
    }
  });
});

test('L3: a specific route still wins over the wrap', () => {
  withFixture((root) => {
    const wrapped = classifyShellCommand({
      toolName: 'Bash', toolInput: { command: 'cat file.txt' }, cwd: root, env: {},
    });
    // `sando read` carries source-class routing and a line range; the wrap carries neither.
    assert.equal(wrapped.route, 'sando_read');
  });
});

test('L3: the wrap refuses to nest inside itself', () => {
  withFixture((root) => {
    const env = {};
    for (const command of ['sando exec -- bash -lc "ls"', 'sando read -- file.txt', '/opt/sando/bin/sando grep -F -- x file.txt']) {
      const result = classifyShellCommand({ toolName: 'Bash', toolInput: { command }, cwd: root, env });
      assert.notEqual(result.route, 'sando_exec', command);
    }
  });
});
