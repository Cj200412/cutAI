import type { TranscriptResult } from './types';
import type { LocalTranscriptionDevice } from '../../shared/transcription-providers';

interface WorkerResult {
  text: string;
  chunks: Array<{ text?: string; timestamp?: [number | null, number | null] }>;
}

interface Pending {
  resolve: (value: TranscriptResult) => void;
  reject: (reason: Error) => void;
  onProgress?: () => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function transcriptWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./local-whisper.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
    const id = Number(event.data.id);
    const job = pending.get(id);
    if (!job) return;
    if (event.data.type === 'progress') {
      job.onProgress?.();
      return;
    }
    pending.delete(id);
    if (event.data.type === 'error') {
      job.reject(new Error(String(event.data.message || 'local Whisper failed')));
      return;
    }
    job.resolve(localWhisperResult(event.data.result as WorkerResult));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'local Whisper worker failed');
    for (const job of pending.values()) job.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function localWhisperResult(result: WorkerResult): TranscriptResult {
  const words = result.chunks.flatMap((chunk) => {
    const text = (chunk.text ?? '').trim();
    const start = chunk.timestamp?.[0];
    const end = chunk.timestamp?.[1];
    if (!text || typeof start !== 'number' || typeof end !== 'number') return [];
    return [{ text, start: Math.max(0, Math.round(start * 1000)), end: Math.max(0, Math.round(end * 1000)), speaker: null }];
  });
  if (!words.length) throw new Error('本地模型没有返回词级时间戳，请更换 Whisper 模型后重试');
  return { text: result.text || words.map((word) => word.text).join(''), words, utterances: [] };
}

async function decodeMono16k(blob: Blob): Promise<Float32Array> {
  const AudioContextClass = globalThis.AudioContext;
  if (!AudioContextClass) throw new Error('当前环境不支持本地音频解码，请改用 AssemblyAI 或自定义服务');
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const channels = decoded.numberOfChannels;
    const mixed = new Float32Array(decoded.length);
    for (let channel = 0; channel < channels; channel += 1) {
      const data = decoded.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) mixed[i] += data[i]! / channels;
    }
    if (decoded.sampleRate === 16_000) return mixed;
    const ratio = decoded.sampleRate / 16_000;
    const output = new Float32Array(Math.max(1, Math.floor(mixed.length / ratio)));
    for (let i = 0; i < output.length; i += 1) {
      const offset = i * ratio;
      const left = Math.floor(offset);
      const right = Math.min(mixed.length - 1, left + 1);
      const fraction = offset - left;
      output[i] = mixed[left]! * (1 - fraction) + mixed[right]! * fraction;
    }
    return output;
  } finally {
    void context.close().catch(() => undefined);
  }
}

export async function transcribeLocalBlob(
  blob: Blob,
  model: string,
  device: LocalTranscriptionDevice,
  onProgress?: () => void,
): Promise<TranscriptResult> {
  const audio = await decodeMono16k(blob);
  const id = nextId++;
  const promise = new Promise<TranscriptResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
  });
  transcriptWorker().postMessage({ id, type: 'transcribe', model, device, audio }, [audio.buffer]);
  onProgress?.();
  return promise;
}
