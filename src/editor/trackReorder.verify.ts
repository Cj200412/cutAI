import assert from 'node:assert/strict';
import { reduce } from './reduce';
import { previewTrackReorder, reducerOrderForTrackDrop } from './trackReorder';
import { timelineTrackIds, type TimelineState, type TrackId } from './types';

const base: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  items: [],
  trackOrder: ['caption_a', 'caption_b', 'video_top', 'video_mid', 'video_main', 'audio_a', 'audio_b'],
  tracks: {
    caption_a: { kind: 'caption' },
    caption_b: { kind: 'caption' },
    video_top: { kind: 'video' },
    video_mid: { kind: 'video' },
    video_main: { kind: 'video' },
    audio_a: { kind: 'audio' },
    audio_b: { kind: 'audio' },
  },
};

const drop = (track: TrackId, visualIndex: number): TrackId[] => timelineTrackIds(reduce(base, {
  type: 'track.update',
  track,
  patch: { order: reducerOrderForTrackDrop(base, track, visualIndex) },
}));

assert.deepEqual(
  previewTrackReorder(base, 'video_main', 0),
  ['caption_a', 'caption_b', 'video_main', 'video_top', 'video_mid', 'audio_a', 'audio_b'],
  'preview keeps kind groups and moves a video lane to the visual top',
);
assert.deepEqual(drop('video_main', 0), previewTrackReorder(base, 'video_main', 0),
  'video top drop converts to the bottom-up reducer order');
assert.deepEqual(drop('video_top', 2), previewTrackReorder(base, 'video_top', 2),
  'video bottom drop converts to the bottom-up reducer order');
assert.deepEqual(drop('video_top', 1), previewTrackReorder(base, 'video_top', 1),
  'video middle drop converts to the bottom-up reducer order');
assert.deepEqual(drop('audio_b', 0), previewTrackReorder(base, 'audio_b', 0),
  'audio order remains top-down');
assert.deepEqual(drop('caption_a', 1), previewTrackReorder(base, 'caption_a', 1),
  'caption order remains top-down');

console.log('trackReorder.verify: ok');
