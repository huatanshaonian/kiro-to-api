#!/usr/bin/env node
import { ensureDataRoot, claudeCli } from './paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ensureGateway } from './manage.mjs';
import { loadApprovalConfig, approvalModel } from './approval-router.mjs';

const root = ensureDataRoot();
const state = await ensureGateway();
const approval = loadApprovalConfig(root);
const apiKey = fs.readFileSync(state.keyPath, 'utf8').trim();
const routingEnv = { ANTHROPIC_BASE_URL: state.baseUrl, ANTHROPIC_API_KEY: apiKey,
  ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
  CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? '1000000' };
if (approval.enabled) Object.assign(routingEnv, {
  CLAUDE_CODE_AUTO_MODE_MODEL: approvalModel + '[1m]', CLAUDE_CODE_AUTO_MODE_SERVER: '0', ENABLE_TOOL_SEARCH: 'false' });
const env = { ...process.env, ...routingEnv,
  ANTHROPIC_MODEL: 'claude-opus-5-5', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' };
for (const key of ['ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL']) delete env[key];
const args = process.argv.slice(2);
if (args.includes('--gateway-info')) {
  console.log(JSON.stringify({ baseUrl: state.baseUrl, defaultModel: 'claude-opus-5-5', authentication: 'local gateway API key',
    approvalModel: approval.enabled ? approvalModel : null, defaultPermissionMode: approval.enabled ? 'auto' : 'client default',
    settingsScope: 'command-line overlay; original settings unchanged' }, null, 2));
  process.exit(0);
}
// A settings.json env block overrides the inherited shell environment. Supply
// routing in a command-line settings file so ordinary user/project settings
// cannot replace this launcher's gateway destination or credentials.
const settings = { env: routingEnv, ...(approval.enabled ? { permissions: { defaultMode: 'auto' } } : {}) };
const settingsPath = path.join(root, 'cc-routing-settings.json');
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
args.push('--settings', settingsPath);
if (!args.some(arg => arg === '--model' || arg.startsWith('--model='))) args.unshift('--model', 'claude-opus-5-5');
const child = spawn(claudeCli, args, { env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => {});
