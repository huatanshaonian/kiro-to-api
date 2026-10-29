import { dataRoot, openCodeCli } from './paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelIds } from './protocol.mjs';
import { contextPolicy } from './context.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export function openCodeConfig(state, apiKey, policy = contextPolicy()) {
  return { $schema: 'https://opencode.ai/config.json', update: 'disable',
    model: 'kiro/claude-haiku-5-5',
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: 'kiro', effect: 'allow' }],
    providers: { kiro: { package: '@opencode/ai/providers/anthropic-compatible', name: 'Kiro local gateway',
      settings: { baseURL: `${state.baseUrl}/v1`, apiKey, compaction: { type: 'summary' } },
      models: Object.fromEntries(modelIds.map(id => [id, { name: id,
        capabilities: { tools: true, input: ['text'], output: ['text'], reasoning: { supported: false } },
        limit: { context: policy.contextTokens, input: policy.inputTokens, output: policy.reserveTokens } }])) } },
    compaction: { auto: true, keep: { tokens: 15000 }, buffer: policy.reserveTokens } };
}

export function openCodeEnv(state, key, runtimeRoot = path.join(dataRoot, 'opencode')) {
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(runtimeRoot, 'config'),
    XDG_DATA_HOME: path.join(runtimeRoot, 'data'), XDG_CACHE_HOME: path.join(runtimeRoot, 'cache'),
    XDG_STATE_HOME: path.join(runtimeRoot, 'state'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig(state, key)),
    KIRO_GATEWAY_API_KEY: key, OPENCODE_DISABLE_AUTOUPDATE: '1' };
  delete env.OPENCODE_DISABLE_PROJECT_CONFIG;
  delete env.OPENCODE_CONFIG; delete env.OPENCODE_CONFIG_DIR;
  return env;
}

export function materializeOpenCodeConfig(env) {
  const file = path.join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Keep a credential-free copy for debugging the isolated profile.
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  for (const provider of Object.values(config.providers ?? {})) if (provider.settings?.apiKey)
    provider.settings.apiKey = '{env:KIRO_GATEWAY_API_KEY}';
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

export const openCodeExe = openCodeCli;
