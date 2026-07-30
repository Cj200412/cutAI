import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { ViteDevServer } from 'vite';
import { createMiniConnect } from '../../desktop/mini-connect.ts';
import { firecrawlPlugin } from './firecrawl.ts';

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
let receivedAuth = 'unset';
const upstream = createServer((req, res) => {
  receivedPath = req.url ?? '';
  receivedAuth = String(req.headers.authorization ?? '');
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: {
        markdown: '# self-hosted',
        metadata: { sourceURL: 'https://example.com', title: 'Example' },
      },
    }));
  });
});
const upstreamPort = await listen(upstream);

const app = createMiniConnect((error) => { throw error; });
const proxyServer = createServer((req, res) => app.handle(req, res));
const plugin = firecrawlPlugin({
  apiKey: '',
  baseUrl: `http://127.0.0.1:${upstreamPort}`,
});
const fake = {
  middlewares: { use: app.use.bind(app) },
  config: { logger: console },
} as unknown as ViteDevServer;
const hook = plugin.configureServer;
const configure = typeof hook === 'function' ? hook : hook?.handler;
await configure?.call(plugin as never, fake);
const proxyPort = await listen(proxyServer);

try {
  const response = await fetch(`http://127.0.0.1:${proxyPort}/api/web-browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'] }),
  });
  assert.equal(response.status, 200);
  assert.equal(receivedPath, '/v1/scrape');
  assert.equal(receivedAuth, '', 'self-hosted Firecrawl can run without a bearer key');
  const body = await response.json() as { configured?: boolean; ok?: boolean; markdown?: string };
  assert.equal(body.configured, true);
  assert.equal(body.ok, true);
  assert.equal(body.markdown, '# self-hosted');
} finally {
  await Promise.all([
    new Promise<void>((resolve) => proxyServer.close(() => resolve())),
    new Promise<void>((resolve) => upstream.close(() => resolve())),
  ]);
}

console.log('firecrawl self-host verify: ok');
