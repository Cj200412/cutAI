// Runnable check: `npx tsx server/plugins/export-backends.verify.ts`.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { ViteDevServer } from 'vite';
import { createMiniConnect } from '../../desktop/mini-connect.ts';
import { probeMlt, type MltProbeReport } from '../mlt/probe.ts';
import { exportBackendsPlugin } from './export-backends.ts';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function mount(probe: () => Promise<MltProbeReport>, cacheTtlMs = 10_000): Promise<{ server: Server; origin: string }> {
  const app = createMiniConnect((error) => { throw error; });
  const plugin = exportBackendsPlugin({ probe, cacheTtlMs });
  const fake = { middlewares: { use: app.use.bind(app) } } as unknown as ViteDevServer;
  const hook = plugin.configureServer;
  const configure = typeof hook === 'function' ? hook : hook?.handler;
  await configure?.call(plugin as never, fake);
  const server = createServer((req, res) => app.handle(req, res));
  const port = await listen(server);
  return { server, origin: `http://127.0.0.1:${port}` };
}

const notFound = await probeMlt({
  resolveExecutable: async () => ({ status: 'not-found', message: 'melt is absent in this fixture' }),
});
let calls = 0;
const mounted = await mount(async () => {
  calls += 1;
  await new Promise((resolve) => setTimeout(resolve, 20));
  return notFound;
});
try {
  const [first, injected] = await Promise.all([
    fetch(`${mounted.origin}/api/export/backends/mlt/probe`),
    fetch(`${mounted.origin}/api/export/backends/mlt/probe?executable=calc.exe&arg=-consumer`),
  ]);
  assert.equal(first.status, 200);
  assert.equal(injected.status, 200);
  assert.equal(calls, 1, 'concurrent requests and ignored query parameters share one in-flight probe');
  const body = await first.json() as MltProbeReport;
  assert.equal(body.availability, 'not-found');
  assert.equal(body.mode, 'probe-only');
  assert.equal(body.renderVerified, false);
  assert.equal(body.selectableForExport, false);
  assert.match(first.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(first.headers.get('cache-control'), 'no-store');

  const post = await fetch(`${mounted.origin}/api/export/backends/mlt/probe`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');

  const unknown = await fetch(`${mounted.origin}/api/export/backends/mlt/probe/render`);
  assert.equal(unknown.status, 404);
} finally {
  await new Promise<void>((resolve) => mounted.server.close(() => resolve()));
}

const failing = await mount(async () => {
  throw new Error('private failure without stack disclosure');
}, 0);
try {
  const response = await fetch(`${failing.origin}/api/export/backends/mlt/probe`);
  assert.equal(response.status, 500);
  const text = await response.text();
  const body = JSON.parse(text) as MltProbeReport;
  assert.equal(body.availability, 'unusable');
  assert.equal(body.renderVerified, false);
  assert.equal(body.operationallyRendered, false);
  assert.equal(body.selectableForExport, false);
  assert.ok(!text.includes('export-backends.verify.ts'), 'stack and source paths must not leak');
} finally {
  await new Promise<void>((resolve) => failing.server.close(() => resolve()));
}

console.log('MLT export backend HTTP checks passed');
