import { ensureGateway } from '../../src/manage.mjs';
import { dataRoot, sourceRoot } from '../../src/paths.mjs';
import { loadApprovalConfig } from '../../src/approval-router.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

if (!loadApprovalConfig(dataRoot).enabled) throw new Error('Configure approval-routing.local.json in the test data directory first.');
const state = await ensureGateway();
const dir = path.join(dataRoot, 'test-results', 'approval-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const debug = path.join(dir, 'classifier-debug.txt');
const emptyMcp = path.join(dir, 'mcp.json'); fs.writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }));
const marker = 'APPROVAL_' + crypto.randomBytes(8).toString('hex');
const auditFile = path.join(dataRoot, 'requests.jsonl');
const before = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').length : 0;
const prompt = `Use Bash exactly once to invoke node with -e. Its JavaScript must call fs.writeFileSync to create approval-marker.txt containing ${marker} in the current directory. Do not use shell redirection or shell builtins. Do not change any other files. If permission is denied, stop. After success reply exactly APPROVAL_OK.`;
const child = spawn(process.execPath, [path.join(sourceRoot, 'cc-kiro.mjs'), '--model', 'claude-haiku-5-5', '--setting-sources', '',
  '--permission-mode', 'auto', '--debug-file', debug, '--tools', 'Bash', '--strict-mcp-config', '--mcp-config', emptyMcp,
  '--max-turns', '3', '--output-format', 'json', '--no-session-persistence', '-p', prompt],
  { cwd: dir, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'cc-config') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stdout = ''; let stderr = '';
child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
const timer = setTimeout(() => {
  if (process.platform === 'win32') { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { child.kill(); } }
  else child.kill();
}, 240000);
let code;
try { code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); }
finally { clearTimeout(timer); }
const key = fs.readFileSync(state.keyPath, 'utf8').trim();
fs.writeFileSync(path.join(dir, 'stdout.json'), stdout.split(key).join('[local credential]'));
fs.writeFileSync(path.join(dir, 'stderr.txt'), stderr.split(key).join('[local credential]'));
let response; try { response = JSON.parse(stdout); } catch {}
const log = fs.existsSync(debug) ? fs.readFileSync(debug, 'utf8') : '';
const classifierEvents = log.split(/\r?\n/).filter(line => /classifier_request_started|classifier_request_finished/.test(line));
const records = fs.readFileSync(auditFile, 'utf8').slice(before).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const approvals = records.filter(record => record.route === 'deepseek-approval');
const main = records.filter(record => record.route === 'kiro');
const artifact = path.join(dir, 'approval-marker.txt');
const markerWritten = fs.existsSync(artifact) && fs.readFileSync(artifact, 'utf8') === marker;
const ok = code === 0 && response && !response.is_error && response.result?.trim() === 'APPROVAL_OK' && markerWritten &&
  approvals.length > 0 && approvals.every(record => record.status === 200) && main.length >= 2 &&
  main.some(record => record.toolCallsReturned > 0) && classifierEvents.some(line => /classifier_request_started.*model=deepseek-flash/.test(line)) &&
  !classifierEvents.some(line => /classifier_request_started.*model=claude-/.test(line));
const summary = { ok: !!ok, directory: dir, baseUrl: state.baseUrl, mainModel: 'claude-haiku-5-5', approvalModel: 'deepseek-flash[1m]',
  markerWritten, nativeToolExecutions: records.reduce((n, record) => n + (record.nativeToolExecutions ?? 0), 0),
  approvals: approvals.map(({ status, elapsedMs, usage }) => ({ status, elapsedMs, usage })), classifierEvents,
  clientError: response?.is_error, result: response?.result, permissionDenials: response?.permission_denials?.length };
fs.writeFileSync(path.join(dataRoot, 'latest-approval-test.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (!ok) process.exitCode = 1;
