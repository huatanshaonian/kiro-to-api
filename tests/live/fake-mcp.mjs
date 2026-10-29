import readline from 'node:readline';
import fs from 'node:fs';

const lines = readline.createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
for await (const line of lines) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.id === undefined) continue;
  if (message.method === 'initialize') reply(message.id, {
    protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'kiro-cc-probe', version: '1.0.0' }
  });
  else if (message.method === 'tools/list') reply(message.id, { tools: [{ name: 'lookup_probe',
    description: 'Look up an opaque test value. The value cannot be guessed; call this tool with the supplied key.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }] });
  else if (message.method === 'tools/call') {
    const valid = message.params.name === 'lookup_probe' && message.params.arguments?.key === process.env.PROBE_EXPECTED_KEY;
    fs.appendFileSync(process.env.PROBE_CALL_LOG, JSON.stringify({ name: message.params.name, arguments: message.params.arguments, valid }) + '\n');
    reply(message.id, { content: [{ type: 'text', text: JSON.stringify(valid ? { value: process.env.PROBE_RETURN_VALUE } : { error: 'Unknown key' }) }], isError: !valid });
  } else if (message.method === 'ping') reply(message.id, {});
  else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
}
