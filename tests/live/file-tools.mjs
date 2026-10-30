import { sourceRoot, dataRoot, testResultsRoot } from '../../src/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startOpenCode } from '../../src/opencode-server.mjs';
import { openCodeExe } from '../../src/opencode-config.mjs';
const root = dataRoot;
const liveRoot = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(testResultsRoot, { recursive: true });
const output = path.join(testResultsRoot, `files-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const summaries = [];
for (const client of ['cc', 'opencode']) {
  const dir = path.join(output, client); fs.mkdirSync(dir);
  const fixture = { nonce: `验证🔧_${crypto.randomBytes(12).toString('hex')}`, numbers: [17, 29, 43] };
  fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify(fixture));
  const emptyMcp = path.join(dir, 'empty-mcp.json'); fs.writeFileSync(emptyMcp, '{"mcpServers":{}}');
  const prompt = 'Work only in this directory. Read seed.json using your file-reading tool, then write result.json using your file-writing tool. ' +
    'The output must be JSON with nonce copied exactly from the input and sum equal to the sum of numbers. Do not use shell, other files, or network. Reply DONE after writing.';
  let server, executable, args, env;
  if (client === 'cc') {
    executable = process.execPath;
    args = [path.join(sourceRoot, 'cc-kiro.mjs'), '--model', 'claude-haiku-5-5', '--setting-sources', '', '-p', prompt, '--tools', 'Read,Write', '--allowedTools', 'Read', 'Write',
      '--strict-mcp-config', '--mcp-config', emptyMcp, '--output-format', 'json', '--no-session-persistence', '--max-turns', '5'];
    env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'config') };
  } else {
    server = await startOpenCode(path.join(dir, 'server'), { permissions: [
      { action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: 'seed.json', effect: 'allow' },
      { action: 'edit', resource: 'result.json', effect: 'allow' }] }, { cwd: dir });
    executable = openCodeExe; env = server.clientEnv;
    args = ['run', '--auto', '--server', server.baseUrl, '--format', 'json', '--model', 'kiro/claude-haiku-5-5', prompt];
  }
  const child = spawn(executable, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = ''; child.stdout.on('data', part => stdout += part); child.stderr.on('data', part => stderr += part);
  const timer = setTimeout(() => child.kill(), 180000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    const actual = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    if (code !== 0 || actual.nonce !== fixture.nonce || actual.sum !== 89) throw new Error(`${client}: file result mismatch.`);
    summaries.push({ client, ok: true, unicodeNonceMatched: true, sum: actual.sum });
  } catch (error) { summaries.push({ client, ok: false, error: error.message }); }
  finally { clearTimeout(timer); if (server) await server.stop(); }
  fs.writeFileSync(path.join(dir, 'stdout.txt'), stdout); fs.writeFileSync(path.join(dir, 'stderr.txt'), stderr);
  console.log(JSON.stringify(summaries.at(-1)));
}
const summary = { ok: summaries.every(result => result.ok), clients: summaries, outputDirectory: output };
fs.writeFileSync(path.join(root, 'latest-file-tools-test.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
if (!summary.ok) process.exitCode = 1;
