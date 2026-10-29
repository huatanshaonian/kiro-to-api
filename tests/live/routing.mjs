import { sourceRoot, dataRoot, testResultsRoot } from '../../src/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dataRoot;
const liveRoot = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(testResultsRoot, { recursive: true });
const output = path.join(testResultsRoot, `routing-${new Date().toISOString().replaceAll(':', '-')}`);
const configDir = path.join(output, 'fake-user-config');
fs.mkdirSync(configDir, { recursive: true });
// Replicate a conflicting user settings env block without loading real user
// hooks, passwords, or provider credentials, and without contacting that API.
fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ env: {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'intentionally-wrong-routing-test-token'
} }));
const expected = `ROUTING_OK_${crypto.randomBytes(5).toString('hex')}`;
const child = spawn(process.execPath, [path.join(sourceRoot, 'cc-kiro.mjs'), '--setting-sources', 'user',
  '-p', `Reply with exactly ${expected}. Do not call tools.`, '--tools', '', '--strict-mcp-config',
  '--output-format', 'json', '--no-session-persistence', '--max-turns', '1'], {
  cwd: output, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
let stdout = ''; let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
const timer = setTimeout(() => child.kill(), 90_000);
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const response = JSON.parse(stdout);
  const ok = code === 0 && !response.is_error && response.result?.trim() === expected;
  const result = { ok, conflictingUserSettingsOverridden: ok, response: response.result,
    originalUserSettingsModified: false, outputDirectory: output };
  fs.writeFileSync(path.join(root, 'latest-routing-test.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, stdout: stdout.slice(-800), stderr: stderr.slice(-500) }));
  process.exitCode = 1;
} finally { clearTimeout(timer); }
