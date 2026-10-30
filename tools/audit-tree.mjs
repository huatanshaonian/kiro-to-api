import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../src/paths.mjs';
const checkout = path.resolve(process.argv[2] ?? projectRoot);
const forbidden = /^(approval-routing\.local\.json|local-api-key|auth\.json|credentials\.json|gateway-state\.json|reasoning-state\.json|cc-routing-settings\.json|requests\.jsonl)$/i;
const secrets = [/sk-ant-(?:api|sid)[A-Za-z0-9_-]{20,}/, /AKIA[A-Z0-9]{16}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
const files = [];
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link in source tree: ${file}`);
    if (entry.isDirectory()) visit(file);
    else {
      if (forbidden.test(entry.name) || /\.(?:pem|key|log|jsonl)$/i.test(entry.name)) throw new Error(`Runtime or credential file in source tree: ${file}`);
      if (secrets.some(pattern => pattern.test(fs.readFileSync(file, 'utf8')))) throw new Error(`Possible credential in source file: ${file}`);
      files.push(path.relative(checkout, file));
    }
  }
}
visit(checkout);
console.log(JSON.stringify({ ok: true, sourceFilesAudited: files.length, checkout }));
