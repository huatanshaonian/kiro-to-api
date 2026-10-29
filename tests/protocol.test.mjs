import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SseDecoder, AnthropicStream, translateRequest, mapModel } from '../src/protocol.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(root, 'fixtures');

test('structured model tool fixture converts to Anthropic tool_use under fragmented SSE', () => {
  const raw = fs.readFileSync(path.join(fixture, '01-tool-request.response.sse'), 'utf8');
  const emitted = [];
  const adapter = new AnthropicStream('claude-haiku-5-5', 20, (name, event) => emitted.push([name, event]));
  const decoder = new SseDecoder(event => adapter.accept(event));
  adapter.start();
  for (let offset = 0; offset < raw.length; offset += 7) decoder.push(raw.slice(offset, offset + 7));
  const result = adapter.message();
  assert.equal(adapter.finished, true);
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.content[0].name, 'lookup_probe');
  assert.equal(typeof result.content[0].input.key, 'string');
  assert.deepEqual(emitted.slice(-2).map(item => item[0]), ['message_delta', 'message_stop']);
});

test('Claude Code tool_use/tool_result IDs retain their protocol linkage', () => {
  const body = { model: 'claude-haiku-5-5', system: [{ type: 'text', text: '应用说明中文' }], tools: [], messages: [
    { role: 'user', content: 'lookup' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_probe', name: 'lookup_probe', input: { key: '中文🔧' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_probe', content: [{ type: 'text', text: '测试结果' }] }] }
  ] };
  const spec = translateRequest(body);
  assert.equal(spec.instructions, '应用说明中文');
  assert.equal(spec.input[1].call_id, spec.input[2].call_id);
  assert.equal(JSON.parse(spec.input[1].arguments).key, '中文🔧');
  assert.equal(spec.input[2].output, '测试结果');
  assert.equal(spec.toolResults, 1);
});

test('final answer fixture converts to a complete end_turn response', () => {
  const raw = fs.readFileSync(path.join(fixture, '02-tool-result.response.sse'), 'utf8');
  const adapter = new AnthropicStream('claude-haiku-5-5', 20);
  new SseDecoder(event => adapter.accept(event)).push(raw);
  const expected = 'fixture_external_value';
  assert.equal(adapter.message().content[0].text, expected);
  assert.equal(adapter.message().stop_reason, 'end_turn');
});

test('unsupported content and model IDs fail explicitly', () => {
  assert.throws(() => translateRequest({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }), /Unsupported content/);
  assert.throws(() => mapModel('made-up-model'), /Unsupported model/);
});

test('mid-conversation system context is explicitly downgraded rather than sent as an upstream system field', () => {
  const spec = translateRequest({ model: 'claude-haiku-5-5', messages: [
    { role: 'system', content: [{ type: 'text', text: '上下文更新' }] },
    { role: 'user', content: '继续' }
  ] });
  assert.equal(spec.input[0].role, 'user');
  assert.equal(spec.input[0].content, '上下文更新');
  assert.equal(spec.systemChars, 5);
});

test('appending context after a tool turn does not change the leading-system/tool prefix metric', () => {
  const first = { model: 'claude-haiku-5-5', system: 'constant', messages: [
    { role: 'system', content: 'stable application instructions' }, { role: 'user', content: 'lookup' }
  ] };
  const second = { ...first, messages: [...first.messages, { role: 'assistant', content: 'working' },
    { role: 'system', content: 'new context appended after the previous turn' }, { role: 'user', content: 'continue' }] };
  assert.equal(translateRequest(first).prefixHash, translateRequest(second).prefixHash);
});
