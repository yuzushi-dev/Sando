import assert from 'node:assert/strict';
import test from 'node:test';

import { countInteractions } from '../live/interaction-counts.mjs';

test('counts Claude model turns, native tools, and Sando MCP calls separately', () => {
  const stdout = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__sando__sando_read' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
  ].join('\n');
  assert.deepEqual(countInteractions(stdout, 'claude'), {
    modelTurns: 2, totalToolCalls: 2, nativeToolCalls: 1, sandoMcpCalls: 1,
  });
});

test('counts Codex completed model turn and distinct native/MCP tool calls', () => {
  const stdout = [
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', name: 'sando_exec' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
  assert.deepEqual(countInteractions(stdout, 'codex'), {
    modelTurns: 1, totalToolCalls: 2, nativeToolCalls: 1, sandoMcpCalls: 1,
  });
});
