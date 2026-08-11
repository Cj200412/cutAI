// Collision-safe placement for interactive timeline moves.
//
// This deliberately applies only to dragging existing clips. Add/overwrite and
// reducer semantics stay unchanged: the pointer preview asks for the closest
// legal frame delta, then commits that exact same delta on release.
import {
  timelineTrackIds,
  trackKind,
  type TimelineItem,
  type TimelineState,
  type TrackId,
} from './types';

export interface MoveTrackShift {
  from: TrackId;
  to: TrackId;
}

/**
 * Keep a multi-selection's lane geometry intact. If one movable member cannot
 * apply the same relative lane shift (for example at the top/bottom boundary),
 * reject the vertical part for the whole group instead of collapsing members
 * onto one track.
 */
export function legalMoveTrackShift(
  state: TimelineState,
  ids: readonly string[],
  requested: MoveTrackShift | null,
): MoveTrackShift | null {
  if (!requested || requested.from === requested.to) return null;
  const order = timelineTrackIds(state);
  const fromIdx = order.indexOf(requested.from);
  const toIdx = order.indexOf(requested.to);
  if (
    fromIdx < 0
    || toIdx < 0
    || trackKind(state, requested.from) !== trackKind(state, requested.to)
  ) return null;

  const idSet = new Set(ids);
  const delta = toIdx - fromIdx;
  const moving = state.items.filter(
    (item) => idSet.has(item.id) && !state.tracks?.[item.track]?.locked,
  );
  if (!moving.length) return null;

  const canShiftAll = moving.every((item) => {
    const itemIdx = order.indexOf(item.track);
    const destination = order[itemIdx + delta];
    return itemIdx >= 0
      && !!destination
      && trackKind(state, destination) === trackKind(state, item.track)
      && !state.tracks?.[destination]?.locked;
  });
  return canShiftAll ? requested : null;
}

/** Resolve one group member's destination using the same relative lane shift as the grabbed clip. */
export function moveDestinationTrack(
  state: TimelineState,
  item: TimelineItem,
  trackShift: MoveTrackShift | null,
): TrackId {
  if (!trackShift) return item.track;
  const order = timelineTrackIds(state);
  const fromIdx = order.indexOf(trackShift.from);
  const toIdx = order.indexOf(trackShift.to);
  if (fromIdx < 0 || toIdx < 0) return item.track;

  const candidate = order[order.indexOf(item.track) + toIdx - fromIdx];
  if (
    candidate
    && trackKind(state, candidate) === trackKind(state, item.track)
    && !state.tracks?.[candidate]?.locked
  ) {
    return candidate;
  }
  return item.track;
}

interface ClosedInterval {
  lo: number;
  hi: number;
}

function mergeClosedIntervals(intervals: ClosedInterval[]): ClosedInterval[] {
  const sorted = intervals
    .filter((range) => range.lo <= range.hi)
    .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const merged: ClosedInterval[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    // Adjacent integer ranges can be merged too: there is no legal frame
    // between [..., n] and [n + 1, ...].
    if (previous && range.lo <= previous.hi + 1) {
      previous.hi = Math.max(previous.hi, range.hi);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Find the closest integer delta that keeps every movable selected clip out of
 * stationary clips on its destination track. Touching edges are legal. Clips
 * on different tracks never constrain one another.
 */
export function closestLegalMoveDelta(
  state: TimelineState,
  ids: readonly string[],
  desiredDelta: number,
  trackShift: MoveTrackShift | null = null,
): number {
  const requestedIds = new Set(ids);
  const moving = state.items.filter(
    (item) => requestedIds.has(item.id) && !state.tracks?.[item.track]?.locked,
  );
  if (!moving.length) return 0;

  const legalTrackShift = legalMoveTrackShift(state, ids, trackShift);

  const movingIds = new Set(moving.map((item) => item.id));
  const minimumDelta = -Math.min(...moving.map((item) => item.startFrame));
  const desired = Math.max(minimumDelta, Math.round(desiredDelta));
  const forbidden: ClosedInterval[] = [];

  for (const item of moving) {
    const destination = moveDestinationTrack(state, item, legalTrackShift);
    const movingStart = item.startFrame;
    const movingEnd = item.startFrame + item.durationInFrames;
    for (const obstacle of state.items) {
      if (movingIds.has(obstacle.id) || obstacle.track !== destination) continue;

      // Half-open clips [start, end) overlap when:
      //   movingStart + delta < obstacleEnd
      //   movingEnd   + delta > obstacleStart
      // Frames are integral, giving this inclusive forbidden delta range.
      const lo = obstacle.startFrame - movingEnd + 1;
      const hi = obstacle.startFrame + obstacle.durationInFrames - movingStart - 1;
      if (lo <= hi) forbidden.push({ lo, hi });
    }
  }

  const merged = mergeClosedIntervals(forbidden);
  const blocked = merged.find((range) => desired >= range.lo && desired <= range.hi);
  if (!blocked) return desired;

  const before = blocked.lo - 1;
  const after = blocked.hi + 1;
  if (before < minimumDelta) return after;
  return desired - before <= after - desired ? before : after;
}
