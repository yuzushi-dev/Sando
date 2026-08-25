/**
 * Does Sando's history transform preserve the host's cache_control breakpoints?
 *
 * Sando sets no breakpoints of its own, but proxy.mjs:130 rewrites the request body
 * it receives from Claude Code — which does set them. If a rewrite drops or relocates
 * a marker, caching breaks on EVERY transformed request, not just on the turns that
 * rewrite history. That would gate any plan to add breakpoints.
 *
 * Also probes replaceResult's silent-no-op branch: context-transform.mjs:94-97 only
 * rewrites an array-shaped content when EVERY block is text/input_text. Any other block
 * type (e.g. an image) makes it fall through with no branch taken — while the caller
 * still increments its counter.
 *
 * Deterministic, no network, no API cost.
 */

import { transformProviderRequest } from '../packages/sando/src/context-transform.mjs';

const MARK = { type: 'ephemeral' };

const read = (id, file) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: file } });

function countMarkers(node, acc = { total: 0, paths: [] }, path = '$') {
  if (Array.isArray(node)) {
    node.forEach((v, i) => countMarkers(v, acc, `${path}[${i}]`));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'cache_control') { acc.total += 1; acc.paths.push(path); }
      else countMarkers(v, acc, `${path}.${k}`);
    }
  }
  return acc;
}

function run(name, body, expectRewrite) {
  const before = countMarkers(body);
  const out = transformProviderRequest({ provider: 'anthropic', body, policy: {} });
  const after = countMarkers(out.body);
  const s = out.stats;
  const claimed = s.supersededReads + s.elidedUselessSuccesses + s.deduplicatedResults
    + s.compactedStructures + s.shakenResults;
  const reallyChanged = JSON.stringify(body) !== JSON.stringify(out.body);

  console.log(`\n### ${name}`);
  console.log(`  cache_control markers : ${before.total} in  ->  ${after.total} out`
    + (before.total === after.total ? '  OK' : '  *** LOST ***'));
  if (before.total !== after.total) {
    const lost = before.paths.filter((p) => !after.paths.includes(p));
    console.log(`  lost at               : ${lost.join(', ')}`);
  }
  console.log(`  transform claimed     : ${claimed} rewrite(s), reasons=[${out.reasons}]`);
  console.log(`  body actually changed : ${reallyChanged}`);
  if (claimed > 0 && !reallyChanged) console.log(`  *** SILENT NO-OP: counter incremented, body identical ***`);
  if (expectRewrite && claimed === 0) console.log(`  (note: expected a rewrite, none fired — case did not exercise the path)`);
}

// --- case 1: marker on the tool_result block, superseded read (the common shape) ----
run('marker on tool_result block, string content, superseded read', {
  model: 'claude-sonnet-4-5',
  messages: [
    { role: 'assistant', content: [read('t1', '/a.ts')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'OLD BODY', cache_control: MARK }] },
    { role: 'assistant', content: [read('t2', '/a.ts')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'NEW BODY' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ],
}, true);

// --- case 2: marker on a nested text block, multi-block content ---------------------
run('marker on nested content block [1] of a superseded read', {
  model: 'claude-sonnet-4-5',
  messages: [
    { role: 'assistant', content: [read('t1', '/b.ts')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
      { type: 'text', text: 'OLD PART ONE' },
      { type: 'text', text: 'OLD PART TWO', cache_control: MARK },
    ] }] },
    { role: 'assistant', content: [read('t2', '/b.ts')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'NEW BODY' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ],
}, true);

// --- case 3: non-text block in content -> replaceResult falls through silently ------
run('superseded read whose content array contains an image block', {
  model: 'claude-sonnet-4-5',
  messages: [
    { role: 'assistant', content: [read('t1', '/c.png')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
      { type: 'text', text: 'OLD BODY' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ] }] },
    { role: 'assistant', content: [read('t2', '/c.png')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'NEW BODY' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ],
}, true);

// --- case 4: markers on system + tools, as Claude Code actually places them ---------
run('markers on system and tools alongside a superseded read', {
  model: 'claude-sonnet-4-5',
  system: [{ type: 'text', text: 'You are Claude Code.', cache_control: MARK }],
  tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' }, cache_control: MARK }],
  messages: [
    { role: 'assistant', content: [read('t1', '/d.ts')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'OLD BODY' }] },
    { role: 'assistant', content: [read('t2', '/d.ts')] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'NEW BODY', cache_control: MARK }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ],
}, true);
