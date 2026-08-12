import assert from 'node:assert/strict';
import { TaskLimiter } from '../task-limiter.ts';
import {
  cancelGenerationJob, createGenerationJob, deleteGenerationJob, getGenerationJobSnapshot, resumeGenerationJobDownload,
} from './generation-jobs.ts';
import { pickMurekaAudioUrl } from './music.ts';
import { ResultDownloadError } from './result-download.ts';

const success = createGenerationJob({ kind: 'music' }, async (jobId, update) => {
  update({ phase: 'rendering', progress: 63, processedFrames: 63, totalFrames: 100 });
  const running = getGenerationJobSnapshot(jobId);
  assert.equal(running?.status, 'running');
  assert.equal(running?.phase, 'rendering');
  assert.equal(running?.progress, 63);
  assert.equal(running?.processedFrames, 63);
  assert.equal(running?.totalFrames, 100);
  return {
    assetId: jobId,
    kind: 'audio',
    name: 'check music',
    path: '/media/uploads/check.mp3',
    durationSeconds: 1,
  };
});
assert.equal(getGenerationJobSnapshot(success.jobId)?.status, 'queued');

await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
const completed = getGenerationJobSnapshot(success.jobId);
assert.equal(completed?.status, 'succeeded');
assert.equal(completed?.phase, 'completed');
assert.equal(completed?.progress, 100);
assert.equal(completed?.processedFrames, 100);
assert.equal(completed?.result?.assetId, success.jobId);
assert.deepEqual(completed?.results?.map((item) => item.assetId), [success.jobId]);

const multiple = createGenerationJob({ kind: 'music' }, async (id) => [
  { assetId: `${id}:1`, kind: 'audio', name: 'one', path: '/one.mp3', durationSeconds: 1 },
  { assetId: `${id}:2`, kind: 'audio', name: 'two', path: '/two.mp3', durationSeconds: 1 },
]);
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(getGenerationJobSnapshot(multiple.jobId)?.result?.assetId, `${multiple.jobId}:1`);
assert.equal(getGenerationJobSnapshot(multiple.jobId)?.results?.length, 2);

const cleanedPaths: string[] = [];
const cleanupResult = (id: string) => ({
  assetId: id,
  kind: 'video' as const,
  name: id,
  path: `/media/uploads/${id}.mp4`,
  durationSeconds: 1,
});
const removable = createGenerationJob({ kind: 'export' }, async (id) => cleanupResult(id), {
  cleanupResult: async (generated) => { cleanedPaths.push(generated.path); },
});
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(await deleteGenerationJob(removable.jobId), true);
assert.equal(getGenerationJobSnapshot(removable.jobId), undefined);
assert.deepEqual(cleanedPaths, [`/media/uploads/${removable.jobId}.mp4`]);
assert.equal(await deleteGenerationJob(removable.jobId), false, 'job cleanup must be idempotent');

const expiring = createGenerationJob({ kind: 'export' }, async (id) => cleanupResult(id), {
  cleanupResult: async (generated) => { cleanedPaths.push(`expired:${generated.path}`); },
  retentionMs: 10,
});
await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
assert.equal(getGenerationJobSnapshot(expiring.jobId), undefined, 'expired jobs must be evicted automatically');
assert.ok(cleanedPaths.includes(`expired:/media/uploads/${expiring.jobId}.mp4`), 'expiry must dispose the result file');

const failure = createGenerationJob({ kind: 'video' }, async () => { throw new Error('expected failure'); });
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(getGenerationJobSnapshot(failure.jobId)?.status, 'failed');
assert.equal(getGenerationJobSnapshot(failure.jobId)?.phase, 'failed');
assert.equal(getGenerationJobSnapshot(failure.jobId)?.error, 'expected failure');

let cancelledSignal: AbortSignal | undefined;
const cancellable = createGenerationJob({ kind: 'export' }, async (_id, _update, _download, signal) => {
  cancelledSignal = signal;
  await new Promise<void>((resolvePromise) => signal.addEventListener('abort', () => resolvePromise(), { once: true }));
  throw new DOMException('cancelled', 'AbortError');
});
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(cancelGenerationJob(cancellable.jobId), true);
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(cancelledSignal?.aborted, true);
assert.equal(getGenerationJobSnapshot(cancellable.jobId)?.status, 'cancelled');
assert.equal(getGenerationJobSnapshot(cancellable.jobId)?.phase, 'cancelled');
assert.equal(cancelGenerationJob(cancellable.jobId), false, 'terminal cancellation is idempotent');

let releaseLateResult: (() => void) | undefined;
const lateResultGate = new Promise<void>((resolve) => { releaseLateResult = resolve; });
const lateCleanup: string[] = [];
const cancelledAfterReturn = createGenerationJob({ kind: 'export' }, async (id) => {
  await lateResultGate;
  return cleanupResult(id);
}, {
  cleanupResult: async (generated) => { lateCleanup.push(generated.path); },
});
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(cancelGenerationJob(cancelledAfterReturn.jobId), true);
releaseLateResult?.();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(getGenerationJobSnapshot(cancelledAfterReturn.jobId)?.status, 'cancelled');
assert.deepEqual(
  lateCleanup,
  [`/media/uploads/${cancelledAfterReturn.jobId}.mp4`],
  'a result returned after cancellation must be disposed immediately instead of leaking until the stale sweep',
);

let downloadAttempts = 0;
const resumable = createGenerationJob({ kind: 'video' }, async (id, _update, registerDownload) => {
  const download = async () => {
    downloadAttempts += 1;
    if (downloadAttempts === 1) throw new ResultDownloadError('https://cdn.example/result.mp4', 'network');
    return cleanupResult(id);
  };
  registerDownload('https://cdn.example/result.mp4', download);
  return download();
});
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(getGenerationJobSnapshot(resumable.jobId)?.pendingDownloadUrl, 'https://cdn.example/result.mp4');
assert.equal(await resumeGenerationJobDownload(resumable.jobId), true);
assert.equal(getGenerationJobSnapshot(resumable.jobId)?.status, 'succeeded');
assert.equal(downloadAttempts, 2, 'resume must retry only the download callback');

const limiter = new TaskLimiter(1);
let finishFirst: (() => void) | undefined;
const firstBlocked = new Promise<void>((resolve) => { finishFirst = resolve; });
const result = (id: string) => ({
  assetId: id,
  kind: 'video' as const,
  name: id,
  path: `/media/uploads/${id}.mp4`,
  durationSeconds: 1,
});
const first = createGenerationJob({ kind: 'export' }, async (id) => {
  await firstBlocked;
  return result(id);
}, { acquire: () => limiter.acquire() });
const second = createGenerationJob({ kind: 'export' }, async (id) => result(id), {
  acquire: () => limiter.acquire(),
});
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(getGenerationJobSnapshot(first.jobId)?.status, 'running');
assert.equal(getGenerationJobSnapshot(second.jobId)?.status, 'queued');
assert.equal(cancelGenerationJob(second.jobId), true, 'queued jobs must be cancellable before their permit arrives');
assert.deepEqual(limiter.snapshot(), { active: 1, queued: 1, limit: 1 });
const realNow = Date.now;
Date.now = () => realNow() + 2 * 60 * 60_000;
createGenerationJob({ kind: 'cleanup-trigger' }, async (id) => result(id));
Date.now = realNow;
assert.equal(getGenerationJobSnapshot(second.jobId)?.status, 'queued', 'cancelled queued job remains queued until permit wait unwinds');
finishFirst?.();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
assert.equal(getGenerationJobSnapshot(first.jobId)?.status, 'succeeded');
assert.equal(getGenerationJobSnapshot(second.jobId)?.status, 'cancelled');
assert.deepEqual(limiter.snapshot(), { active: 0, queued: 0, limit: 1 });

const retainedCleanup: string[] = [];
const retainedIds: string[] = [];
for (let index = 0; index < 130; index += 1) {
  const retained = createGenerationJob({ kind: 'retention-check', index }, async (id) => result(id), {
    cleanupResult: async (generated) => { retainedCleanup.push(generated.path); },
  });
  retainedIds.push(retained.jobId);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}
assert.equal(getGenerationJobSnapshot(retainedIds[0]!), undefined, 'the oldest terminal job must be evicted at the total retention cap');
assert.equal(getGenerationJobSnapshot(retainedIds.at(-1)!)?.status, 'succeeded');
assert.ok(retainedCleanup.length > 0, 'retention eviction must dispose generated artifacts');

assert.equal(pickMurekaAudioUrl({ choices: [{ audio_url: 'audio' }] }), 'audio');
assert.equal(pickMurekaAudioUrl({ choices: [{ url: 'url' }] }), 'url');
assert.equal(pickMurekaAudioUrl({ choices: [{ wav_url: 'wav' }] }), 'wav');
assert.equal(pickMurekaAudioUrl({ choices: [{ flac_url: 'flac' }] }), 'flac');

console.log('generation checks passed');
