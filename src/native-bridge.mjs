import { sourceRoot, projectRoot, ensureDataRoot, kiroCli } from './paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { SseDecoder } from './protocol.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const bootstrapRoot = path.join(projectRoot, 'assets', 'bootstrap');
const cli = kiroCli;
const tempRoot = path.join(ensureDataRoot(), 'tmp');
fs.mkdirSync(tempRoot, { recursive: true });

export async function infer(spec, onEvent, signal) {
  if (signal?.aborted) throw Object.assign(new Error('Client disconnected.'), { status: 499 });
  const id = crypto.randomUUID();
  const base = path.join(tempRoot, id);
  const files = { config: `${base}.json`, status: `${base}.status.json`, stream: `${base}.sse`, response: `${base}.response` };
  const config = { model: spec.model, instructions: spec.instructions, instructionsPlacement: 'user',
    tools: spec.tools, input: spec.input, statusPath: files.status, streamPath: files.stream, responsePath: files.response };
  fs.writeFileSync(files.config, JSON.stringify(config));
  const preload = `--import=${pathToFileURL(path.join(sourceRoot, 'transport', 'capture-model.mjs')).href}`;
  const env = { ...process.env, KIRO_GATEWAY_REQUEST_CONFIG: files.config,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' ') };
  delete env.KIRO_TEST_TUI_JS_PATH;
  const child = spawn(cli, ['chat', '--v3', '--no-interactive', '--output-format', 'stream-json',
    '--agent', 'protocol-probe', '--model', spec.model, 'Reply BOOTSTRAP_OK. Do not call tools.'],
    { cwd: bootstrapRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const terminate = () => {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => { if (error && child.exitCode === null) child.kill(); });
    else child.kill();
  };
  let stdout = ''; let stderr = ''; let offset = 0; let parseError; let status;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
  const decoder = new SseDecoder(event => onEvent(event));
  const utf8 = new StringDecoder('utf8');
  const pump = () => {
    if (parseError) return;
    try {
      if (!status && fs.existsSync(files.status)) {
        try { status = JSON.parse(fs.readFileSync(files.status, 'utf8')); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      if (!fs.existsSync(files.stream) || (status && status.status !== 200)) return;
      const size = fs.statSync(files.stream).size;
      if (size <= offset) return;
      const fd = fs.openSync(files.stream, 'r');
      const buffer = Buffer.alloc(size - offset);
      try { fs.readSync(fd, buffer, 0, buffer.length, offset); } finally { fs.closeSync(fd); }
      offset = size;
      decoder.push(utf8.write(buffer));
    } catch (error) { parseError = error; terminate(); }
  };
  const interval = setInterval(pump, 100);
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; terminate(); }, Number(process.env.KIRO_GATEWAY_TIMEOUT_MS ?? 300000));
  const abort = () => terminate();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    pump();
    if (signal?.aborted) throw Object.assign(new Error('Client disconnected.'), { status: 499 });
    if (timedOut) throw Object.assign(new Error('Kiro inference timed out.'), { status: 504 });
    if (parseError) throw parseError;
    if (!status && fs.existsSync(files.status)) status = JSON.parse(fs.readFileSync(files.status, 'utf8'));
    if (!status) throw new Error(`No model response was captured. ${stderr.slice(-500)}`);
    if (status.status !== 200) {
      const raw = fs.existsSync(files.response) ? fs.readFileSync(files.response, 'utf8') : '';
      let message = raw;
      try { const parsed = JSON.parse(raw); message = parsed.error?.message ?? parsed.message ?? raw; } catch {}
      const error = new Error(message || status.error || 'Upstream error.');
      error.status = status.status ?? 502; throw error;
    }
    decoder.push(utf8.end()); decoder.finish();
    const toolEvents = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
      .filter(event => event.data?.update?.sessionUpdate === 'tool_call');
    if (toolEvents.length) throw new Error('Unexpected Kiro-side tool execution.');
    return { requestId: status.requestId, nativeToolExecutions: 0 };
  } finally {
    clearInterval(interval); clearTimeout(timeout); signal?.removeEventListener('abort', abort);
    for (const file of Object.values(files)) try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') console.error(`Temp cleanup: ${error.code}`); }
  }
}
