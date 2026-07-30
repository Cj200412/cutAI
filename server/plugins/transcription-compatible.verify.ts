import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { ViteDevServer } from 'vite';
import { seedKeystore } from '../keystore.ts';
import { createMiniConnect } from '../../desktop/mini-connect.ts';
import { transcriptionCompatiblePlugin } from './transcription-compatible.ts';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

let receivedPath = '';
let receivedAuth = '';
let receivedBytes = 0;
const upstream = createServer((req, res) => {
  receivedPath = req.url ?? '';
  receivedAuth = String(req.headers.authorization ?? '');
  req.on('data', (chunk: Buffer) => { receivedBytes += chunk.length; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      text: '测试',
      words: [{ word: '测试', start: 0, end: 0.5 }],
    }));
  });
});
const upstreamPort = await listen(upstream);

seedKeystore({
  TRANSCRIPTION_CUSTOM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
  TRANSCRIPTION_CUSTOM_API_KEY: 'probe-secret',
});

const app = createMiniConnect((error) => { throw error; });
const proxyServer = createServer((req, res) => app.handle(req, res));
const plugin = transcriptionCompatiblePlugin();
const fake = {
  middlewares: { use: app.use.bind(app) },
  config: { logger: console },
} as unknown as ViteDevServer;
const hook = plugin.configureServer;
const configure = typeof hook === 'function' ? hook : hook?.handler;
await configure?.call(plugin as never, fake);
const proxyPort = await listen(proxyServer);

try {
  const form = new FormData();
  form.append('file', new Blob(['audio-bytes'], { type: 'audio/wav' }), 'sample.wav');
  form.append('model', 'custom-whisper');
  const response = await fetch(`http://127.0.0.1:${proxyPort}/transcription-compatible/audio/transcriptions`, {
    method: 'POST',
    body: form,
  });
  assert.equal(response.status, 200);
  assert.equal(receivedPath, '/v1/audio/transcriptions');
  assert.equal(receivedAuth, 'Bearer probe-secret');
  assert.ok(receivedBytes > 20, 'multipart body reaches the custom backend');
  assert.deepEqual(await response.json(), {
    text: '测试',
    words: [{ word: '测试', start: 0, end: 0.5 }],
  });
} finally {
  await Promise.all([
    new Promise<void>((resolve) => proxyServer.close(() => resolve())),
    new Promise<void>((resolve) => upstream.close(() => resolve())),
  ]);
}

console.log('transcription compatible proxy verify: ok');
