import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { infer } from '../src/native-bridge.mjs';
import { AnthropicStream, translateRequest } from '../src/protocol.mjs';
import { ensureDataRoot } from '../src/paths.mjs';

const model = process.argv[2] ?? 'claude-haiku-5-5';
const lookupKey = crypto.randomBytes(8).toString('hex');
const value = crypto.randomBytes(16).toString('hex');
const cache = new Map();
const body = { model, system: 'For this protocol test, call lookup_probe with the exact key. After a tool result, reply only with its value field.',
  tools: [{ name: 'lookup_probe', description: 'Look up an unpredictable test value.', input_schema: {
    type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }],
  messages: [{ role: 'user', content: `Look up key ${lookupKey}.` }] };
async function run(request) {
  const spec = translateRequest(request, cache);
  const adapter = new AnthropicStream(model, spec.estimatedInputTokens);
  const native = await infer(spec, event => adapter.accept(event));
  if (!adapter.finished || native.nativeToolExecutions !== 0) throw new Error('Native probe did not complete safely.');
  const reasoning = adapter.rawItems.filter(item => item?.type === 'reasoning' && item.encrypted_content)
    .map(item => ({ type: 'reasoning', summary: [], encrypted_content: item.encrypted_content }));
  for (const call of adapter.rawItems.filter(item => item?.type === 'function_call')) cache.set(`${spec.model}\0${call.call_id}`, reasoning);
  return adapter.message();
}
const first = await run(body);
const call = first.content.find(block => block.type === 'tool_use');
if (call?.name !== 'lookup_probe' || call.input.key !== lookupKey) throw new Error('Structured tool call mismatch.');
body.messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [
  { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ value }) }] });
const second = await run(body);
if (second.content.map(block => block.text ?? '').join('').trim() !== value) throw new Error('External tool result mismatch.');
const result = { ok: true, model, structuredToolCall: true, externalResultMatched: true, nativeToolExecutions: 0,
  instructionsPlacement: 'user-context', at: new Date().toISOString() };
fs.writeFileSync(path.join(ensureDataRoot(), 'latest-probe-test.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
