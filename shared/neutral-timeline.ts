/**
 * Renderer-neutral, versioned timeline interchange boundary.
 *
 * Time is represented exclusively as integer frames. Every span is half-open:
 * [startFrame, startFrame + durationFrames). Source URIs remain logical; only a
 * trusted server-side backend may resolve them to local filesystem paths.
 */
export const NEUTRAL_TIMELINE_SCHEMA = 'cutai-neutral-timeline' as const;
export const NEUTRAL_TIMELINE_VERSION = 1 as const;

export interface NeutralFrameRateV1 {
  numerator: number;
  denominator: number;
}

export type NeutralTrackKindV1 = 'video' | 'audio' | 'caption';
export type NeutralTrackRoleV1 = 'motion-graphic' | 'anchor' | 'follower';
export type NeutralClipKindV1 =
  | 'motion-graphic'
  | 'audio'
  | 'video'
  | 'image'
  | 'text'
  | 'gif'
  | 'svg'
  | 'solid';

export interface NeutralSourceSegmentV1 {
  /** Position relative to the parent clip start. */
  timelineOffsetFrames: number;
  sourceInFrame: number;
  durationFrames: number;
}

export interface NeutralMediaSourceV1 {
  uri: string;
  /** Optional isolated/processed audio used while the picture still uses uri. */
  alternateAudioUri?: string;
  /** Ingested display dimensions. Visual backends use these to fail closed when fit semantics cannot be preserved. */
  width?: number;
  height?: number;
  sourceInFrame: number;
  playbackRate: number;
  /** Edited transcript audio is represented as explicit, ordered source cuts. */
  segments?: NeutralSourceSegmentV1[];
}

export interface NeutralCropV1 {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

export interface NeutralVisualV1 {
  scale?: number;
  x?: number;
  y?: number;
  rotation?: number;
  crop?: NeutralCropV1;
  brightness?: number;
  contrast?: number;
  saturate?: number;
  blur?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

export interface NeutralAudioV1 {
  volume: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

export type NeutralAnimatedPropertyV1 = 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'volume';
export interface NeutralKeyframeV1 {
  frame: number;
  value: number;
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | [number, number, number, number];
}

export interface NeutralPlaceholderV1 {
  kind: 'motion-graphic' | 'text' | 'solid' | 'missing-media';
  reason: string;
}

export interface NeutralClipV1 {
  id: string;
  name: string;
  kind: NeutralClipKindV1;
  startFrame: number;
  durationFrames: number;
  source?: NeutralMediaSourceV1;
  visual?: NeutralVisualV1;
  audio?: NeutralAudioV1;
  keyframes?: Partial<Record<NeutralAnimatedPropertyV1, NeutralKeyframeV1[]>>;
  placeholder?: NeutralPlaceholderV1;
}

export interface NeutralCaptionCueV1 {
  id: string;
  startFrame: number;
  endFrameExclusive: number;
  text: string;
  secondaryText?: string;
}

export interface NeutralCaptionPresentationV1 {
  template: string;
  pacing: 'word' | 'phrase';
  bilingual: boolean;
  translationLanguage?: string;
  style?: {
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number;
    color?: string;
    highlightColor?: string;
    highlightBackground?: string;
    strokeColor?: string;
    strokeWidth?: number;
    textShadow?: string;
    textTransform?: 'none' | 'uppercase';
    displayMode?: 'stacked';
    wordsPerPage?: number;
    wholeLine?: boolean;
    background?: string;
  };
  layout?: {
    anchor?: string;
    offsetXRatio?: number;
    offsetYRatio?: number;
  };
}

export interface NeutralTrackV1 {
  id: string;
  /** Zero is the visually top-most editor row. Backends must map their z-order explicitly. */
  order: number;
  kind: NeutralTrackKindV1;
  name?: string;
  role?: NeutralTrackRoleV1;
  enabled: boolean;
  muted: boolean;
  locked: boolean;
  audioRouting?: { duckDepthDb?: number };
  clips: NeutralClipV1[];
  captions?: {
    presentation: NeutralCaptionPresentationV1;
    cues: NeutralCaptionCueV1[];
  };
}

export interface NeutralTransitionV1 {
  id: string;
  type: string;
  trackId: string;
  outgoingClipId: string;
  incomingClipId: string;
  durationFrames: number;
  enabled: boolean;
  direction?: 'left' | 'right' | 'up' | 'down';
  custom?: {
    label?: string;
    fragmentShader?: string;
    uniforms?: Record<string, number>;
  };
}

export type NeutralDiagnosticSeverity = 'info' | 'warning' | 'error';
export type NeutralDiagnosticCode =
  | 'caption-outside-timeline'
  | 'clip-on-caption-track'
  | 'missing-source'
  | 'placeholder-required'
  | 'same-track-overlap'
  | 'transition-invalid'
  | 'unsupported-feature';

export interface NeutralDiagnosticV1 {
  code: NeutralDiagnosticCode;
  severity: NeutralDiagnosticSeverity;
  message: string;
  trackId?: string;
  clipId?: string;
  transitionId?: string;
  feature?: string;
}

export interface NeutralTimelineV1 {
  schema: typeof NEUTRAL_TIMELINE_SCHEMA;
  version: typeof NEUTRAL_TIMELINE_VERSION;
  frameRate: NeutralFrameRateV1;
  canvas: {
    width: number;
    height: number;
    fit: 'contain' | 'cover';
  };
  durationFrames: number;
  tracks: NeutralTrackV1[];
  transitions: NeutralTransitionV1[];
  diagnostics: NeutralDiagnosticV1[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateOptionalFiniteFields(
  errors: string[],
  path: string,
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (value[field] !== undefined && !isFiniteNumber(value[field])) {
      errors.push(`${path}.${field} must be a finite number`);
    }
  }
}

function validateOptionalFrameFields(
  errors: string[],
  path: string,
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (value[field] !== undefined && !isNonNegativeInteger(value[field])) {
      errors.push(`${path}.${field} must be a non-negative integer`);
    }
  }
}

const NEUTRAL_CLIP_KINDS = new Set<string>([
  'motion-graphic', 'audio', 'video', 'image', 'text', 'gif', 'svg', 'solid',
]);
const NEUTRAL_KEYFRAME_PROPERTIES = new Set<string>(['x', 'y', 'scale', 'rotation', 'opacity', 'volume']);
const NEUTRAL_EASINGS = new Set<string>(['linear', 'easeIn', 'easeOut', 'easeInOut']);
const NEUTRAL_DIAGNOSTIC_CODES = new Set<string>([
  'caption-outside-timeline', 'clip-on-caption-track', 'missing-source', 'placeholder-required',
  'same-track-overlap', 'transition-invalid', 'unsupported-feature',
]);
const NEUTRAL_DIAGNOSTIC_SEVERITIES = new Set<string>(['info', 'warning', 'error']);

/** Runtime guard for the server boundary; returns every structural failure found. */
export function neutralTimelineV1Errors(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ['timeline must be an object'];
  if (value.schema !== NEUTRAL_TIMELINE_SCHEMA) errors.push(`schema must be ${NEUTRAL_TIMELINE_SCHEMA}`);
  if (value.version !== NEUTRAL_TIMELINE_VERSION) errors.push(`version must be ${NEUTRAL_TIMELINE_VERSION}`);
  if (!isObject(value.frameRate)
    || !isPositiveInteger(value.frameRate.numerator)
    || !isPositiveInteger(value.frameRate.denominator)) {
    errors.push('frameRate numerator/denominator must be positive integers');
  }
  if (!isObject(value.canvas)
    || !isPositiveInteger(value.canvas.width)
    || !isPositiveInteger(value.canvas.height)
    || (value.canvas.fit !== 'contain' && value.canvas.fit !== 'cover')) {
    errors.push('canvas must contain positive integer width/height and a valid fit');
  }
  if (!isPositiveInteger(value.durationFrames)) errors.push('durationFrames must be a positive integer');
  if (!Array.isArray(value.tracks)) return [...errors, 'tracks must be an array'];
  if (!Array.isArray(value.transitions)) errors.push('transitions must be an array');
  if (!Array.isArray(value.diagnostics)) errors.push('diagnostics must be an array');

  const trackIds = new Set<string>();
  const clipOwners = new Map<string, string>();
  const orders = new Set<number>();
  for (const [trackIndex, rawTrack] of value.tracks.entries()) {
    if (!isObject(rawTrack)) { errors.push(`tracks[${trackIndex}] must be an object`); continue; }
    const id = typeof rawTrack.id === 'string' ? rawTrack.id : '';
    if (!id) errors.push(`tracks[${trackIndex}].id must be a non-empty string`);
    else if (trackIds.has(id)) errors.push(`duplicate track id: ${id}`);
    else trackIds.add(id);
    if (!isNonNegativeInteger(rawTrack.order)) errors.push(`track ${id || trackIndex} order must be a non-negative integer`);
    else if (orders.has(rawTrack.order)) errors.push(`duplicate track order: ${rawTrack.order}`);
    else orders.add(rawTrack.order);
    if (rawTrack.kind !== 'video' && rawTrack.kind !== 'audio' && rawTrack.kind !== 'caption') {
      errors.push(`track ${id || trackIndex} has an invalid kind`);
    }
    if (rawTrack.name !== undefined && typeof rawTrack.name !== 'string') errors.push(`track ${id || trackIndex} name must be a string`);
    if (rawTrack.role !== undefined
      && rawTrack.role !== 'motion-graphic' && rawTrack.role !== 'anchor' && rawTrack.role !== 'follower') {
      errors.push(`track ${id || trackIndex} has an invalid role`);
    }
    if (typeof rawTrack.enabled !== 'boolean'
      || typeof rawTrack.muted !== 'boolean'
      || typeof rawTrack.locked !== 'boolean') {
      errors.push(`track ${id || trackIndex} enabled/muted/locked must be booleans`);
    }
    if (rawTrack.audioRouting !== undefined) {
      if (!isObject(rawTrack.audioRouting)) errors.push(`track ${id || trackIndex} audioRouting must be an object`);
      else validateOptionalFiniteFields(errors, `track ${id || trackIndex} audioRouting`, rawTrack.audioRouting, ['duckDepthDb']);
    }
    if (!Array.isArray(rawTrack.clips)) { errors.push(`track ${id || trackIndex} clips must be an array`); continue; }
    for (const [clipIndex, rawClip] of rawTrack.clips.entries()) {
      if (!isObject(rawClip)) { errors.push(`track ${id || trackIndex} clip ${clipIndex} must be an object`); continue; }
      const clipId = typeof rawClip.id === 'string' ? rawClip.id : '';
      if (!clipId) errors.push(`track ${id || trackIndex} clip ${clipIndex} id must be a non-empty string`);
      else if (clipOwners.has(clipId)) errors.push(`duplicate clip id: ${clipId}`);
      else clipOwners.set(clipId, id);
      if (typeof rawClip.name !== 'string') errors.push(`clip ${clipId || clipIndex} name must be a string`);
      if (typeof rawClip.kind !== 'string' || !NEUTRAL_CLIP_KINDS.has(rawClip.kind)) {
        errors.push(`clip ${clipId || clipIndex} has an invalid kind`);
      }
      if (!isNonNegativeInteger(rawClip.startFrame) || !isPositiveInteger(rawClip.durationFrames)) {
        errors.push(`clip ${clipId || clipIndex} must use non-negative startFrame and positive durationFrames`);
      } else if (isPositiveInteger(value.durationFrames)
        && rawClip.startFrame + rawClip.durationFrames > value.durationFrames) {
        errors.push(`clip ${clipId || clipIndex} exceeds timeline duration`);
      }
      if (rawClip.source !== undefined) {
        if (!isObject(rawClip.source) || typeof rawClip.source.uri !== 'string' || !rawClip.source.uri.trim()) {
          errors.push(`clip ${clipId || clipIndex} source.uri must be a non-empty string`);
        } else if (!isNonNegativeInteger(rawClip.source.sourceInFrame)
          || typeof rawClip.source.playbackRate !== 'number'
          || !Number.isFinite(rawClip.source.playbackRate)
          || rawClip.source.playbackRate <= 0) {
          errors.push(`clip ${clipId || clipIndex} source timing is invalid`);
        }
        if (isObject(rawClip.source) && rawClip.source.alternateAudioUri !== undefined
          && (typeof rawClip.source.alternateAudioUri !== 'string' || !rawClip.source.alternateAudioUri.trim())) {
          errors.push(`clip ${clipId || clipIndex} alternateAudioUri must be a non-empty string`);
        }
        if (isObject(rawClip.source)
          && (rawClip.source.width !== undefined || rawClip.source.height !== undefined)
          && (!isPositiveInteger(rawClip.source.width) || !isPositiveInteger(rawClip.source.height))) {
          errors.push(`clip ${clipId || clipIndex} source width/height must both be positive integers`);
        }
        if (isObject(rawClip.source) && rawClip.source.segments !== undefined) {
          if (!Array.isArray(rawClip.source.segments)) {
            errors.push(`clip ${clipId || clipIndex} source.segments must be an array`);
          } else {
            for (const [segmentIndex, rawSegment] of rawClip.source.segments.entries()) {
              if (!isObject(rawSegment)
                || !isNonNegativeInteger(rawSegment.timelineOffsetFrames)
                || !isNonNegativeInteger(rawSegment.sourceInFrame)
                || !isPositiveInteger(rawSegment.durationFrames)
                || (isPositiveInteger(rawClip.durationFrames)
                  && isNonNegativeInteger(rawSegment.timelineOffsetFrames)
                  && rawSegment.timelineOffsetFrames + Number(rawSegment.durationFrames) > rawClip.durationFrames)) {
                errors.push(`clip ${clipId || clipIndex} source segment ${segmentIndex} is invalid`);
              }
            }
          }
        }
      }
      if (rawClip.placeholder !== undefined
        && (!isObject(rawClip.placeholder)
          || (rawClip.placeholder.kind !== 'motion-graphic'
            && rawClip.placeholder.kind !== 'text'
            && rawClip.placeholder.kind !== 'solid'
            && rawClip.placeholder.kind !== 'missing-media')
          || typeof rawClip.placeholder.reason !== 'string')) {
        errors.push(`clip ${clipId || clipIndex} placeholder is invalid`);
      }
      if (rawClip.visual !== undefined) {
        if (!isObject(rawClip.visual)) errors.push(`clip ${clipId || clipIndex} visual must be an object`);
        else {
          validateOptionalFiniteFields(errors, `clip ${clipId || clipIndex} visual`, rawClip.visual, [
            'scale', 'x', 'y', 'rotation', 'brightness', 'contrast', 'saturate', 'blur',
          ]);
          validateOptionalFrameFields(errors, `clip ${clipId || clipIndex} visual`, rawClip.visual, [
            'fadeInFrames', 'fadeOutFrames',
          ]);
          if (rawClip.visual.crop !== undefined) {
            if (!isObject(rawClip.visual.crop)) errors.push(`clip ${clipId || clipIndex} visual.crop must be an object`);
            else validateOptionalFiniteFields(
              errors,
              `clip ${clipId || clipIndex} visual.crop`,
              rawClip.visual.crop,
              ['left', 'top', 'right', 'bottom'],
            );
          }
        }
      }
      if (rawClip.audio !== undefined) {
        if (!isObject(rawClip.audio)
          || !isFiniteNumber(rawClip.audio.volume)
          || rawClip.audio.volume < 0) {
          errors.push(`clip ${clipId || clipIndex} audio.volume must be a finite non-negative number`);
        } else {
          validateOptionalFrameFields(errors, `clip ${clipId || clipIndex} audio`, rawClip.audio, [
            'fadeInFrames', 'fadeOutFrames',
          ]);
        }
      }
      if (rawClip.keyframes !== undefined) {
        if (!isObject(rawClip.keyframes)) errors.push(`clip ${clipId || clipIndex} keyframes must be an object`);
        else for (const [property, rawFrames] of Object.entries(rawClip.keyframes)) {
          if (!NEUTRAL_KEYFRAME_PROPERTIES.has(property)) {
            errors.push(`clip ${clipId || clipIndex} keyframes.${property} is not supported`);
            continue;
          }
          if (!Array.isArray(rawFrames)) {
            errors.push(`clip ${clipId || clipIndex} keyframes.${property} must be an array`);
            continue;
          }
          for (const [keyframeIndex, rawKeyframe] of rawFrames.entries()) {
            const path = `clip ${clipId || clipIndex} keyframes.${property}[${keyframeIndex}]`;
            if (!isObject(rawKeyframe)
              || !isNonNegativeInteger(rawKeyframe.frame)
              || !isFiniteNumber(rawKeyframe.value)) {
              errors.push(`${path} must contain a non-negative integer frame and finite value`);
              continue;
            }
            const easing = rawKeyframe.easing;
            if (easing !== undefined
              && !(typeof easing === 'string' && NEUTRAL_EASINGS.has(easing))
              && !(Array.isArray(easing) && easing.length === 4 && easing.every(isFiniteNumber))) {
              errors.push(`${path}.easing is invalid`);
            }
          }
        }
      }
    }
    if (rawTrack.captions !== undefined) {
      if (rawTrack.kind !== 'caption') errors.push(`non-caption track ${id || trackIndex} cannot contain captions`);
      if (!isObject(rawTrack.captions)
        || !isObject(rawTrack.captions.presentation)
        || !Array.isArray(rawTrack.captions.cues)) {
        errors.push(`track ${id || trackIndex} captions.cues must be an array`);
      } else {
        const presentation = rawTrack.captions.presentation;
        if (typeof presentation.template !== 'string'
          || (presentation.pacing !== 'word' && presentation.pacing !== 'phrase')
          || typeof presentation.bilingual !== 'boolean'
          || (presentation.translationLanguage !== undefined && typeof presentation.translationLanguage !== 'string')) {
          errors.push(`track ${id || trackIndex} caption presentation is invalid`);
        }
        if (presentation.style !== undefined) {
          if (!isObject(presentation.style)) errors.push(`track ${id || trackIndex} caption style must be an object`);
          else {
            validateOptionalFiniteFields(errors, `track ${id || trackIndex} caption style`, presentation.style, [
              'fontSize', 'fontWeight', 'strokeWidth',
            ]);
            for (const field of [
              'fontFamily', 'color', 'highlightColor', 'highlightBackground', 'strokeColor', 'textShadow', 'background',
            ]) {
              if (presentation.style[field] !== undefined && typeof presentation.style[field] !== 'string') {
                errors.push(`track ${id || trackIndex} caption style.${field} must be a string`);
              }
            }
            if (presentation.style.wordsPerPage !== undefined && !isPositiveInteger(presentation.style.wordsPerPage)) {
              errors.push(`track ${id || trackIndex} caption style.wordsPerPage must be a positive integer`);
            }
            if (presentation.style.wholeLine !== undefined && typeof presentation.style.wholeLine !== 'boolean') {
              errors.push(`track ${id || trackIndex} caption style.wholeLine must be a boolean`);
            }
            if (presentation.style.textTransform !== undefined
              && presentation.style.textTransform !== 'none' && presentation.style.textTransform !== 'uppercase') {
              errors.push(`track ${id || trackIndex} caption style.textTransform is invalid`);
            }
            if (presentation.style.displayMode !== undefined && presentation.style.displayMode !== 'stacked') {
              errors.push(`track ${id || trackIndex} caption style.displayMode is invalid`);
            }
          }
        }
        if (presentation.layout !== undefined) {
          if (!isObject(presentation.layout)) errors.push(`track ${id || trackIndex} caption layout must be an object`);
          else {
            if (presentation.layout.anchor !== undefined && typeof presentation.layout.anchor !== 'string') {
              errors.push(`track ${id || trackIndex} caption layout.anchor must be a string`);
            }
            validateOptionalFiniteFields(errors, `track ${id || trackIndex} caption layout`, presentation.layout, [
              'offsetXRatio', 'offsetYRatio',
            ]);
          }
        }
        for (const [cueIndex, rawCue] of rawTrack.captions.cues.entries()) {
          if (!isObject(rawCue)
            || !isNonNegativeInteger(rawCue.startFrame)
            || !isPositiveInteger(rawCue.endFrameExclusive)
            || rawCue.endFrameExclusive <= rawCue.startFrame
            || typeof rawCue.text !== 'string'
            || (rawCue.secondaryText !== undefined && typeof rawCue.secondaryText !== 'string')) {
            errors.push(`track ${id || trackIndex} caption cue ${cueIndex} is invalid`);
          }
        }
      }
    }
  }

  if (Array.isArray(value.transitions)) {
    const transitionIds = new Set<string>();
    for (const [index, rawTransition] of value.transitions.entries()) {
      if (!isObject(rawTransition)) { errors.push(`transitions[${index}] must be an object`); continue; }
      const id = typeof rawTransition.id === 'string' ? rawTransition.id : String(index);
      const trackId = typeof rawTransition.trackId === 'string' ? rawTransition.trackId : '';
      const outgoing = typeof rawTransition.outgoingClipId === 'string' ? rawTransition.outgoingClipId : '';
      const incoming = typeof rawTransition.incomingClipId === 'string' ? rawTransition.incomingClipId : '';
      if (typeof rawTransition.id !== 'string' || !rawTransition.id
        || typeof rawTransition.type !== 'string' || !rawTransition.type
        || typeof rawTransition.enabled !== 'boolean') {
        errors.push(`transition ${id} must have id, type, and enabled`);
      }
      if (transitionIds.has(id)) errors.push(`duplicate transition id: ${id}`);
      else transitionIds.add(id);
      if (!trackIds.has(trackId)) errors.push(`transition ${id} references an unknown track`);
      if (clipOwners.get(outgoing) !== trackId || clipOwners.get(incoming) !== trackId) {
        errors.push(`transition ${id} clips must exist on track ${trackId}`);
      }
      if (!isPositiveInteger(rawTransition.durationFrames)) errors.push(`transition ${id} durationFrames must be positive`);
      if (rawTransition.direction !== undefined
        && rawTransition.direction !== 'left' && rawTransition.direction !== 'right'
        && rawTransition.direction !== 'up' && rawTransition.direction !== 'down') {
        errors.push(`transition ${id} direction is invalid`);
      }
      if (rawTransition.custom !== undefined) {
        if (!isObject(rawTransition.custom)) errors.push(`transition ${id} custom must be an object`);
        else {
          if (rawTransition.custom.label !== undefined && typeof rawTransition.custom.label !== 'string') {
            errors.push(`transition ${id} custom.label must be a string`);
          }
          if (rawTransition.custom.fragmentShader !== undefined && typeof rawTransition.custom.fragmentShader !== 'string') {
            errors.push(`transition ${id} custom.fragmentShader must be a string`);
          }
          if (rawTransition.custom.uniforms !== undefined) {
            if (!isObject(rawTransition.custom.uniforms)) errors.push(`transition ${id} custom.uniforms must be an object`);
            else for (const [name, uniform] of Object.entries(rawTransition.custom.uniforms)) {
              if (!isFiniteNumber(uniform)) errors.push(`transition ${id} custom.uniforms.${name} must be finite`);
            }
          }
        }
      }
    }
  }
  if (Array.isArray(value.diagnostics)) {
    for (const [index, rawDiagnostic] of value.diagnostics.entries()) {
      if (!isObject(rawDiagnostic)
        || typeof rawDiagnostic.code !== 'string' || !NEUTRAL_DIAGNOSTIC_CODES.has(rawDiagnostic.code)
        || typeof rawDiagnostic.severity !== 'string' || !NEUTRAL_DIAGNOSTIC_SEVERITIES.has(rawDiagnostic.severity)
        || typeof rawDiagnostic.message !== 'string') {
        errors.push(`diagnostics[${index}] is invalid`);
        continue;
      }
      for (const field of ['trackId', 'clipId', 'transitionId', 'feature']) {
        if (rawDiagnostic[field] !== undefined && typeof rawDiagnostic[field] !== 'string') {
          errors.push(`diagnostics[${index}].${field} must be a string`);
        }
      }
    }
  }
  return errors;
}

export function assertNeutralTimelineV1(value: unknown): asserts value is NeutralTimelineV1 {
  const errors = neutralTimelineV1Errors(value);
  if (errors.length) throw new Error(`Invalid NeutralTimelineV1: ${errors.join('; ')}`);
}
