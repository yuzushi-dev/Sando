import fs from 'node:fs';
import readline from 'node:readline';

const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const executionLog = process.argv[3];
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'sando-output-contract', version: '1.0.0' },
    });
  } else if (message.method === 'tools/list') {
    send(message.id, {
      tools: [{
        name: fixture.tool,
        description: 'Return a deterministic synthetic result for host contract tests.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      }],
    });
  } else if (message.method === 'tools/call') {
    fs.appendFileSync(executionLog, `${JSON.stringify({ tool: message.params?.name })}\n`);
    send(message.id, fixture.result);
  } else if (message.id !== undefined) {
    send(message.id, {});
  }
});
