import {
  captionsOnTrack,
  isMotionGraphicTrack,
  isVisualItemKind,
  timelineTrackIds,
  trackKind,
  type TimelineItem,
  type TimelineState,
  type TransitionItem,
} from '../editor/types';
import { captionPages } from '../captions/exportCaptions';
import { buildCues } from '../captions/captionCues';
import { activeTranslation, joinCaptionWords, type CaptionsData } from '../captions/types';
import { itemEditOpts, itemWindow, keptSegments } from '../transcript/edit';
import { msToFrame } from '../transcript/types';
import {
  NEUTRAL_TIMELINE_SCHEMA,
  NEUTRAL_TIMELINE_VERSION,
  assertNeutralTimelineV1,
  type NeutralClipV1,
  type NeutralDiagnosticV1,
  type NeutralFrameRateV1,
  type NeutralTimelineV1,
  type NeutralTrackV1,
  type NeutralTransitionV1,
} from '../../shared/neutral-timeline';

const KEYFRAME_PROPERTIES = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'] as const;

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

/** Preserve the editor's numeric fps without guessing a broadcast standard. */
export function neutralFrameRate(fps: number, maxDenominator = 1_000_000): NeutralFrameRateV1 {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('timeline fps must be a positive finite number');
  let remainder = fps;
  let previousNumerator = 0;
  let numerator = 1;
  let previousDenominator = 1;
  let denominator = 0;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const whole = Math.floor(remainder);
    const nextNumerator = whole * numerator + previousNumerator;
    const nextDenominator = whole * denominator + previousDenominator;
    if (!Number.isSafeInteger(nextNumerator)
      || !Number.isSafeInteger(nextDenominator)
      || nextDenominator > maxDenominator) break;
    [previousNumerator, numerator] = [numerator, nextNumerator];
    [previousDenominator, denominator] = [denominator, nextDenominator];
    if (Math.abs(numerator / denominator - fps) <= 1e-10) break;
    const fractional = remainder - whole;
    if (fractional <= Number.EPSILON) break;
    remainder = 1 / fractional;
  }
  if (denominator <= 0) {
    numerator = Math.max(1, Math.round(fps * maxDenominator));
    denominator = maxDenominator;
  }
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function validateEditorTimeline(state: TimelineState): void {
  neutralFrameRate(state.fps);
  if (!Number.isInteger(state.width) || state.width <= 0
    || !Number.isInteger(state.height) || state.height <= 0) {
    throw new Error('timeline width/height must be positive integers');
  }
  for (const item of state.items) {
    if (!item.id || !item.track || !Number.isInteger(item.startFrame) || item.startFrame < 0
      || !Number.isInteger(item.durationInFrames) || item.durationInFrames <= 0) {
      throw new Error(`timeline item ${item.id || '<unknown>'} has invalid placement`);
    }
    if (item.playbackRate !== undefined
      && (!Number.isFinite(item.playbackRate) || item.playbackRate <= 0)) {
      throw new Error(`timeline item ${item.id} has invalid playbackRate`);
    }
  }
}

function convertKeyframes(item: TimelineItem): NeutralClipV1['keyframes'] | undefined {
  if (!item.keyframes) return undefined;
  const converted: NonNullable<NeutralClipV1['keyframes']> = {};
  for (const property of KEYFRAME_PROPERTIES) {
    const frames = item.keyframes[property];
    if (!frames?.length) continue;
    converted[property] = [...frames]
      .sort((a, b) => a.frame - b.frame)
      .map((keyframe) => ({
        frame: keyframe.frame,
        value: keyframe.value,
        ...(keyframe.easing === undefined ? {} : { easing: keyframe.easing }),
      }));
  }
  return Object.keys(converted).length ? converted : undefined;
}

function visualSourceDimensions(item: TimelineItem, state: TimelineState): { width: number; height: number } | undefined {
  if (item.kind !== 'video' && item.kind !== 'image') return undefined;
  const asset = state.assets?.find((candidate) => candidate.src === item.src);
  const width = asset?.width ?? item.width;
  const height = asset?.height ?? item.height;
  return Number.isInteger(width) && Number(width) > 0 && Number.isInteger(height) && Number(height) > 0
    ? { width: Number(width), height: Number(height) }
    : undefined;
}

function convertedSource(item: TimelineItem, fps: number, state: TimelineState): NeutralClipV1['source'] | undefined {
  if (!item.src) return undefined;
  const dimensions = visualSourceDimensions(item, state);
  const source = {
    uri: item.kind === 'audio' ? item.denoisedSrc || item.src : item.src,
    ...(item.kind === 'video' && item.denoisedSrc ? { alternateAudioUri: item.denoisedSrc } : {}),
    ...(dimensions ?? {}),
    sourceInFrame: item.srcInFrame ?? 0,
    playbackRate: item.playbackRate ?? 1,
  } satisfies NonNullable<NeutralClipV1['source']>;
  if (item.kind !== 'audio' || !item.transcript?.length) return source;
  const segments = keptSegments(
    item.transcript,
    new Set(item.deletedWordIdx ?? []),
    fps,
    item.startFrame,
    { ...itemEditOpts(item), window: itemWindow(item) },
  ).map((segment) => ({
    timelineOffsetFrames: segment.fromFrame - item.startFrame,
    sourceInFrame: segment.srcStartFrame,
    durationFrames: segment.durFrames,
  }));
  return { ...source, sourceInFrame: 0, playbackRate: 1, segments };
}

function convertClip(
  item: TimelineItem,
  fps: number,
  state: TimelineState,
  diagnostics: NeutralDiagnosticV1[],
): NeutralClipV1 {
  const source = convertedSource(item, fps, state);
  let placeholder: NeutralClipV1['placeholder'];
  if (!source) {
    if (item.kind === 'motion-graphic' || item.kind === 'text' || item.kind === 'solid') {
      placeholder = {
        kind: item.kind,
        reason: `${item.kind} requires backend rendering or a pre-rendered media source`,
      };
      diagnostics.push({
        code: 'placeholder-required',
        severity: 'warning',
        message: `${item.name} has no pre-rendered media source`,
        trackId: item.track,
        clipId: item.id,
        feature: item.kind,
      });
    } else {
      placeholder = { kind: 'missing-media', reason: `${item.kind} clip has no source URI` };
      diagnostics.push({
        code: 'missing-source',
        severity: 'error',
        message: `${item.name} has no media source`,
        trackId: item.track,
        clipId: item.id,
      });
    }
  }

  if (item.zoom) diagnostics.push({
    code: 'unsupported-feature', severity: 'warning', message: `${item.name} uses animated zoom not represented in NeutralTimelineV1`,
    trackId: item.track, clipId: item.id, feature: 'zoom',
  });
  if (item.effects?.length) diagnostics.push({
    code: 'unsupported-feature', severity: 'warning', message: `${item.name} uses a clip effect stack not represented in NeutralTimelineV1`,
    trackId: item.track, clipId: item.id, feature: 'effects',
  });

  const visual = isVisualItemKind(item.kind) ? {
    ...(item.transform ?? {}),
    ...(item.filters ?? {}),
    ...(item.fadeInFrames === undefined ? {} : { fadeInFrames: item.fadeInFrames }),
    ...(item.fadeOutFrames === undefined ? {} : { fadeOutFrames: item.fadeOutFrames }),
  } : undefined;
  const hasAudio = item.kind === 'audio' || item.kind === 'video';
  const keyframes = convertKeyframes(item);
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    startFrame: item.startFrame,
    durationFrames: item.durationInFrames,
    ...(source ? { source } : {}),
    ...(visual && Object.keys(visual).length ? { visual } : {}),
    ...(hasAudio ? {
      audio: {
        volume: item.volume ?? 1,
        ...(item.fadeInFrames === undefined ? {} : { fadeInFrames: item.fadeInFrames }),
        ...(item.fadeOutFrames === undefined ? {} : { fadeOutFrames: item.fadeOutFrames }),
      },
    } : {}),
    ...(keyframes ? { keyframes } : {}),
    ...(placeholder ? { placeholder } : {}),
  };
}

function convertCaptions(
  trackId: string,
  captions: CaptionsData,
  state: TimelineState,
  durationFrames: number,
  diagnostics: NeutralDiagnosticV1[],
): NonNullable<NeutralTrackV1['captions']> {
  if (captions.sourceEntries?.length || captions.layoutPolicy || captions.perSource) diagnostics.push({
    code: 'unsupported-feature',
    severity: 'warning',
    message: 'multi-lane caption placement is flattened in NeutralTimelineV1',
    trackId,
    feature: 'caption-multi-lane-layout',
  });
  const rows = captions.sourceEntries?.length
    ? captionPages(captions, state.items, state.fps).map((page) => ({
      start: page.start,
      end: page.end,
      text: joinCaptionWords(page.words),
    }))
    : buildCues(captions, state.items, state.fps);
  const cues = rows.flatMap((row, index) => {
    const text = row.text.trim();
    if (!text) return [];
    const startFrame = Math.max(0, msToFrame(row.start, state.fps));
    const endFrameExclusive = Math.max(startFrame + 1, msToFrame(row.end, state.fps));
    if (startFrame >= durationFrames || endFrameExclusive > durationFrames) diagnostics.push({
      code: 'caption-outside-timeline',
      severity: 'warning',
      message: `caption cue ${index + 1} extends beyond the rendered timeline`,
      trackId,
    });
    const translated = captions.bilingual && captions.translation
      ? activeTranslation(captions.translation, row.start)?.text.trim()
      : undefined;
    return [{
      id: `${trackId}:caption:${index}`,
      startFrame,
      endFrameExclusive,
      text,
      ...(translated ? { secondaryText: translated } : {}),
    }];
  });
  return {
    presentation: {
      template: captions.template,
      pacing: captions.pacing,
      bilingual: captions.bilingual ?? false,
      ...(captions.translationLang ? { translationLanguage: captions.translationLang } : {}),
      ...(captions.styleOverride ? { style: { ...captions.styleOverride } } : {}),
      ...(captions.layout ? { layout: { ...captions.layout } } : {}),
    },
    cues,
  };
}

function diagnoseTrackOverlap(track: NeutralTrackV1, diagnostics: NeutralDiagnosticV1[]): void {
  let furthest: NeutralClipV1 | undefined;
  let furthestEnd = -1;
  for (const clip of track.clips) {
    if (furthest && clip.startFrame < furthestEnd) diagnostics.push({
      code: 'same-track-overlap',
      severity: 'error',
      message: `${furthest.name} overlaps ${clip.name} on the same track`,
      trackId: track.id,
      clipId: clip.id,
    });
    const end = clip.startFrame + clip.durationFrames;
    if (end > furthestEnd) { furthest = clip; furthestEnd = end; }
  }
}

function convertTransition(
  transition: TransitionItem,
  state: TimelineState,
  diagnostics: NeutralDiagnosticV1[],
): NeutralTransitionV1 {
  const outgoing = state.items.find((item) => item.id === transition.outgoingItemId);
  const incoming = state.items.find((item) => item.id === transition.incomingItemId);
  if (!outgoing || !incoming
    || outgoing.track !== transition.trackId
    || incoming.track !== transition.trackId) {
    diagnostics.push({
      code: 'transition-invalid', severity: 'error', message: `transition ${transition.id} references clips outside its track`,
      trackId: transition.trackId, transitionId: transition.id,
    });
  } else if (outgoing.startFrame + outgoing.durationInFrames !== incoming.startFrame) {
    diagnostics.push({
      code: 'transition-invalid', severity: 'error', message: `transition ${transition.id} clips are not adjacent at one cut`,
      trackId: transition.trackId, transitionId: transition.id,
    });
  }
  return {
    id: transition.id,
    type: transition.type,
    trackId: transition.trackId,
    outgoingClipId: transition.outgoingItemId,
    incomingClipId: transition.incomingItemId,
    durationFrames: transition.durationInFrames,
    enabled: transition.enabled !== false,
    ...(transition.direction ? { direction: transition.direction } : {}),
    ...(transition.customFrag || transition.customLabel || transition.customUniforms ? {
      custom: {
        ...(transition.customLabel ? { label: transition.customLabel } : {}),
        ...(transition.customFrag ? { fragmentShader: transition.customFrag } : {}),
        ...(transition.customUniforms ? { uniforms: { ...transition.customUniforms } } : {}),
      },
    } : {}),
  };
}

export interface NeutralTimelineExportOptions {
  /** Half-open source range. The returned timeline is rebased to frame zero. */
  frameRange?: readonly [number, number];
}

function rangedTimeline(timeline: NeutralTimelineV1, frameRange: readonly [number, number]): NeutralTimelineV1 {
  const [startFrame, endFrameExclusive] = frameRange;
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrameExclusive)
    || startFrame < 0 || endFrameExclusive <= startFrame || endFrameExclusive > timeline.durationFrames) {
    throw new Error('neutral timeline frameRange must be a valid half-open interval');
  }
  if (startFrame === 0 && endFrameExclusive === timeline.durationFrames) return timeline;
  const tracks = timeline.tracks.map((track) => ({
    ...track,
    clips: track.clips.flatMap((clip) => {
      const clipEnd = clip.startFrame + clip.durationFrames;
      const keptStart = Math.max(startFrame, clip.startFrame);
      const keptEnd = Math.min(endFrameExclusive, clipEnd);
      if (keptEnd <= keptStart) return [];
      const trimFrames = keptStart - clip.startFrame;
      const keptDuration = keptEnd - keptStart;
      const source = clip.source ? {
        ...clip.source,
        sourceInFrame: clip.source.sourceInFrame + Math.round(trimFrames * clip.source.playbackRate),
        ...(clip.source.segments ? {
          segments: clip.source.segments.flatMap((segment) => {
            const segmentStart = segment.timelineOffsetFrames;
            const segmentEnd = segmentStart + segment.durationFrames;
            const intersectionStart = Math.max(trimFrames, segmentStart);
            const intersectionEnd = Math.min(trimFrames + keptDuration, segmentEnd);
            return intersectionEnd > intersectionStart ? [{
              timelineOffsetFrames: intersectionStart - trimFrames,
              sourceInFrame: segment.sourceInFrame + intersectionStart - segmentStart,
              durationFrames: intersectionEnd - intersectionStart,
            }] : [];
          }),
        } : {}),
      } : undefined;
      const keyframes = clip.keyframes ? Object.fromEntries(
        Object.entries(clip.keyframes).flatMap(([name, rows]) => {
          const kept = rows?.filter((row) => row.frame >= trimFrames && row.frame < trimFrames + keptDuration)
            .map((row) => ({ ...row, frame: row.frame - trimFrames }));
          return kept?.length ? [[name, kept]] : [];
        }),
      ) : undefined;
      return [{
        ...clip,
        startFrame: keptStart - startFrame,
        durationFrames: keptDuration,
        ...(source ? { source } : {}),
        ...(keyframes && Object.keys(keyframes).length ? { keyframes } : { keyframes: undefined }),
      }];
    }),
    ...(track.captions ? {
      captions: {
        ...track.captions,
        cues: track.captions.cues.flatMap((cue) => {
          const keptStart = Math.max(startFrame, cue.startFrame);
          const keptEnd = Math.min(endFrameExclusive, cue.endFrameExclusive);
          return keptEnd > keptStart ? [{
            ...cue,
            startFrame: keptStart - startFrame,
            endFrameExclusive: keptEnd - startFrame,
          }] : [];
        }),
      },
    } : {}),
  }));
  const keptClipIds = new Set(tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  const ranged: NeutralTimelineV1 = {
    ...timeline,
    durationFrames: endFrameExclusive - startFrame,
    tracks,
    transitions: timeline.transitions.filter((transition) => (
      keptClipIds.has(transition.outgoingClipId) && keptClipIds.has(transition.incomingClipId)
    )),
  };
  assertNeutralTimelineV1(ranged);
  return ranged;
}

export function toNeutralTimeline(
  state: TimelineState,
  options: NeutralTimelineExportOptions = {},
): NeutralTimelineV1 {
  validateEditorTimeline(state);
  const diagnostics: NeutralDiagnosticV1[] = [];
  const lastItemFrame = state.items.reduce(
    (maximum, item) => Math.max(maximum, item.startFrame + item.durationInFrames),
    0,
  );
  const durationFrames = Math.max(1, Math.ceil(state.fps), lastItemFrame);
  const ids = timelineTrackIds(state);
  const tracks = ids.map((trackId, order): NeutralTrackV1 => {
    const metadata = state.tracks?.[trackId];
    const kind = trackKind(state, trackId);
    const captions = kind === 'caption' ? captionsOnTrack(state, trackId) : null;
    const clips = state.items
      .filter((item) => item.track === trackId)
      .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id))
      .map((item) => convertClip(item, state.fps, state, diagnostics));
    if (kind === 'caption' && clips.length) diagnostics.push({
      code: 'clip-on-caption-track', severity: 'error', message: `caption track ${trackId} contains media clips`, trackId,
    });
    const role = isMotionGraphicTrack(state, trackId) ? 'motion-graphic' : metadata?.role;
    const converted: NeutralTrackV1 = {
      id: trackId,
      order,
      kind,
      ...(metadata?.name ? { name: metadata.name } : {}),
      ...(role ? { role } : {}),
      enabled: metadata?.hidden !== true && (kind !== 'caption' || captions?.enabled !== false),
      muted: metadata?.muted === true,
      locked: metadata?.locked === true,
      ...(metadata?.audioRouting ? { audioRouting: { ...metadata.audioRouting } } : {}),
      clips,
      ...(captions ? { captions: convertCaptions(trackId, captions, state, durationFrames, diagnostics) } : {}),
    };
    diagnoseTrackOverlap(converted, diagnostics);
    return converted;
  });
  const transitions = (state.transitions ?? []).map((transition) => convertTransition(transition, state, diagnostics));
  if (state.watermark?.enabled) diagnostics.push({
    code: 'unsupported-feature', severity: 'warning', message: 'watermark is not represented in NeutralTimelineV1', feature: 'watermark',
  });
  const timeline: NeutralTimelineV1 = {
    schema: NEUTRAL_TIMELINE_SCHEMA,
    version: NEUTRAL_TIMELINE_VERSION,
    frameRate: neutralFrameRate(state.fps),
    canvas: { width: state.width, height: state.height, fit: state.fit ?? 'contain' },
    durationFrames,
    tracks,
    transitions,
    diagnostics,
  };
  assertNeutralTimelineV1(timeline);
  return options.frameRange ? rangedTimeline(timeline, options.frameRange) : timeline;
}
