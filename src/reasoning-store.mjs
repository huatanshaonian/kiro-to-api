import fs from 'node:fs';

// Only opaque upstream reasoning envelopes, never prompts/tool results/credentials.
// Model-scoped IDs prevent restoration under a different model. TTL bounds disk use.
export class ReasoningStore {
  constructor(file, { ttlMs = 86400000, maxEntries = 1000, maxBytes = 32000000 } = {}) {
    this.file = file; this.ttlMs = ttlMs; this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    this.items = new Map();
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      if (Buffer.byteLength(raw) > maxBytes) throw new Error('Reasoning store exceeds configured bound.');
      const data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('Unsupported reasoning store format.');
      this.items = new Map(data.entries);
      this.prune();
    }
  }
  prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.items) if (entry.at < cutoff) this.items.delete(key);
    while (this.items.size > this.maxEntries) this.items.delete(this.items.keys().next().value);
  }
  get(key) {
    const entry = this.items.get(key);
    if (!entry || entry.at < Date.now() - this.ttlMs) { this.items.delete(key); return undefined; }
    return entry.value;
  }
  remember(model, rawItems) {
    const reasoning = rawItems.filter(item => item?.type === 'reasoning' && item.encrypted_content)
      .map(item => ({ type: 'reasoning', summary: [], encrypted_content: item.encrypted_content }));
    if (!reasoning.length) return;
    for (const call of rawItems.filter(item => item?.type === 'function_call'))
      this.items.set(`${model}\0${call.call_id}`, { at: Date.now(), value: reasoning });
    this.prune();
    let raw = JSON.stringify({ version: 1, entries: [...this.items] });
    while (Buffer.byteLength(raw) > this.maxBytes && this.items.size) {
      this.items.delete(this.items.keys().next().value);
      raw = JSON.stringify({ version: 1, entries: [...this.items] });
    }
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, raw, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
