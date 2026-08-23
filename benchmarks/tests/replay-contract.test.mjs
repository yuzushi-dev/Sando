import test from 'node:test';
import assert from 'node:assert/strict';

import { loadScenario, replayScenario } from '../lib/replay.mjs';

test('loads a scenario with stable event order', async () => {
  const scenario = await loadScenario(new URL('../fixtures/read-large.json', import.meta.url));
  assert.equal(scenario.id, 'read-large');
  assert.ok(Array.isArray(scenario.events));
  assert.ok(scenario.events.length >= 2);
  assert.deepEqual(scenario.events.map((event) => event.id), ['read-1', 'read-2']);
});

test('replay produces a receipt for every event and preserves scenario identity', async () => {
  const scenario = await loadScenario(new URL('../fixtures/read-large.json', import.meta.url));
  const result = await replayScenario(scenario, async (event) => ({
    inline: event.output,
    stats: { inlineBytes: Buffer.byteLength(event.output), artifactBytes: 0 },
  }));
  assert.equal(result.scenario, 'read-large');
  assert.equal(result.receipts.length, scenario.events.length);
  assert.deepEqual(result.receipts.map((receipt) => receipt.event), ['read-1', 'read-2']);
});

test('loads head/middle/tail fixtures across Read, Grep, git, npm, and cargo outputs', async () => {
  const scenario = await loadScenario(new URL('../fixtures/tool-suite.json', import.meta.url));
  assert.deepEqual(scenario.events.map((event) => event.toolName), ['Read', 'Grep', 'Bash', 'Bash', 'Bash']);
  for (const event of scenario.events) {
    assert.ok(event.output.includes(event.requiredFacts.find((fact) => fact.location === 'head').value));
    assert.ok(event.output.includes(event.requiredFacts.find((fact) => fact.location === 'middle').value));
    assert.ok(event.output.includes(event.requiredFacts.find((fact) => fact.location === 'tail').value));
  }
});
