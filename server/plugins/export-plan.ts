import { normalizeFrameRange } from '../../src/export/range.ts';
import {
  EXPORT_FPS_OPTIONS,
  EXPORT_RESOLUTIONS,
  exportScale,
  type ExportResolution,
} from '../../src/export/mediaSettings.ts';
import { assertNeutralTimelineV1, type NeutralTimelineV1 } from '../../shared/neutral-timeline.ts';
import { sanitizeFileName } from '../file-name.ts';

export { EXPORT_FPS_OPTIONS, EXPORT_RESOLUTIONS, exportScale } from '../../src/export/mediaSettings.ts';
export type { ExportResolution } from '../../src/export/mediaSettings.ts';

export type ExportBackend = 'remotion' | 'mlt-experimental';

export type ExportRequest = {
  state?: unknown;
  backend?: ExportBackend;
  neutralTimeline?: NeutralTimelineV1;
  format?: 'video' | 'audio';
  codec?: 'h264' | 'vp8' | 'mp3' | 'wav';
  name?: string;
  startFrame?: number;
  endFrameExclusive?: number;
  startSeconds?: number;
  endSeconds?: number;
  resolution?: ExportResolution;
  fps?: number;
};

export type ExportTimeline = {
  fps: number;
  items: Array<{ startFrame: number; durationInFrames: number }>;
};

const MAX_MLT_CANVAS_DIMENSION = 16_384;
const MAX_MLT_CANVAS_PIXELS = 33_177_600;
const MAX_MLT_PROFILE_INTEGER = 2_147_483_647;
const MAX_MLT_FRAME_RATE = 240;
const MAX_MLT_DURATION_SECONDS = 60 * 60;
const MAX_MLT_TRACKS = 256;
const MAX_MLT_ACTIVE_MEDIA_TRACKS = 16;
const MAX_MLT_COMPOSITING_PIXELS = 67_108_864;
const MAX_MLT_CLIPS = 100_000;

export const EXPORT_MEDIA = {
  h264: { codec: 'h264', ext: 'mp4', mime: 'video/mp4' },
  vp8: { codec: 'vp8', ext: 'webm', mime: 'video/webm' },
  mp3: { codec: 'mp3', ext: 'mp3', mime: 'audio/mpeg' },
  wav: { codec: 'wav', ext: 'wav', mime: 'audio/wav' },
} as const;

export interface ExportPlan {
  state: unknown;
  backend: ExportBackend;
  neutralTimeline: NeutralTimelineV1 | undefined;
  format: 'video' | 'audio';
  media: (typeof EXPORT_MEDIA)[keyof typeof EXPORT_MEDIA];
  frameRange: [number, number] | undefined;
  totalFrames: number;
  filename: string;
  durationSeconds: number;
  scale: number;
  retimeFps: number | undefined;
}

class ExportRequestError extends Error {}

export function validateVideoParams(
  body: { resolution?: unknown; fps?: unknown } | null,
  format: 'video' | 'audio',
): void {
  if (body?.resolution !== undefined) {
    if (format !== 'video') throw new ExportRequestError('resolution applies to video exports only');
    if (typeof body.resolution !== 'string' || !(body.resolution in EXPORT_RESOLUTIONS)) {
      throw new ExportRequestError('resolution must be 480p, 720p, or 1080p');
    }
  }
  if (body?.fps !== undefined) {
    if (format !== 'video') throw new ExportRequestError('fps applies to video exports only');
    if (typeof body.fps !== 'number' || !(EXPORT_FPS_OPTIONS as readonly number[]).includes(body.fps)) {
      throw new ExportRequestError('fps must be 24, 25, 30, 50, or 60');
    }
  }
}

export function exportFilename(name: string | undefined, ext: string): string {
  const base = sanitizeFileName((name ?? 'export').replace(/\.(?:mp4|webm|mp3|wav)$/i, ''), 'export');
  return `${base}.${ext}`;
}

export function exportDuration(state: ExportTimeline): number {
  return Math.max(
    state.fps,
    state.items.reduce((end, item) => Math.max(end, item.startFrame + item.durationInFrames), 0),
  );
}

export function planExport(body: ExportRequest | null): ExportPlan {
  if (body?.backend !== undefined && body.backend !== 'remotion' && body.backend !== 'mlt-experimental') {
    throw new ExportRequestError('backend must be remotion or mlt-experimental');
  }
  const backend = body?.backend ?? 'remotion';
  let state: unknown;
  let fps: number;
  let totalFrames: number;
  let neutralTimeline: NeutralTimelineV1 | undefined;
  if (backend === 'mlt-experimental') {
    if (body?.state !== undefined) {
      throw new ExportRequestError(
        'backend=mlt-experimental accepts neutralTimeline as its only timeline source; omit state',
      );
    }
    if (body?.neutralTimeline === undefined) {
      throw new ExportRequestError('backend=mlt-experimental requires neutralTimeline');
    }
    try {
      assertNeutralTimelineV1(body.neutralTimeline);
    } catch (error) {
      throw new ExportRequestError(
        `neutralTimeline is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    neutralTimeline = body.neutralTimeline;
    if (neutralTimeline.frameRate.numerator > MAX_MLT_PROFILE_INTEGER
      || neutralTimeline.frameRate.denominator > MAX_MLT_PROFILE_INTEGER) {
      throw new ExportRequestError(
        `neutralTimeline frameRate numerator/denominator must not exceed ${MAX_MLT_PROFILE_INTEGER}`,
      );
    }
    const neutralFps = neutralTimeline.frameRate.numerator / neutralTimeline.frameRate.denominator;
    if (neutralFps < 1 || neutralFps > MAX_MLT_FRAME_RATE) {
      throw new ExportRequestError(`neutralTimeline frameRate must be between 1 and ${MAX_MLT_FRAME_RATE} fps`);
    }
    const clipCount = neutralTimeline.tracks.reduce((count, track) => count + track.clips.length, 0);
    const activeMediaTrackCount = neutralTimeline.tracks.filter(
      (track) => track.enabled && track.kind !== 'caption' && track.clips.length > 0,
    ).length;
    if (neutralTimeline.canvas.width > MAX_MLT_CANVAS_DIMENSION
      || neutralTimeline.canvas.height > MAX_MLT_CANVAS_DIMENSION) {
      throw new ExportRequestError(`neutralTimeline canvas dimensions must not exceed ${MAX_MLT_CANVAS_DIMENSION}`);
    }
    if (neutralTimeline.canvas.width * neutralTimeline.canvas.height > MAX_MLT_CANVAS_PIXELS) {
      throw new ExportRequestError(`neutralTimeline canvas area must not exceed ${MAX_MLT_CANVAS_PIXELS} pixels`);
    }
    if (neutralTimeline.durationFrames / neutralFps > MAX_MLT_DURATION_SECONDS) {
      throw new ExportRequestError(
        `neutralTimeline duration must not exceed ${MAX_MLT_DURATION_SECONDS} seconds`,
      );
    }
    if (neutralTimeline.tracks.length > MAX_MLT_TRACKS || clipCount > MAX_MLT_CLIPS) {
      throw new ExportRequestError(
        `neutralTimeline exceeds the MLT limit of ${MAX_MLT_TRACKS} tracks or ${MAX_MLT_CLIPS} clips`,
      );
    }
    if (activeMediaTrackCount > MAX_MLT_ACTIVE_MEDIA_TRACKS) {
      throw new ExportRequestError(
        `neutralTimeline must not exceed ${MAX_MLT_ACTIVE_MEDIA_TRACKS} active media tracks`,
      );
    }
    if (neutralTimeline.canvas.width * neutralTimeline.canvas.height * Math.max(1, activeMediaTrackCount)
      > MAX_MLT_COMPOSITING_PIXELS) {
      throw new ExportRequestError(
        `neutralTimeline canvas area multiplied by active media tracks must not exceed ${MAX_MLT_COMPOSITING_PIXELS}`,
      );
    }
    fps = neutralFps;
    totalFrames = neutralTimeline.durationFrames;
    state = {
      fps,
      width: neutralTimeline.canvas.width,
      height: neutralTimeline.canvas.height,
      items: neutralTimeline.tracks
        .filter((track) => track.enabled)
        .flatMap((track) => track.clips.map((clip) => ({
          startFrame: clip.startFrame,
          durationInFrames: clip.durationFrames,
        }))),
    } satisfies ExportTimeline & { width: number; height: number };
  } else {
    state = body?.state;
    if (!state || typeof state !== 'object' || !Array.isArray((state as { items?: unknown }).items)) {
      throw new ExportRequestError('body must be { state: TimelineState } with an items array');
    }
    fps = (state as ExportTimeline).fps;
    if (!Number.isFinite(fps) || fps <= 0) throw new ExportRequestError('state.fps must be a positive number');
    totalFrames = exportDuration(state as ExportTimeline);
  }
  if (body?.format !== undefined && body.format !== 'video' && body.format !== 'audio') {
    throw new ExportRequestError('format must be video or audio');
  }
  if (body?.codec !== undefined && !Object.hasOwn(EXPORT_MEDIA, body.codec)) {
    throw new ExportRequestError('codec must be h264, vp8, mp3, or wav');
  }
  if (body?.name !== undefined && typeof body.name !== 'string') throw new ExportRequestError('name must be a string');
  if ([body?.startSeconds, body?.endSeconds].some((value) => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)))) {
    throw new ExportRequestError('startSeconds and endSeconds must be finite numbers');
  }
  const format = body?.format ?? 'video';
  const codec = body?.codec ?? (format === 'audio' ? 'mp3' : 'h264');
  if ((format === 'audio') !== (codec === 'mp3' || codec === 'wav')) {
    throw new ExportRequestError(`${format} export does not support codec=${codec}`);
  }
  validateVideoParams(body, format);
  if (backend === 'mlt-experimental') {
    if (format !== 'video') {
      throw new ExportRequestError('backend=mlt-experimental supports video exports only');
    }
    if (codec !== 'h264') {
      throw new ExportRequestError('backend=mlt-experimental supports codec=h264 only');
    }
    if (body?.resolution !== undefined) {
      throw new ExportRequestError('backend=mlt-experimental supports original resolution only; omit resolution');
    }
    if (body?.fps !== undefined && body.fps !== fps) {
      throw new ExportRequestError(
        `backend=mlt-experimental supports original timeline fps only; omit fps or set fps=${fps}`,
      );
    }
    if ([body?.startFrame, body?.endFrameExclusive, body?.startSeconds, body?.endSeconds]
      .some((value) => value !== undefined)) {
      throw new ExportRequestError('backend=mlt-experimental does not support ranged exports; omit start/end');
    }
  }
  const startFrame = body?.startFrame ?? (body?.startSeconds === undefined ? undefined : Math.floor(body.startSeconds * fps));
  const endFrame = body?.endFrameExclusive ?? (body?.endSeconds === undefined ? undefined : Math.ceil(body.endSeconds * fps));
  const frameRange = normalizeFrameRange(totalFrames, startFrame, endFrame);
  const frames = frameRange ? frameRange[1] - frameRange[0] + 1 : totalFrames;
  const media = EXPORT_MEDIA[codec];
  return {
    state,
    backend,
    neutralTimeline,
    format,
    media,
    frameRange,
    totalFrames: frames,
    filename: exportFilename(body?.name, media.ext),
    durationSeconds: frames / fps,
    scale: exportScale(state as { width?: unknown; height?: unknown }, body?.resolution),
    retimeFps: format === 'video' && body?.fps !== undefined && body.fps !== fps ? body.fps : undefined,
  };
}
