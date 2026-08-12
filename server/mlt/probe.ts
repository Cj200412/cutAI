import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const MLT_PROBE_VERSION = 1 as const;
export const MLT_QUERY_NAMES = [
  'consumers', 'producers', 'filters', 'transitions', 'video_codecs', 'audio_codecs', 'formats',
] as const;
export type MltQueryName = (typeof MLT_QUERY_NAMES)[number];
export type MltCommandStatus = 'ok' | 'failed' | 'timeout' | 'output-limit' | 'aborted' | 'skipped';
export type MltProbeAvailability = 'not-found' | 'unusable' | 'inspectable';

export interface BoundedProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  terminationReason?: 'timeout' | 'output-limit' | 'aborted' | 'spawn-error';
  errorMessage?: string;
}

export interface BoundedProcessOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
}

export interface MltQueryReport {
  status: MltCommandStatus;
  items: string[];
  truncated: boolean;
  durationMs?: number;
  message?: string;
}

export interface MltProbeDiagnostic {
  code: 'melt-not-found' | 'melt-path-invalid' | 'probe-command-failed' | 'probe-internal-error';
  severity: 'info' | 'warning' | 'error';
  message: string;
  command?: 'version' | MltQueryName;
}

export interface MltProbeReport {
  backend: 'mlt';
  probeVersion: typeof MLT_PROBE_VERSION;
  mode: 'probe-only';
  availability: MltProbeAvailability;
  executable: {
    source: 'configured' | 'path' | 'none';
    resolvedPath?: string;
  };
  version?: string;
  versionStatus: MltCommandStatus;
  queries: Record<MltQueryName, MltQueryReport>;
  checks: {
    avformatProducerReported: boolean;
    avformatConsumerReported: boolean;
    xmlConsumerReported: boolean;
  };
  hardwareCodecCandidates: string[];
  hardwareCodecStatus: 'reported-unverified';
  renderVerified: false;
  operationallyRendered: false;
  selectableForExport: boolean;
  exportCompatibilityFailure?: string;
  diagnostics: MltProbeDiagnostic[];
}

export type MltExecutableResolution =
  | { status: 'resolved'; source: 'configured' | 'path'; resolvedPath: string }
  | { status: 'not-found'; message: string }
  | { status: 'misconfigured'; message: string };

export type MltProbeRunner = (
  executable: string,
  args: readonly string[],
  options: BoundedProcessOptions,
) => Promise<BoundedProcessResult>;

export interface ProbeMltOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  resolveExecutable?: (environment: NodeJS.ProcessEnv, platform: NodeJS.Platform) => Promise<MltExecutableResolution>;
  runner?: MltProbeRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_LIST_ITEMS = 8_192;
const SAFE_ENV_NAMES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'QT_QPA_PLATFORM',
  'MLT_DATA', 'MLT_REPOSITORY', 'MLT_PROFILES_PATH', 'MLT_PRESETS_PATH',
]);
const HARDWARE_CODECS = new Set([
  'h264_nvenc', 'hevc_nvenc', 'av1_nvenc',
  'h264_qsv', 'hevc_qsv', 'av1_qsv',
  'h264_amf', 'hevc_amf', 'av1_amf',
  'h264_videotoolbox', 'hevc_videotoolbox', 'prores_videotoolbox',
  'h264_vaapi', 'hevc_vaapi', 'av1_vaapi',
  'h264_vulkan', 'hevc_vulkan', 'av1_vulkan',
]);

function stripAnsi(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 27 && value[index + 1] === '[') {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) break;
        index += 1;
      }
      continue;
    }
    output += value[index];
  }
  return output;
}

function stripUnsafeControls(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) continue;
    output += character;
  }
  return output;
}

function boundedMessage(value: unknown, limit = 300): string {
  const raw = value instanceof Error ? value.message : String(value ?? 'unknown error');
  return stripUnsafeControls(stripAnsi(raw))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit) || 'unknown error';
}

function outputLine(value: string): string | undefined {
  const lines = stripUnsafeControls(stripAnsi(value))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[0];
}

function meltVersionLine(value: string): string | undefined {
  return stripUnsafeControls(stripAnsi(value))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\bmelt\b.*\d/i.test(line));
}

function emptyQueries(): Record<MltQueryName, MltQueryReport> {
  return {
    consumers: { status: 'skipped', items: [], truncated: false },
    producers: { status: 'skipped', items: [], truncated: false },
    filters: { status: 'skipped', items: [], truncated: false },
    transitions: { status: 'skipped', items: [], truncated: false },
    video_codecs: { status: 'skipped', items: [], truncated: false },
    audio_codecs: { status: 'skipped', items: [], truncated: false },
    formats: { status: 'skipped', items: [], truncated: false },
  };
}

function baseReport(
  availability: MltProbeAvailability,
  executable: MltProbeReport['executable'],
  diagnostics: MltProbeDiagnostic[],
): MltProbeReport {
  return {
    backend: 'mlt',
    probeVersion: MLT_PROBE_VERSION,
    mode: 'probe-only',
    availability,
    executable,
    versionStatus: 'skipped',
    queries: emptyQueries(),
    checks: {
      avformatProducerReported: false,
      avformatConsumerReported: false,
      xmlConsumerReported: false,
    },
    hardwareCodecCandidates: [],
    hardwareCodecStatus: 'reported-unverified',
    renderVerified: false,
    operationallyRendered: false,
    selectableForExport: false,
    diagnostics,
  };
}

/**
 * Return the first unmet requirement for the experimental CPU export path.
 * This deliberately does not treat probing as a successful render: the two
 * render verification flags remain false until a separate real render proves
 * otherwise.
 */
export function mltExperimentalCpuExportCompatibilityFailure(
  report: MltProbeReport,
): string | undefined {
  if (report.availability !== 'inspectable' || report.versionStatus !== 'ok' || !report.executable.resolvedPath) {
    return report.diagnostics[0]?.message ?? 'melt is unavailable or did not pass its version probe';
  }
  if (report.queries.producers.status !== 'ok'
    || !report.queries.producers.items.includes('avformat')
    || !report.queries.producers.items.includes('xml')
    || !report.queries.producers.items.includes('color')) {
    return 'melt must report avformat, xml, and color producers';
  }
  if (report.queries.consumers.status !== 'ok' || !report.queries.consumers.items.includes('avformat')) {
    return 'melt must report the avformat consumer';
  }
  if (report.queries.transitions.status !== 'ok'
    || !report.queries.transitions.items.includes('qtblend')
    || !report.queries.transitions.items.includes('mix')) {
    return 'melt must report the qtblend and mix transitions';
  }
  if (report.queries.video_codecs.status !== 'ok' || !report.queries.video_codecs.items.includes('libx264')) {
    return 'melt avformat must report the CPU libx264 encoder';
  }
  if (report.queries.audio_codecs?.status !== 'ok' || !report.queries.audio_codecs.items.includes('aac')) {
    return 'melt avformat must report the AAC audio encoder';
  }
  if (report.queries.formats?.status !== 'ok' || !report.queries.formats.items.includes('mp4')) {
    return 'melt avformat must report the MP4 muxer';
  }
  return undefined;
}

async function usableExecutable(path: string, platform: NodeJS.Platform): Promise<string | null> {
  try {
    const resolved = await realpath(path);
    if (platform === 'win32' && !resolved.toLowerCase().endsWith('.exe')) return null;
    if (!(await stat(resolved)).isFile()) return null;
    await access(resolved, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

function environmentPath(environment: NodeJS.ProcessEnv): string {
  const entry = Object.entries(environment).find(([name]) => name.toUpperCase() === 'PATH');
  return entry?.[1] ?? '';
}

/** Resolve only a trusted absolute config path or an absolute directory from PATH. */
export async function resolveMltExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<MltExecutableResolution> {
  const configured = environment.MLT_MELT_PATH?.trim();
  if (configured) {
    if (configured.includes('\0') || !isAbsolute(configured)
      || (platform === 'win32' && !configured.toLowerCase().endsWith('.exe'))) {
      return { status: 'misconfigured', message: 'MLT_MELT_PATH must name an absolute melt executable' };
    }
    const resolvedPath = await usableExecutable(configured, platform);
    return resolvedPath
      ? { status: 'resolved', source: 'configured', resolvedPath }
      : { status: 'misconfigured', message: 'MLT_MELT_PATH does not name an executable file' };
  }

  const separator = platform === 'win32' ? ';' : ':';
  const filename = platform === 'win32' ? 'melt.exe' : 'melt';
  for (const rawDirectory of environmentPath(environment).split(separator)) {
    const trimmed = rawDirectory.trim();
    const directory = trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
    // Empty/relative PATH entries can resolve against the application cwd; never probe them.
    if (!directory || !isAbsolute(directory)) continue;
    const resolvedPath = await usableExecutable(join(directory, filename), platform);
    if (resolvedPath) return { status: 'resolved', source: 'path', resolvedPath };
  }
  return { status: 'not-found', message: 'melt was not found in trusted configuration or absolute PATH entries' };
}

export function mltProbeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase();
    if (value !== undefined && (SAFE_ENV_NAMES.has(upper) || upper.startsWith('LC_'))) clean[name] = value;
  }
  return clean;
}

/** A byte-bounded child runner with one settlement gate for close/error/kill races. */
export function runBoundedProcess(
  executable: string,
  args: readonly string[],
  options: BoundedProcessOptions = {},
): Promise<BoundedProcessResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = Math.max(1, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  const killGraceMs = Math.max(1, options.killGraceMs ?? 1_000);
  const startedAt = Date.now();
  const platform = options.platform ?? process.platform;
  return new Promise((resolvePromise) => {
    if (options.signal?.aborted) {
      resolvePromise({
        exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 0,
        truncated: false, terminationReason: 'aborted', errorMessage: 'probe cancelled',
      });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: options.cwd ?? tmpdir(),
        env: options.env ?? mltProbeEnvironment(),
        detached: platform !== 'win32',
      });
    } catch (error) {
      resolvePromise({
        exitCode: null, signal: null, stdout: '', stderr: '', durationMs: Date.now() - startedAt,
        truncated: false, terminationReason: 'spawn-error', errorMessage: boundedMessage(error),
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let keptBytes = 0;
    let settled = false;
    let terminationReason: BoundedProcessResult['terminationReason'];
    let errorMessage: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killGrace: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killGrace) clearTimeout(killGrace);
      options.signal?.removeEventListener('abort', abortHandler);
      resolvePromise({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - startedAt,
        truncated: terminationReason === 'output-limit',
        ...(terminationReason ? { terminationReason } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      });
    };

    const killTree = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false, windowsHide: true, stdio: 'ignore',
        });
        killer.unref();
        return;
      }
      try { process.kill(-child.pid, 'SIGKILL'); } catch {
        try { child.kill('SIGKILL'); } catch { /* already closed */ }
      }
    };

    const terminate = (reason: NonNullable<BoundedProcessResult['terminationReason']>, message?: string) => {
      if (terminationReason || settled) return;
      terminationReason = reason;
      if (message) errorMessage = boundedMessage(message);
      killTree();
      killGrace = setTimeout(() => finish(null, null), killGraceMs);
    };
    const abortHandler = () => terminate('aborted', 'probe cancelled');

    const collect = (chunk: Buffer | string, target: Buffer[]) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - keptBytes);
      if (remaining) {
        const kept = buffer.subarray(0, remaining);
        target.push(kept);
        keptBytes += kept.length;
      }
      if (buffer.length > remaining) terminate('output-limit', `probe output exceeded ${maxOutputBytes} bytes`);
    };

    timeout = setTimeout(() => terminate('timeout', `probe timed out after ${timeoutMs} ms`), timeoutMs);
    options.signal?.addEventListener('abort', abortHandler, { once: true });
    if (options.signal?.aborted) abortHandler();
    child.stdout?.on('data', (chunk) => collect(chunk as Buffer, stdout));
    child.stderr?.on('data', (chunk) => collect(chunk as Buffer, stderr));
    child.once('error', (error) => terminate('spawn-error', error instanceof Error ? error.message : String(error)));
    child.once('close', (code, signal) => finish(code, signal));
  });
}

export function parseMltList(raw: string): string[] {
  const items = new Set<string>();
  const cleaned = stripUnsafeControls(stripAnsi(raw));
  for (const line of cleaned.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+(?:"([^"]+)"|'([^']+)'|([^#]+?))\s*(?:#.*)?$/);
    const candidate = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,199}$/.test(candidate)) continue;
    items.add(candidate);
    if (items.size >= MAX_LIST_ITEMS) break;
  }
  return [...items].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function commandStatus(result: BoundedProcessResult): MltCommandStatus {
  if (result.terminationReason === 'aborted') return 'aborted';
  if (result.terminationReason === 'timeout') return 'timeout';
  if (result.terminationReason === 'output-limit') return 'output-limit';
  return result.exitCode === 0 && !result.terminationReason ? 'ok' : 'failed';
}

function queryMessage(result: BoundedProcessResult): string | undefined {
  if (result.errorMessage) return boundedMessage(result.errorMessage);
  const line = outputLine(result.stderr) ?? outputLine(result.stdout);
  return line ? boundedMessage(line) : undefined;
}

async function runQueries(
  executable: string,
  runner: MltProbeRunner,
  processOptions: BoundedProcessOptions,
): Promise<Record<MltQueryName, BoundedProcessResult>> {
  const results = {} as Record<MltQueryName, BoundedProcessResult>;
  let next = 0;
  const worker = async () => {
    while (next < MLT_QUERY_NAMES.length) {
      const name = MLT_QUERY_NAMES[next++]!;
      results[name] = await runner(executable, ['-query', name], processOptions);
    }
  };
  await Promise.all([worker(), worker()]);
  return results;
}

export async function probeMlt(options: ProbeMltOptions = {}): Promise<MltProbeReport> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const resolver = options.resolveExecutable ?? resolveMltExecutable;
  const runner = options.runner ?? runBoundedProcess;
  let resolution: MltExecutableResolution;
  try {
    resolution = await resolver(environment, platform);
  } catch (error) {
    return baseReport('unusable', { source: 'none' }, [{
      code: 'probe-internal-error', severity: 'error', message: boundedMessage(error),
    }]);
  }
  if (resolution.status === 'not-found') {
    return baseReport('not-found', { source: 'none' }, [{
      code: 'melt-not-found', severity: 'info', message: resolution.message,
    }]);
  }
  if (resolution.status === 'misconfigured') {
    return baseReport('unusable', { source: 'configured' }, [{
      code: 'melt-path-invalid', severity: 'error', message: resolution.message,
    }]);
  }

  const processOptions: BoundedProcessOptions = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    cwd: tmpdir(),
    env: mltProbeEnvironment(environment),
    platform,
    signal: options.signal,
  };
  const report = baseReport('unusable', {
    source: resolution.source,
    resolvedPath: resolution.resolvedPath,
  }, []);
  const versionResult = await runner(resolution.resolvedPath, ['-version'], processOptions);
  report.versionStatus = commandStatus(versionResult);
  const version = meltVersionLine(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (report.versionStatus !== 'ok' || !version) {
    report.diagnostics.push({
      code: 'probe-command-failed',
      severity: 'error',
      command: 'version',
      message: queryMessage(versionResult) ?? 'melt did not return a usable version',
    });
    return report;
  }
  report.version = version;
  report.availability = 'inspectable';

  const queryResults = await runQueries(resolution.resolvedPath, runner, processOptions);
  for (const name of MLT_QUERY_NAMES) {
    const result = queryResults[name];
    const status = commandStatus(result);
    const items = status === 'ok' ? parseMltList(`${result.stdout}\n${result.stderr}`) : [];
    report.queries[name] = {
      status,
      items,
      truncated: result.truncated,
      durationMs: result.durationMs,
      ...(status === 'ok' ? {} : { message: queryMessage(result) ?? `${name} query failed` }),
    };
    if (status !== 'ok') report.diagnostics.push({
      code: 'probe-command-failed',
      severity: 'warning',
      command: name,
      message: report.queries[name].message ?? `${name} query failed`,
    });
  }
  report.checks = {
    avformatProducerReported: report.queries.producers.items.includes('avformat'),
    avformatConsumerReported: report.queries.consumers.items.includes('avformat'),
    xmlConsumerReported: report.queries.consumers.items.includes('xml'),
  };
  report.hardwareCodecCandidates = report.queries.video_codecs.items.filter((codec) => HARDWARE_CODECS.has(codec));
  const exportCompatibilityFailure = mltExperimentalCpuExportCompatibilityFailure(report);
  report.selectableForExport = exportCompatibilityFailure === undefined;
  if (exportCompatibilityFailure) report.exportCompatibilityFailure = exportCompatibilityFailure;
  return report;
}

export function mltInternalErrorReport(error: unknown): MltProbeReport {
  return baseReport('unusable', { source: 'none' }, [{
    code: 'probe-internal-error', severity: 'error', message: boundedMessage(error),
  }]);
}
