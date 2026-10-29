#!/usr/bin/env node
import { dataRoot } from './paths.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ensureGateway } from './manage.mjs';
import { contextPolicy } from './context.mjs';
import { openCodeExe } from './opencode-config.mjs';
import { startOpenCode } from './opencode-server.mjs';
export { openCodeConfig, openCodeEnv, openCodeExe, materializeOpenCodeConfig } from './opencode-config.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const state = await ensureGateway();
  const args = process.argv.slice(2);
  if (args.includes('--gateway-info')) console.log(JSON.stringify({ baseUrl: `${state.baseUrl}/v1`,
    provider: 'kiro', model: 'kiro/claude-haiku-5-5', runtime: path.join(dataRoot, 'opencode'), contextPolicy: contextPolicy() }, null, 2));
  else {
    if (process.env.KIRO_GATEWAY_TRACE) console.error('OpenCode launcher: starting isolated server.');
    const server = await startOpenCode(path.join(dataRoot, 'opencode'), {}, { cwd: process.cwd() });
    if (process.env.KIRO_GATEWAY_TRACE) console.error('OpenCode launcher: server ready; starting client.');
    const childArgs = args.filter(arg => arg !== '--standalone');
    if (childArgs.includes('--server') || childArgs.some(arg => arg.startsWith('--server='))) {
      await server.stop(); throw new Error('This launcher owns its isolated OpenCode server; use plain opencode to attach to another server.');
    }
    childArgs.push('--server', server.baseUrl);
    const child = spawn(openCodeExe, childArgs, { env: server.clientEnv, stdio: 'inherit', windowsHide: true });
    process.on('SIGINT', () => {});
    try { process.exitCode = await new Promise((resolve, reject) => { child.once('exit', code => resolve(code ?? 1)); child.once('error', reject); }); }
    finally { await server.stop(); }
  }
}
