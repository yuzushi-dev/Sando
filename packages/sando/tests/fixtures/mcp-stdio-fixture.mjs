import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  let result;
  if (message.method === 'initialize') result = { capabilities: { tools: { listChanged: true } } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'read', description: 'read fixture', inputSchema: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } } }] };
  else if (message.method === 'tools/call') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'fixture', progress: 1 } })}\n`);
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`);
    result = { content: [{ type: 'text', text: message.params.arguments.value }] };
  }
  else result = {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
});
