// Runnable check: `npx tsx src/editor/trackPlacement.verify.ts`.
import assert from 'node:assert/strict';
import { moveItemsByDelta } from './multiSelect';
import { closestLegalMoveDelta, legalMoveTrackShift } from './trackPlacement';
import type { TimelineItem, TimelineState, TrackId } from './types';

const clip = (id: string, track: TrackId, startFrame: number, durationInFrames: number): TimelineItem => ({
  id,
  track,
  startFrame,
  durationInFrames,
  name: id,
  kind: 'video',
});

const stateOf = (items: TimelineItem[]): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  items,
  trackOrder: ['V2', 'V1'],
  tracks: { V2: { kind: 'video' }, V1: { kind: 'video' } },
  selectedId: null,
  selectedIds: [],
});

// Single-clip dragging chooses the nearest free edge; touching is not overlap.
{
  const state = stateOf([clip('moving', 'V1', 0, 10), clip('fixed', 'V1', 20, 10)]);
  assert.equal(closestLegalMoveDelta(state, ['moving'], 15), 10, 'nearest legal gap is before fixed clip');
  assert.equal(closestLegalMoveDelta(state, ['moving'], 29), 30, 'nearest legal gap is after fixed clip');
  assert.equal(closestLegalMoveDelta(state, ['moving'], 10), 10, 'edge-touch before obstacle remains legal');
  assert.equal(closestLegalMoveDelta(state, ['moving'], 30), 30, 'edge-touch after obstacle remains legal');
}

// A multi-selection keeps one shared delta and avoids obstacles for every member.
{
  const state = stateOf([
    clip('a', 'V1', 0, 10),
    clip('b', 'V1', 20, 10),
    clip('fixed', 'V1', 50, 10),
  ]);
  const delta = closestLegalMoveDelta(state, ['a', 'b'], 35);
  assert.equal(delta, 40, 'all group members share the nearest delta that is legal for each of them');
  const next = moveItemsByDelta(state, ['a', 'b'], delta, null);
  assert.deepEqual(
    next.items.filter((item) => item.id === 'a' || item.id === 'b').map((item) => item.startFrame),
    [40, 60],
    'commit uses the exact delta shown by the drag preview',
  );
}

// Only clips on the destination track constrain placement. Other tracks may overlap in time.
{
  const state = stateOf([clip('moving', 'V1', 0, 10), clip('other-lane', 'V2', 0, 100)]);
  assert.equal(closestLegalMoveDelta(state, ['moving'], 40), 40);
}

// A vertical move checks the destination lane, then the commit reuses that result.
{
  const state = stateOf([clip('moving', 'V2', 0, 10), clip('fixed', 'V1', 20, 10)]);
  const shift = { from: 'V2', to: 'V1' };
  const delta = closestLegalMoveDelta(state, ['moving'], 15, shift);
  assert.equal(delta, 10);
  const next = moveItemsByDelta(state, ['moving'], delta, shift);
  const moved = next.items.find((item) => item.id === 'moving')!;
  assert.deepEqual({ track: moved.track, startFrame: moved.startFrame }, { track: 'V1', startFrame: 10 });
}

// Group movement cannot distort relative timing by clamping members independently at frame zero.
{
  const state = stateOf([clip('a', 'V1', 3, 5), clip('b', 'V1', 10, 5)]);
  assert.equal(closestLegalMoveDelta(state, ['a', 'b'], -20), -3);
}

// If one selected lane would fall outside the video group, reject the whole
// vertical shift so two selected clips cannot collapse onto the same lane.
{
  const state = stateOf([clip('upper', 'V2', 0, 10), clip('lower', 'V1', 20, 10)]);
  const requested = { from: 'V2' as TrackId, to: 'V1' as TrackId };
  assert.equal(legalMoveTrackShift(state, ['upper', 'lower'], requested), null);
  const next = moveItemsByDelta(state, ['upper', 'lower'], 5, requested);
  assert.deepEqual(
    next.items.map((item) => ({ id: item.id, track: item.track, start: item.startFrame })),
    [
      { id: 'upper', track: 'V2', start: 5 },
      { id: 'lower', track: 'V1', start: 25 },
    ],
  );
}

console.log('trackPlacement.verify: ok (single/group gaps, cross-track isolation, destination collision, frame-zero/lane-boundary clamps)');
