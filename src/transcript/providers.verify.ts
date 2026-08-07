import assert from 'node:assert/strict';
import {
  DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
  normalizeLocalTranscriptionDevice,
  normalizeLocalTranscriptionModel,
  normalizeTranscriptionProvider,
  trimApiBaseUrl,
} from '../../shared/transcription-providers.ts';
import { compatibleTranscriptResult } from './openai-compatible.ts';
import { acceptWhisperWindow } from './local-whisper-segments.ts';
import {
  inspectLocalTranscriptionRuntime,
  installLocalTranscriptionRuntime,
  localWhisperResult,
  resolvePerformanceTranscriptionDevice,
  unloadLocalTranscriptionRuntime,
} from './local-whisper.ts';

assert.equal(normalizeTranscriptionProvider(undefined), 'assemblyai');
assert.equal(normalizeTranscriptionProvider('local'), 'local');
assert.equal(normalizeTranscriptionProvider('custom'), 'custom');
assert.equal(normalizeTranscriptionProvider('unknown'), 'assemblyai');
assert.equal(DEFAULT_LOCAL_TRANSCRIPTION_MODEL, 'onnx-community/whisper-small');
assert.equal(normalizeLocalTranscriptionModel('onnx-community/whisper-small-chinese-2-ONNX'), DEFAULT_LOCAL_TRANSCRIPTION_MODEL);
assert.equal(normalizeLocalTranscriptionModel('onnx-community/whisper-base'), 'onnx-community/whisper-base');
assert.equal(normalizeLocalTranscriptionDevice('webgpu'), 'webgpu');
assert.equal(normalizeLocalTranscriptionDevice('bad'), 'auto');
assert.equal(resolvePerformanceTranscriptionDevice('auto', 'off'), 'wasm');
assert.equal(resolvePerformanceTranscriptionDevice('webgpu', 'off'), 'wasm');
assert.equal(resolvePerformanceTranscriptionDevice('auto', 'auto'), 'auto');
assert.equal(trimApiBaseUrl(' http://127.0.0.1:8000/v1/// '), 'http://127.0.0.1:8000/v1');

assert.throws(
  () => acceptWhisperWindow({ text: '有内容', chunks: [] }, 5),
  /缺少分段时间戳/,
);
assert.throws(
  () => acceptWhisperWindow({ text: '有内容', chunks: [{ text: '有内容' }] }, 5),
  /缺少分段时间戳/,
);
assert.deepEqual(acceptWhisperWindow({
  text: '一句尚未说完',
  chunks: [{ text: '一句尚未说完', timestamp: [0, null] }],
}, 5), {
  text: '', chunks: [], durationSeconds: 5, punctuationBoundary: false,
}, '开放末段应触发扩窗，而不是误报时间戳缺失');
assert.deepEqual(acceptWhisperWindow({
  text: '最后一句',
  chunks: [{ text: '最后一句', timestamp: [1, null] }],
}, 5, true), {
  text: '最后一句',
  chunks: [{ text: '最后一句', timestamp: [1, 5] }],
  durationSeconds: 5,
  punctuationBoundary: false,
}, '音频末尾或 30 秒上限应安全收束开放末段');
assert.deepEqual(acceptWhisperWindow({
  text: '第一句，后半句',
  chunks: [
    { text: '第一句，', timestamp: [0, 3] },
    { text: '后半句', timestamp: [3, 5] },
  ],
}, 5), {
  text: '第一句，',
  chunks: [{ text: '第一句，', timestamp: [0, 3] }],
  durationSeconds: 3,
  punctuationBoundary: true,
});
assert.equal(acceptWhisperWindow({
  text: '他说：你好。”后面',
  chunks: [{ text: '他说：你好。”后面', timestamp: [0, 5] }],
}, 5).text, '他说：你好。”', '标点断句应保留紧随其后的闭合引号');
assert.deepEqual(acceptWhisperWindow({
  text: '你好。',
  chunks: [{ text: '你好', timestamp: [0, 2] }],
}, 5), {
  text: '你好。',
  chunks: [{ text: '你好。', timestamp: [0, 2] }],
  durationSeconds: 2,
  punctuationBoundary: true,
});

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
    { text: '你', start: 100, end: 400, speaker: null },
    { text: '好', start: 400, end: 700, speaker: null },
    { text: '世', start: 700, end: 1050, speaker: null },
    { text: '界', start: 1050, end: 1400, speaker: null },
  ]);
}

assert.deepEqual(localWhisperResult({ text: '', chunks: [] }), {
  text: '', words: [], utterances: [],
});
assert.throws(
  () => localWhisperResult({ text: '有内容但没有时间戳', chunks: [] }),
  /没有返回分段时间戳/,
);

assert.equal(inspectLocalTranscriptionRuntime(), 'installed');
assert.deepEqual(unloadLocalTranscriptionRuntime(), { abortedJobs: 0 });
assert.equal(inspectLocalTranscriptionRuntime(), 'uninstalled');
installLocalTranscriptionRuntime();
assert.equal(inspectLocalTranscriptionRuntime(), 'installed');

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
