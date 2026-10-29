import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { ensureGateway } from './manage.mjs';
import { openCodeEnv, openCodeExe, materializeOpenCodeConfig } from './opencode-config.mjs';
import { mcpCatalogReady, mcpStatus } from './mcp-readiness.mjs';

export async function startOpenCode(output, patch = {}, { cwd = output } = {}) {
  fs.mkdirSync(output, { recursive: true });
  const state = await ensureGateway();
  const key = fs.readFileSync(state.keyPath, 'utf8').trim();
  const env = openCodeEnv(state, key, path.join(output, 'runtime'));
  const config = { ...JSON.parse(env.OPENCODE_CONFIG_CONTENT), ...patch };
  if (process.env.KIRO_GATEWAY_TRACE) console.error('OpenCode server: configuration prepared.');
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  materializeOpenCodeConfig(env);
  delete env.OPENCODE_SERVER_USERNAME;
  env.OPENCODE_PASSWORD = crypto.randomBytes(24).toString('hex');
  env.OPENCODE_SERVER_PASSWORD = env.OPENCODE_PASSWORD;
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn(openCodeExe, ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
    { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', part => log = (log + part).slice(-10000)); child.stderr.on('data', part => log = (log + part).slice(-10000));
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Connection: 'close',
    Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString('base64')}` };
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverPid;
  const statePath = path.join(output, 'owned-server.json');
  const stop = async () => {
    const pid = serverPid ?? child.pid;
    if (pid) {
      if (process.platform === 'win32') await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, error => {
        if (error && child.exitCode === null) child.kill(); resolve();
      }));
      else child.kill();
    }
    child.stdout.destroy(); child.stderr.destroy();
    fs.writeFileSync(path.join(output, 'opencode-server.log'), log.split(key).join('[local credential]').split(env.OPENCODE_SERVER_PASSWORD).join('[server credential]'));
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/info`, { headers, signal: AbortSignal.timeout(1000) });
      const info = await response.json(); if (!response.ok) throw new Error('not ready');
      serverPid = info.pid;
      fs.writeFileSync(statePath, JSON.stringify({ pid: serverPid, launcherPid: child.pid, baseUrl, startedAt: new Date().toISOString() }));
      break;
    }
    catch { if (attempt > 100 || child.exitCode !== null) { await stop(); throw new Error(`OpenCode server startup failed: ${log.slice(-1500)}`); } await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  const request = async (method, route, body) => {
    const response = await fetch(baseUrl + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300000) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`OpenCode ${method} ${route}: HTTP ${response.status} ${raw.slice(0, 1200)}`);
    try { return JSON.parse(raw); } catch { return raw; }
  };
  // Build the location before handing the server to a UI/CLI client. MCP
  // catalogs initialize asynchronously in V2; a first turn must not race them.
  const locationQuery = '?location[directory]=' + encodeURIComponent(cwd);
  if (process.env.KIRO_GATEWAY_TRACE) console.error('OpenCode server: HTTP ready; loading location.');
  await request('GET', '/api/location' + locationQuery);
  const sources = await request('GET', '/api/config' + locationQuery);
  const servers = {};
  for (const source of sources) Object.assign(servers, source.info?.mcp?.servers ?? {});
  const expectedMcp = Object.keys(servers).filter(name => !servers[name].disabled);
  for (let attempt = 0; expectedMcp.length; attempt++) {
    const catalog = await request('GET', '/api/mcp' + locationQuery);
    if (mcpCatalogReady(catalog, expectedMcp)) break;
    if (attempt >= 300) { await stop(); throw new Error('OpenCode MCP servers did not become connected: ' + expectedMcp.map(name => `${name}: ${mcpStatus(catalog, name)}`).join(', ')); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { baseUrl, request, stop, config, clientEnv: env };
}
