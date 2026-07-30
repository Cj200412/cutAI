import assert from 'node:assert/strict';
import {
  TRANSFORMERS_CACHE_NAME,
  deleteLocalModelCache,
  inspectLocalModelCache,
} from './local-model-cache.ts';

const tinyPrefix = 'https://huggingface.co/onnx-community/whisper-tiny/resolve/main/';
const basePrefix = 'https://huggingface.co/onnx-community/whisper-base/resolve/main/';
const entries = new Map<string, Response>([
  [`${tinyPrefix}config.json`, new Response('1234', { headers: { 'content-length': '4' } })],
  [`${tinyPrefix}onnx/encoder_model_q4.onnx`, new Response('encoder', { headers: { 'content-length': '10' } })],
  [`${tinyPrefix}onnx/decoder_model_merged_q4.onnx`, new Response('decoder', { headers: { 'content-length': '20' } })],
  [`${basePrefix}onnx/encoder_model_q4.onnx`, new Response('base', { headers: { 'content-length': '30' } })],
  ['https://example.com/unrelated', new Response('keep')],
]);

const cache = {
  keys: async () => [...entries.keys()].map((url) => new Request(url)),
  match: async (request: RequestInfo | URL) => {
    const url = request instanceof Request ? request.url : String(request);
    return entries.get(url);
  },
  delete: async (request: RequestInfo | URL) => {
    const url = request instanceof Request ? request.url : String(request);
    return entries.delete(url);
  },
} as unknown as Cache;
const storage = {
  open: async (name: string) => {
    assert.equal(name, TRANSFORMERS_CACHE_NAME);
    return cache;
  },
} as unknown as CacheStorage;

assert.deepEqual(await inspectLocalModelCache('onnx-community/whisper-tiny', storage), {
  state: 'downloaded',
  cachedBytes: 34,
  cachedFiles: 3,
});
assert.deepEqual(await inspectLocalModelCache('onnx-community/whisper-base', storage), {
  state: 'partial',
  cachedBytes: 30,
  cachedFiles: 1,
});
assert.deepEqual(await inspectLocalModelCache('onnx-community/whisper-small', storage), {
  state: 'not-downloaded',
  cachedBytes: 0,
  cachedFiles: 0,
});

assert.deepEqual(await deleteLocalModelCache('onnx-community/whisper-tiny', storage), {
  deletedFiles: 3,
  freedBytes: 34,
});
assert.equal(entries.has(`${basePrefix}onnx/encoder_model_q4.onnx`), true);
assert.equal(entries.has('https://example.com/unrelated'), true);

console.log('local model cache checks passed');
