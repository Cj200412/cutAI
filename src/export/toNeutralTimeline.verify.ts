// Runnable check: `npx tsx src/export/toNeutralTimeline.verify.ts`.
import assert from 'node:assert/strict';
import {
  assertNeutralTimelineV1,
  neutralTimelineV1Errors,
} from '../../shared/neutral-timeline';
import { MOTION_GRAPHIC_TRACK_NAME, type TimelineState } from '../editor/types';
import { neutralFrameRate, toNeutralTimeline } from './toNeutralTimeline';

assert.deepEqual(neutralFrameRate(30), { numerator: 30, denominator: 1 });
assert.deepEqual(neutralFrameRate(29.97), { numerator: 2997, denominator: 100 });
assert.deepEqual(neutralFrameRate(30_000 / 1_001), { numerator: 30_000, denominator: 1_001 });

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  fit: 'cover',
  selectedId: null,
  trackOrder: ['mg-track', 'video-main', 'audio-main', 'caption-main'],
  tracks: {
    'mg-track': { kind: 'video', name: MOTION_GRAPHIC_TRACK_NAME },
    'video-main': { kind: 'video', name: '主画面' },
    'audio-main': { kind: 'audio', name: '配音', role: 'anchor' },
    'caption-main': {
      kind: 'caption',
      name: '字幕',
      captions: {
        enabled: true,
        template: 'plain',
        pacing: 'phrase',
        sourceItemId: 'speech',
        bilingual: true,
        translationLang: 'English',
        translation: [{ start: 0, end: 3000, text: 'hello world' }],
      },
    },
  },
  items: [
    {
      id: 'mg', track: 'mg-track', startFrame: 0, durationInFrames: 60,
      name: '片头标题', kind: 'motion-graphic', code: 'export default () => null',
    },
    {
      id: 'picture', track: 'video-main', startFrame: 0, durationInFrames: 90,
      name: '采访画面', kind: 'video', src: '/workspace-media/p/%E9%87%87%E8%AE%BF.mp4',
      srcInFrame: 15, playbackRate: 1.25, denoisedSrc: '/media/uploads/isolated.wav',
      transform: { scale: 1.1, x: 3, crop: { left: 0.1 } },
      filters: { contrast: 1.1 },
      keyframes: { x: [{ frame: 30, value: 20 }, { frame: 0, value: 0 }] },
    },
    {
      id: 'speech', track: 'audio-main', startFrame: 0, durationInFrames: 60,
      name: '配音', kind: 'audio', src: '/media/uploads/%E9%85%8D%E9%9F%B3.wav', volume: 0.8,
      transcript: [
        { text: '你', start: 0, end: 1000 },
        { text: '嗯', start: 1000, end: 2000 },
        { text: '好', start: 2000, end: 3000 },
      ],
      deletedWordIdx: [1],
    },
  ],
};

const neutral = toNeutralTimeline(state);
assertNeutralTimelineV1(neutral);
assert.deepEqual(neutral, toNeutralTimeline(state), 'same input must serialize deterministically');
assert.equal(neutral.schema, 'cutai-neutral-timeline');
assert.equal(neutral.version, 1);
assert.equal(neutral.canvas.fit, 'cover');
assert.deepEqual(neutral.tracks.map((track) => [track.id, track.order]), [
  ['mg-track', 0], ['video-main', 1], ['audio-main', 2], ['caption-main', 3],
]);

const mgTrack = neutral.tracks[0]!;
assert.equal(mgTrack.role, 'motion-graphic');
assert.equal(mgTrack.clips[0]?.placeholder?.kind, 'motion-graphic');
assert.ok(neutral.diagnostics.some((diagnostic) => diagnostic.code === 'placeholder-required' && diagnostic.clipId === 'mg'));

const picture = neutral.tracks[1]!.clips[0]!;
assert.equal(picture.source?.uri, '/workspace-media/p/%E9%87%87%E8%AE%BF.mp4', 'logical URI must stay unresolved');
assert.equal(picture.source?.alternateAudioUri, '/media/uploads/isolated.wav');
assert.equal(picture.source?.sourceInFrame, 15);
assert.equal(picture.visual?.contrast, 1.1);
assert.deepEqual(picture.keyframes?.x?.map((keyframe) => keyframe.frame), [0, 30]);

const speech = neutral.tracks[2]!.clips[0]!;
assert.equal(speech.source?.uri, '/media/uploads/%E9%85%8D%E9%9F%B3.wav');
assert.equal(speech.source?.playbackRate, 1);
assert.deepEqual(speech.source?.segments, [
  { timelineOffsetFrames: 0, sourceInFrame: 0, durationFrames: 30 },
  { timelineOffsetFrames: 30, sourceInFrame: 60, durationFrames: 30 },
]);
assert.equal(speech.audio?.volume, 0.8);

const captionTrack = neutral.tracks[3]!;
assert.equal(captionTrack.captions?.cues.length, 1);
assert.equal(captionTrack.captions?.cues[0]?.text, '你好');
assert.equal(captionTrack.captions?.cues[0]?.secondaryText, 'hello world');
assert.deepEqual(
  [captionTrack.captions?.cues[0]?.startFrame, captionTrack.captions?.cues[0]?.endFrameExclusive],
  [0, 60],
);

const collisionState: TimelineState = {
  fps: 30, width: 1280, height: 720, selectedId: null,
  trackOrder: ['V1'], tracks: { V1: { kind: 'video' } },
  items: [
    { id: 'a', track: 'V1', startFrame: 0, durationInFrames: 30, name: 'A', kind: 'video', src: '/media/uploads/a.mp4' },
    { id: 'b', track: 'V1', startFrame: 20, durationInFrames: 30, name: 'B', kind: 'video', src: '/media/uploads/b.mp4' },
  ],
};
assert.ok(toNeutralTimeline(collisionState).diagnostics.some((diagnostic) => diagnostic.code === 'same-track-overlap'));

const transitionState: TimelineState = {
  fps: 30, width: 1280, height: 720, selectedId: null,
  trackOrder: ['V1'], tracks: { V1: { kind: 'video' } },
  items: [
    { id: 'out', track: 'V1', startFrame: 0, durationInFrames: 30, name: 'out', kind: 'video', src: '/media/uploads/a.mp4' },
    { id: 'in', track: 'V1', startFrame: 30, durationInFrames: 30, name: 'in', kind: 'video', src: '/media/uploads/b.mp4' },
  ],
  transitions: [{
    id: 'transition', type: 'custom-shader', trackId: 'V1', outgoingItemId: 'out', incomingItemId: 'in',
    durationInFrames: 10, customFrag: 'void main() {}', customUniforms: { u_amount: 1 },
  }],
};
const convertedTransition = toNeutralTimeline(transitionState).transitions[0]!;
assert.equal(convertedTransition.outgoingClipId, 'out');
assert.equal(convertedTransition.incomingClipId, 'in');
assert.equal(convertedTransition.custom?.fragmentShader, 'void main() {}');

const invalid = { ...neutral, version: 2 };
assert.match(neutralTimelineV1Errors(invalid).join('\n'), /version must be 1/);

const invalidVolumeState: TimelineState = {
  ...state,
  items: state.items.map((item) => item.id === 'speech' ? { ...item, volume: Number.NaN } : item),
};
assert.throws(
  () => toNeutralTimeline(invalidVolumeState),
  /audio\.volume must be a finite non-negative number/,
  'NaN must be rejected before JSON serialization can silently turn it into null',
);
const invalidVisualState: TimelineState = {
  ...state,
  items: state.items.map((item) => item.id === 'picture'
    ? { ...item, transform: { ...item.transform, x: Number.POSITIVE_INFINITY } }
    : item),
};
assert.throws(() => toNeutralTimeline(invalidVisualState), /visual\.x must be a finite number/);
const invalidKeyframeState: TimelineState = {
  ...state,
  items: state.items.map((item) => item.id === 'picture'
    ? { ...item, keyframes: { ...item.keyframes, x: [{ frame: 0, value: Number.NaN }] } }
    : item),
};
assert.throws(() => toNeutralTimeline(invalidKeyframeState), /keyframes\.x\[0\].*finite value/);

const outsideCaptionState: TimelineState = {
  fps: 30,
  width: 640,
  height: 360,
  selectedId: null,
  trackOrder: ['caption-only'],
  tracks: {
    'caption-only': {
      kind: 'caption',
      captions: {
        enabled: true,
        template: 'plain',
        pacing: 'phrase',
        words: [{ text: '超出时间线。', start: 0, end: 2_000 }],
      },
    },
  },
  items: [],
};
const outsideCaption = toNeutralTimeline(outsideCaptionState);
assert.equal(outsideCaption.durationFrames, 30);
assert.equal(outsideCaption.tracks[0]?.captions?.cues[0]?.endFrameExclusive, 60);
assert.ok(
  outsideCaption.diagnostics.some((diagnostic) => diagnostic.code === 'caption-outside-timeline'),
  'an out-of-range cue remains convertible and carries an explicit warning',
);
assertNeutralTimelineV1(outsideCaption);

const nonFiniteCue = structuredClone(outsideCaption);
nonFiniteCue.tracks[0]!.captions!.cues[0]!.startFrame = Number.NaN;
assert.match(neutralTimelineV1Errors(nonFiniteCue).join('\n'), /caption cue 0 is invalid/);
const reversedCue = structuredClone(outsideCaption);
reversedCue.tracks[0]!.captions!.cues[0]!.startFrame = 10;
reversedCue.tracks[0]!.captions!.cues[0]!.endFrameExclusive = 10;
assert.match(neutralTimelineV1Errors(reversedCue).join('\n'), /caption cue 0 is invalid/);

console.log('neutral timeline checks passed');
