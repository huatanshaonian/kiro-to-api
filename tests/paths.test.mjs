import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { projectRoot, sourceRoot } from '../src/paths.mjs';

test('transport and bootstrap resources are entirely inside this project', () => {
  assert.ok(fs.existsSync(path.join(sourceRoot, 'transport', 'capture-model.mjs')));
  const agent = JSON.parse(fs.readFileSync(path.join(projectRoot, 'assets/bootstrap/.kiro/agents/protocol-probe.json'), 'utf8'));
  assert.deepEqual(agent.tools, []); assert.equal(agent.includeMcpJson, false);
  assert.match(fs.readFileSync(path.join(sourceRoot, 'native-bridge.mjs'), 'utf8'), /assets', 'bootstrap/);
});

test('data directory and executable overrides resolve without touching source files', () => {
  const tempData = path.join(os.tmpdir(), 'kiro-gateway-path-test-do-not-create');
  const code = `import { dataRoot, kiroCli, claudeCli, openCodeCli } from ${JSON.stringify(pathToFileURL(path.join(sourceRoot, 'paths.mjs')).href)}; process.stdout.write(JSON.stringify({dataRoot,kiroCli,claudeCli,openCodeCli}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, KIRO_GATEWAY_DATA_DIR: tempData, KIRO_CLI_PATH: 'custom-kiro', CLAUDE_CLI_PATH: 'custom-cc', OPENCODE_CLI_PATH: 'custom-opencode' } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { dataRoot: tempData, kiroCli: 'custom-kiro', claudeCli: 'custom-cc', openCodeCli: 'custom-opencode' });
});
