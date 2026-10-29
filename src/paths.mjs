import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.dirname(sourceRoot);
export const dataRoot = path.resolve(process.env.KIRO_GATEWAY_DATA_DIR ??
  path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'Kiro-Gateway'));
export const testResultsRoot = path.join(dataRoot, 'test-results');
export const installationId = crypto.createHash('sha256').update(projectRoot.toLowerCase()).digest('hex').slice(0, 20);
export const gatewayPort = Number(process.env.KIRO_GATEWAY_PORT ?? 18321);
export const kiroCli = process.env.KIRO_CLI_PATH ?? path.join(process.env.LOCALAPPDATA ?? '', 'Kiro-Cli', 'kiro-cli.exe');
export const claudeCli = process.env.CLAUDE_CLI_PATH ?? path.join(os.homedir(), '.local', 'bin', 'claude.exe');
export const openCodeCli = process.env.OPENCODE_CLI_PATH ?? path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
export function ensureDataRoot() { fs.mkdirSync(dataRoot, { recursive: true }); return dataRoot; }
