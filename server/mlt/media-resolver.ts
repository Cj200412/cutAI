import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { resolveWorkspaceMediaFile } from '../../desktop/workspace-project.ts';
import type { NeutralTimelineV1 } from '../../shared/neutral-timeline.ts';
import { ffprobeBin } from '../media-binaries.ts';
import { DEFAULT_UPLOAD_DIR, isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
import { mltProbeEnvironment } from './probe.ts';

export interface ResolvedMltResource {
  uri: string;
  absolutePath: string;
  width?: number;
  height?: number;
}

export interface ResolveMltMediaOptions {
  resolveUpload?: (name: string) => string | null;
  resolveWorkspace?: (uri: string, signal?: AbortSignal) => Promise<string | null>;
  probeDimensions?: (
    path: string,
    signal: AbortSignal,
  ) => Promise<{ width: number; height: number } | null>;
  signal?: AbortSignal;
  /** Test-injectable hard deadline; callers may shorten but never extend it. */
  preflightTimeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_OUTPUT_LIMIT = 64 * 1024;
const MAX_DIMENSION_PROBES = 2;
const MAX_MLT_RESOURCES = 512;
const MAX_PREFLIGHT_TIMEOUT_MS = 120_000;

function namedError(name: 'AbortError' | 'TimeoutError', message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : namedError('AbortError', 'MLT media preflight cancelled');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function preflightDeadline(
  external: AbortSignal | undefined,
  requestedTimeoutMs: number | undefined,
): { signal: AbortSignal; dispose: () => void } {
  const timeoutMs = requestedTimeoutMs ?? MAX_PREFLIGHT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_PREFLIGHT_TIMEOUT_MS) {
    throw new Error(`MLT media preflightTimeoutMs must be an integer from 1 to ${MAX_PREFLIGHT_TIMEOUT_MS}`);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(namedError('AbortError', 'MLT media preflight cancelled'));
  if (external?.aborted) cancel();
  else external?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    controller.abort(namedError('TimeoutError', `MLT media preflight timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', cancel);
    },
  };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolveOperation, rejectOperation) => {
    const aborted = () => {
      cleanup();
      rejectOperation(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(
      (value) => { cleanup(); resolveOperation(value); },
      (error: unknown) => { cleanup(); rejectOperation(error); },
    );
  });
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function uploadRoots(): Promise<string[]> {
  const roots = await Promise.all([...new Set([uploadDir(), DEFAULT_UPLOAD_DIR])].map(async (root) => {
    try { return await realpath(root); } catch { return null; }
  }));
  return roots.filter((root): root is string => root !== null);
}

async function probeVisualDimensions(
  path: string,
  signal: AbortSignal,
): Promise<{ width: number; height: number } | null> {
  throwIfAborted(signal);
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(ffprobeBin(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,sample_aspect_ratio:stream_side_data=rotation', '-of', 'json', path,
    ], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: mltProbeEnvironment(),
      signal,
      killSignal: 'SIGKILL',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const aborted = () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(abortReason(signal));
    };
    const finish = (error?: Error, value: { width: number; height: number } | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      if (error) rejectProbe(error);
      else resolveProbe(value);
    };
    const collect = (chunk: Buffer, target: Buffer[]) => {
      bytes += chunk.length;
      if (bytes > PROBE_OUTPUT_LIMIT) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish(new Error('ffprobe dimension output exceeded its limit'));
        return;
      }
      target.push(chunk);
    };
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(new Error('ffprobe dimension probe timed out'));
    }, PROBE_TIMEOUT_MS);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, stdout));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, stderr));
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`ffprobe dimension probe failed: ${Buffer.concat(stderr).toString('utf8').trim().slice(-300)}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8')) as {
          streams?: Array<{
            width?: unknown;
            height?: unknown;
            sample_aspect_ratio?: unknown;
            side_data_list?: Array<{ rotation?: unknown }>;
          }>;
        };
        const stream = parsed.streams?.[0];
        const sampleAspectRatio = String(stream?.sample_aspect_ratio ?? '1:1');
        if (sampleAspectRatio !== '1:1' && sampleAspectRatio !== 'N/A') {
          finish(undefined, null);
          return;
        }
        let width = Number(stream?.width);
        let height = Number(stream?.height);
        const rotation = Number(stream?.side_data_list?.find((entry) => Number.isFinite(Number(entry.rotation)))?.rotation ?? 0);
        if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
        finish(undefined, Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
          ? { width, height }
          : null);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function uploadName(uri: string): string | null {
  const match = /^\/media\/uploads\/([^/?#]+)(?:[?#].*)?$/.exec(uri);
  if (!match) return null;
  try {
    const name = decodeURIComponent(match[1]);
    return isSafeUploadName(name) ? name : null;
  } catch {
    return null;
  }
}

async function verifiedFile(path: string | null): Promise<string | null> {
  if (!path) return null;
  try {
    const actual = await realpath(path);
    return (await stat(actual)).isFile() ? actual : null;
  } catch {
    return null;
  }
}

/**
 * Resolve only the two local URI namespaces owned by CutAI. HTTP(S), file URLs,
 * arbitrary absolute paths, and traversal attempts never reach melt.
 */
export async function resolveMltMediaUri(
  uri: string,
  options: ResolveMltMediaOptions = {},
): Promise<string> {
  if (options.signal) throwIfAborted(options.signal);
  const name = uploadName(uri);
  const candidate = name
    ? options.resolveUpload
      ? options.resolveUpload(name)
      : resolveUploadFile(name)
    : uri.startsWith('/workspace-media/')
      ? await (options.resolveWorkspace ?? resolveWorkspaceMediaFile)(uri, options.signal)
      : null;
  if (options.signal) throwIfAborted(options.signal);
  const resolved = await verifiedFile(candidate);
  if (!resolved) throw new Error(`MLT media URI is not a registered local file: ${uri}`);
  if (name && !options.resolveUpload) {
    const roots = await uploadRoots();
    if (!roots.some((root) => contained(root, resolved))) {
      throw new Error(`MLT upload URI resolves outside registered upload directories: ${uri}`);
    }
  }
  return resolved;
}

/** Resolve each logical source once while preserving the original URI key. */
export async function resolveMltTimelineResources(
  timeline: NeutralTimelineV1,
  options: ResolveMltMediaOptions = {},
): Promise<ResolvedMltResource[]> {
  const deadline = preflightDeadline(options.signal, options.preflightTimeoutMs);
  const signal = deadline.signal;
  try {
    throwIfAborted(signal);
    const uris = new Set<string>();
    for (const track of timeline.tracks) {
      if (!track.enabled) continue;
      for (const clip of track.clips) {
        if (clip.source?.uri) uris.add(clip.source.uri);
        if (clip.source?.alternateAudioUri) uris.add(clip.source.alternateAudioUri);
      }
    }
    const visualUris = new Set(timeline.tracks.flatMap((track) => track.enabled
      ? track.clips.flatMap((clip) => (
        (clip.kind === 'video' || clip.kind === 'image') && clip.source?.uri ? [clip.source.uri] : []
      ))
      : []));
    const orderedUris = [...uris].sort();
    if (orderedUris.length > MAX_MLT_RESOURCES) {
      throw new Error(`MLT export supports at most ${MAX_MLT_RESOURCES} unique local resources per job`);
    }
    const resolved = await abortable(Promise.all(orderedUris.map(async (uri) => ({
      uri,
      absolutePath: await resolveMltMediaUri(uri, { ...options, signal }),
    }))), signal);
    const result: ResolvedMltResource[] = new Array(resolved.length);
    const dimensionsByPath = new Map<string, Promise<{ width: number; height: number } | null>>();
    let next = 0;
    const worker = async () => {
      while (next < resolved.length) {
        throwIfAborted(signal);
        const index = next++;
        const resource = resolved[index]!;
        let dimensions: { width: number; height: number } | null = null;
        if (visualUris.has(resource.uri)) {
          let pending = dimensionsByPath.get(resource.absolutePath);
          if (!pending) {
            pending = (options.probeDimensions ?? probeVisualDimensions)(resource.absolutePath, signal);
            dimensionsByPath.set(resource.absolutePath, pending);
          }
          dimensions = await abortable(pending, signal);
        }
        result[index] = { ...resource, ...(dimensions ?? {}) };
      }
    };
    await abortable(
      Promise.all(Array.from({ length: Math.min(MAX_DIMENSION_PROBES, resolved.length) }, worker)),
      signal,
    );
    throwIfAborted(signal);
    return result;
  } finally {
    deadline.dispose();
  }
}
