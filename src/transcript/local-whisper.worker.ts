/// <reference lib="webworker" />
import { pipeline } from '@huggingface/transformers';
import { normalizeLocalTranscriptionModel } from '../../shared/transcription-providers';

interface TranscribeRequest {
  id: number;
  type: 'transcribe';
  model: string;
  device: 'auto' | 'webgpu' | 'wasm';
  audio: Float32Array;
}

interface WhisperChunk {
  text?: string;
  timestamp?: [number | null, number | null];
}

interface WhisperOutput {
  text?: string;
  chunks?: WhisperChunk[];
}

type WhisperTranscriber = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<WhisperOutput>;

const scope = self as unknown as DedicatedWorkerGlobalScope;
let loadedKey = '';
let transcriber: WhisperTranscriber | null = null;
let loading: Promise<WhisperTranscriber> | null = null;
let loadingKey = '';

function selectedDevice(requested: TranscribeRequest['device']): 'webgpu' | 'wasm' {
  if (requested !== 'auto') return requested;
  return 'gpu' in navigator ? 'webgpu' : 'wasm';
}

/** Cheap gate for digital silence. Sampling at most ~4k points keeps this
 * negligible compared with an ASR pass while avoiding model calls for long
 * silent gaps in a timeline. The threshold is intentionally very low so quiet
 * speech is still sent to Whisper. */
function isNearSilence(audio: Float32Array, start: number, end: number): boolean {
  const length = Math.max(0, end - start);
  if (!length) return true;
  const stride = Math.max(1, Math.ceil(length / 4_000));
  let peak = 0;
  let energy = 0;
  let count = 0;
  for (let index = start; index < end; index += stride) {
    const sample = Math.abs(audio[index] ?? 0);
    peak = Math.max(peak, sample);
    energy += sample * sample;
    count += 1;
  }
  return peak < 0.001 && Math.sqrt(energy / Math.max(1, count)) < 0.0005;
}

async function load(request: TranscribeRequest) {
  const device = selectedDevice(request.device);
  const model = normalizeLocalTranscriptionModel(request.model);
  const key = `${model}:${device}`;
  if (transcriber && loadedKey === key) return transcriber;
  if (loading && loadingKey === key) return loading;
  transcriber = null;
  loadedKey = key;
  loadingKey = key;
  loading = pipeline('automatic-speech-recognition', model, {
      device,
      dtype: 'q4',
      progress_callback: (progress: unknown) => {
        scope.postMessage({ id: request.id, type: 'progress', progress });
      },
    })
    .then((loaded) => loaded as unknown as WhisperTranscriber);
  const current = loading;
  try {
    transcriber = await current;
    return transcriber;
  } finally {
    if (loading === current) {
      loading = null;
      loadingKey = '';
    }
  }
}

async function run(request: TranscribeRequest): Promise<void> {
  const pipe = await load(request);
  const durationSamples = request.audio.length;
  const durationSeconds = durationSamples / 16_000;
  const allChunks: WhisperChunk[] = [];
  let cursor = 0;
  // Adaptive windows: start at 5s, grow in 5s steps until the recognized text
  // reaches a natural punctuation boundary. This avoids sending a long master
  // as one request while keeping sentence timing intact.
  while (cursor < durationSeconds) {
    let window = Math.min(5, durationSeconds - cursor);
    let output: WhisperOutput = { text: '', chunks: [] };
    for (;;) {
      const start = Math.round(cursor * 16_000);
      const end = Math.min(durationSamples, Math.round((cursor + window) * 16_000));
      if (isNearSilence(request.audio, start, end)) {
        output = { text: '', chunks: [] };
        break;
      }
      // The pipeline only reads this audio during the await. A subarray avoids
      // copying up to 30 seconds of PCM for every adaptive retry.
      output = await pipe(request.audio.subarray(start, end), {
        language: 'chinese', task: 'transcribe', return_timestamps: true,
        chunk_length_s: Math.min(30, window), stride_length_s: Math.min(2, window / 3),
      });
      const text = output.text ?? '';
      // Keep growing until Whisper returns a real sentence/clause boundary.
      const boundary = /[。！？；：，、.!?;:…](?:["'”’）)】』」》〉〕】]*)$/.test(text.trim());
      if (boundary || cursor + window >= durationSeconds || window >= 30) break;
      window = Math.min(window + 5, durationSeconds - cursor);
    }
    for (const chunk of output.chunks ?? []) {
      const start = (chunk.timestamp?.[0] ?? 0) + cursor;
      const end = (chunk.timestamp?.[1] ?? window) + cursor;
      allChunks.push({ ...chunk, timestamp: [start, end] });
    }
    cursor += window;
  }
  scope.postMessage({
    id: request.id,
    type: 'result',
    result: {
      text: allChunks.map((chunk) => chunk.text ?? '').join(''),
      chunks: allChunks,
    },
  });
}

scope.onmessage = (event: MessageEvent<TranscribeRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'transcribe' || !Number.isInteger(request.id)
    || typeof request.model !== 'string' || !(request.audio instanceof Float32Array)) {
    return;
  }
  void run(request).catch((reason: unknown) => {
    const detail = reason instanceof Error ? reason.message : String(reason);
    const message = detail.includes('cache_position')
      ? '所选 ONNX 模型与当前 Transformers.js 运行框架不兼容，请改用本地 Whisper small/base/tiny，并删除旧模型缓存后重试。'
      : detail;
    scope.postMessage({
      id: request.id,
      type: 'error',
      message,
    });
  });
};
