import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, contextPolicy, checkContext } from '../src/context.mjs';
import { ReasoningStore } from '../src/reasoning-store.mjs';
import { RequestQueue } from '../src/request-queue.mjs';
import { translateRequest, AnthropicStream, SseDecoder } from '../src/protocol.mjs';
import { mcpCatalogReady } from '../src/mcp-readiness.mjs';

test('MCP catalog presence is insufficient until every required server connects', () => {
  assert.equal(mcpCatalogReady({ data: [{ name: 'probe', status: { status: 'pending' } }] }, ['probe']), false);
  assert.equal(mcpCatalogReady({ data: [{ name: 'probe', status: { status: 'connected' } }] }, ['probe']), true);
  assert.equal(mcpCatalogReady({ data: [{ name: 'probe', status: { status: 'failed' } }] }, ['probe']), false);
  assert.equal(mcpCatalogReady({ data: [] }, ['probe']), false);
});

test('Chinese and emoji count conservatively, and context rejection never truncates input', () => {
  assert.ok(estimateTokens('中文🔧'.repeat(100)) > 500);
  const spec = { estimatedInputTokens: 5000, input: [{ content: 'unaltered' }] };
  assert.throws(() => checkContext(spec, contextPolicy({ KIRO_GATEWAY_CONTEXT_TOKENS: '6000', KIRO_GATEWAY_RESERVE_TOKENS: '2000' })), /prompt is too long/);
  assert.equal(spec.input[0].content, 'unaltered');
});

test('opaque reasoning survives restart, stays scoped to model and expires', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-reasoning-test-'));
  try {
    const file = path.join(dir, 'state.json');
    const store = new ReasoningStore(file);
    store.remember('claude-haiku-5.5', [{ type: 'reasoning', encrypted_content: 'opaque_encrypted_test' },
      { type: 'function_call', call_id: 'tool_1' }]);
    const restored = new ReasoningStore(file);
    const body = { model: 'claude-haiku-5-5', messages: [{ role: 'assistant', content: [
      { type: 'tool_use', id: 'tool_1', name: 'lookup', input: {} }] }] };
    assert.equal(translateRequest(body, restored).input[0].type, 'reasoning');
    assert.equal(translateRequest({ ...body, model: 'claude-sonnet-5-5' }, restored).input[0].type, 'function_call');
    assert.equal(new ReasoningStore(file, { ttlMs: -1 }).get('claude-haiku-5.5\0tool_1'), undefined);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('messages'));
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('kiro-reasoning-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queued requests cancel without leaking capacity; release is idempotent', async () => {
  const queue = new RequestQueue(1, 1, 1000);
  const release = await queue.acquire();
  const controller = new AbortController();
  const pending = queue.acquire(controller.signal);
  await assert.rejects(queue.acquire(), /full/);
  controller.abort(); await assert.rejects(pending, /disconnected/);
  release(); release();
  const next = await queue.acquire(); next();
  assert.equal(queue.active, 0); assert.equal(queue.waiting.length, 0);
});

test('parallel tool argument streams keep IDs and error results linked', () => {
  const adapter = new AnthropicStream('claude-haiku-5-5', 10);
  adapter.accept({ type: 'response.output_item.added', item: { type: 'function_call', id: 'a', call_id: 'call_a', name: 'first' } });
  adapter.accept({ type: 'response.output_item.added', item: { type: 'function_call', id: 'b', call_id: 'call_b', name: 'second' } });
  for (const [item_id, delta] of [['a', '{"n":'], ['b', '{"n":2}'], ['a', '1}']]) adapter.accept({ type: 'response.function_call_arguments.delta', item_id, delta });
  adapter.accept({ type: 'response.completed', response: { output: [] } });
  assert.deepEqual(adapter.message().content.map(b => [b.id, b.input.n]), [['call_a', 1], ['call_b', 2]]);
  const spec = translateRequest({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', is_error: true, content: 'permission denied' }] }] });
  assert.equal(spec.input[0].call_id, 'call_a'); assert.match(spec.input[0].output, /permission denied/);
});

test('truncated SSE and unknown argument IDs fail instead of corrupting tool arguments', () => {
  const decoder = new SseDecoder(() => {}); decoder.push('data: {"type":');
  assert.throws(() => decoder.finish(), /incomplete/);
  const adapter = new AnthropicStream('test', 1);
  assert.throws(() => adapter.accept({ type: 'response.function_call_arguments.delta', item_id: 'missing', delta: '{}' }), /unknown/);
});
