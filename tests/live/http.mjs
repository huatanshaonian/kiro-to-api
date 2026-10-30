import { sourceRoot, dataRoot, testResultsRoot } from '../../src/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ensureGateway } from '../../src/manage.mjs';
const root = dataRoot;
const liveRoot = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(testResultsRoot, { recursive: true });
const state = await ensureGateway(), key = fs.readFileSync(state.keyPath, 'utf8').trim();
const headers = { 'x-api-key': key, 'Content-Type': 'application/json' };
const post = body => fetch(state.baseUrl + '/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
assert.equal((await fetch(state.baseUrl + '/v1/models')).status, 401);
assert.equal((await post({ messages: [] })).status, 400);
const protocol = await (await fetch(state.baseUrl + '/protocol', { headers })).json();
// Exceed the configured local estimate, including the new 1M budget, before inference.
const oversized = await post({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: '中文'.repeat(Math.ceil(protocol.contextPolicy.inputTokens / 4) + 1024) }] });
assert.equal(oversized.status, 400); assert.match(await oversized.text(), /prompt is too long/);
const controller = new AbortController();
const response = await fetch(state.baseUrl + '/v1/messages', { method: 'POST', headers, signal: controller.signal,
  body: JSON.stringify({ model: 'claude-haiku-5-5', stream: true, messages: [{ role: 'user', content: 'Reply OK only.' }] }) });
assert.equal(response.status, 200);
const requestId = response.headers.get('request-id');
const reader = response.body.getReader(); await reader.read();
controller.abort();
let cancellation;
for (let n = 0; n < 100; n++) {
  // Other integration tests may be using the gateway concurrently. Match our
  // request ID instead of incorrectly requiring the entire service to be idle.
  const records = fs.readFileSync(path.join(root, 'requests.jsonl'), 'utf8').trim().split('\n').slice(-100).map(JSON.parse);
  cancellation = records.find(record => record.requestId === requestId && record.status === 499);
  if (cancellation) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
assert.ok(cancellation, 'Cancelled request did not finish with its own 499 audit record.');
const summary = { ok: true, localAuthenticationPassed: true, badRequestRejected: true,
  contextOverflowRejectedBeforeInference: true, cancelledRequestReleased: true };
fs.writeFileSync(path.join(root, 'latest-http-test.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
