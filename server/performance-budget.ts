import { availableParallelism } from 'node:os';
import {
  normalizeGpuAccelerationMode,
  resolveCpuThreadLimit,
  resolveMaxHeavyTasks,
  resolvePerformanceCpuPercent,
} from '../shared/performance-settings.ts';
import { getKey } from './keystore.ts';
import { TaskLimiter, type ReleaseTaskPermit } from './task-limiter.ts';

const heavyTaskLimiter = new TaskLimiter(1);

function syncHeavyTaskLimit(): void {
  heavyTaskLimiter.setLimit(resolveMaxHeavyTasks(getKey('PERFORMANCE_MAX_HEAVY_TASKS')));
}

/** Approximate per-process CPU budget. FFmpeg and local ASR receive this as a
 * thread limit; Remotion maps the same percentage to render-page concurrency. */
export function localCpuThreadLimit(cores = availableParallelism()): number {
  return resolveCpuThreadLimit(getKey('PERFORMANCE_CPU_PERCENT'), cores);
}

export function performanceCpuPercent(): number {
  return resolvePerformanceCpuPercent(getKey('PERFORMANCE_CPU_PERCENT'));
}

/** Global FFmpeg options. Keep these before the first input so both filter and
 * codec thread pools obey the configured local CPU budget. */
export function ffmpegThreadArgs(): string[] {
  const threads = String(localCpuThreadLimit());
  return ['-filter_threads', threads, '-filter_complex_threads', threads, '-threads', threads];
}

/** FFmpeg's -threads is a per-file option: before -i it limits decoding, while
 * this form belongs immediately before the output path and limits encoding. */
export function ffmpegOutputThreadArgs(): string[] {
  return ['-threads', String(localCpuThreadLimit())];
}

export function isGpuAccelerationDisabled(): boolean {
  return normalizeGpuAccelerationMode(getKey('PERFORMANCE_GPU_ACCELERATION')) === 'off';
}

export function acquireHeavyTaskPermit(): Promise<ReleaseTaskPermit> {
  syncHeavyTaskLimit();
  return heavyTaskLimiter.acquire();
}

export async function withHeavyTaskPermit<T>(task: () => Promise<T>): Promise<T> {
  const release = await acquireHeavyTaskPermit();
  try {
    return await task();
  } finally {
    release();
  }
}

export function heavyTaskBudgetSnapshot(): { active: number; queued: number; limit: number } {
  syncHeavyTaskLimit();
  return heavyTaskLimiter.snapshot();
}
