import { sourceRoot, dataRoot, testResultsRoot } from '../../src/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startOpenCode } from '../../src/opencode-server.mjs';
const root = dataRoot;
const liveRoot = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(testResultsRoot, { recursive: true });
const automatic = process.argv.includes('--auto');
const output = path.join(testResultsRoot, `oc-compact-${Date.now()}`);
const facts = Object.fromEntries(['START', 'MIDDLE', 'END'].map(name => [name, crypto.randomBytes(8).toString('hex')]));
const lookupKey = `oc_${crypto.randomBytes(6).toString('hex')}`, value = `oc_after_compact_${crypto.randomBytes(10).toString('hex')}`;
const callLog = path.join(output, 'mcp-calls.jsonl');
const server = await startOpenCode(output, {
  permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'probe_*', resource: '*', effect: 'allow' }],
  mcp: { servers: { probe: { type: 'local', codemode: false, command: [process.execPath, path.join(liveRoot, 'fake-mcp.mjs')],
    environment: { PROBE_EXPECTED_KEY: lookupKey, PROBE_RETURN_VALUE: value, PROBE_CALL_LOG: callLog } } } },
  compaction: { auto: true, keep: { tokens: 1000 }, buffer: automatic ? 100000 : 16000 }
});
try {
  const session = (await server.request('POST', '/api/session', { title: 'Kiro compact acceptance',
    location: { directory: output }, model: { providerID: 'kiro', id: 'claude-haiku-5-5' } })).data;
  const route = `/api/session/${session.id}`;
  const mcp = await server.request('GET', '/api/mcp?location[directory]=' + encodeURIComponent(output));
  console.log(JSON.stringify({ session: session.id, mcp }));
  async function prompt(name, text) {
    await server.request('POST', route + '/prompt', { text });
    await server.request('POST', `/api/experimental/session/${session.id}/wait`);
    const messages = await server.request('GET', route + '/message?limit=100&order=asc');
    fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(messages, null, 2));
    const assistants = messages.data.filter(message => message.type === 'assistant');
    console.log(JSON.stringify({ name, messageTypes: messages.data.map(message => message.type), lastAssistant: assistants.at(-1) }));
    return messages;
  }
  const filler = Array.from({ length: 500 }, (_, i) => `Synthetic background ${i}: test material has no action and must not replace the pending task.\n`).join('');
  const text = `Preserve the following exact facts and pending task when summarizing. Constraint: do not modify any files. ` +
    `The pending lookup task is LOCKED until the user sends the exact command NEXT_LOOKUP. Compaction does NOT unlock it. ` +
    `Once explicitly unlocked, call lookup_probe using key ${lookupKey}, and report its value. Until then reply RECORDED only, no tool calls.\n` +
    `START=${facts.START}\n${filler}\nMIDDLE=${facts.MIDDLE}\n${filler}\nEND=${facts.END}\nFor now reply RECORDED only and do not call tools.`;
  const before = await prompt('01-before', text);
  if (fs.existsSync(callLog) && fs.readFileSync(callLog, 'utf8').trim()) throw new Error('The pending tool ran before explicit unlock.');
  if (!JSON.stringify(before.data.filter(m => m.type === 'assistant').at(-1)).includes('RECORDED')) throw new Error('Recording response was not preserved.');
  if (!automatic) await server.request('POST', route + '/compact', {});
  else await prompt('02-auto-trigger', 'Keep the pending lookup task for the next message. Reply WAITING only.');
  await server.request('POST', `/api/experimental/session/${session.id}/wait`);
  const compacted = await server.request('GET', route + '/message?type=compaction&limit=100&order=asc');
  fs.writeFileSync(path.join(output, '02-compaction.json'), JSON.stringify(compacted, null, 2));
  console.log(JSON.stringify({ compactions: compacted.data }));
  if (!compacted.data.some(message => message.status === 'completed' && (!automatic || message.reason !== 'manual'))) throw new Error('No completed native OpenCode compaction was observed.');
  const after = await prompt('03-after', 'NEXT_LOOKUP. Continue the pending lookup task now. Reply with JSON containing START, MIDDLE, END, constraint, and toolValue.');
  const last = after.data.filter(message => message.type === 'assistant').at(-1);
  const result = JSON.stringify(last);
  const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').map(JSON.parse) : [];
  if (!Object.values(facts).every(fact => result.includes(fact)) || !result.includes(value) || !calls.some(call => call.valid)) throw new Error('Facts or MCP result missing after OpenCode compaction.');
  const summary = { ok: true, mode: automatic ? 'auto-test-buffer-100k' : 'manual', nativeCompactionObserved: true, factsRetained: true, explicitUnlockRespected: true, toolAfterCompactPassed: true, inputCharacters: text.length, session: session.id, outputDirectory: output };
  fs.writeFileSync(path.join(root, automatic ? 'latest-opencode-auto-compact-test.json' : 'latest-opencode-compact-test.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
} catch (error) {
  const summary = { ok: false, error: error.message, outputDirectory: output };
  fs.writeFileSync(path.join(root, automatic ? 'latest-opencode-auto-compact-test.json' : 'latest-opencode-compact-test.json'), JSON.stringify(summary, null, 2)); console.error(JSON.stringify(summary)); process.exitCode = 1;
} finally { await server.stop(); }
