import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { minimaxVoiceBody, minimaxVoiceResult, openAiCompatibleVoice } from './voice-providers.ts';
import { validateVoiceRequest } from './voice.ts';
import type { VoiceOptions } from './voice-types.ts';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

const mm = validateVoiceRequest({
  provider: 'minimax',
  text: '你好',
  voiceId: '',
  speed: 1.1,
  pitch: -2,
  volume: 1.5,
  emotion: 'calm',
  sampleRate: 44_100,
  audioFormat: 'flac',
  channel: 2,
  languageBoost: 'Chinese',
  textNormalization: true,
  pronunciations: ['OpenChatCut/(open chat cut)'],
  timbreWeights: [{ voiceId: 'female-yujie', weight: 70 }, { voiceId: 'female-shaonv', weight: 30 }],
  voiceModify: { pitch: 10, intensity: -10, effect: 'robotic' },
  subtitleEnable: true,
});
assert.equal(mm.provider, 'minimax');
assert.equal(mm.pitch, -2);
assert.equal(mm.volume, 1.5);
assert.equal(mm.audioFormat, 'flac');
assert.equal(mm.timbreWeights?.length, 2);
const mmBody = minimaxVoiceBody('speech-2.6-hd', mm);
assert.equal((mmBody.voice_setting as Record<string, unknown>).text_normalization, true);
assert.equal(mmBody.text_normalization, undefined);
assert.equal((mmBody.audio_setting as Record<string, unknown>).bitrate, undefined);

const streamed = validateVoiceRequest({
  provider: 'minimax', text: 'stream it', voiceId: 'female-yujie', audioFormat: 'mp3', stream: true,
  forceCbr: true, excludeAggregatedAudio: true, subtitleEnable: true, subtitleType: 'word_streaming',
});
const streamedBody = minimaxVoiceBody('speech-2.6-hd', streamed);
assert.equal(streamedBody.stream, true);
assert.equal((streamedBody.stream_options as Record<string, unknown>).exclude_aggregated_audio, true);
assert.equal((streamedBody.audio_setting as Record<string, unknown>).force_cbr, true);
const sse = [
  'data: {"data":{"audio":"6162","status":1},"base_resp":{"status_code":0}}',
  'data: {"data":{"audio":"63","status":1},"base_resp":{"status_code":0}}',
  'data: {"data":{"status":2,"subtitle_file":"https://example.com/subtitles.json"},"base_resp":{"status_code":0}}',
  'data: [DONE]',
].join('\n');
const parsed = minimaxVoiceResult(sse, true, true);
assert.equal(parsed.audio.toString(), 'abc');
assert.equal(parsed.subtitleUrl, 'https://example.com/subtitles.json');

assert.throws(
  () => validateVoiceRequest({ provider: 'minimax', text: 'x', voiceId: 'a', volume: 11 }),
  /greater than 0 and at most 10/,
);
assert.throws(
  () => validateVoiceRequest({ provider: 'minimax', text: 'x', voiceId: 'a', pitch: 13 }),
  /pitch must be between -12 and 12/,
);
assert.throws(
  () => validateVoiceRequest({ provider: 'minimax', text: 'x', voiceId: 'a', audioFormat: 'flac', bitrate: 128_000 }),
  /bitrate applies to MP3 only/,
);
assert.throws(
  () => validateVoiceRequest({ provider: 'minimax', text: 'x', voiceId: 'a', forceCbr: true }),
  /forceCbr requires stream=true and audioFormat=mp3/,
);
assert.throws(
  () => validateVoiceRequest({ provider: 'minimax', text: 'x', voiceId: 'a', subtitleType: 'word' }),
  /subtitleType requires subtitleEnable=true/,
);
assert.throws(
  () => validateVoiceRequest({ provider: 'minimax', text: 'x', voiceId: 'a', languageBoost: 'Klingon' as never }),
  /unsupported MiniMax languageBoost/,
);
const eleven = validateVoiceRequest({
  provider: 'elevenlabs', text: 'Hello', voiceId: 'peter', similarityBoost: 0.8,
  style: 0.2, useSpeakerBoost: true, languageCode: 'en', seed: 42,
  outputFormat: 'wav_44100', optimizeStreamingLatency: 2, enableLogging: false,
  applyTextNormalization: 'on', previousText: 'Before', nextText: 'After',
  pronunciationDictionaryLocators: [{ pronunciationDictionaryId: 'dict', versionId: 'v1' }],
});
assert.equal(eleven.outputFormat, 'wav_44100');
assert.equal(eleven.seed, 42);
assert.throws(
  () => validateVoiceRequest({ provider: 'elevenlabs', text: 'hi', voiceId: 'peter', outputFormat: 'wav' }),
  /unsupported ElevenLabs outputFormat/,
);
assert.throws(
  () => validateVoiceRequest({ provider: 'minimax', text: 'x', voiceId: 'a', emotion: 'calm', emotionScale: 2 }),
  /MiniMax does not accept ElevenLabs\/Doubao-only/,
);
assert.throws(
  () => validateVoiceRequest({ provider: 'elevenlabs', text: 'hi', voiceId: 'peter', volume: 2 }),
  /ElevenLabs does not accept/,
);

const doubao = validateVoiceRequest({
  provider: 'doubao',
  text: '你好',
  voiceId: 'vivi',
  pitch: 1,
  emotion: 'happy',
  emotionScale: 3,
});
assert.equal(doubao.provider, 'doubao');

const custom = validateVoiceRequest({
  provider: 'custom',
  text: '你好',
  voiceId: '',
  modelId: 'request-model',
  speed: 1.25,
  outputFormat: 'mp3',
});
assert.equal(custom.provider, 'custom');
assert.equal(custom.voiceId, '');

let customAuth = 'unset';
let customBody: Record<string, unknown> = {};
const customServer = createServer((req, res) => {
  customAuth = String(req.headers.authorization ?? '');
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    customBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(Buffer.from('mock-mp3'));
  });
});
const customPort = await listen(customServer);
try {
  const options: VoiceOptions = {
    elevenBaseUrl: '', elevenApiKey: '', elevenModel: '',
    doubaoBaseUrl: '', doubaoAppId: '', doubaoAccessKey: '', doubaoResourceId: '',
    minimaxBaseUrl: '', minimaxApiKey: '', minimaxModel: '',
    customBaseUrl: `http://127.0.0.1:${customPort}/v1`,
    customApiKey: '',
    customModel: 'configured-model',
    customVoice: 'zh-default',
  };
  const audio = await openAiCompatibleVoice(options, custom);
  assert.equal(customAuth, '', 'unauthenticated local TTS endpoints do not receive a bearer header');
  assert.equal(customBody.model, 'request-model');
  assert.equal(customBody.voice, 'zh-default');
  assert.equal(customBody.response_format, 'mp3');
  assert.equal(audio.toString(), 'mock-mp3');
} finally {
  await new Promise<void>((resolve) => customServer.close(() => resolve()));
}

console.log('voice.check: ok (minimax pitch/volume + provider gates)');
