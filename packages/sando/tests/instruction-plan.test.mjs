import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  INSTRUCTION_PLAN_SCHEMA,
  buildInstructionPlan,
  serializeInstructionPlan,
} from '../index.mjs';

const ROOT = path.join(import.meta.dirname, 'fixtures/instructions');

test('plans only procedure-like moves and keeps policy/ambiguous blocks on', () => {
  const plan = buildInstructionPlan({ root: ROOT, host: 'both' });

  assert.equal(plan.schema, INSTRUCTION_PLAN_SCHEMA);
  assert.equal(plan.host, 'both');
  assert.ok(plan.files.some((file) => file.path === 'AGENTS.md'));
  assert.ok(plan.files.some((file) => file.path === 'src/AGENTS.md'));
  assert.ok(plan.files.some((file) => file.path === 'docs/imported.md'));
  assert.ok(plan.imports.some((item) => item.status === 'resolved' && item.target === 'docs/imported.md'));
  assert.ok(plan.imports.some((item) => item.status === 'external'));

  const safety = plan.blocks.find((block) => block.source.path === 'AGENTS.md' && block.source.startLine === 3);
  assert.equal(safety.classification, 'always-on');
  assert.equal(plan.proposals.some((proposal) => proposal.blockId === safety.id), false);

  const ambiguous = plan.blocks.find((block) => block.source.path === 'AGENTS.md' && block.source.startLine === 7);
  assert.equal(ambiguous.classification, 'unknown');
  assert.ok(plan.blocks.some((block) => block.classification === 'unknown'));
  assert.ok(plan.blocks.some((block) => block.classification === 'unknown' && block.conflictWith?.length));
  assert.ok(plan.blocks.some((block) => block.classification === 'always-on' && block.conflictWith?.length));
  assert.ok(plan.blocks.some((block) => block.classification === 'duplicate' && block.duplicateOf));
  assert.ok(plan.proposals.length >= 2);
  for (const proposal of plan.proposals) {
    assert.equal(proposal.classification, 'on-demand');
    assert.ok(proposal.estimatedFootprintAvoided.bytes > 0);
    assert.deepEqual(Object.keys(proposal.destination.hostPaths).sort(), ['claude', 'codex']);
    assert.equal(proposal.destination.shared, true);
    assert.ok(proposal.diff.remove.path);
    assert.ok(proposal.diff.add.hostPaths.claude);
    assert.equal(Object.hasOwn(proposal.diff.remove, 'content'), false);
    assert.equal(Object.hasOwn(proposal.diff.add, 'content'), false);
    assert.deepEqual(proposal.diff.add.preview, proposal.diff.remove.preview);
    assert.equal(proposal.diff.remove.preview.bytes, proposal.estimatedFootprintAvoided.bytes);
    assert.match(proposal.diff.remove.preview.digest, /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(plan.summary.proposedBytes, plan.proposals.reduce((total, item) => total + item.estimatedFootprintAvoided.bytes, 0));
  assert.ok(plan.summary.alwaysOnBlocks > 0);
  assert.ok(plan.summary.onDemandBlocks > 0);
});

test('instruction plan is deterministic, relative, and never writes the root', () => {
  const before = fs.readdirSync(ROOT, { recursive: true }).sort();
  const first = buildInstructionPlan({ root: ROOT, host: 'claude' });
  const second = buildInstructionPlan({ root: ROOT, host: 'claude' });
  const serialized = serializeInstructionPlan(first);

  assert.equal(serialized, serializeInstructionPlan(second));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.doesNotMatch(serialized, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(fs.readdirSync(ROOT, { recursive: true }).sort(), before);
  assert.deepEqual(Object.keys(first.proposals[0].destination.hostPaths), ['claude']);
});

test('instruction planner refuses automatic application and preserves conflict evidence', () => {
  const plan = buildInstructionPlan({ root: ROOT, host: 'both' });
  assert.ok(plan.blocks.some((block) => block.conflictWith?.length));
  assert.ok(plan.proposals.every((proposal) => proposal.diff.operation === 'move-preview'));
  assert.equal(Object.hasOwn(plan, 'apply'), false);
});

test('keeps destructive production procedures always-on', (t) => {
  const root = fs.mkdtempSync(path.join(import.meta.dirname, 'fixtures', 'instruction-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'When deleting production files, run a dry-run first and confirm with the user.\n');

  const plan = buildInstructionPlan({ root, host: 'codex' });

  assert.equal(plan.blocks.length, 1);
  assert.equal(plan.blocks[0].classification, 'always-on');
  assert.equal(plan.proposals.length, 0);
});

test('selects only instructions owned by the requested host', () => {
  const claude = buildInstructionPlan({ root: ROOT, host: 'claude' });
  const codex = buildInstructionPlan({ root: ROOT, host: 'codex' });

  assert.ok(claude.files.some((file) => file.path === 'CLAUDE.md'));
  assert.ok(claude.files.every((file) => file.kind === 'import' || !file.path.endsWith('AGENTS.md')));
  assert.ok(codex.files.some((file) => file.path === 'AGENTS.md'));
  assert.ok(codex.files.every((file) => file.kind === 'import' || !file.path.endsWith('CLAUDE.md')));
});
