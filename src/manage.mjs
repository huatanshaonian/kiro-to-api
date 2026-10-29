#!/usr/bin/env node
import { sourceRoot, ensureDataRoot, installationId, gatewayPort } from './paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = ensureDataRoot();
const statePath = path.join(root, 'gateway-state.json');
async function current() {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const response = await fetch(`${state.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
  const health = await response.json();
  if (!response.ok || health.service !== 'kiro-anthropic-local' || health.installationId !== installationId || Number(new URL(state.baseUrl).port) !== gatewayPort) throw new Error('The recorded port is not this gateway.');
  return state;
}
export async function ensureGateway() {
  try { return await current(); } catch {}
  const stdout = fs.openSync(path.join(root, 'server.stdout.log'), 'a');
  const stderr = fs.openSync(path.join(root, 'server.stderr.log'), 'a');
  try {
    const child = spawn(process.execPath, [path.join(sourceRoot, 'server.mjs')], {
      cwd: sourceRoot, detached: true, stdio: ['ignore', stdout, stderr], windowsHide: true
    });
    child.unref();
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { return await current(); } catch {}
  }
  throw new Error('Gateway did not start. Check server.stderr.log and whether the configured port is already in use.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const operation = process.argv[2] ?? 'start';
    if (operation === 'stop') {
      const state = await current();
      const key = fs.readFileSync(state.keyPath, 'utf8').trim();
      const response = await fetch(`${state.baseUrl}/shutdown`, { method: 'POST', headers: { 'x-api-key': key } });
      if (!response.ok) throw new Error(await response.text());
      console.log('Kiro API stopped.');
    } else if (operation === 'start' || operation === 'status') {
      const state = operation === 'start' ? await ensureGateway() : await current();
      console.log(JSON.stringify({ baseUrl: state.baseUrl, pid: state.pid, localKeyFile: state.keyPath }));
    } else throw new Error('Use start, status, or stop.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
