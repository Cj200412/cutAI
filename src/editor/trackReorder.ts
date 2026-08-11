import {
  timelineTrackIds,
  trackKind,
  type TimelineState,
  type TrackId,
  type TrackKind,
} from './types';

const TRACK_KIND_ORDER: readonly TrackKind[] = ['caption', 'video', 'audio'];

/** Track ids of the source lane's kind, in visual top-to-bottom order. */
export function sameKindTrackIds(state: TimelineState, sourceTrackId: TrackId): TrackId[] {
  const kind = trackKind(state, sourceTrackId);
  return timelineTrackIds(state).filter((id) => trackKind(state, id) === kind);
}

/**
 * Preview a header drag using a visual (top-to-bottom) insertion index.
 * Track kinds remain grouped because caption/video/audio lanes have different
 * rendering and alias semantics.
 */
export function previewTrackReorder(
  state: TimelineState,
  sourceTrackId: TrackId,
  visualInsertIndex: number,
): TrackId[] {
  const sourceKind = trackKind(state, sourceTrackId);
  const groups = Object.fromEntries(TRACK_KIND_ORDER.map((kind) => [
    kind,
    timelineTrackIds(state).filter((id) => id !== sourceTrackId && trackKind(state, id) === kind),
  ])) as Record<TrackKind, TrackId[]>;
  const lane = groups[sourceKind];
  const index = Math.max(0, Math.min(Math.round(visualInsertIndex), lane.length));
  lane.splice(index, 0, sourceTrackId);
  return TRACK_KIND_ORDER.flatMap((kind) => groups[kind]);
}

/**
 * Convert a visual header-drop index into the reducer's existing `order`
 * contract. Video aliases count bottom-up (V1 is the bottom video lane), while
 * caption/audio aliases count top-down.
 */
export function reducerOrderForTrackDrop(
  state: TimelineState,
  sourceTrackId: TrackId,
  visualInsertIndex: number,
): number {
  const kind = trackKind(state, sourceTrackId);
  const remaining = sameKindTrackIds(state, sourceTrackId).filter((id) => id !== sourceTrackId);
  const index = Math.max(0, Math.min(Math.round(visualInsertIndex), remaining.length));
  return kind === 'video' ? remaining.length - index : index;
}
