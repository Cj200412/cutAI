import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { ViteDevServer } from 'vite';
import { createMiniConnect } from '../../desktop/mini-connect.ts';
import { LOCAL_TRANSCRIPTION_RUNTIME } from '../../shared/local-transcription-assets.ts';
import { fetchLocalModelManifest, localModelAssetsPlugin } from './local-model-assets.ts';

const siblings = [
  { rfilename: 'config.json', size: 2_000 },
  { rfilename: 'onnx/encoder_model_q4.onnx', size: 9_000_000 },
  { rfilename: 'onnx/decoder_model_merged_q4.onnx', size: 86_000_000 },
  { rfilename: 'onnx/encoder_model.onnx', size: 40_000_000 },
];
const mockFetch = (async () => new Response(JSON.stringify({ siblings }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})) as typeof fetch;

const manifest = await fetchLocalModelManifest('onnx-community/whisper-tiny', mockFetch);
assert.equal(manifest.expectedBytes, 95_002_000);
assert.deepEqual(manifest.files.map((file) => file.path), [
  'config.json',
  'onnx/encoder_model_q4.onnx',
  'onnx/decoder_model_merged_q4.onnx',
]);

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

const app = createMiniConnect((error) => { throw error; });
const plugin = localModelAssetsPlugin(mockFetch);
const fake = { middlewares: { use: app.use.bind(app) } } as unknown as ViteDevServer;
const hook = plugin.configureServer;
const configure = typeof hook === 'function' ? hook : hook?.handler;
await configure?.call(plugin as never, fake);
const server = createServer((req, res) => app.handle(req, res));
const port = await listen(server);
try {
  const valid = await fetch(`http://127.0.0.1:${port}/api/local-model-assets?model=onnx-community%2Fwhisper-tiny`);
  assert.equal(valid.status, 200);
  assert.equal((await valid.json() as { expectedBytes: number }).expectedBytes, 95_002_000);

  const invalid = await fetch(`http://127.0.0.1:${port}/api/local-model-assets?model=other%2Fmodel`);
  assert.equal(invalid.status, 400);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const transformersPackage = JSON.parse(await readFile(
  new URL('../../node_modules/@huggingface/transformers/package.json', import.meta.url),
  'utf8',
)) as { version: string };
const [transformersBundle, onnxWasm] = await Promise.all([
  stat(new URL('../../node_modules/@huggingface/transformers/dist/transformers.min.js', import.meta.url)),
  stat(new URL('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', import.meta.url)),
]);
assert.equal(LOCAL_TRANSCRIPTION_RUNTIME.version, transformersPackage.version);
assert.equal(LOCAL_TRANSCRIPTION_RUNTIME.bytes, transformersBundle.size + onnxWasm.size);
assert.equal(LOCAL_TRANSCRIPTION_RUNTIME.unloadable, true);
assert.equal(LOCAL_TRANSCRIPTION_RUNTIME.packageRemovable, false);

console.log('local model asset checks passed');
