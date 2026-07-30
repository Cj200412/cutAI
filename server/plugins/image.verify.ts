import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { callOpenAiCompatibleImage, validateImageRequest } from './image.ts';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

const basic = validateImageRequest({ prompt: 'a cat' });
assert.equal(basic.model, 'gpt-image-2');
assert.equal(basic.aspectRatio, '16:9');
assert.equal(basic.count, 1);

const mm = validateImageRequest({
  model: 'image-01',
  prompt: 'matte bottle',
  count: 3,
  seed: 42,
  width: 1024,
  height: 1536,
  referencePaths: ['/media/uploads/a.jpg'],
  promptOptimizer: false,
});
assert.equal(mm.model, 'image-01');
assert.equal(mm.promptOptimizer, false);
assert.equal(mm.count, 3);
assert.equal(mm.seed, 42);
assert.equal(mm.width, 1024);
assert.equal(mm.referencePaths.length, 1);

assert.throws(
  () => validateImageRequest({ model: 'image-01', prompt: 'x'.repeat(1501) }),
  /at most 1500 characters/,
);
assert.throws(
  () => validateImageRequest({ model: 'image-01', prompt: 'x', count: 10 }),
  /at most 9 images/,
);
assert.throws(
  () => validateImageRequest({ model: 'image-01', prompt: 'x', width: 1025, height: 1024 }),
  /divisible by 8/,
);
assert.throws(
  () => validateImageRequest({ model: 'gpt-image-2', prompt: 'x', promptOptimizer: true }),
  /promptOptimizer is supported by image-01/,
);
assert.throws(
  () => validateImageRequest({ model: 'nano-banana', prompt: 'x', referencePaths: Array.from({ length: 15 }, (_, i) => `/media/uploads/${i}.jpg`) }),
  /too many reference images/,
);

const gpt = validateImageRequest({
  model: 'gpt-image-2',
  prompt: 'product shot',
  referencePaths: ['/media/uploads/source.png'],
  maskPath: '/media/uploads/mask.png',
  background: 'transparent',
  moderation: 'low',
  inputFidelity: 'high',
  outputFormat: 'webp',
  outputCompression: 82,
});
assert.equal(gpt.inputFidelity, 'high');
assert.equal(gpt.outputCompression, 82);
assert.throws(
  () => validateImageRequest({ model: 'gpt-image-2', prompt: 'x', outputCompression: 80 }),
  /requires outputFormat jpeg or webp/,
);
assert.throws(
  () => validateImageRequest({ model: 'nano-banana', prompt: 'x', quality: 'high' }),
  /GPT Image options are not supported/,
);

let customAuth = 'unset';
let customBody: Record<string, unknown> = {};
let customPath = '';
const customImageServer = createServer((req, res) => {
  customAuth = String(req.headers.authorization ?? '');
  customPath = req.url ?? '';
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    customBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }));
  });
});
const customImagePort = await listen(customImageServer);
try {
  const result = await callOpenAiCompatibleImage(`http://127.0.0.1:${customImagePort}/v1`, '', {
    model: 'local-image-model',
    prompt: 'local prompt',
    quality: 'auto',
    count: 1,
    size: '1024x1024',
    referencePaths: [],
    outputFormat: 'png',
  });
  assert.equal(customAuth, '', 'unauthenticated local image endpoints do not receive a bearer header');
  assert.equal(customPath, '/v1/images/generations', 'a configured /v1 prefix is not duplicated');
  assert.equal(customBody.model, 'local-image-model');
  assert.equal(result.length, 1);
} finally {
  await new Promise<void>((resolve) => customImageServer.close(() => resolve()));
}

console.log('image.check: ok (provider-specific official parameters)');
