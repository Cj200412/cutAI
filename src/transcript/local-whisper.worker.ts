/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';
import { normalizeLocalTranscriptionModel } from '../../shared/transcription-providers';
import {
  acceptWhisperWindow,
  type LocalWhisperChunk as WhisperChunk,
  type LocalWhisperWindowOutput as WhisperOutput,
} from './local-whisper-segments';

interface TranscribeRequest {
  id: number;
  type: 'transcribe';
  model: string;
  device: 'auto' | 'webgpu' | 'wasm';
  cpuThreads: number;
  audio: Float32Array;
}

type WhisperTranscriber = ((
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<WhisperOutput>) & { dispose?: () => void | Promise<void> };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let loadedKey = '';
let transcriber: WhisperTranscriber | null = null;
let loading: Promise<WhisperTranscriber> | null = null;
let loadingKey = '';
let webGpuUnavailable = false;
let runQueue: Promise<void> = Promise.resolve();

async function disposeTranscriber(): Promise<void> {
  const current = transcriber;
  transcriber = null;
  loadedKey = '';
  try {
    await current?.dispose?.();
  } catch {
    // A failed backend may also reject disposal. Dropping the reference still
    // lets the worker reclaim it before the fallback runtime is loaded.
  }
}

function selectedDevice(requested: TranscribeRequest['device']): 'webgpu' | 'wasm' {
  if (requested !== 'auto') return requested;
  return !webGpuUnavailable && 'gpu' in navigator ? 'webgpu' : 'wasm';
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
  const model = normalizeLocalTranscriptionModel(request.model);
  let device = selectedDevice(request.device);
  const threads = Math.max(1, Math.min(32, Math.round(request.cpuThreads) || 1));
  let key = `${model}:${device}:${device === 'wasm' ? threads : 0}`;
  if (transcriber && loadedKey === key) return transcriber;
  if (loading && loadingKey === key) return loading;
  await disposeTranscriber();
  loadingKey = key;
  const start = (target: 'webgpu' | 'wasm'): Promise<WhisperTranscriber> => {
    if (target === 'wasm') {
      const wasm = env.backends.onnx.wasm;
      if (wasm) Object.assign(wasm, { numThreads: threads });
    }
    return pipeline('automatic-speech-recognition', model, {
      device: target,
      dtype: 'q4',
      progress_callback: (progress: unknown) => {
        scope.postMessage({ id: request.id, type: 'progress', progress });
      },
    }).then((loaded) => loaded as unknown as WhisperTranscriber);
  };
  let current = start(device);
  loading = current;
  try {
    try {
      transcriber = await current;
    } catch (error) {
      if (request.device !== 'auto' || device !== 'webgpu') throw error;
      // WebGPU availability is not proof that this GPU/driver supports every
      // ONNX operator. Auto mode falls back once and remembers the failure for
      // subsequent queued jobs in this Worker.
      webGpuUnavailable = true;
      device = 'wasm';
      key = `${model}:wasm:${threads}`;
      loadingKey = key;
      current = start(device);
      loading = current;
      transcriber = await current;
    }
    loadedKey = key;
    return transcriber;
  } finally {
    if (loading === current) {
      loading = null;
      loadingKey = '';
    }
  }
}

async function transcribeAdaptive(
  request: TranscribeRequest,
  pipe: WhisperTranscriber,
): Promise<{ text: string; chunks: WhisperChunk[] }> {
  const durationSamples = request.audio.length;
  const durationSeconds = durationSamples / 16_000;
  const allChunks: WhisperChunk[] = [];
  let cursor = 0;
  // Adaptive windows: start at 5s, grow in 5s steps until the recognized text
  // reaches a natural punctuation boundary. CPU saturation is controlled by
  // the Worker queue and configured thread budget, without sacrificing the
  // longer context that Chinese punctuation recognition needs.
  while (cursor < durationSeconds) {
    let window = Math.min(5, durationSeconds - cursor);
    let output: WhisperOutput = { text: '', chunks: [] };
    let accepted = acceptWhisperWindow(output, window);
    for (;;) {
      const start = Math.round(cursor * 16_000);
      const end = Math.min(durationSamples, Math.round((cursor + window) * 16_000));
      if (isNearSilence(request.audio, start, end)) {
        output = { text: '', chunks: [] };
        accepted = acceptWhisperWindow(output, window);
        break;
      }
      output = await pipe(request.audio.subarray(start, end), {
        language: 'chinese', task: 'transcribe', return_timestamps: true,
        chunk_length_s: Math.min(30, window), stride_length_s: Math.min(2, window / 3),
      });
      const closesWindow = cursor + window >= durationSeconds || window >= 30;
      accepted = acceptWhisperWindow(output, window, closesWindow);
      if (accepted.punctuationBoundary || closesWindow) break;
      window = Math.min(window + 5, durationSeconds - cursor);
    }
    for (const chunk of accepted.chunks) {
      const chunkStart = (chunk.timestamp?.[0] as number) + cursor;
      const chunkEnd = (chunk.timestamp?.[1] as number) + cursor;
      allChunks.push({ ...chunk, timestamp: [chunkStart, chunkEnd] });
    }
    cursor += accepted.durationSeconds;
  }
  return { text: allChunks.map((chunk) => chunk.text ?? '').join(''), chunks: allChunks };
}

async function run(request: TranscribeRequest): Promise<void> {
  let pipe = await load(request);
  let result: { text: string; chunks: WhisperChunk[] };
  try {
    result = await transcribeAdaptive(request, pipe);
  } catch (error) {
    const failedOnAutomaticWebGpu = request.device === 'auto' && loadedKey.includes(':webgpu:');
    if (!failedOnAutomaticWebGpu) throw error;
    // WebGPU may load successfully but fail on its first real inference. Auto
    // mode retries this job once on the bounded WASM backend.
    webGpuUnavailable = true;
    await disposeTranscriber();
    const fallbackRequest = { ...request, device: 'wasm' as const };
    pipe = await load(fallbackRequest);
    result = await transcribeAdaptive(fallbackRequest, pipe);
  }
  scope.postMessage({ id: request.id, type: 'result', result });
}

function reportError(request: TranscribeRequest, reason: unknown): void {
  const detail = reason instanceof Error ? reason.message : String(reason);
  const message = detail.includes('cache_position')
    ? '所选 ONNX 模型与当前 Transformers.js 运行框架不兼容，请改用本地 Whisper small/base/tiny，并删除旧模型缓存后重试。'
    : detail;
  scope.postMessage({
    id: request.id,
    type: 'error',
    message,
  });
}

scope.onmessage = (event: MessageEvent<TranscribeRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'transcribe' || !Number.isInteger(request.id)
    || typeof request.model !== 'string' || !(request.audio instanceof Float32Array)) {
    return;
  }
  // One Worker owns one model/runtime. Queue requests so multiple imported
  // videos cannot each start a full inference pass and saturate CPU/GPU.
  runQueue = runQueue.then(() => run(request)).catch((reason: unknown) => {
    reportError(request, reason);
  });
};
