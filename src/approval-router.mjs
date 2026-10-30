import fs from 'node:fs';
import path from 'node:path';

export const approvalModel = 'deepseek-flash';
export const approvalConfigName = 'approval-routing.local.json';
export const isApprovalModel = model => model === approvalModel || model === `${approvalModel}[1m]`;
const failure = (status, message) => Object.assign(new Error(message), { status });

export function loadApprovalConfig(root) {
  const file = path.join(root, approvalConfigName);
  if (!fs.existsSync(file)) return { enabled: false };
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (settings.enabled === false) return { enabled: false };
    if (settings.enabled !== true || !path.isAbsolute(settings.providerSettingsFile ?? '')) throw new Error();
    const provider = JSON.parse(fs.readFileSync(settings.providerSettingsFile, 'utf8').replace(/^\uFEFF/, ''));
    const env = provider.env ?? {};
    const base = new URL(env.ANTHROPIC_BASE_URL);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
    if (base.username || base.password || base.search || base.hash ||
        !(loopback && base.protocol === 'http:' || base.protocol === 'https:' && base.hostname === 'api.deepseek.com' && !base.port && base.pathname.replace(/\/$/, '') === '/anthropic')) throw new Error();
    const credential = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
    if (typeof credential !== 'string' || !credential.trim() || /[\r\n]/.test(credential)) throw new Error();
    const timeoutMs = settings.timeoutMs ?? 45000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error();
    return { enabled: true, url: `${base.href.replace(/\/$/, '')}/v1/messages`, credential,
      credentialHeader: env.ANTHROPIC_API_KEY ? 'x-api-key' : 'authorization',
      credentialPrefix: env.ANTHROPIC_API_KEY ? '' : 'Bearer ', timeoutMs };
  } catch {
    // Never include credential material, provider contents or raw parse errors.
    throw failure(503, 'DeepSeek approval routing configuration is unavailable or invalid.');
  }
}

export function assertApprovalRequest(body) {
  const blocks = typeof body.system === 'string' ? [{ text: body.system }] : body.system;
  const signature = Array.isArray(blocks) && blocks.some(block =>
    typeof block?.text === 'string' && block.text.trimStart().startsWith('You are a security monitor for autonomous AI coding agents.'));
  if (!isApprovalModel(body.model) || !signature || body.stream === true ||
      !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 2 ||
      !body.messages.every(message => ['user', 'assistant'].includes(message.role)) ||
      body.tools && (!Array.isArray(body.tools) || body.tools.some(tool => tool.name !== 'classify_result'))) {
    throw failure(400, 'This model is reserved for native Claude Code auto-mode approval requests.');
  }
}

export async function forwardApproval(body, config, { signal, headers = {}, fetchImpl = fetch } = {}) {
  assertApprovalRequest(body);
  if (!config.enabled) throw failure(503, 'DeepSeek approval routing is not enabled.');
  const upstreamHeaders = { 'content-type': 'application/json',
    'anthropic-version': headers['anthropic-version'] ?? '2023-06-01',
    [config.credentialHeader]: config.credentialPrefix + config.credential };
  if (headers['anthropic-beta']) upstreamHeaders['anthropic-beta'] = headers['anthropic-beta'];
  // Preserve native policy, transcript, prefill and scoring format. Only the
  // upstream model and classifier-only thinking settings change.
  const payload = { ...body, model: approvalModel, thinking: { type: 'disabled' } };
  delete payload.reasoning_effort;
  try {
    const signals = [AbortSignal.timeout(config.timeoutMs)];
    if (signal) signals.push(signal);
    const response = await fetchImpl(config.url, { method: 'POST', headers: upstreamHeaders,
      body: JSON.stringify(payload), signal: AbortSignal.any(signals), redirect: 'error' });
    const chunks = []; let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 1024 * 1024) throw failure(502, 'DeepSeek approval response exceeded the size limit.');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch {}
    if (response.ok && (parsed?.type !== 'message' || !Array.isArray(parsed.content) || !parsed.content.length)) {
      throw failure(502, 'DeepSeek approval returned an invalid Messages response.');
    }
    const usage = {};
    for (const name of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])
      if (Number.isFinite(parsed?.usage?.[name])) usage[name] = parsed.usage[name];
    const resultHeaders = { 'content-type': response.headers.get('content-type') ?? 'application/json' };
    for (const name of ['retry-after', 'request-id']) if (response.headers.has(name)) resultHeaders[name] = response.headers.get(name);
    // HTTP failures remain failures; no synthetic allow and no router fallback.
    return { status: response.status, raw, headers: resultHeaders, usage };
  } catch (error) {
    if (signal?.aborted) throw failure(499, 'Approval client disconnected.');
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw failure(504, 'DeepSeek approval request timed out.');
    if (error.status) throw error;
    throw failure(502, 'DeepSeek approval upstream request failed.');
  }
}
