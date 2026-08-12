import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeutralTimelineV1 } from '../../shared/neutral-timeline.ts';
import { resolveMltMediaUri, resolveMltTimelineResources } from './media-resolver.ts';

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const aborted = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
}

const directory = await mkdtemp(join(tmpdir(), 'cutai-mlt-media-'));
const upload = join(directory, '中文 素材.mp4');
const workspace = join(directory, 'workspace.mp4');
await writeFile(upload, 'upload');
await writeFile(workspace, 'workspace');

const options = {
  resolveUpload: (name: string) => name === '中文 素材.mp4' ? upload : null,
  resolveWorkspace: async (uri: string) => uri === '/workspace-media/p/workspace.mp4' ? workspace : null,
  probeDimensions: async () => ({ width: 1280, height: 720 }),
};

assert.equal(
  await resolveMltMediaUri('/media/uploads/%E4%B8%AD%E6%96%87%20%E7%B4%A0%E6%9D%90.mp4', options),
  await realpath(upload),
);
assert.equal(await resolveMltMediaUri('/workspace-media/p/workspace.mp4', options), await realpath(workspace));
for (const uri of [
  'https://example.com/video.mp4',
  'file:///C:/secret.mp4',
  'C:\\secret.mp4',
  '/media/uploads/..%2Fsecret.mp4',
  '/media/uploads/missing.mp4',
]) {
  await assert.rejects(() => resolveMltMediaUri(uri, options), /not a registered local file/);
}

const timeline = {
  schema: 'cutai-neutral-timeline', version: 1,
  frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 1280, height: 720, fit: 'contain' }, durationFrames: 30,
  tracks: [{
    id: 'V1', order: 0, kind: 'video', enabled: true, muted: false, locked: false,
    clips: [
      { id: 'a', name: 'a', kind: 'video', startFrame: 0, durationFrames: 15, source: { uri: '/workspace-media/p/workspace.mp4', sourceInFrame: 0, playbackRate: 1 } },
      { id: 'b', name: 'b', kind: 'video', startFrame: 15, durationFrames: 15, source: { uri: '/media/uploads/%E4%B8%AD%E6%96%87%20%E7%B4%A0%E6%9D%90.mp4', sourceInFrame: 0, playbackRate: 1 } },
    ],
  }, {
    id: 'disabled', order: 1, kind: 'video', enabled: false, muted: false, locked: false,
    clips: [{
      id: 'ignored', name: 'ignored', kind: 'video', startFrame: 0, durationFrames: 30,
      source: { uri: 'https://example.com/disabled.mp4', sourceInFrame: 0, playbackRate: 1 },
    }],
  }], transitions: [], diagnostics: [],
} satisfies NeutralTimelineV1;
const resources = await resolveMltTimelineResources(timeline, options);
assert.deepEqual(resources.map((resource) => resource.uri), [
  '/media/uploads/%E4%B8%AD%E6%96%87%20%E7%B4%A0%E6%9D%90.mp4',
  '/workspace-media/p/workspace.mp4',
]);
assert.ok(resources.every((resource) => resource.width === 1280 && resource.height === 720));

let active = 0;
let maxActive = 0;
const manyTimeline = structuredClone(timeline);
manyTimeline.tracks[0]!.clips = Array.from({ length: 8 }, (_, index) => ({
  id: `clip-${index}`, name: `clip-${index}`, kind: 'video' as const,
  startFrame: index * 3, durationFrames: 3,
  source: { uri: `/media/uploads/probe-${index}.mp4`, sourceInFrame: 0, playbackRate: 1 },
}));
await Promise.all(Array.from({ length: 8 }, (_, index) => writeFile(join(directory, `probe-${index}.mp4`), 'probe')));
await resolveMltTimelineResources(manyTimeline, {
  resolveUpload: (name) => join(directory, name),
  resolveWorkspace: options.resolveWorkspace,
  probeDimensions: async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return { width: 1280, height: 720 };
  },
});
assert.ok(maxActive <= 2, `dimension probe concurrency must be bounded, observed ${maxActive}`);

const sharedPhysicalFile = join(directory, 'shared-physical.mp4');
await writeFile(sharedPhysicalFile, 'shared');
const deduplicatedTimeline = structuredClone(timeline);
deduplicatedTimeline.tracks[0]!.clips = [
  {
    id: 'alias-a', name: 'alias-a', kind: 'video', startFrame: 0, durationFrames: 15,
    source: { uri: '/media/uploads/alias-a.mp4', sourceInFrame: 0, playbackRate: 1 },
  },
  {
    id: 'alias-b', name: 'alias-b', kind: 'video', startFrame: 15, durationFrames: 15,
    source: { uri: '/media/uploads/alias-b.mp4', sourceInFrame: 0, playbackRate: 1 },
  },
];
let deduplicatedProbeCalls = 0;
const deduplicated = await resolveMltTimelineResources(deduplicatedTimeline, {
  resolveUpload: () => sharedPhysicalFile,
  probeDimensions: async () => {
    deduplicatedProbeCalls += 1;
    return { width: 1280, height: 720 };
  },
});
assert.equal(deduplicated.length, 2);
assert.equal(deduplicatedProbeCalls, 1, 'aliases of one physical file must share one dimension probe');

const cancelController = new AbortController();
let cancelProbeSignal: AbortSignal | undefined;
let markCancelProbeStarted: (() => void) | undefined;
const cancelProbeStarted = new Promise<void>((resolve) => { markCancelProbeStarted = resolve; });
const cancelledPreflight = resolveMltTimelineResources(timeline, {
  ...options,
  signal: cancelController.signal,
  preflightTimeoutMs: 1_000,
  probeDimensions: async (_path, signal) => {
    cancelProbeSignal = signal;
    markCancelProbeStarted?.();
    return waitForAbort(signal);
  },
});
await cancelProbeStarted;
cancelController.abort();
await assert.rejects(
  cancelledPreflight,
  (error: unknown) => error instanceof Error
    && error.name === 'AbortError'
    && /preflight cancelled/.test(error.message),
);
assert.equal(cancelProbeSignal?.aborted, true, 'external cancellation must reach active dimension probes');

let timeoutProbeSignal: AbortSignal | undefined;
const timeoutStartedAt = Date.now();
await assert.rejects(
  resolveMltTimelineResources(timeline, {
    ...options,
    preflightTimeoutMs: 100,
    probeDimensions: async (_path, signal) => {
      timeoutProbeSignal = signal;
      return waitForAbort(signal);
    },
  }),
  (error: unknown) => error instanceof Error
    && error.name === 'TimeoutError'
    && /timed out after 100 ms/.test(error.message),
);
assert.equal(timeoutProbeSignal?.aborted, true, 'the total deadline must abort active dimension probes');
assert.ok(Date.now() - timeoutStartedAt < 1_000, 'the injected total deadline must settle promptly');

console.log('MLT media resolver checks passed');
