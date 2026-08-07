import type { TranscriptResult } from './types';
import type { LocalTranscriptionDevice } from '../../shared/transcription-providers';
import {
  normalizeGpuAccelerationMode,
  resolveCpuThreadLimit,
  type GpuAccelerationMode,
} from '../../shared/performance-settings';

interface WorkerResult {
  text: string;
  chunks: Array<{ text?: string; timestamp?: [number | null, number | null] }>;
}

interface Pending {
  resolve: (value: TranscriptResult) => void;
  reject: (reason: Error) => void;
  onProgress?: () => void;
}

export type LocalTranscriptionRuntimeState = 'installed' | 'uninstalled';

const RUNTIME_STATE_KEY = 'cutai.local-transcription-runtime';
let runtimeState: LocalTranscriptionRuntimeState = 'installed';

let worker: Worker | null = null;
let workerCpuThreads = 0;
let nextId = 1;
const pending = new Map<number, Pending>();
let localTranscriptionQueue: Promise<void> = Promise.resolve();

function runtimeStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function inspectLocalTranscriptionRuntime(): LocalTranscriptionRuntimeState {
  const storage = runtimeStorage();
  if (!storage) return runtimeState;
  try {
    const stored = storage.getItem(RUNTIME_STATE_KEY);
    runtimeState = stored === 'uninstalled' ? 'uninstalled' : 'installed';
  } catch {
    // A browser can expose localStorage but still reject reads (for example
    // in a blocked/private storage context). Keep the in-memory state.
  }
  return runtimeState;
}

function setRuntimeState(next: LocalTranscriptionRuntimeState): void {
  runtimeState = next;
  const storage = runtimeStorage();
  if (!storage) return;
  try {
    if (next === 'installed') storage.removeItem(RUNTIME_STATE_KEY);
    else storage.setItem(RUNTIME_STATE_KEY, next);
  } catch {
    // Storage may be unavailable in a restricted browser context. The
    // in-memory state still applies until the page is reloaded.
  }
}

function terminateWorker(reason: Error): number {
  const active = pending.size;
  worker?.terminate();
  worker = null;
  workerCpuThreads = 0;
  for (const job of pending.values()) job.reject(reason);
  pending.clear();
  return active;
}

/** Unload the active local ASR Worker and release its loaded model/runtime.
 * The bundled package remains part of the application and is lazily recreated
 * after installLocalTranscriptionRuntime() or the next app session. */
export function unloadLocalTranscriptionRuntime(): { abortedJobs: number } {
  setRuntimeState('uninstalled');
  return { abortedJobs: terminateWorker(new Error('本地转写运行框架已卸载，请先恢复运行框架')) };
}

/** Re-enable lazy loading of the bundled runtime. No model is loaded until the
 * next actual transcription request. */
export function installLocalTranscriptionRuntime(): void {
  setRuntimeState('installed');
}

function transcriptWorker(cpuThreads: number): Worker {
  if (worker && workerCpuThreads !== cpuThreads && pending.size === 0) {
    worker.terminate();
    worker = null;
  }
  if (worker) return worker;
  worker = new Worker(new URL('./local-whisper.worker.ts', import.meta.url), { type: 'module' });
  workerCpuThreads = cpuThreads;
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
    workerCpuThreads = 0;
  };
  return worker;
}

interface LocalRuntimePerformance {
  cpuThreads: number;
  gpuMode: GpuAccelerationMode;
}

export function resolvePerformanceTranscriptionDevice(
  requested: LocalTranscriptionDevice,
  gpuMode: unknown,
): LocalTranscriptionDevice {
  return normalizeGpuAccelerationMode(gpuMode) === 'off' ? 'wasm' : requested;
}

async function configuredRuntimePerformance(): Promise<LocalRuntimePerformance> {
  let configured = '';
  let gpuMode: unknown = '';
  try {
    const response = await fetch('/api/keys', { cache: 'no-store' });
    if (response.ok) {
      const status = (await response.json()) as { models?: Record<string, string> };
      configured = status.models?.PERFORMANCE_CPU_PERCENT ?? '';
      gpuMode = status.models?.PERFORMANCE_GPU_ACCELERATION ?? '';
    }
  } catch {
    // The local runtime also works in isolated/browser-only checks. Use the
    // conservative default when the settings endpoint is unavailable.
  }
  // ORT WebAssembly is memory-heavy per worker; its own safe default caps at
  // four threads, so the product CPU budget may lower but never raise that cap.
  return {
    cpuThreads: Math.min(4, resolveCpuThreadLimit(configured, navigator.hardwareConcurrency || 1)),
    gpuMode: normalizeGpuAccelerationMode(gpuMode),
  };
}

function textTokens(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (/\s/.test(trimmed)) return trimmed.split(/\s+/).filter(Boolean);
  return Array.from(trimmed);
}

export function localWhisperResult(result: WorkerResult): TranscriptResult {
  const words = result.chunks.flatMap((chunk) => {
    const text = (chunk.text ?? '').trim();
    const start = chunk.timestamp?.[0];
    const end = chunk.timestamp?.[1];
    if (!text || typeof start !== 'number' || typeof end !== 'number') return [];
    const startMs = Math.max(0, Math.round(start * 1000));
    const endMs = Math.max(startMs, Math.round(end * 1000));
    const tokens = textTokens(text);
    const span = Math.max(tokens.length, endMs - startMs);
    return tokens.map((token, index) => ({
      text: token,
      start: Math.round(startMs + span * index / tokens.length),
      end: Math.round(startMs + span * (index + 1) / tokens.length),
      speaker: null,
    }));
  });
  // A genuinely silent clip is a valid empty transcript, not a model failure.
  // Keep rejecting non-empty text without timestamps because it cannot become
  // editable, time-aligned captions.
  if (!words.length && !(result.text ?? '').trim()) {
    return { text: '', words: [], utterances: [] };
  }
  if (!words.length) throw new Error('本地模型没有返回分段时间戳，请更换 Whisper 模型后重试');
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

async function transcribeLocalBlobQueued(
  blob: Blob,
  model: string,
  device: LocalTranscriptionDevice,
  onProgress?: () => void,
): Promise<TranscriptResult> {
  if (inspectLocalTranscriptionRuntime() === 'uninstalled') {
    throw new Error('本地转写运行框架已卸载，请到“设置 → 素材 · 转写”恢复运行框架后重试');
  }
  const runtimePerformance = configuredRuntimePerformance();
  const audio = await decodeMono16k(blob);
  if (inspectLocalTranscriptionRuntime() === 'uninstalled') {
    throw new Error('本地转写运行框架已卸载，请到“设置 → 素材 · 转写”恢复运行框架后重试');
  }
  const { cpuThreads, gpuMode } = await runtimePerformance;
  const effectiveDevice = resolvePerformanceTranscriptionDevice(device, gpuMode);
  const id = nextId++;
  const target = transcriptWorker(cpuThreads);
  const promise = new Promise<TranscriptResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
  });
  target.postMessage({ id, type: 'transcribe', model, device: effectiveDevice, cpuThreads, audio }, [audio.buffer]);
  onProgress?.();
  return promise;
}

export function transcribeLocalBlob(
  blob: Blob,
  model: string,
  device: LocalTranscriptionDevice,
  onProgress?: () => void,
): Promise<TranscriptResult> {
  // Queue the complete memory-heavy path, including browser audio decoding.
  // This also gives a changed thread budget a clean worker boundary once the
  // preceding task has removed itself from `pending`.
  const task = localTranscriptionQueue.then(() => transcribeLocalBlobQueued(blob, model, device, onProgress));
  localTranscriptionQueue = task.then(() => undefined, () => undefined);
  return task;
}
