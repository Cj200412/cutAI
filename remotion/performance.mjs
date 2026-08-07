import { availableParallelism, totalmem } from 'node:os';

const MAX_RENDER_CONCURRENCY = 24;
const DEFAULT_CPU_PERCENT = 60;
const MIN_CPU_PERCENT = 25;
const MAX_CPU_PERCENT = 85;
const GIB = 1024 ** 3;

function cpuCount(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function configuredConcurrency(value, cores) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const percent = raw.match(/^(\d+(?:\.\d+)?)%$/);
  if (percent) {
    const ratio = Math.min(100, Math.max(1, Number(percent[1]))) / 100;
    return Math.max(1, Math.min(cores, Math.floor(cores * ratio)));
  }
  if (/^\d+$/.test(raw)) return Math.max(1, Math.min(cores, Number(raw)));
  return null;
}

function cpuPercent(value) {
  const parsed = Number(typeof value === 'string' ? value.replace(/%$/, '').trim() : value);
  if (!Number.isFinite(parsed)) return DEFAULT_CPU_PERCENT;
  return Math.max(MIN_CPU_PERCENT, Math.min(MAX_CPU_PERCENT, Math.round(parsed)));
}

/**
 * Bound renderer pages by both the live CPU budget and available memory. The
 * legacy override remains available for diagnostics and explicit CLI use.
 */
export function resolveRenderConcurrency({
  cores = availableParallelism(),
  memoryBytes = totalmem(),
  override = process.env.OPENCHATCUT_RENDER_CONCURRENCY,
  cpuPercent: configuredCpuPercent = DEFAULT_CPU_PERCENT,
} = {}) {
  const count = cpuCount(cores);
  const configured = configuredConcurrency(override, count);
  if (configured !== null) return configured;
  if (count <= 2) return 1;
  const cpuTarget = Math.max(1, Math.floor(count * cpuPercent(configuredCpuPercent) / 100));
  // Reserve half of physical RAM for Electron, the OS and other applications;
  // budget the remainder at ~1.25 GiB per headless render tab.
  const memoryTarget = Math.max(1, Math.floor((memoryBytes / GIB * 0.5) / 1.25));
  return Math.max(1, Math.min(MAX_RENDER_CONCURRENCY, cpuTarget, memoryTarget));
}

/** OffthreadVideo is memory-heavy; scale it more conservatively than pages. */
export function resolveOffthreadVideoThreads({
  cores = availableParallelism(),
  cpuPercent: configuredCpuPercent = DEFAULT_CPU_PERCENT,
} = {}) {
  const count = cpuCount(cores);
  const budgetedCores = Math.max(1, Math.floor(count * cpuPercent(configuredCpuPercent) / 100));
  return Math.max(1, Math.min(4, Math.ceil(budgetedCores / 4)));
}

/** Final FFmpeg encoding is separate from headless-page rendering and needs
 * its own thread ceiling, especially after a hardware encoder falls back. */
export function resolveFfmpegThreads({
  cores = availableParallelism(),
  cpuPercent: configuredCpuPercent = DEFAULT_CPU_PERCENT,
} = {}) {
  const count = cpuCount(cores);
  return Math.max(1, Math.min(count, Math.floor(count * cpuPercent(configuredCpuPercent) / 100)));
}

/** Add both global filter limits and the output-side codec thread limit to a
 * Remotion pre-stitcher/stitcher command, replacing any previous values. */
export function applyFfmpegThreadBudget(args, threads) {
  const limit = String(Math.max(1, Math.floor(Number(threads)) || 1));
  const pairedOptions = new Set(['-filter_threads', '-filter_complex_threads', '-threads']);
  const cleaned = [];
  for (let index = 0; index < args.length; index += 1) {
    if (pairedOptions.has(args[index])) {
      index += 1;
      continue;
    }
    cleaned.push(args[index]);
  }
  if (!cleaned.length) return ['-filter_threads', limit, '-filter_complex_threads', limit, '-threads', limit];
  const output = cleaned[cleaned.length - 1];
  return [
    '-filter_threads', limit,
    '-filter_complex_threads', limit,
    ...cleaned.slice(0, -1),
    '-threads', limit,
    output,
  ];
}

/**
 * Remotion maps this to VideoToolbox on both Intel and Apple Silicon Macs, and
 * NVENC on Windows. We require it for the first attempt so a missing device is
 * surfaced to our explicit software retry. Alpha ProRes stays on software to
 * avoid platform-dependent alpha loss.
 */
export function remotionHardwareAcceleration(codec, {
  platform = process.platform,
  disabled,
  encoder,
} = {}) {
  const environmentDisabled = /^(?:1|true|yes)$/i.test(process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING ?? '');
  if ((disabled ?? environmentDisabled) || codec !== 'h264') return 'disable';
  if (platform === 'darwin') return 'required';
  // Remotion 4 currently maps Windows hardware H.264 only to NVENC. QSV and
  // AMF are still used by our FFmpeg/browser paths, but must not trigger a
  // doomed NVENC render attempt here.
  if (platform === 'win32') return encoder && encoder !== 'h264_nvenc' ? 'disable' : 'required';
  return 'disable';
}

/** Stable, high-quality H.264 bitrate scaled by output pixels and frame rate. */
export function resolveH264VideoBitrate({ width, height, fps, scale = 1 } = {}) {
  const outputWidth = Math.max(2, Number(width) * Number(scale));
  const outputHeight = Math.max(2, Number(height) * Number(scale));
  const frameRate = Math.max(1, Number(fps));
  const raw = Number.isFinite(outputWidth * outputHeight * frameRate)
    ? outputWidth * outputHeight * frameRate * 0.16
    : 10_000_000;
  const clamped = Math.max(4_000_000, Math.min(30_000_000, raw));
  return `${Math.ceil(clamped / 500_000) * 500}k`;
}

/** Runtime device/driver failure that an encoder-list probe cannot detect. */
export function isHardwareEncoderFailure(error) {
  const message = error instanceof Error
    ? `${error.message}\n${error.cause instanceof Error ? error.cause.message : String(error.cause ?? '')}`
    : String(error ?? '');
  return /videotoolbox|nvenc|nvcuda|libcuda|no (?:nvenc )?capable devices|no device|device setup failed|hardware encoder|failed to open encoder|could not open encoder|error initializing output stream/i.test(message);
}

/** Execute one hardware attempt and retry only recognized encoder failures. */
export async function withHardwareEncoderFallback({
  render,
  hardwareOptions,
  softwareOptions,
  cleanup = async () => {},
  onFallback = () => {},
}) {
  try {
    return await render(hardwareOptions);
  } catch (error) {
    if (hardwareOptions.hardwareAcceleration === 'disable' || !isHardwareEncoderFailure(error)) throw error;
    await cleanup();
    onFallback(error);
    return render(softwareOptions);
  }
}
