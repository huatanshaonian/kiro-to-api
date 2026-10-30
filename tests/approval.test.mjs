import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadApprovalConfig, isApprovalModel, assertApprovalRequest, forwardApproval } from '../src/approval-router.mjs';

const request = (extra = {}) => ({ model: 'deepseek-flash[1m]', max_tokens: 64, stream: false,
  system: [{ type: 'text', text: 'x-anthropic-billing-header: fixture' },
    { type: 'text', text: 'You are a security monitor for autonomous AI coding agents.\nPreserve this policy.' }],
  messages: [{ role: 'user', content: 'A synthetic pending operation.' }, { role: 'assistant', content: '<block>' }], ...extra });
const config = { enabled: true, url: 'http://127.0.0.1/anthropic/v1/messages', credential: 'upstream-fixture-credential',
  credentialHeader: 'authorization', credentialPrefix: 'Bearer ', timeoutMs: 1000 };
const message = { type: 'message', model: 'deepseek-flash', content: [{ type: 'text', text: 'no</block>' }],
  usage: { input_tokens: 42, output_tokens: 4, unsafe_extra: 'not logged' } };

test('reserved model cannot route normal conversations, subagents or streams', () => {
  assert.equal(isApprovalModel('claude-sonnet-5-5'), false);
  for (const extra of [{ system: 'ordinary chat' }, { stream: true }, { messages: [] },
    { messages: [1, 2, 3].map(() => ({ role: 'user', content: 'x' })) },
    { tools: [{ name: 'Bash' }] }, { model: 'claude-haiku-5-5' }]) assert.throws(() => assertApprovalRequest(request(extra)), /reserved/);
  assert.doesNotThrow(() => assertApprovalRequest(request()));
  assert.doesNotThrow(() => assertApprovalRequest(request({ tools: [{ name: 'classify_result' }] })));
});

test('upstream credential is isolated; native policy and verdict bytes stay intact', async () => {
  const body = request({ thinking: { type: 'adaptive' }, reasoning_effort: 'max' });
  const raw = JSON.stringify(message);
  const result = await forwardApproval(body, config, { headers: { authorization: 'Bearer local-fixture', 'x-api-key': 'local-fixture' },
    fetchImpl: async (url, options) => {
      assert.equal(url, config.url); assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, 'Bearer upstream-fixture-credential');
      assert.equal(options.headers['x-api-key'], undefined);
      const sent = JSON.parse(options.body);
      assert.deepEqual(sent.system, body.system); assert.deepEqual(sent.messages, body.messages);
      assert.equal(sent.model, 'deepseek-flash'); assert.deepEqual(sent.thinking, { type: 'disabled' });
      assert.equal(sent.reasoning_effort, undefined);
      return new Response(raw, { headers: { 'content-type': 'application/json', 'set-cookie': 'not forwarded' } });
    } });
  assert.equal(result.raw.toString(), raw); assert.equal(result.headers['set-cookie'], undefined);
  assert.deepEqual(result.usage, { input_tokens: 42, output_tokens: 4 });
  assert.equal(body.thinking.type, 'adaptive');
});

test('explicit block responses are relayed unchanged', async () => {
  const raw = JSON.stringify({ ...message, content: [{ type: 'text', text: 'yes</block>' }] });
  const result = await forwardApproval(request(), config, { fetchImpl: async () => new Response(raw) });
  assert.equal(result.raw.toString(), raw);
});

test('upstream auth, rate and server errors are never turned into approvals', async () => {
  for (const status of [401, 429, 503]) {
    const raw = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fixture failure' } });
    const result = await forwardApproval(request(), config, { fetchImpl: async () => new Response(raw, { status, headers: { 'retry-after': '2' } }) });
    assert.equal(result.status, status); assert.equal(result.raw.toString(), raw); assert.equal(result.headers['retry-after'], '2');
  }
  for (const response of ['not JSON', '{"type":"message","content":[]}'])
    await assert.rejects(forwardApproval(request(), config, { fetchImpl: async () => new Response(response) }), error => error.status === 502);
  await assert.rejects(forwardApproval(request(), { enabled: false }), error => error.status === 503);
});

test('timeouts and disconnects remain errors without disclosing credentials', async () => {
  await assert.rejects(forwardApproval(request(), config, { fetchImpl: async () => { throw new DOMException('fixture', 'TimeoutError'); } }), error => error.status === 504);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(forwardApproval(request(), config, { signal: controller.signal,
    fetchImpl: async () => { throw Error(config.credential); } }), error => error.status === 499 && !error.message.includes(config.credential));
  await assert.rejects(forwardApproval(request(), config, { fetchImpl: async () => { throw Error(config.credential); } }), error => error.status === 502 && !error.message.includes(config.credential));
});

test('local profile credentials reload for rotation; invalid destinations fail closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-approval-test-'));
  try {
    assert.deepEqual(loadApprovalConfig(dir), { enabled: false });
    const profile = path.join(dir, 'provider.json');
    fs.writeFileSync(path.join(dir, 'approval-routing.local.json'), JSON.stringify({ enabled: true, providerSettingsFile: profile }));
    fs.writeFileSync(profile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'first-fixture' } }));
    assert.equal(loadApprovalConfig(dir).credential, 'first-fixture');
    fs.writeFileSync(profile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_API_KEY: 'rotated-fixture' } }));
    assert.equal(loadApprovalConfig(dir).credential, 'rotated-fixture'); assert.equal(loadApprovalConfig(dir).credentialHeader, 'x-api-key');
    fs.writeFileSync(profile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://unexpected.invalid', ANTHROPIC_API_KEY: 'rotated-fixture' } }));
    assert.throws(() => loadApprovalConfig(dir), error => error.status === 503 && !error.message.includes('rotated-fixture'));
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('kiro-approval-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP boundary enforces local auth, isolates upstream auth, tracks busy state and cancels', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-approval-http-test-'));
  let calls = 0; let held = false; let seenAuth;
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    calls++; seenAuth = req.headers.authorization;
    if (!held) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const profile = path.join(dir, 'provider.json');
  const localConfig = path.join(dir, 'approval-routing.local.json');
  fs.writeFileSync(profile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}/anthropic`, ANTHROPIC_AUTH_TOKEN: 'upstream-http-fixture' } }));
  fs.writeFileSync(localConfig, JSON.stringify({ enabled: true, providerSettingsFile: profile, timeoutMs: 1000 }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    { env: { ...process.env, KIRO_GATEWAY_DATA_DIR: dir, KIRO_GATEWAY_PORT: '0' }, stdio: 'ignore', windowsHide: true });
  t.after(async () => {
    const stopped = child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
    child.kill(); await stopped; upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('kiro-approval-http-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function until(predicate) {
    for (let i = 0; i < 120; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw Error('Timed out waiting for HTTP test state');
  }
  const stateFile = path.join(dir, 'gateway-state.json');
  await until(() => fs.existsSync(stateFile));
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const localKey = fs.readFileSync(state.keyPath, 'utf8').trim();
  const post = (body, signal, key = localKey, route = '/v1/messages') => fetch(state.baseUrl + route,
    { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  assert.equal((await post(request(), undefined, 'wrong-local-fixture')).status, 401); assert.equal(calls, 0);
  const allowed = await post(request()); assert.equal(allowed.status, 200); assert.deepEqual(await allowed.json(), message);
  assert.equal(seenAuth, 'Bearer upstream-http-fixture'); assert.notEqual(seenAuth, 'Bearer ' + localKey);
  assert.equal((await post(request({ system: 'ordinary chat' }))).status, 400); assert.equal(calls, 1);
  fs.writeFileSync(localConfig, '{"enabled":false}');
  assert.equal((await post(request())).status, 503); assert.equal(calls, 1);
  fs.writeFileSync(localConfig, JSON.stringify({ enabled: true, providerSettingsFile: profile, timeoutMs: 1000 }));
  held = true;
  const health = async () => (await fetch(state.baseUrl + '/health')).json();
  const controller = new AbortController();
  const pending = post(request(), controller.signal); const rejection = assert.rejects(pending);
  await until(() => calls === 2);
  assert.equal((await health()).approvalRouting.inflight, 1);
  assert.equal((await post({}, undefined, localKey, '/shutdown')).status, 409);
  controller.abort(); await rejection;
  await until(async () => (await health()).inflight === 0);
  assert.equal((await post(request())).status, 504);
  await until(async () => (await health()).inflight === 0);
  const records = fs.readFileSync(path.join(dir, 'requests.jsonl'), 'utf8');
  assert.ok(!records.includes('upstream-http-fixture')); assert.ok(!records.includes(localKey));
  assert.ok(records.includes('deepseek-approval'));
});
