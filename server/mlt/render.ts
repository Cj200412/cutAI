import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { NeutralTimelineV1 } from '../../shared/neutral-timeline.ts';
import type { ResolvedMltResource } from './media-resolver.ts';
import {
  mltExperimentalCpuExportCompatibilityFailure,
  mltProbeEnvironment,
  probeMlt,
  type MltProbeReport,
} from './probe.ts';
import { convertNeutralTimelineToMltXml, MltCompatibilityError } from './xml.ts';

export const MLT_RENDER_VERSION = 1 as const;

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_XML_BYTES = 64 * 1024 * 1024;
const OUTPUT_TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS = 1_500;
export const MAX_MLT_CPU_THREADS = 16;

export type MltProcessTerminationReason = 'aborted' | 'timeout' | 'output-limit' | 'spawn-error';

export interface MltRenderProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  platform?: NodeJS.Platform;
  onProgress?: (progress: number) => void;
}

export interface MltRenderProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  lastProgress: number;
  terminationReason?: MltProcessTerminationReason;
  errorMessage?: string;
}

export type MltRenderProcessRunner = (
  executable: string,
  args: readonly string[],
  options: MltRenderProcessOptions,
) => Promise<MltRenderProcessResult>;

export interface MltRenderOutputTarget {
  /** Existing trusted directory owned by the export service. */
  rootDirectory: string;
  /** A relative `.mp4` path below rootDirectory. Existing files are never replaced. */
  relativePath: string;
}

export interface MltRenderSettings {
  /** CPU-only first slice: libx264 + AAC. */
  cpuThreads?: number;
  timeoutMs?: number;
}

export interface RenderMltTimelineRequest {
  timeline: NeutralTimelineV1;
  resources: ResolvedMltResource[];
  output: MltRenderOutputTarget;
  settings?: MltRenderSettings;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export type MltRenderDiagnosticCode =
  | 'cancelled'
  | 'invalid-request'
  | 'melt-incompatible'
  | 'melt-unavailable'
  | 'output-publish-failed'
  | 'process-failed'
  | 'process-output-limit'
  | 'process-timeout'
  | 'xml-incompatible';

export interface MltRenderDiagnostic {
  code: MltRenderDiagnosticCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface MltRenderResult {
  backend: 'mlt';
  renderVersion: typeof MLT_RENDER_VERSION;
  status: 'completed' | 'cancelled' | 'failed' | 'unavailable';
  durationMs: number;
  lastProgress: number;
  outputPath?: string;
  diagnostics: MltRenderDiagnostic[];
}

export interface MltRenderDependencies {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  probe?: (signal?: AbortSignal) => Promise<MltProbeReport>;
  processRunner?: MltRenderProcessRunner;
  convert?: (
    timeline: NeutralTimelineV1,
    resources: readonly ResolvedMltResource[],
    options: { cpuThreads: number },
  ) => ReturnType<typeof convertNeutralTimelineToMltXml>;
}

interface ValidatedOutput {
  outputPath: string;
  outputDirectory: string;
}

function cleanMessage(value: unknown, limit = 500): string {
  const raw = value instanceof Error ? value.message : String(value ?? 'unknown error');
  let clean = '';
  for (const character of raw) {
    const code = character.charCodeAt(0);
    if (code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) continue;
    clean += character;
  }
  return clean.replace(/\s+/g, ' ').trim().slice(0, limit) || 'unknown error';
}

function appendTail(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= OUTPUT_TAIL_BYTES) return chunk.subarray(chunk.length - OUTPUT_TAIL_BYTES);
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= OUTPUT_TAIL_BYTES
    ? combined
    : combined.subarray(combined.length - OUTPUT_TAIL_BYTES);
}

function parseProgressLine(line: string): number | undefined {
  const match = /\bpercentage\s*:\s*(\d{1,3}(?:\.\d+)?)\b/i.exec(line);
  if (!match) return undefined;
  const percentage = Number(match[1]);
  if (!Number.isFinite(percentage)) return undefined;
  return Math.min(1, Math.max(0, percentage / 100));
}

async function terminateProcessTree(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
  force: boolean,
): Promise<void> {
  if (!child.pid) return;
  if (platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolveKill) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
      const timer = setTimeout(() => {
        try { killer.kill('SIGKILL'); } catch { /* best effort */ }
        resolveKill();
      }, 2_000);
      killer.once('error', () => {
        clearTimeout(timer);
        resolveKill();
      });
      killer.once('close', () => {
        clearTimeout(timer);
        resolveKill();
      });
    });
    return;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

/**
 * Run one fixed-argument melt invocation. This boundary never uses a shell and
 * terminates the process tree on cancellation, timeout, or excessive output.
 */
export function runMltRenderProcess(
  executable: string,
  args: readonly string[],
  options: MltRenderProcessOptions,
): Promise<MltRenderProcessResult> {
  const startedAt = Date.now();
  const maxOutputBytes = Math.max(1, options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES);
  const killGraceMs = Math.max(1, options.killGraceMs ?? KILL_GRACE_MS);
  const platform = options.platform ?? process.platform;
  if (options.signal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
      durationMs: 0,
      lastProgress: 0,
      terminationReason: 'aborted',
    });
  }

  return new Promise((resolveResult) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolveResult({
        exitCode: null,
        signal: null,
        stdoutTail: '',
        stderrTail: '',
        durationMs: Date.now() - startedAt,
        lastProgress: 0,
        terminationReason: 'spawn-error',
        errorMessage: cleanMessage(error),
      });
      return;
    }

    let stdoutTail: Buffer = Buffer.alloc(0);
    let stderrTail: Buffer = Buffer.alloc(0);
    let stdoutLine = '';
    let stderrLine = '';
    let outputBytes = 0;
    let lastProgress = 0;
    let settled = false;
    let terminationReason: MltProcessTerminationReason | undefined;
    let errorMessage: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;

    const publishProgress = (value: number | undefined): void => {
      if (value === undefined || value < lastProgress) return;
      lastProgress = value;
      try { options.onProgress?.(value); } catch { /* observers cannot break rendering */ }
    };

    const parseLines = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const previous = stream === 'stdout' ? stdoutLine : stderrLine;
      const parts = `${previous}${chunk.toString('utf8')}`.split(/[\r\n]+/);
      const remainder = parts.pop() ?? '';
      if (stream === 'stdout') stdoutLine = remainder.slice(-4_096);
      else stderrLine = remainder.slice(-4_096);
      for (const line of parts) publishProgress(parseProgressLine(line));
    };

    const cleanupListeners = (keepForceTimer = false): void => {
      options.signal?.removeEventListener('abort', abortHandler);
      if (timeout) clearTimeout(timeout);
      if (forceTimer && !keepForceTimer) clearTimeout(forceTimer);
      if (settlementTimer) clearTimeout(settlementTimer);
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanupListeners(terminationReason !== undefined && platform !== 'win32');
      publishProgress(parseProgressLine(stdoutLine));
      publishProgress(parseProgressLine(stderrLine));
      resolveResult({
        exitCode,
        signal,
        stdoutTail: stdoutTail.toString('utf8'),
        stderrTail: stderrTail.toString('utf8'),
        durationMs: Date.now() - startedAt,
        lastProgress,
        ...(terminationReason ? { terminationReason } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      });
    };

    const terminate = (reason: MltProcessTerminationReason, message?: string): void => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      if (message) errorMessage = cleanMessage(message);
      if (timeout) clearTimeout(timeout);
      void terminateProcessTree(child, platform, false);
      forceTimer = setTimeout(() => { void terminateProcessTree(child, platform, true); }, killGraceMs);
      // A final settlement guard prevents a broken executable from holding the
      // export queue forever after both tree-kill attempts.
      settlementTimer = setTimeout(() => finish(null, null), killGraceMs * 3);
    };

    const collect = (chunkValue: Buffer | string, stream: 'stdout' | 'stderr'): void => {
      if (settled) return;
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      outputBytes += chunk.length;
      if (stream === 'stdout') stdoutTail = appendTail(stdoutTail, chunk);
      else stderrTail = appendTail(stderrTail, chunk);
      parseLines(chunk, stream);
      if (outputBytes > maxOutputBytes) {
        terminate('output-limit', `melt output exceeded ${maxOutputBytes} bytes`);
      }
    };

    timeout = setTimeout(
      () => terminate('timeout', `MLT render timed out after ${options.timeoutMs} ms`),
      Math.max(1, options.timeoutMs),
    );
    const abortHandler = (): void => terminate('aborted', 'MLT render cancelled');
    options.signal?.addEventListener('abort', abortHandler, { once: true });
    if (options.signal?.aborted) abortHandler();
    child.stdout?.on('data', (chunk) => collect(chunk as Buffer, 'stdout'));
    child.stderr?.on('data', (chunk) => collect(chunk as Buffer, 'stderr'));
    child.once('error', (error) => {
      terminationReason = 'spawn-error';
      errorMessage = cleanMessage(error);
      finish(null, null);
    });
    child.once('close', (code, signal) => finish(code, signal));
  });
}

function defaultCpuThreads(): number {
  return Math.max(1, Math.min(4, Math.ceil(availableParallelism() / 2)));
}

function validateSettings(settings: MltRenderSettings | undefined): { cpuThreads: number; timeoutMs: number } {
  const cpuThreads = settings?.cpuThreads ?? defaultCpuThreads();
  const timeoutMs = settings?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(cpuThreads) || cpuThreads < 1 || cpuThreads > MAX_MLT_CPU_THREADS) {
    throw new Error(`cpuThreads must be an integer from 1 to ${MAX_MLT_CPU_THREADS}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer from 1000 to ${MAX_TIMEOUT_MS}`);
  }
  return { cpuThreads, timeoutMs };
}

function containedPath(root: string, target: string, platform: NodeJS.Platform): boolean {
  const delta = relative(root, target);
  if (!delta || delta === '.') return false;
  if (isAbsolute(delta) || delta === '..' || delta.startsWith(`..${platform === 'win32' ? '\\' : '/'}`)) return false;
  if (platform === 'win32') {
    const canonicalRoot = root.toLocaleLowerCase('en-US');
    const canonicalTarget = target.toLocaleLowerCase('en-US');
    return canonicalTarget.startsWith(`${canonicalRoot}\\`);
  }
  return true;
}

async function validateOutputTarget(
  target: MltRenderOutputTarget,
  platform: NodeJS.Platform,
): Promise<ValidatedOutput> {
  if (!target || typeof target.rootDirectory !== 'string' || typeof target.relativePath !== 'string') {
    throw new Error('output must contain rootDirectory and relativePath');
  }
  if (!isAbsolute(target.rootDirectory) || target.rootDirectory.includes('\0')) {
    throw new Error('output.rootDirectory must be an absolute local directory');
  }
  if (!target.relativePath || isAbsolute(target.relativePath) || target.relativePath.includes('\0')) {
    throw new Error('output.relativePath must be a non-empty relative path');
  }
  if (!target.relativePath.toLowerCase().endsWith('.mp4')) {
    throw new Error('the experimental MLT slice only writes .mp4 files');
  }
  const actualRoot = await realpath(target.rootDirectory);
  if (!(await stat(actualRoot)).isDirectory()) throw new Error('output.rootDirectory is not a directory');
  const outputPath = resolve(actualRoot, target.relativePath);
  if (!containedPath(actualRoot, outputPath, platform)) {
    throw new Error('output.relativePath escapes output.rootDirectory');
  }
  const requestedDirectory = dirname(outputPath);
  const actualDirectory = await realpath(requestedDirectory);
  if (!(await stat(actualDirectory)).isDirectory() || !containedPath(actualRoot, join(actualDirectory, basename(outputPath)), platform)) {
    throw new Error('output directory escapes output.rootDirectory');
  }
  try {
    await lstat(outputPath);
    throw new Error('output file already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { outputPath: join(actualDirectory, basename(outputPath)), outputDirectory: actualDirectory };
}

function diagnostic(
  code: MltRenderDiagnosticCode,
  message: string,
  severity: MltRenderDiagnostic['severity'] = 'error',
): MltRenderDiagnostic {
  return { code, severity, message: cleanMessage(message) };
}

function result(
  status: MltRenderResult['status'],
  startedAt: number,
  lastProgress: number,
  diagnostics: MltRenderDiagnostic[],
  outputPath?: string,
): MltRenderResult {
  return {
    backend: 'mlt',
    renderVersion: MLT_RENDER_VERSION,
    status,
    durationMs: Date.now() - startedAt,
    lastProgress,
    ...(outputPath ? { outputPath } : {}),
    diagnostics,
  };
}

function renderEnvironment(source: NodeJS.ProcessEnv, cpuThreads: number): NodeJS.ProcessEnv {
  return {
    ...mltProbeEnvironment(source),
    OMP_NUM_THREADS: String(cpuThreads),
    OPENBLAS_NUM_THREADS: String(cpuThreads),
    MKL_NUM_THREADS: String(cpuThreads),
    VECLIB_MAXIMUM_THREADS: String(cpuThreads),
    NUMEXPR_NUM_THREADS: String(cpuThreads),
  };
}

function renderArgs(xmlPath: string, partialPath: string, cpuThreads: number): string[] {
  return [
    xmlPath,
    '-consumer',
    `avformat:${partialPath}`,
    'f=mp4',
    'vcodec=libx264',
    'acodec=aac',
    'preset=veryfast',
    'crf=20',
    'ab=192k',
    'movflags=+faststart',
    `threads=${cpuThreads}`,
    'real_time=-1',
    'progress=1',
    '-progress2',
  ];
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Experimental CPU-only MLT renderer. Probe flags remain truthful: a completed
 * job proves only this invocation, not that MLT is a production export backend.
 */
export async function renderMltTimeline(
  request: RenderMltTimelineRequest,
  dependencies: MltRenderDependencies = {},
): Promise<MltRenderResult> {
  const startedAt = Date.now();
  const platform = dependencies.platform ?? process.platform;
  let output: ValidatedOutput;
  let settings: ReturnType<typeof validateSettings>;
  try {
    settings = validateSettings(request.settings);
    output = await validateOutputTarget(request.output, platform);
  } catch (error) {
    return result('failed', startedAt, 0, [diagnostic('invalid-request', cleanMessage(error))]);
  }
  if (request.signal?.aborted) {
    return result('cancelled', startedAt, 0, [diagnostic('cancelled', 'MLT render cancelled', 'info')]);
  }

  let report: MltProbeReport;
  try {
    report = await (dependencies.probe ?? ((signal) => probeMlt({
      environment: dependencies.environment ?? process.env,
      platform,
      signal,
    })))(request.signal);
  } catch (error) {
    if (request.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return result('cancelled', startedAt, 0, [diagnostic('cancelled', 'MLT render cancelled', 'info')]);
    }
    return result('unavailable', startedAt, 0, [diagnostic('melt-unavailable', cleanMessage(error))]);
  }
  if (request.signal?.aborted) {
    return result('cancelled', startedAt, 0, [diagnostic('cancelled', 'MLT render cancelled', 'info')]);
  }
  const incompatibility = mltExperimentalCpuExportCompatibilityFailure(report);
  if (incompatibility || !report.executable.resolvedPath) {
    const code = report.availability === 'not-found' ? 'melt-unavailable' : 'melt-incompatible';
    return result('unavailable', startedAt, 0, [diagnostic(code, incompatibility ?? 'melt executable is unavailable')]);
  }

  let xml: string;
  try {
    xml = (dependencies.convert ?? convertNeutralTimelineToMltXml)(
      request.timeline,
      request.resources,
      { cpuThreads: settings.cpuThreads },
    ).xml;
    if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) throw new Error('generated MLT XML exceeds 64 MiB');
  } catch (error) {
    const message = cleanMessage(error);
    return result('failed', startedAt, 0, [diagnostic(
      error instanceof MltCompatibilityError ? 'xml-incompatible' : 'invalid-request',
      message,
    )]);
  }

  let temporaryDirectory: string | undefined;
  let partialPath: string | undefined;
  let publishedPath: string | undefined;
  let lastProgress = 0;
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'cutai-mlt-'));
    const xmlPath = join(temporaryDirectory, 'timeline.mlt');
    await writeFile(xmlPath, xml, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    partialPath = join(output.outputDirectory, `.${basename(output.outputPath)}.partial-${randomUUID()}.mp4`);
    const progress = (value: number): void => {
      const bounded = Math.min(1, Math.max(0, value));
      if (bounded < lastProgress) return;
      lastProgress = bounded;
      try { request.onProgress?.(bounded); } catch { /* observers cannot break rendering */ }
    };
    const processResult = await (dependencies.processRunner ?? runMltRenderProcess)(
      report.executable.resolvedPath,
      renderArgs(xmlPath, partialPath, settings.cpuThreads),
      {
        cwd: temporaryDirectory,
        env: renderEnvironment(dependencies.environment ?? process.env, settings.cpuThreads),
        signal: request.signal,
        timeoutMs: settings.timeoutMs,
        maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
        platform,
        onProgress: progress,
      },
    );
    lastProgress = Math.max(lastProgress, processResult.lastProgress);
    if (processResult.terminationReason === 'aborted' || request.signal?.aborted) {
      return result('cancelled', startedAt, lastProgress, [diagnostic('cancelled', 'MLT render cancelled', 'info')]);
    }
    if (processResult.terminationReason === 'timeout') {
      return result('failed', startedAt, lastProgress, [diagnostic(
        'process-timeout',
        processResult.errorMessage ?? 'melt exceeded its render timeout',
      )]);
    }
    if (processResult.terminationReason === 'output-limit') {
      return result('failed', startedAt, lastProgress, [diagnostic(
        'process-output-limit',
        processResult.errorMessage ?? 'melt emitted excessive process output',
      )]);
    }
    if (processResult.terminationReason || processResult.exitCode !== 0) {
      const detail = processResult.errorMessage
        || processResult.stderrTail.trim()
        || `melt exited with code ${processResult.exitCode ?? 'unknown'}`;
      return result('failed', startedAt, lastProgress, [diagnostic('process-failed', detail)]);
    }
    const partialInfo = await lstat(partialPath);
    if (!partialInfo.isFile() || partialInfo.size <= 0) {
      return result('failed', startedAt, lastProgress, [diagnostic('process-failed', 'melt did not produce a non-empty file')]);
    }
    await syncFile(partialPath);
    if (request.signal?.aborted) {
      return result('cancelled', startedAt, lastProgress, [diagnostic('cancelled', 'MLT render cancelled', 'info')]);
    }
    // link is an atomic, no-clobber publication because partial and final live
    // in the same directory. It avoids rename-overwriting a user file on POSIX.
    await link(partialPath, output.outputPath);
    publishedPath = output.outputPath;
    if (request.signal?.aborted) {
      await rm(output.outputPath, { force: true });
      publishedPath = undefined;
      return result('cancelled', startedAt, lastProgress, [diagnostic('cancelled', 'MLT render cancelled', 'info')]);
    }
    await unlink(partialPath);
    partialPath = undefined;
    progress(1);
    if (request.signal?.aborted) {
      await rm(output.outputPath, { force: true });
      publishedPath = undefined;
      return result('cancelled', startedAt, lastProgress, [diagnostic('cancelled', 'MLT render cancelled', 'info')]);
    }
    return result('completed', startedAt, 1, [], output.outputPath);
  } catch (error) {
    if (publishedPath) await rm(publishedPath, { force: true }).catch(() => undefined);
    return result('failed', startedAt, lastProgress, [diagnostic('output-publish-failed', cleanMessage(error))]);
  } finally {
    if (partialPath) await rm(partialPath, { force: true }).catch(() => undefined);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
