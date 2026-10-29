import { sourceRoot, dataRoot, testResultsRoot } from '../../src/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ensureGateway } from '../../src/manage.mjs';
import { openCodeExe } from '../../src/opencode-config.mjs';
import { startOpenCode } from '../../src/opencode-server.mjs';

const root = dataRoot;
const liveRoot = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(testResultsRoot, { recursive: true });
const state = await ensureGateway();
const key = fs.readFileSync(state.keyPath, 'utf8').trim();
const output = path.join(testResultsRoot, `opencode-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const expectedKey = `oc_${crypto.randomBytes(6).toString('hex')}`;
const value = `external_${crypto.randomBytes(10).toString('hex')}`;
const callLog = path.join(output, 'mcp-calls.jsonl');

async function run(name, prompt, mcp = false) {
  const config = { permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'probe_*', resource: '*', effect: 'allow' }] };
  if (mcp) config.mcp = { servers: { probe: { type: 'local', codemode: false, command: [process.execPath, path.join(liveRoot, 'fake-mcp.mjs')],
    environment: { PROBE_EXPECTED_KEY: expectedKey, PROBE_RETURN_VALUE: value, PROBE_CALL_LOG: callLog } } } };
  const launcher = process.argv.includes('--launcher');
  let server;
  if (launcher) fs.writeFileSync(path.join(output, 'opencode.json'), JSON.stringify(config));
  else server = await startOpenCode(path.join(output, name), config, { cwd: output });
  const args = ['run', '--auto', '--format', 'json', '--model', 'kiro/claude-haiku-5-5', prompt];
  const child = launcher ? spawn(process.execPath, [path.join(sourceRoot, 'opencode-kiro.mjs'), ...args],
    { env: process.env, cwd: output, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) :
    spawn(openCodeExe, [...args, '--server', server.baseUrl], { env: server.clientEnv, cwd: output, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const timer = setTimeout(() => child.kill(), 180000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }); }
  finally {
    clearTimeout(timer);
    if (server) await server.stop();
  }
  stdout = stdout.split(key).join('[local credential]'); stderr = stderr.split(key).join('[local credential]');
  fs.writeFileSync(path.join(output, `${name}.jsonl`), stdout); fs.writeFileSync(path.join(output, `${name}.stderr.txt`), stderr);
  const events = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const text = events.filter(event => event.type === 'text').map(event => event.part?.text ?? event.text ?? '').join('');
  console.log(JSON.stringify({ name, code, text, eventTypes: [...new Set(events.map(e => e.type))], stderr: stderr.slice(-1000) }));
  if (code !== 0 || events.some(event => event.type === 'error')) throw new Error(`${name} failed: ${stdout.slice(-1500)} ${stderr.slice(-500)}`);
  return { text, events };
}
try {
  if (!process.argv.includes('--tool-only')) {
    const baseline = await run('01-text', 'Reply with exactly OPENCODE_KIRO_OK. Do not call tools.');
    if (baseline.text.trim() !== 'OPENCODE_KIRO_OK') throw new Error('OpenCode baseline text mismatch.');
  }
  const tool = await run('02-tool', `Call the tool lookup_probe from MCP server probe exactly once using key ${expectedKey}. Then reply with only the returned value field.`, true);
  const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').map(JSON.parse) : [];
  if (calls.length !== 1 || !calls[0].valid || tool.text.trim() !== value) throw new Error('OpenCode tool roundtrip mismatch.');
  const summary = { ok: true, mode: process.argv.includes('--launcher') ? 'actual-launcher-project-config' : 'direct-server-cli',
    model: 'claude-haiku-5-5', textPassed: !process.argv.includes('--tool-only'), toolRoundtripPassed: true, outputDirectory: output };
  fs.writeFileSync(path.join(root, 'latest-opencode-test.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} catch (error) {
  const summary = { ok: false, error: error.message, outputDirectory: output };
  fs.writeFileSync(path.join(root, 'latest-opencode-test.json'), JSON.stringify(summary, null, 2));
  console.error(JSON.stringify(summary)); process.exitCode = 1;
}
