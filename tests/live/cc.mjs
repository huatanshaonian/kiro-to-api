import { ensureGateway } from '../../src/manage.mjs';
import { sourceRoot, dataRoot, testResultsRoot } from '../../src/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dataRoot;
const liveRoot = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(testResultsRoot, { recursive: true });
const state = await ensureGateway();
const key = fs.readFileSync(state.keyPath, 'utf8').trim();
const full = process.argv.includes('--full');
const output = path.join(testResultsRoot, new Date().toISOString().replaceAll(':', '-'));
fs.mkdirSync(output, { recursive: true });
const expectedKey = `cc_${crypto.randomBytes(6).toString('hex')}`;
const value = `cc_external_${crypto.randomBytes(10).toString('hex')}`;
const callLog = path.join(output, 'mcp-calls.jsonl');
const mcpPath = path.join(output, 'mcp.json');
const emptyMcp = path.join(output, 'empty-mcp.json');
fs.writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }));
fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { probe: { command: process.execPath,
  args: [path.join(liveRoot, 'fake-mcp.mjs')], env: { PROBE_EXPECTED_KEY: expectedKey, PROBE_RETURN_VALUE: value, PROBE_CALL_LOG: callLog } } } }, null, 2));

async function cc(name, prompt, extra) {
  const args = [...(full ? ['--setting-sources', ''] : ['--bare']), '-p', prompt, '--tools', '', '--output-format', 'json', '--no-session-persistence',
    '--max-turns', '3', '--strict-mcp-config', ...extra];
  const child = spawn(process.execPath, [path.join(sourceRoot, 'cc-kiro.mjs'), ...args],
    { cwd: output, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(output, 'cc-config') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 180_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timer); }
  stdout = stdout.split(key).join('[local credential]'); stderr = stderr.split(key).join('[local credential]');
  fs.writeFileSync(path.join(output, `${name}.stdout.json`), stdout);
  fs.writeFileSync(path.join(output, `${name}.stderr.txt`), stderr);
  let result;
  try { result = JSON.parse(stdout); }
  catch { throw new Error(`${name}: Claude Code did not return JSON. ${stdout.slice(-800)} ${stderr.slice(-500)}`); }
  if (code !== 0 || result.is_error) throw new Error(`${name}: ${JSON.stringify(result).slice(-1200)} ${stderr.slice(-500)}`);
  console.log(JSON.stringify({ stage: name, result: result.result }));
  return result;
}

try {
  const baseline = await cc('01-text', 'Reply with exactly CC_KIRO_OK. Do not call any tools.', ['--mcp-config', emptyMcp]);
  if (baseline.result?.trim() !== 'CC_KIRO_OK') throw new Error('The baseline text response did not match.');
  const tool = await cc('02-tool', `Call the MCP tool lookup_probe on server probe exactly once with key ${expectedKey}. ` +
    'You cannot know the value without this tool. After receiving its result, reply with only its value field. Do not call any other tools.',
    ['--mcp-config', mcpPath, '--allowedTools', 'mcp__probe__lookup_probe']);
  const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  if (calls.length !== 1 || !calls[0].valid || tool.result?.trim() !== value) throw new Error('The Claude Code tool roundtrip did not match the external result.');
  const summary = { ok: true, mode: full ? 'regular-claude-code-isolated-settings' : 'bare', claudeCodeVersion: '2.1.312', model: 'claude-haiku-5-5', baseUrl: state.baseUrl,
    textPassed: true, claudeCodeExecutedMcpTool: true, toolCalls: calls, externalResultMatched: true,
    systemRole: 'user-context', cacheStatus: 'not reported by Kiro', outputDirectory: output };
  fs.writeFileSync(path.join(root, 'latest-cc-test.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  const summary = { ok: false, error: error.message, outputDirectory: output };
  fs.writeFileSync(path.join(root, 'latest-cc-test.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(summary, null, 2));
  console.error(JSON.stringify(summary, null, 2)); process.exitCode = 1;
}
