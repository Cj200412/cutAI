export const LOCAL_TRANSCRIPTION_MODELS = [
  // These repositories use the legacy Whisper ONNX export understood by the
  // Transformers.js 3.x worker (no cache_position input).
  'onnx-community/whisper-small',
  'onnx-community/whisper-base',
  'onnx-community/whisper-tiny',
  'onnx-community/whisper-large-v3-turbo',
] as const;

/** Model added in an earlier build but incompatible with the bundled worker.
 * Keep it in the cache inventory so an upgrade can remove its stale files. */
export const LOCAL_TRANSCRIPTION_LEGACY_MODELS = [
  'onnx-community/whisper-small-chinese-2-ONNX',
] as const;
export const LOCAL_TRANSCRIPTION_CACHE_MODELS = [
  ...LOCAL_TRANSCRIPTION_MODELS,
  ...LOCAL_TRANSCRIPTION_LEGACY_MODELS,
] as const;

export const DEFAULT_LOCAL_TRANSCRIPTION_MODEL = LOCAL_TRANSCRIPTION_MODELS[0];
export const DEFAULT_CUSTOM_TRANSCRIPTION_MODEL = 'whisper-1';

export type TranscriptionProvider = 'assemblyai' | 'local' | 'custom';
export type LocalTranscriptionModel = (typeof LOCAL_TRANSCRIPTION_MODELS)[number];
export type LocalTranscriptionCacheModel = (typeof LOCAL_TRANSCRIPTION_CACHE_MODELS)[number];
export type LocalTranscriptionDevice = 'auto' | 'webgpu' | 'wasm';

export function normalizeLocalTranscriptionModel(value: unknown): LocalTranscriptionModel {
  return typeof value === 'string'
    && (LOCAL_TRANSCRIPTION_MODELS as readonly string[]).includes(value)
    ? value as LocalTranscriptionModel
    : DEFAULT_LOCAL_TRANSCRIPTION_MODEL;
}

export function normalizeTranscriptionProvider(value: string | null | undefined): TranscriptionProvider {
  return value === 'local' || value === 'custom' ? value : 'assemblyai';
}

export function normalizeLocalTranscriptionDevice(value: string | null | undefined): LocalTranscriptionDevice {
  return value === 'webgpu' || value === 'wasm' ? value : 'auto';
}

export function trimApiBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}
