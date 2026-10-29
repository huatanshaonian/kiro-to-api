import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot } from '../src/paths.mjs';
const files = [];
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.name.endsWith('.mjs')) files.push(file);
  }
}
for (const dir of ['src', 'tests', 'tools']) visit(path.join(projectRoot, dir));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`${file}\n${result.stderr}`);
}
console.log(JSON.stringify({ ok: true, syntaxCheckedFiles: files.length }));
