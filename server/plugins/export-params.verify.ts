// 导出分辨率/帧率参数检查:短边缩放、夹取、视频专用校验。
// 跑法:npx tsx server/plugins/export-params.verify.ts（已接入 npm test）。
import assert from 'node:assert/strict';
import { exportScale, validateVideoParams } from './export.ts';
import { planExport } from './export-plan.ts';

// 短边对齐:1080p 时间线 → 480p = 480/1080;竖屏 1080×1920 → 720p 用短边 1080
assert.equal(exportScale({ width: 1920, height: 1080 }, '480p'), 480 / 1080);
assert.equal(exportScale({ width: 1080, height: 1920 }, '720p'), 720 / 1080);
assert.equal(exportScale({ width: 1920, height: 1080 }, '1080p'), 1);
assert.equal(exportScale({ width: 1920, height: 1080 }, undefined), 1, '省略=不缩放');
// 720 时间线选 1080p = 放大 1.5(允许);夹取上限 4
assert.equal(exportScale({ width: 1280, height: 720 }, '1080p'), 1.5);
assert.equal(exportScale({ width: 100, height: 100 }, '1080p'), 4, '上限夹 4');

validateVideoParams({ resolution: '720p', fps: 60 }, 'video');
validateVideoParams(null, 'audio');
assert.throws(() => validateVideoParams({ resolution: '720p' }, 'audio'), /video exports only/);
assert.throws(() => validateVideoParams({ fps: 60 }, 'audio'), /video exports only/);
assert.throws(() => validateVideoParams({ resolution: '4k' }, 'video'), /480p, 720p, or 1080p/);
assert.throws(() => validateVideoParams({ fps: 29.97 }, 'video'), /24, 25, 30, 50, or 60/);

const state = { fps: 30, width: 1920, height: 1080, items: [] };
const neutralTimeline = {
  schema: 'cutai-neutral-timeline',
  version: 1,
  frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 1920, height: 1080, fit: 'contain' },
  durationFrames: 30,
  tracks: [],
  transitions: [],
  diagnostics: [],
} as const;
assert.equal(planExport({ state }).backend, 'remotion', 'omitting backend must retain Remotion');
const mltPlan = planExport({ backend: 'mlt-experimental', neutralTimeline });
assert.equal(mltPlan.backend, 'mlt-experimental');
assert.equal(mltPlan.neutralTimeline, neutralTimeline, 'the validated neutral boundary reaches the render plan');
assert.deepEqual(
  { fps: (mltPlan.state as typeof state).fps, width: (mltPlan.state as typeof state).width, height: (mltPlan.state as typeof state).height },
  { fps: 30, width: 1920, height: 1080 },
  'MLT render metadata must be derived from its one authoritative neutral timeline',
);
assert.equal(
  planExport({ backend: 'mlt-experimental', neutralTimeline, fps: 30 }).retimeFps,
  undefined,
  'the source fps is allowed without retiming',
);
assert.throws(
  () => planExport({ state, backend: 'unknown' as never }),
  /backend must be remotion or mlt-experimental/,
);
assert.throws(
  () => planExport({
    backend: 'mlt-experimental',
    neutralTimeline: { ...neutralTimeline, canvas: { ...neutralTimeline.canvas, width: 1e100 } },
  }),
  /neutralTimeline is invalid/,
);
assert.throws(
  () => planExport({
    backend: 'mlt-experimental',
    neutralTimeline: { ...neutralTimeline, canvas: { ...neutralTimeline.canvas, width: 20_000 } },
  }),
  /canvas dimensions must not exceed/,
);
assert.throws(
  () => planExport({
    backend: 'mlt-experimental',
    neutralTimeline: { ...neutralTimeline, canvas: { ...neutralTimeline.canvas, width: 16_384, height: 16_384 } },
  }),
  /canvas area must not exceed 33177600 pixels/,
);
assert.throws(
  () => planExport({
    backend: 'mlt-experimental',
    neutralTimeline: { ...neutralTimeline, durationFrames: 30 * 60 * 60 + 1 },
  }),
  /duration must not exceed 3600 seconds/,
);
const activeTracks = Array.from({ length: 17 }, (_, index) => ({
  id: `video-${index}`,
  order: index,
  kind: 'video' as const,
  enabled: true,
  muted: false,
  locked: false,
  clips: [{
    id: `clip-${index}`,
    name: `clip-${index}`,
    kind: 'video' as const,
    startFrame: 0,
    durationFrames: 30,
    source: {
      uri: `/media/uploads/clip-${index}.mp4`,
      width: 1920,
      height: 1080,
      sourceInFrame: 0,
      playbackRate: 1,
    },
  }],
}));
assert.throws(
  () => planExport({ backend: 'mlt-experimental', neutralTimeline: { ...neutralTimeline, tracks: activeTracks } }),
  /must not exceed 16 active media tracks/,
);
assert.throws(
  () => planExport({
    backend: 'mlt-experimental',
    neutralTimeline: {
      ...neutralTimeline,
      canvas: { ...neutralTimeline.canvas, width: 7680, height: 4320 },
      tracks: activeTracks.slice(0, 3),
    },
  }),
  /canvas area multiplied by active media tracks must not exceed 67108864/,
);
assert.doesNotThrow(() => planExport({
  backend: 'mlt-experimental',
  neutralTimeline: { ...neutralTimeline, frameRate: { numerator: 2_147_483_647, denominator: 2_147_483_647 } },
}));
assert.doesNotThrow(() => planExport({
  backend: 'mlt-experimental',
  neutralTimeline: { ...neutralTimeline, frameRate: { numerator: 30_000, denominator: 1_001 } },
}));
for (const frameRate of [
  { numerator: 2_147_483_648, denominator: 1 },
  { numerator: 1, denominator: 2_147_483_648 },
]) {
  assert.throws(
    () => planExport({ backend: 'mlt-experimental', neutralTimeline: { ...neutralTimeline, frameRate } }),
    /frameRate numerator\/denominator must not exceed 2147483647/,
  );
}
for (const frameRate of [{ numerator: 241, denominator: 1 }, { numerator: 1, denominator: 2 }]) {
  assert.throws(
    () => planExport({ backend: 'mlt-experimental', neutralTimeline: { ...neutralTimeline, frameRate } }),
    /frameRate must be between 1 and 240 fps/,
  );
}
assert.throws(
  () => planExport({ backend: 'mlt-experimental', neutralTimeline, format: 'audio' }),
  /supports video exports only/,
);
assert.throws(
  () => planExport({ backend: 'mlt-experimental', neutralTimeline, codec: 'vp8' }),
  /supports codec=h264 only/,
);
assert.throws(
  () => planExport({ backend: 'mlt-experimental', neutralTimeline, resolution: '1080p' }),
  /supports original resolution only/,
);
assert.throws(
  () => planExport({ backend: 'mlt-experimental', neutralTimeline, fps: 60 }),
  /supports original timeline fps only/,
);
assert.throws(
  () => planExport({ backend: 'mlt-experimental' }),
  /requires neutralTimeline/,
);
assert.throws(
  () => planExport({ backend: 'mlt-experimental', neutralTimeline: {} as never }),
  /neutralTimeline is invalid: Invalid NeutralTimelineV1/,
);
assert.throws(
  () => planExport({ backend: 'mlt-experimental', neutralTimeline, startFrame: 0 }),
  /does not support ranged exports/,
);
assert.throws(
  () => planExport({
    backend: 'mlt-experimental',
    state: {
      fps: 30, width: 1920, height: 1080,
      items: [{ startFrame: 0, durationInFrames: 30 }],
    },
    neutralTimeline,
  }),
  /only timeline source; omit state/,
  'MLT must reject a second, potentially stale or contradictory state representation',
);

console.log('export params verification passed');
