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
  const output = await pipe(request.audio, {
    language: 'chinese',
    task: 'transcribe',
    return_timestamps: 'word',
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  scope.postMessage({
    id: request.id,
    type: 'result',
    result: {
      text: output.text ?? '',
      chunks: output.chunks ?? [],
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
