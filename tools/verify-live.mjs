import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dataRoot, projectRoot } from '../src/paths.mjs';
const names = process.argv.includes('--full')
  ? ['probe', 'cc', 'opencode', 'file-tools', 'http', 'routing', 'cc-compact', 'cc-auto-compact', 'opencode-compact', 'opencode-auto-compact']
  : ['probe', 'cc', 'opencode', 'http'];
const checks = names.map(name => {
  const result = JSON.parse(fs.readFileSync(path.join(dataRoot, `latest-${name}-test.json`), 'utf8'));
  assert.equal(result.ok, true, `${name}: ${result.error}`);
  return { name, ok: true, mode: result.mode, outputDirectory: result.outputDirectory };
});
const tempFiles = fs.existsSync(path.join(dataRoot, 'tmp')) ? fs.readdirSync(path.join(dataRoot, 'tmp')) : [];
assert.equal(tempFiles.length, 0, 'Unexpected leftover inference temporary files.');
const result = { ok: true, at: new Date().toISOString(), projectRoot, dataRoot, checks, remainingInferenceTemporaryFiles: 0 };
fs.writeFileSync(path.join(dataRoot, 'verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
