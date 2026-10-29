import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

// Process-local transport adapter. Authentication, identity headers,
// endpoint, and profile selection remain owned by the unmodified Kiro CLI.
const configPath = process.env.KIRO_GATEWAY_REQUEST_CONFIG;
if (configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let captured = false;
  for (const module of [https, http]) {
    const originalRequest = module.request;
    module.request = function (...args) {
      let url;
      try { url = new URL(args[0]); } catch { return originalRequest.apply(this, args); }
      if (captured || !url.hostname.endsWith('.kiro.dev') || url.pathname !== '/v1/responses') {
        return originalRequest.apply(this, args);
      }
      captured = true;
      const callbackIndex = args.findLastIndex(value => typeof value === 'function');
      if (callbackIndex < 0) throw new Error('Expected the native raw-response callback.');

      // Do not deliver the response to Kiro's agent loop: capture it at the
      // inference boundary and end this disposable KAS process instead.
      args[callbackIndex] = response => {
        const parts = [];
        let bytes = 0;
        const status = {
          status: response.statusCode,
          requestId: response.headers['x-amzn-requestid'] ?? response.headers['x-request-id'] ?? null,
          contentType: response.headers['content-type'] ?? null,
          interceptedBeforeAgentExecution: true
        };
        fs.writeFileSync(config.statusPath, JSON.stringify(status, null, 2));
        response.on('data', part => {
          bytes += part.length;
          if (bytes > 2_000_000) response.destroy(new Error('Probe response exceeded size limit.'));
          else {
            parts.push(Buffer.from(part));
            if (config.streamPath) fs.appendFileSync(config.streamPath, part);
          }
        });
        response.on('end', () => {
          fs.writeFileSync(config.responsePath, Buffer.concat(parts));
          fs.writeFileSync(config.statusPath, JSON.stringify(status, null, 2));
          process.exit(86); // Intentional: no agent-side tool execution.
        });
        response.on('error', error => {
          fs.writeFileSync(config.statusPath, JSON.stringify({ error: error.message }));
          process.exit(87);
        });
      };
      const request = originalRequest.apply(this, args);
      const originalEnd = request.end;
      const pieces = [];
      request.write = function (chunk, encoding, callback) {
        if (chunk != null) pieces.push(Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
        if (typeof encoding === 'function') encoding();
        if (typeof callback === 'function') callback();
        return true;
      };
      request.end = function (chunk, encoding, callback) {
        if (typeof chunk === 'string' || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
          pieces.push(Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
        }
        const nativeBody = JSON.parse(Buffer.concat(pieces).toString('utf8'));
        if (nativeBody.model !== config.model) throw new Error('Unexpected bootstrap model.');
        const body = {
          ...nativeBody,
          input: config.input,
          tools: config.tools,
          stream: true
        };
        if (config.instructionsPlacement === 'system') body.instructions = config.instructions;
        else {
          delete body.instructions;
          body.input = config.instructions ? [{ role: 'user', content: config.instructions }, ...config.input] : config.input;
        }
        if (!config.tools?.length) delete body.tools;
        const encoded = JSON.stringify(body);
        request.setHeader('Content-Length', Buffer.byteLength(encoded));
        // Save only the artificial probe content. No credentials, profile ARN,
        // native workspace context, or request headers are written to disk.
        if (config.requestPath) fs.writeFileSync(config.requestPath, JSON.stringify({
          model: body.model, instructions: body.instructions, input: body.input,
          tools: body.tools, reasoning: body.reasoning ?? null
        }, null, 2));
        const completion = typeof encoding === 'function' ? encoding : callback;
        return originalEnd.call(this, encoded, typeof completion === 'function' ? completion : undefined);
      };
      return request;
    };
  }
  syncBuiltinESMExports();
}
