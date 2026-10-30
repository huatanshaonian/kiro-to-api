// A conservative heuristic for compaction scheduling, NOT a model tokenizer.
// Count CJK/Unicode separately: chars/4 badly undercounts Chinese conversations.
// Explicit per-image scheduling allowance, not measured/billed vision usage.
export const imageTokenEstimate = 4096;
export function estimateTokens(value) {
  let images = 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '', (key, item) => {
    if (item && typeof item === 'object' && ['input_image', 'image'].includes(item.type)) {
      images++; return { type: 'image_estimate', detail: item.detail ?? 'auto' };
    }
    return item;
  });
  let ascii = 0, unicode = 0;
  for (const char of text) {
    if (char.codePointAt(0) < 128) ascii++;
    else unicode += char.codePointAt(0) > 0xffff ? 3 : 2;
  }
  return Math.max(1, Math.ceil(ascii / 3) + unicode + images * imageTokenEstimate);
}

export function contextPolicy(env = process.env) {
  const contextTokens = Number(env.KIRO_GATEWAY_CONTEXT_TOKENS ?? 128000);
  const reserveTokens = Number(env.KIRO_GATEWAY_RESERVE_TOKENS ?? 16000);
  if (!Number.isSafeInteger(contextTokens) || !Number.isSafeInteger(reserveTokens) || reserveTokens < 1024 || contextTokens <= reserveTokens + 1024)
    throw new Error('Invalid gateway context/reserve token budget.');
  return { contextTokens, reserveTokens, inputTokens: contextTokens - reserveTokens, estimated: true };
}

export function checkContext(spec, policy) {
  if (spec.estimatedInputTokens > policy.inputTokens) {
    const error = new Error(`prompt is too long: estimated ${spec.estimatedInputTokens} input tokens exceeds gateway input budget ${policy.inputTokens}. Compact the conversation or reduce input. No messages were truncated.`);
    error.status = 400; error.type = 'invalid_request_error'; error.contextExceeded = true;
    throw error;
  }
}
