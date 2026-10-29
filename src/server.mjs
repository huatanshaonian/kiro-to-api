import { dataRoot, ensureDataRoot, installationId, gatewayPort, projectRoot } from './paths.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { modelIds, translateRequest, AnthropicStream } from './protocol.mjs';
import { infer } from './native-bridge.mjs';
import { contextPolicy, checkContext } from './context.mjs';
import { ReasoningStore } from './reasoning-store.mjs';
import { RequestQueue } from './request-queue.mjs';

const root = ensureDataRoot();
const keyPath = path.join(root, 'local-api-key');
const statePath = path.join(root, 'gateway-state.json');
const logPath = path.join(root, 'requests.jsonl');
const apiKey = fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8').trim() : crypto.randomBytes(32).toString('hex');
if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, `${apiKey}\n`, { mode: 0o600 });
const reasoningCache = new ReasoningStore(path.join(root, 'reasoning-state.json'));
const policy = contextPolicy();
const queue = new RequestQueue();
let inflight = 0;
const limitations = {
  systemRole: 'Forwarded as leading user-message context; upstream rejects custom system instructions.',
  cache: 'Upstream-managed and not reported; Anthropic cache_control markers are not translated.',
  tokenUsage: 'Estimated from text length unless reported upstream; not Kiro billing.',
  supported: ['text', 'custom function tools', 'tool results', 'SSE text/tool streams'],
  notImplemented: ['images/documents', 'server tools', 'prompt-cache control', 'max_tokens enforcement', 'full thinking/context-management compatibility']
};
function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'x-kiro-gateway': 'local-v1', ...headers });
  response.end(JSON.stringify(body));
}
function authorized(request) {
  const given = request.headers['x-api-key'] ?? request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given); const b = Buffer.from(apiKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function readJson(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16_000_000) throw new Error('Request exceeds the 16 MB gateway limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function audit(record) { fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n'); }

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/health' || (request.method === 'HEAD' && url.pathname === '/api/hello')) {
    return json(response, 200, { ok: true, service: 'kiro-anthropic-local', revision: 3, installationId, inflight, queued: queue.waiting.length });
  }
  if (!authorized(request)) {
    audit({ status: 401, method: request.method, path: url.pathname, localAuthenticationRejected: true });
    return json(response, 401, { type: 'error', error: { type: 'authentication_error', message: 'A valid local gateway credential is required.' } });
  }
  if (url.pathname === '/protocol') return json(response, 200, { prototype: true, revision: 2, contextPolicy: policy, reasoningPersistence: { ttlHours: 24, maxEntries: 1000 }, ...limitations });
  if (url.pathname === '/v1/models' && request.method === 'GET') {
    return json(response, 200, { data: modelIds.map(id => ({ id, type: 'model', display_name: id, created_at: '2026-10-29T00:00:00Z' })),
      has_more: false, first_id: modelIds[0], last_id: modelIds.at(-1) });
  }
  if (url.pathname === '/shutdown' && request.method === 'POST') {
    if (inflight || queue.waiting.length) return json(response, 409, { error: 'Requests are still running.' });
    json(response, 200, { stopped: true }); server.close(); return;
  }
  if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname)) {
    return json(response, 404, { type: 'error', error: { type: 'not_found_error', message: 'Unknown endpoint.' } });
  }
  let body; let spec;
  try { body = await readJson(request); spec = translateRequest(body, reasoningCache); }
  catch (error) { return json(response, 400, { type: 'error', error: { type: 'invalid_request_error', message: error.message } }); }
  if (url.pathname.endsWith('/count_tokens')) return json(response, 200, { input_tokens: spec.estimatedInputTokens }, { 'x-kiro-token-usage': 'estimated' });
  try { checkContext(spec, policy); }
  catch (error) { return json(response, 400, { type: 'error', error: { type: error.type, message: error.message } }); }
  const started = Date.now(); const requestId = crypto.randomUUID(); const controller = new AbortController();
  response.on('close', () => { if (!response.writableEnded) controller.abort(); });
  let release;
  try { release = await queue.acquire(controller.signal); }
  catch (error) {
    if (!response.destroyed) json(response, error.status ?? 503, { type: 'error', error: { type: 'rate_limit_error', message: error.message } }, { 'Retry-After': '2' });
    return;
  }
  const queuedMs = Date.now() - started;
  let ping;
  const emit = (event, value) => {
    if (body.stream && !response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  if (body.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
      'request-id': requestId, 'x-kiro-gateway': 'local-v1', 'x-kiro-system-role': 'user-context', 'x-kiro-cache-status': 'not-reported', 'x-kiro-token-usage': 'estimated' });
    ping = setInterval(() => emit('ping', { type: 'ping' }), 5000);
  }
  const adapter = new AnthropicStream(body.model ?? 'claude-haiku-5-5', spec.estimatedInputTokens, emit);
  inflight++;
  if (body.stream) adapter.start();
  try {
    const native = await infer(spec, event => adapter.accept(event), controller.signal);
    if (!adapter.finished) throw new Error('The model stream ended without a completed response.');
    reasoningCache.remember(spec.model, adapter.rawItems);
    audit({ requestId, model: spec.model, status: 200, elapsedMs: Date.now() - started,
      queuedMs, messageCount: body.messages.length, estimatedInputTokens: spec.estimatedInputTokens,
      nativeUsage: adapter.nativeUsage,
      systemChars: spec.systemChars, tools: spec.tools.map(tool => tool.name),
      toolResultsReceived: spec.toolResults, toolCallsReturned: adapter.blocks.filter(block => block.type === 'tool_use').length,
      prefixHash: spec.prefixHash, prefixMetricVersion: 2, nativeToolExecutions: native.nativeToolExecutions,
      upstreamRequestId: native.requestId, kiroCredits: adapter.nativeUsage?.['kiro:credits']?.value ?? null,
      cacheReadTokens: adapter.nativeUsage?.cache_read_input_tokens ?? null,
      cacheWriteTokens: adapter.nativeUsage?.cache_creation_input_tokens ?? null });
    if (body.stream) response.end();
    else json(response, 200, adapter.message(), { 'request-id': requestId, 'x-kiro-system-role': 'user-context',
      'x-kiro-cache-status': 'not-reported', 'x-kiro-token-usage': 'estimated' });
  } catch (error) {
    audit({ requestId, model: spec.model, status: error.status ?? 502, error: error.message, elapsedMs: Date.now() - started });
    const type = error.status === 429 ? 'rate_limit_error' : error.status === 400 ? 'invalid_request_error' : error.status === 401 ? 'authentication_error' : 'api_error';
    const failure = { type: 'error', error: { type, message: error.message } };
    if (body.stream) { emit('error', failure); response.end(); }
    else json(response, error.status >= 400 && error.status < 600 ? error.status : 502, failure);
  } finally { clearInterval(ping); inflight--; release(); }
});

server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.on('close', () => {
  try { const state = JSON.parse(fs.readFileSync(statePath, 'utf8')); if (state.pid === process.pid) fs.unlinkSync(statePath); } catch {}
});
server.listen(gatewayPort, '127.0.0.1', () => {
  const port = server.address().port;
  const state = { installationId, projectRoot, pid: process.pid, baseUrl: `http://127.0.0.1:${port}`, keyPath, startedAt: new Date().toISOString() };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ ...state, keyPath: '[local credential file]', limitations }));
});
