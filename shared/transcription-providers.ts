export const LOCAL_TRANSCRIPTION_MODELS = [
  // Chinese-specialized Whisper fine-tune with Transformers.js-compatible ONNX
  // weights. It is a better default for Mandarin punctuation than the generic
  // tiny model while remaining browser-local and cache-manageable.
  'onnx-community/whisper-small-chinese-2-ONNX',
  'onnx-community/whisper-tiny',
  'onnx-community/whisper-base',
  'onnx-community/whisper-small',
  'onnx-community/whisper-large-v3-turbo',
] as const;

export const DEFAULT_LOCAL_TRANSCRIPTION_MODEL = LOCAL_TRANSCRIPTION_MODELS[0];
export const DEFAULT_CUSTOM_TRANSCRIPTION_MODEL = 'whisper-1';

export type TranscriptionProvider = 'assemblyai' | 'local' | 'custom';
export type LocalTranscriptionModel = (typeof LOCAL_TRANSCRIPTION_MODELS)[number];
export type LocalTranscriptionDevice = 'auto' | 'webgpu' | 'wasm';

export function normalizeTranscriptionProvider(value: string | null | undefined): TranscriptionProvider {
  return value === 'local' || value === 'custom' ? value : 'assemblyai';
}

export function normalizeLocalTranscriptionDevice(value: string | null | undefined): LocalTranscriptionDevice {
  return value === 'webgpu' || value === 'wasm' ? value : 'auto';
}

export function trimApiBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}
