export const DEFAULT_PERFORMANCE_CPU_PERCENT = 60;
export const MIN_PERFORMANCE_CPU_PERCENT = 25;
export const MAX_PERFORMANCE_CPU_PERCENT = 85;
export const DEFAULT_MAX_HEAVY_TASKS = 1;
export const MAX_HEAVY_TASKS = 4;

export type GpuAccelerationMode = 'auto' | 'off';
export const DEFAULT_GPU_ACCELERATION_MODE: GpuAccelerationMode = 'auto';

function finiteNumber(value: unknown): number | null {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/%$/, '')
    : value;
  if (normalized === '' || normalized === null || normalized === undefined) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** CPU budget shared by server jobs, local inference and rendering. */
export function resolvePerformanceCpuPercent(value: unknown): number {
  const parsed = finiteNumber(value);
  if (parsed === null) return DEFAULT_PERFORMANCE_CPU_PERCENT;
  return Math.max(
    MIN_PERFORMANCE_CPU_PERCENT,
    Math.min(MAX_PERFORMANCE_CPU_PERCENT, Math.round(parsed)),
  );
}

/** Maximum number of expensive jobs that may execute at the same time. */
export function resolveMaxHeavyTasks(value: unknown): number {
  const parsed = finiteNumber(value);
  if (parsed === null) return DEFAULT_MAX_HEAVY_TASKS;
  return Math.max(1, Math.min(MAX_HEAVY_TASKS, Math.floor(parsed)));
}

export function normalizeGpuAccelerationMode(value: unknown): GpuAccelerationMode {
  return typeof value === 'string' && value.trim().toLowerCase() === 'off' ? 'off' : 'auto';
}

/** Convert the configured percentage into a safe whole-thread limit. */
export function resolveCpuThreadLimit(
  cpuPercent: unknown,
  logicalCores: unknown = 1,
): number {
  const parsedCores = Math.floor(Number(logicalCores));
  const cores = Number.isFinite(parsedCores) && parsedCores > 0 ? parsedCores : 1;
  const limit = Math.floor(cores * resolvePerformanceCpuPercent(cpuPercent) / 100);
  return Math.max(1, Math.min(cores, limit));
}
