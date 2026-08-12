import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { ResultDownloadError } from './result-download.ts';

export type GenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface GenerationResult {
  assetId: string;
  kind: 'audio' | 'video' | 'image';
  name: string;
  path: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Offset of a ranged export within the source timeline. */
  sourceStartSeconds?: number;
  // 导出/渲染 job 复用同一队列：可选字段，让渲染产物自描述大小与编码（生成类 job 不填）。
  sizeBytes?: number;
  codec?: string;
}

interface GenerationJob {
  id: string;
  status: GenerationJobStatus;
  progress: number;
  phase?: string;
  processedFrames?: number;
  totalFrames?: number;
  params: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  result?: GenerationResult;
  results?: GenerationResult[];
  error?: string;
  /** 成品已生成但没取回来时,供应商给的结果 URL(见 catch 分支)。 */
  pendingDownloadUrl?: string;
  resumeDownload?: () => Promise<GenerationResult | GenerationResult[]>;
  resumeDownloadUrl?: string;
  cleanupResult?: (result: GenerationResult) => Promise<void> | void;
  retentionMs: number;
  expiryTimer?: NodeJS.Timeout;
  abortController: AbortController;
}

export interface GenerationJobSnapshot {
  id: string;
  status: GenerationJobStatus;
  progress: number;
  phase?: string;
  processedFrames?: number;
  totalFrames?: number;
  params: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  result?: GenerationResult;
  results?: GenerationResult[];
  error?: string;
  /**
   * 生成成功但下载失败时,供应商的结果 URL。钱已经花了,成品也确实存在,只是没取回来
   * ——把它交出去,用户/Agent 还能自己取,不必重新生成一遍。
   */
  pendingDownloadUrl?: string;
}

export interface GenerationJobProgress {
  progress?: number;
  phase?: string;
  processedFrames?: number;
  totalFrames?: number;
}

export type UpdateGenerationJob = (progress: GenerationJobProgress) => void;
export type RegisterGenerationDownload = (
  url: string,
  resume: () => Promise<GenerationResult | GenerationResult[]>,
) => void;

export interface GenerationJobOptions {
  /** Keep the job queued until a permit for expensive local work is available. */
  acquire?: () => Promise<() => void>;
  /** Dispose temporary output when a terminal job is deleted or expires. */
  cleanupResult?: (result: GenerationResult) => Promise<void> | void;
  /** Terminal-job retention window. Override only for focused tests. */
  retentionMs?: number;
}

const jobs = new Map<string, GenerationJob>();
const TERMINAL = new Set<GenerationJobStatus>(['succeeded', 'failed', 'cancelled']);
const MAX_NONTERMINAL_JOBS = 32;
const MAX_RETAINED_JOBS = 128;
const MAX_JOB_AGE_MS = 60 * 60_000;

function cleanOldJobs() {
  const cutoff = Date.now() - MAX_JOB_AGE_MS;
  for (const [id, job] of jobs) {
    if (TERMINAL.has(job.status) && job.updatedAt < cutoff) void evictTerminalJob(id);
  }
}

function normalizeRetentionMs(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : MAX_JOB_AGE_MS;
}

function abortError(): DOMException {
  return new DOMException('Job cancelled', 'AbortError');
}

async function acquireJobPermit(
  acquire: GenerationJobOptions['acquire'],
  signal: AbortSignal,
): Promise<(() => void) | undefined> {
  if (!acquire) return undefined;
  if (signal.aborted) throw abortError();
  return new Promise((resolvePermit, rejectPermit) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      rejectPermit(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void acquire().then((release) => {
      signal.removeEventListener('abort', onAbort);
      if (settled || signal.aborted) {
        release();
        if (!settled) rejectPermit(abortError());
        return;
      }
      settled = true;
      resolvePermit(release);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      rejectPermit(error);
    });
  });
}

function scheduleExpiry(job: GenerationJob): void {
  if (!TERMINAL.has(job.status)) return;
  if (job.expiryTimer) clearTimeout(job.expiryTimer);
  job.expiryTimer = setTimeout(() => { void evictTerminalJob(job.id); }, job.retentionMs);
  job.expiryTimer.unref?.();
}

async function evictTerminalJob(jobId: string): Promise<boolean> {
  const job = jobs.get(jobId);
  if (!job || !TERMINAL.has(job.status)) return false;
  jobs.delete(jobId);
  if (job.expiryTimer) clearTimeout(job.expiryTimer);
  if (job.results?.length && job.cleanupResult) {
    try {
      await Promise.all(job.results.map((result) => job.cleanupResult!(result)));
    } catch (error) {
      console.warn(`[generation-job] failed to clean result for ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return true;
}

function applyProgress(job: GenerationJob, next: GenerationJobProgress): void {
  if (TERMINAL.has(job.status)) return;
  if (next.progress !== undefined && Number.isFinite(next.progress)) {
    job.progress = Math.max(job.progress, Math.min(99, Math.max(0, next.progress)));
  }
  if (next.phase !== undefined) job.phase = next.phase;
  if (next.totalFrames !== undefined && Number.isFinite(next.totalFrames)) {
    job.totalFrames = Math.max(0, Math.floor(next.totalFrames));
  }
  if (next.processedFrames !== undefined && Number.isFinite(next.processedFrames)) {
    const processed = Math.max(0, Math.floor(next.processedFrames));
    job.processedFrames = job.totalFrames === undefined ? processed : Math.min(job.totalFrames, processed);
  }
  job.updatedAt = Date.now();
}

function completeGenerationJob(job: GenerationJob, returned: GenerationResult | GenerationResult[]): void {
  job.results = Array.isArray(returned) ? returned : [returned];
  job.result = job.results[0];
  job.status = 'succeeded';
  job.progress = 100;
  job.phase = 'completed';
  job.error = undefined;
  job.pendingDownloadUrl = undefined;
  job.resumeDownload = undefined;
  job.resumeDownloadUrl = undefined;
  if (job.totalFrames !== undefined) job.processedFrames = job.totalFrames;
}

async function cleanupReturnedResults(
  job: GenerationJob,
  returned: GenerationResult | GenerationResult[],
): Promise<void> {
  if (!job.cleanupResult) return;
  const results = Array.isArray(returned) ? returned : [returned];
  try {
    await Promise.all(results.map((generated) => job.cleanupResult!(generated)));
  } catch (error) {
    console.warn(`[generation-job] failed to clean cancelled result for ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function failGenerationJob(job: GenerationJob, error: unknown): void {
  job.status = 'failed';
  job.error = error instanceof Error ? error.message : String(error);
  job.pendingDownloadUrl = error instanceof ResultDownloadError ? error.url : job.resumeDownloadUrl;
  job.progress = 100;
  job.phase = 'failed';
}

async function runGenerationJob(
  job: GenerationJob,
  task: (
    jobId: string,
    update: UpdateGenerationJob,
    registerDownload: RegisterGenerationDownload,
    signal: AbortSignal,
  ) => Promise<GenerationResult | GenerationResult[]>,
  options: GenerationJobOptions,
): Promise<void> {
  let release: (() => void) | undefined;
  try {
    release = await acquireJobPermit(options.acquire, job.abortController.signal);
    if (job.abortController.signal.aborted) throw abortError();
    job.status = 'running';
    job.progress = 10;
    job.phase = 'starting';
    job.updatedAt = Date.now();
    const returned = await task(job.id, (next) => applyProgress(job, next), (url, resume) => {
      job.resumeDownloadUrl = url;
      job.resumeDownload = resume;
    }, job.abortController.signal);
    if (job.abortController.signal.aborted) {
      await cleanupReturnedResults(job, returned);
      throw abortError();
    }
    completeGenerationJob(job, returned);
  } catch (error) {
    if (job.abortController.signal.aborted
      || (error instanceof DOMException && error.name === 'AbortError')) {
      job.status = 'cancelled';
      job.error = 'Job cancelled';
      job.progress = 100;
      job.phase = 'cancelled';
    } else failGenerationJob(job, error);
  } finally {
    job.updatedAt = Date.now();
    release?.();
    scheduleExpiry(job);
  }
}

export function createGenerationJob(
  params: Record<string, unknown>,
  task: (
    jobId: string,
    update: UpdateGenerationJob,
    registerDownload: RegisterGenerationDownload,
    signal: AbortSignal,
  ) => Promise<GenerationResult | GenerationResult[]>,
  options: GenerationJobOptions = {},
): { jobId: string; status: 'queued' } {
  cleanOldJobs();
  const nonterminalJobs = [...jobs.values()].filter((job) => !TERMINAL.has(job.status)).length;
  if (nonterminalJobs >= MAX_NONTERMINAL_JOBS) {
    throw new Error(`generation job limit reached (${MAX_NONTERMINAL_JOBS} queued or running jobs)`);
  }
  trimRetainedJobs();
  if (jobs.size >= MAX_RETAINED_JOBS) {
    throw new Error(`generation job retention limit reached (${MAX_RETAINED_JOBS} jobs)`);
  }
  const id = randomUUID();
  const now = Date.now();
  const job: GenerationJob = {
    id,
    status: 'queued',
    progress: 0,
    phase: 'queued',
    params,
    createdAt: now,
    updatedAt: now,
    cleanupResult: options.cleanupResult,
    retentionMs: normalizeRetentionMs(options.retentionMs),
    abortController: new AbortController(),
  };
  jobs.set(id, job);
  void runGenerationJob(job, task, options);
  return { jobId: id, status: 'queued' };
}

export async function resumeGenerationJobDownload(jobId: string): Promise<boolean> {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'failed' || !job.resumeDownload || !job.pendingDownloadUrl) return false;
  if (job.expiryTimer) clearTimeout(job.expiryTimer);
  job.status = 'running';
  job.progress = 99;
  job.phase = 'downloading';
  job.error = undefined;
  job.updatedAt = Date.now();
  try {
    completeGenerationJob(job, await job.resumeDownload());
    return true;
  } catch (error) {
    failGenerationJob(job, error);
    return false;
  } finally {
    job.updatedAt = Date.now();
    scheduleExpiry(job);
  }
}

export function getGenerationJobSnapshot(jobId: string): GenerationJobSnapshot | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    phase: job.phase,
    processedFrames: job.processedFrames,
    totalFrames: job.totalFrames,
    params: job.params,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    results: job.results,
    error: job.error,
    pendingDownloadUrl: job.pendingDownloadUrl,
  };
}

/** Remove a finished job after a one-shot consumer has downloaded its result. */
export function deleteGenerationJob(jobId: string): Promise<boolean> {
  return evictTerminalJob(jobId);
}

/** Request cancellation for queued/running local work. Terminal jobs are left for normal cleanup. */
export function cancelGenerationJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || TERMINAL.has(job.status)) return false;
  job.abortController.abort();
  job.updatedAt = Date.now();
  return true;
}

function trimRetainedJobs(): void {
  if (jobs.size < MAX_RETAINED_JOBS) return;
  const oldestTerminalJobs = [...jobs.values()]
    .filter((job) => TERMINAL.has(job.status))
    .sort((left, right) => left.updatedAt - right.updatedAt || left.createdAt - right.createdAt);
  while (jobs.size >= MAX_RETAINED_JOBS && oldestTerminalJobs.length) {
    void evictTerminalJob(oldestTerminalJobs.shift()!.id);
  }
}

interface ProgressRequest {
  action?: 'params' | 'status' | 'wait' | 'resume';
  target?: string;
  jobIds?: string[] | string;
  timeoutSeconds?: number;
}

async function readJson(req: IncomingMessage): Promise<ProgressRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 100_000) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProgressRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseJobIds(value: ProgressRequest['jobIds']): string[] {
  const ids = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function report(job: GenerationJob, action: ProgressRequest['action']) {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    phase: job.phase,
    processedFrames: job.processedFrames,
    totalFrames: job.totalFrames,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(action === 'params' ? { params: job.params } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.results && job.results.length > 1 ? { results: job.results } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.pendingDownloadUrl ? { pendingDownloadUrl: job.pendingDownloadUrl } : {}),
  };
}

const wait = (milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export function generationProgressPlugin(): Plugin {
  return {
    name: 'openchatcut-generation-progress',
    configureServer(server) {
      server.middlewares.use('/generate/progress', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          const input = await readJson(req);
          if (input.target !== 'generation') throw new Error('target must be generation');
          if (!input.action || !['params', 'status', 'wait', 'resume'].includes(input.action)) throw new Error('action must be params, status, wait, or resume');
          const jobIds = parseJobIds(input.jobIds);
          if (!jobIds.length) throw new Error('jobIds is required');
          const timeoutSeconds = input.timeoutSeconds ?? 90;
          if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 3600) throw new Error('timeoutSeconds must be between 0 and 3600');

          if (input.action === 'wait') {
            const deadline = Date.now() + timeoutSeconds * 1000;
            while (Date.now() < deadline) {
              const known = jobIds.map((id) => jobs.get(id));
              if (known.every((job) => !job || TERMINAL.has(job.status))) break;
              await wait(250);
            }
          }
          if (input.action === 'resume') {
            await Promise.all(jobIds.map((id) => resumeGenerationJobDownload(id)));
          }

          const reports = jobIds.map((id) => {
            const job = jobs.get(id);
            return job ? report(job, input.action) : { jobId: id, status: 'not_found', error: 'generation job not found' };
          });
          sendJson(res, 200, { target: 'generation', action: input.action, reports });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[generate:progress] ${message}`);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
