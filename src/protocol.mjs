import crypto from 'node:crypto';
import { estimateTokens } from './context.mjs';
import { inlineImage, imageToolResult } from './image-content.mjs';

export const modelIds = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'claude-sonnet-4-5'];
export function mapModel(model = 'claude-haiku-5-5') {
  if (['haiku', 'sonnet', 'opus'].includes(model)) return `claude-${model}-5.5`;
  if (/^claude-(haiku|sonnet|opus)-\d+\.\d+$/.test(model)) return model;
  const match = /^claude-(haiku|sonnet|opus)-(\d+)-(\d+)(?:-\d{8})?$/.exec(model);
  if (match) return `claude-${match[1]}-${match[2]}.${match[3]}`;
  throw new Error(`Unsupported model ID: ${model}`);
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (block.type === 'text') return block.text ?? '';
    throw new Error(`This prototype supports text tool results, not ${block.type}.`);
  }).join('\n');
}

export function translateRequest(body, reasoningCache = new Map()) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw new Error('messages must be a non-empty array.');
  const model = mapModel(body.model);
  const input = [];
  let toolResults = 0;
  let imageCount = 0;
  let messageSystemChars = 0;
  for (const message of body.messages) {
    if (message.role === 'system') {
      const context = textContent(message.content);
      messageSystemChars += context.length;
      if (context) input.push({ role: 'user', content: context });
      continue;
    }
    if (!['user', 'assistant'].includes(message.role)) throw new Error(`Unsupported role: ${message.role}`);
    if (typeof message.content === 'string') {
      if (message.content) input.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) throw new Error('Message content must be text or content blocks.');
    let text = ''; let parts = [];
    const flush = () => {
      if (parts.length) {
        if (text) parts.push({ type: 'input_text', text });
        input.push({ role: message.role, content: parts });
      } else if (text) input.push({ role: message.role, content: text });
      text = ''; parts = [];
    };
    const restored = new Set();
    for (const block of message.content) {
      if (block.type === 'text') text += block.text ?? '';
      else if (block.type === 'image') {
        if (message.role !== 'user') throw new Error('Image input requires user role.');
        if (text) parts.push({ type: 'input_text', text });
        text = ''; parts.push(inlineImage(block)); imageCount++;
      } else if (block.type === 'tool_use') {
        flush();
        if (message.role !== 'assistant') throw new Error('tool_use must be an assistant content block.');
        if (!block.id || !block.name) throw new Error('tool_use requires id and name.');
        for (const item of reasoningCache.get(`${model}\0${block.id}`) ?? []) {
          const key = JSON.stringify(item);
          if (!restored.has(key)) input.push(item), restored.add(key);
        }
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      } else if (block.type === 'tool_result') {
        if (message.role !== 'user' || !block.tool_use_id) throw new Error('tool_result requires user role and tool_use_id.');
        flush(); toolResults++;
        const result = imageToolResult(block);
        input.push(...result.items); imageCount += result.imageCount;
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        // Native reasoning envelopes are held server-side by tool-call ID.
      } else throw new Error(`Unsupported content block: ${block.type}`);
    }
    flush();
  }
  let tools = (body.tools ?? []).map(tool => {
    if (!tool.name || !tool.input_schema) throw new Error('Only client tools with name and input_schema are supported.');
    return { type: 'function', name: tool.name, description: tool.description ?? '', parameters: tool.input_schema };
  });
  if (body.tool_choice?.type === 'none') tools = [];
  else if (body.tool_choice && body.tool_choice.type !== 'auto') throw new Error('This prototype supports tool_choice auto or none.');
  const instructions = textContent(body.system);
  const leadingSystemMessages = [];
  for (const message of body.messages) {
    if (message.role !== 'system') break;
    leadingSystemMessages.push(message.content);
  }
  const estimatedInputTokens = estimateTokens({ instructions, input, tools }) + input.length * 8 + tools.length * 16;
  return { model, instructions, input, tools, estimatedInputTokens, toolResults, imageCount,
    systemChars: instructions.length + messageSystemChars,
    prefixHash: crypto.createHash('sha256').update(JSON.stringify({ model: body.model, instructions,
      systemMessages: leadingSystemMessages, tools })).digest('hex') };
}

export class SseDecoder {
  constructor(onEvent) { this.buffer = ''; this.onEvent = onEvent; }
  push(chunk) {
    this.buffer += chunk;
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      this.onEvent(JSON.parse(data));
    }
  }
  finish() {
    if (this.buffer.trim()) throw new Error('Upstream SSE ended with an incomplete event.');
  }
}

export class AnthropicStream {
  constructor(model, inputTokens, emit = () => {}) {
    this.model = model; this.inputTokens = inputTokens; this.emit = emit;
    this.id = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
    this.blocks = []; this.byKey = new Map(); this.byItemId = new Map();
    this.lastCall = null; this.finished = false; this.nativeUsage = null; this.rawItems = [];
  }
  start() {
    this.emit('message_start', { type: 'message_start', message: {
      id: this.id, type: 'message', role: 'assistant', model: this.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: this.inputTokens, output_tokens: 0 }
    } });
  }
  textBlock(key) {
    if (this.byKey.has(key)) return this.byKey.get(key);
    const block = { type: 'text', text: '', index: this.blocks.length, closed: false };
    this.blocks.push(block); this.byKey.set(key, block);
    this.emit('content_block_start', { type: 'content_block_start', index: block.index, content_block: { type: 'text', text: '' } });
    return block;
  }
  toolBlock(item) {
    const id = item.call_id ?? item.id;
    let block = this.byKey.get(`tool:${id}`);
    if (!block) {
      block = { type: 'tool_use', id, name: item.name, arguments: '', index: this.blocks.length, closed: false };
      this.blocks.push(block); this.byKey.set(`tool:${id}`, block);
      this.emit('content_block_start', { type: 'content_block_start', index: block.index,
        content_block: { type: 'tool_use', id, name: item.name, input: {} } });
    }
    if (item.id) this.byItemId.set(item.id, block);
    this.lastCall = block;
    return block;
  }
  argumentsDelta(block, delta) {
    if (!block || !delta || block.closed) return;
    block.arguments += delta;
    this.emit('content_block_delta', { type: 'content_block_delta', index: block.index,
      delta: { type: 'input_json_delta', partial_json: delta } });
  }
  close(block) {
    if (!block || block.closed) return;
    if (block.type === 'tool_use' && !block.arguments) this.argumentsDelta(block, '{}');
    if (block.type === 'tool_use') JSON.parse(block.arguments);
    block.closed = true;
    this.emit('content_block_stop', { type: 'content_block_stop', index: block.index });
  }
  accept(event) {
    if (this.finished) return;
    const type = event.type;
    if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const block = this.toolBlock(event.item);
      if (event.item.arguments) this.argumentsDelta(block, event.item.arguments);
    } else if (type === 'response.function_call_arguments.delta') {
      const block = event.item_id ? this.byItemId.get(event.item_id) : this.lastCall;
      if (!block) throw new Error('Tool argument delta references an unknown output item.');
      this.argumentsDelta(block, event.delta);
    } else if (type === 'response.function_call_arguments.done') {
      const block = event.item_id ? this.byItemId.get(event.item_id) : this.lastCall;
      if (block && !block.arguments && event.arguments) this.argumentsDelta(block, event.arguments);
      this.close(block);
    } else if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      const block = this.textBlock(`text:${event.output_index ?? 0}:${event.content_index ?? 0}`);
      block.text += event.delta ?? '';
      this.emit('content_block_delta', { type: 'content_block_delta', index: block.index,
        delta: { type: 'text_delta', text: event.delta ?? '' } });
    } else if (type === 'response.output_text.done') {
      this.close(this.byKey.get(`text:${event.output_index ?? 0}:${event.content_index ?? 0}`));
    } else if (type === 'response.output_item.done') {
      this.rawItems.push(event.item);
      if (event.item?.type === 'function_call') {
        const block = this.toolBlock(event.item);
        if (!block.arguments) this.argumentsDelta(block, event.item.arguments ?? '{}');
        this.close(block);
      }
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      this.nativeUsage = event.response?.usage ?? null;
      this.rawItems = event.response?.output ?? this.rawItems;
      for (const item of this.rawItems) {
        if (item?.type === 'function_call') {
          const block = this.toolBlock(item);
          if (!block.arguments) this.argumentsDelta(block, item.arguments ?? '{}');
        }
      }
      if (!this.blocks.length) {
        const text = this.rawItems.filter(item => item?.type === 'message').flatMap(item => item.content ?? []).map(part => part.text ?? '').join('');
        if (text) {
          const block = this.textBlock('final-text'); block.text = text;
          this.emit('content_block_delta', { type: 'content_block_delta', index: block.index, delta: { type: 'text_delta', text } });
        }
      }
      for (const block of this.blocks) this.close(block);
      this.stopReason = type === 'response.incomplete' ? 'max_tokens' : this.blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
      this.outputTokens = estimateTokens(this.blocks.map(block => block.text ?? block.arguments ?? '').join(''));
      this.emit('message_delta', { type: 'message_delta', delta: { stop_reason: this.stopReason, stop_sequence: null }, usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens } });
      this.emit('message_stop', { type: 'message_stop' }); this.finished = true;
    } else if (type === 'response.failed' || type === 'error') {
      throw new Error(event.error?.message ?? event.response?.error?.message ?? 'Upstream inference failed.');
    }
  }
  message() {
    return { id: this.id, type: 'message', role: 'assistant', model: this.model,
      content: this.blocks.map(block => block.type === 'text' ? { type: 'text', text: block.text } :
        { type: 'tool_use', id: block.id, name: block.name, input: JSON.parse(block.arguments || '{}') }),
      stop_reason: this.stopReason, stop_sequence: null,
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens ?? 0 } };
  }
}
