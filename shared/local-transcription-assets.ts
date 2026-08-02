import {
  LOCAL_TRANSCRIPTION_MODELS,
  type LocalTranscriptionModel,
} from './transcription-providers.ts';

/**
 * The local ASR runtime is bundled with CutAI. Keep these byte counts in sync
 * with the installed Transformers.js browser bundle and ONNX Runtime WASM.
 */
export const LOCAL_TRANSCRIPTION_RUNTIME = {
  id: 'transformers-web',
  label: 'Transformers.js + ONNX Runtime Web',
  version: '3.8.1',
  bytes: 22_484_192,
  /** The package is bundled, but the loaded Worker/runtime instance is
   * replaceable and unloadable from the running app. */
  unloadable: true,
  packageRemovable: false,
} as const;

export const LOCAL_TRANSCRIPTION_EXECUTION_BACKENDS = [
  {
    id: 'wasm',
    label: 'ONNX Runtime Web · WASM（CPU）',
    extraBytes: 0,
  },
  {
    id: 'webgpu',
    label: 'ONNX Runtime Web · WebGPU（显卡）',
    extraBytes: 0,
  },
] as const;

export const LOCAL_TRANSCRIPTION_REQUIRED_MODEL_FILES = [
  'onnx/encoder_model_q4.onnx',
  'onnx/decoder_model_merged_q4.onnx',
] as const;

export const LOCAL_TRANSCRIPTION_DOWNLOAD_FILES = [
  'added_tokens.json',
  'config.json',
  'generation_config.json',
  'merges.txt',
  'normalizer.json',
  ...LOCAL_TRANSCRIPTION_REQUIRED_MODEL_FILES,
  'preprocessor_config.json',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.json',
] as const;

export function isLocalTranscriptionModel(value: unknown): value is LocalTranscriptionModel {
  return typeof value === 'string'
    && (LOCAL_TRANSCRIPTION_MODELS as readonly string[]).includes(value);
}
