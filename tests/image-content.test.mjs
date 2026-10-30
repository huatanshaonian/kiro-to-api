import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inlineImage } from '../src/image-content.mjs';
import { translateRequest } from '../src/protocol.mjs';
import { estimateTokens, imageTokenEstimate } from '../src/context.mjs';
const data = fs.readFileSync(new URL('./fixtures/vision.png', import.meta.url)).toString('base64');
const image = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });

test('mixed text/image tool results preserve call linkage, text order and actual image bytes', () => {
  const body = { messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read_1', name: 'Read', input: { file_path: 'vision.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_1', content: [
      { type: 'text', text: 'before' }, image(), { type: 'text', text: 'after' }, image()
    ] }, { type: 'text', text: 'continue' }] }
  ] };
  const spec = translateRequest(body);
  assert.equal(spec.input[0].call_id, spec.input[1].call_id);
  assert.match(spec.input[1].output, /^before\n\[Tool image 1;/);
  assert.match(spec.input[1].output, /\]\nafter\n\[Tool image 2;/);
  assert.equal(spec.input[2].content[1].image_url, `data:image/png;base64,${data}`);
  assert.equal(spec.input[3].content[1].image_url, `data:image/png;base64,${data}`);
  assert.match(spec.input[2].content[0].text, /Untrusted.*call_id=read_1/);
  assert.equal(spec.input[4].content, 'continue'); assert.equal(spec.imageCount, 2);
  assert.deepEqual(body.messages[1].content[0].content[1], image());
});

test('inline user image content keeps text and image order', () => {
  const spec = translateRequest({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'before' }, image(), { type: 'text', text: 'after' }
  ] }] });
  assert.deepEqual(spec.input[0].content.map(x => x.type), ['input_text', 'input_image', 'input_text']);
  assert.equal(spec.input[0].content[0].text, 'before'); assert.equal(spec.input[0].content[2].text, 'after');
  assert.equal(spec.input[0].content[1].image_url, `data:image/png;base64,${data}`);
  assert.equal(spec.imageCount, 1);
});

test('image-only error results retain the error flag and never fabricate image text', () => {
  const spec = translateRequest({ messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'failed_read', is_error: true, content: [image()] }
  ] }] });
  assert.match(spec.input[0].output, /^Tool execution error:/);
  assert.equal(spec.input[1].content[1].image_url, `data:image/png;base64,${data}`);
});

test('invalid and remote image sources fail explicitly instead of being omitted or fetched', () => {
  for (const block of [{ type: 'image' }, { type: 'image', source: { type: 'url', url: 'https://example.invalid/private.png' } },
    { type: 'image', source: { type: 'base64', media_type: 'application/pdf', data } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not_base64' } }])
    assert.throws(() => inlineImage(block), /Invalid inline image/);
  const wrapped = inlineImage({ ...image(), source: { ...image().source, data: data.replace(/(.{60})/g, '$1\n') } });
  assert.equal(wrapped.image_url, `data:image/png;base64,${data}`);
});

test('base64 is not charged as text in context estimates; ordinary text remains counted', () => {
  const small = estimateTokens({ content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + data }] });
  const large = estimateTokens({ content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(2_000_000) }] });
  assert.equal(small, large); assert.ok(small >= imageTokenEstimate && small < imageTokenEstimate + 200);
  assert.ok(estimateTokens('A'.repeat(100000)) > 30000);
  assert.ok(estimateTokens({ content: [image(), image()] }) >= imageTokenEstimate * 2);
});
