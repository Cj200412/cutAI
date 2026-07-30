import assert from 'node:assert/strict';
import {
  normalizeLocalTranscriptionDevice,
  normalizeTranscriptionProvider,
  trimApiBaseUrl,
} from '../../shared/transcription-providers.ts';
import { compatibleTranscriptResult } from './openai-compatible.ts';
import { localWhisperResult } from './local-whisper.ts';

assert.equal(normalizeTranscriptionProvider(undefined), 'assemblyai');
assert.equal(normalizeTranscriptionProvider('local'), 'local');
assert.equal(normalizeTranscriptionProvider('custom'), 'custom');
assert.equal(normalizeTranscriptionProvider('unknown'), 'assemblyai');
assert.equal(normalizeLocalTranscriptionDevice('webgpu'), 'webgpu');
assert.equal(normalizeLocalTranscriptionDevice('bad'), 'auto');
assert.equal(trimApiBaseUrl(' http://127.0.0.1:8000/v1/// '), 'http://127.0.0.1:8000/v1');

{
  const result = localWhisperResult({
    text: '你好世界',
    chunks: [
      { text: '你好', timestamp: [0.1, 0.7] },
      { text: '世界', timestamp: [0.7, 1.4] },
    ],
  });
  assert.equal(result.text, '你好世界');
  assert.deepEqual(result.words.map(({ text, start, end, speaker }) => ({ text, start, end, speaker })), [
    { text: '你好', start: 100, end: 700, speaker: null },
    { text: '世界', start: 700, end: 1400, speaker: null },
  ]);
}

{
  const result = compatibleTranscriptResult({
    text: 'hello world',
    words: [
      { word: 'hello', start: 0, end: 0.4 },
      { word: 'world', start: 0.4, end: 0.9 },
    ],
  });
  assert.equal(result.words.length, 2);
  assert.equal(result.words[1]?.text, 'world');
  assert.equal(result.words[1]?.start, 400);
}

{
  const result = compatibleTranscriptResult({
    text: '你好',
    segments: [{ text: '你好', start: 1, end: 2 }],
  });
  assert.deepEqual(result.words.map(({ text, start, end }) => ({ text, start, end })), [
    { text: '你', start: 1000, end: 1500 },
    { text: '好', start: 1500, end: 2000 },
  ]);
}

assert.throws(
  () => compatibleTranscriptResult({ text: 'no timestamps' }),
  /verbose_json/,
);

console.log('transcription providers verify: ok');
