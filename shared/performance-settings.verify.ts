import assert from 'node:assert/strict';
import {
  DEFAULT_GPU_ACCELERATION_MODE,
  DEFAULT_MAX_HEAVY_TASKS,
  DEFAULT_PERFORMANCE_CPU_PERCENT,
  normalizeGpuAccelerationMode,
  resolveCpuThreadLimit,
  resolveMaxHeavyTasks,
  resolvePerformanceCpuPercent,
} from './performance-settings.ts';

assert.equal(resolvePerformanceCpuPercent(undefined), DEFAULT_PERFORMANCE_CPU_PERCENT);
assert.equal(resolvePerformanceCpuPercent(null), DEFAULT_PERFORMANCE_CPU_PERCENT);
assert.equal(resolvePerformanceCpuPercent('60%'), 60);
assert.equal(resolvePerformanceCpuPercent(0), 25);
assert.equal(resolvePerformanceCpuPercent(100), 85);
assert.equal(resolvePerformanceCpuPercent('invalid'), DEFAULT_PERFORMANCE_CPU_PERCENT);

assert.equal(resolveMaxHeavyTasks(undefined), DEFAULT_MAX_HEAVY_TASKS);
assert.equal(resolveMaxHeavyTasks(0), 1);
assert.equal(resolveMaxHeavyTasks('2'), 2);
assert.equal(resolveMaxHeavyTasks(99), 4);

assert.equal(normalizeGpuAccelerationMode(undefined), DEFAULT_GPU_ACCELERATION_MODE);
assert.equal(normalizeGpuAccelerationMode('AUTO'), 'auto');
assert.equal(normalizeGpuAccelerationMode(' off '), 'off');
assert.equal(normalizeGpuAccelerationMode('invalid'), 'auto');

assert.equal(resolveCpuThreadLimit(undefined, 12), 7);
assert.equal(resolveCpuThreadLimit(50, 12), 6);
assert.equal(resolveCpuThreadLimit(100, 12), 10);
assert.equal(resolveCpuThreadLimit(25, 1), 1);
assert.equal(resolveCpuThreadLimit(60, 0), 1);

console.log('performance settings verification passed');
