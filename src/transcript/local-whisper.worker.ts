/// <reference lib="webworker" />
import { pipeline } from '@huggingface/transformers';

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

function selectedDevice(requested: TranscribeRequest['device']): 'webgpu' | 'wasm' {
  if (requested !== 'auto') return requested;
  return 'gpu' in navigator ? 'webgpu' : 'wasm';
}

async function load(request: TranscribeRequest) {
  const device = selectedDevice(request.device);
  const key = `${request.model}:${device}`;
  if (transcriber && loadedKey === key) return transcriber;
  if (loading && loadedKey === key) return loading;
  transcriber = null;
  loadedKey = key;
  loading = pipeline('automatic-speech-recognition', request.model, {
      device,
      dtype: 'q4',
      progress_callback: (progress: unknown) => {
        scope.postMessage({ id: request.id, type: 'progress', progress });
      },
    })
    .then((loaded) => loaded as unknown as WhisperTranscriber);
  try {
    transcriber = await loading;
    return transcriber;
  } finally {
    loading = null;
  }
}

async function run(request: TranscribeRequest): Promise<void> {
  const pipe = await load(request);
  const durationSeconds = request.audio.length / 16_000;
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
      const end = Math.min(request.audio.length, Math.round((cursor + window) * 16_000));
      output = await pipe(request.audio.slice(start, end), {
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
    scope.postMessage({
      id: request.id,
      type: 'error',
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });
};
