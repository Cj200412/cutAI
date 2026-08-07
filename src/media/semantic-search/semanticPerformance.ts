import {
  normalizeGpuAccelerationMode,
  resolveCpuThreadLimit,
} from '../../../shared/performance-settings';
import type { SemanticDevice } from './types';

export interface SemanticRuntimePerformance {
  device: SemanticDevice;
  cpuThreads: number;
}

export function resolveSemanticRuntimePerformance(
  settings: { cpuPercent?: unknown; gpuMode?: unknown } = {},
  logicalCores: unknown = 1,
  hasWebGpu = false,
): SemanticRuntimePerformance {
  return {
    device: normalizeGpuAccelerationMode(settings.gpuMode) === 'off' || !hasWebGpu ? 'wasm' : 'webgpu',
    // ONNX WASM allocates memory per thread; keep the runtime's safe cap while
    // allowing the shared CPU budget to lower it.
    cpuThreads: Math.min(4, resolveCpuThreadLimit(settings.cpuPercent, logicalCores)),
  };
}

export async function loadSemanticRuntimePerformance(): Promise<SemanticRuntimePerformance> {
  let settings: { cpuPercent?: unknown; gpuMode?: unknown } = {};
  try {
    const response = await fetch('/api/keys', { cache: 'no-store' });
    if (response.ok) {
      const status = await response.json() as { models?: Record<string, string> };
      settings = {
        cpuPercent: status.models?.PERFORMANCE_CPU_PERCENT,
        gpuMode: status.models?.PERFORMANCE_GPU_ACCELERATION,
      };
    }
  } catch {
    // Standalone/browser-only runs use shared conservative defaults.
  }
  return resolveSemanticRuntimePerformance(
    settings,
    navigator.hardwareConcurrency || 1,
    'gpu' in navigator,
  );
}
