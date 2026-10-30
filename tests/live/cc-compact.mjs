import { sourceRoot, dataRoot, testResultsRoot } from '../../src/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ensureGateway } from '../../src/manage.mjs';

const root = dataRoot;
const liveRoot = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(testResultsRoot, { recursive: true });
const automatic = process.argv.includes('--auto');
const imageMode = process.argv.includes('--image');
const imagePath = path.join(liveRoot, '..', 'fixtures', 'vision.png');
const imageCode = imageMode ? fs.readFileSync(path.join(liveRoot, '..', 'fixtures', 'vision-code.txt'), 'utf8').trim() : null;
const state = await ensureGateway();
const key = fs.readFileSync(state.keyPath, 'utf8').trim();
const output = path.join(testResultsRoot, `cc-compact-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const session = crypto.randomUUID();
const facts = Object.fromEntries(['START', 'MIDDLE', 'END'].map(name => [name, crypto.randomBytes(8).toString('hex')]));
const lookupKey = `compact_${crypto.randomBytes(6).toString('hex')}`;
const value = `after_compact_${crypto.randomBytes(10).toString('hex')}`;
const mcpPath = path.join(output, 'mcp.json'), callLog = path.join(output, 'mcp-calls.jsonl');
fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { probe: { command: process.execPath,
  args: [path.join(liveRoot, 'fake-mcp.mjs')], env: { PROBE_EXPECTED_KEY: lookupKey, PROBE_RETURN_VALUE: value, PROBE_CALL_LOG: callLog, ...(imageMode ? { PROBE_IMAGE_PATH: imagePath } : {}) } } } }));

async function cc(name, prompt, first = false) {
  const args = [path.join(sourceRoot, 'cc-kiro.mjs'), '--setting-sources', '', '-p', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--strict-mcp-config', '--mcp-config', mcpPath, '--allowedTools', 'mcp__probe__lookup_probe',
    '--max-turns', '4', ...(first ? ['--session-id', session] : ['--resume', session])];
  const child = spawn(process.execPath, args, { cwd: output, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(output, 'config'),
    ...(automatic ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '10' } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  child.stdin.end(prompt);
  const timer = setTimeout(() => child.kill(), 300000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }); }
  finally { clearTimeout(timer); }
  stdout = stdout.split(key).join('[local credential]'); stderr = stderr.split(key).join('[local credential]');
  fs.writeFileSync(path.join(output, `${name}.jsonl`), stdout); fs.writeFileSync(path.join(output, `${name}.stderr.txt`), stderr);
  const events = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = events.findLast(event => event.type === 'result');
  console.log(JSON.stringify({ name, code, result: result?.result, subtypes: events.filter(e => e.type === 'system').map(e => e.subtype) }));
  if (code !== 0 || result?.is_error || !result) throw new Error(`${name}: ${stdout.slice(-1200)} ${stderr.slice(-500)}`);
  return { events, result };
}

try {
  const filler = Array.from({ length: 600 }, (_, i) => `Background record ${i}: sample measurements are synthetic and have no pending action.\n`).join('');
  const prompt = `We are testing conversation continuity. Preserve these exact facts and the pending task when summarizing. ` +
    `Immutable constraint: do not modify any files. Pending task: after compaction, look up key ${lookupKey} using lookup_probe and report its value. ` +
    `START=${facts.START}\n${filler}\nMIDDLE=${facts.MIDDLE}\n${filler}\nEND=${facts.END}\n` +
    (imageMode ? 'Before compaction, call lookup_probe on server probe now with the pending lookup key. Its result includes a picture. Report both its value field and the exact code printed in the image. Do not call other tools.' : 'For now only reply RECORDED. Do not call any tools yet.');
  const before = await cc('01-long-context', prompt, true);
  if (imageMode && !before.result.result?.includes(imageCode)) throw new Error('The pre-compact image pixels were not read correctly.');
  const compact = automatic ? { events: [] } : await cc('02-compact', '/compact Preserve START, MIDDLE, END exactly, the immutable constraint, and the pending lookup task including its exact key.');
  const after = await cc('03-after-compact', 'Continue the pending lookup task now. Reply with JSON containing START, MIDDLE, END, constraint, toolValue' + (imageMode ? ', and imageCode.' : '.'));
  const boundaries = [...before.events, ...compact.events, ...after.events].filter(event => event.type === 'system' && event.subtype === 'compact_boundary');
  if (!boundaries.length) throw new Error('No actual Claude Code compact_boundary was observed.');
  const text = after.result.result ?? '';
  const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').map(JSON.parse) : [];
  if (!Object.values(facts).every(fact => text.includes(fact)) || !text.includes(value) || !calls.some(call => call.valid))
    throw new Error('Facts or external tool result were lost after compaction.');
  if (imageMode && !text.includes(imageCode)) throw new Error('Image code missing after compaction.');
  const summary = { ok: true, imageMode, imageBeforeCompactVerified: imageMode, imageAfterCompactVerified: imageMode, mode: automatic ? 'auto-threshold-10-percent' : 'manual', compactBoundaries: boundaries, factsRetained: true, toolAfterCompactPassed: true,
    inputCharacters: prompt.length, session, outputDirectory: output };
  fs.writeFileSync(path.join(root, imageMode ? (automatic ? 'latest-cc-image-auto-compact-test.json' : 'latest-cc-image-compact-test.json') : (automatic ? 'latest-cc-auto-compact-test.json' : 'latest-cc-compact-test.json')), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
} catch (error) {
  const summary = { ok: false, error: error.message, session, outputDirectory: output };
  fs.writeFileSync(path.join(root, imageMode ? (automatic ? 'latest-cc-image-auto-compact-test.json' : 'latest-cc-image-compact-test.json') : (automatic ? 'latest-cc-auto-compact-test.json' : 'latest-cc-compact-test.json')), JSON.stringify(summary, null, 2));
  console.error(JSON.stringify(summary)); process.exitCode = 1;
}
