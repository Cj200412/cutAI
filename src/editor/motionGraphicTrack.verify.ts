import assert from 'node:assert/strict';
import { validateGenericAdd } from '../agent/tools/edit-item-generic';
import { docFromTimeline } from '../persist/projectStore';
import type { Tpl } from '../types';
import { makeDraft } from './store';
import {
  isPureMotionGraphicTrack,
  MOTION_GRAPHIC_TRACK_NAME,
  timelineTrackIds,
  trackAlias,
  trackKind,
  type MediaAsset,
  type TimelineItem,
  type TimelineState,
} from './types';

const tpl: Tpl = {
  id: 'mg_test',
  name: 'Test MG',
  category: 'title-cards',
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 60,
  props: {},
  propSchema: [],
  thumb: null,
  code: 'const Component = () => null;',
};

const video = (id: string, track: string): TimelineItem => ({
  id,
  track,
  startFrame: 0,
  durationInFrames: 90,
  name: id,
  kind: 'video',
  src: `/media/${id}.mp4`,
});

const stateWith = (items: TimelineItem[]): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['visual_top', 'visual_main'],
  tracks: {
    visual_top: { kind: 'video' },
    visual_main: { kind: 'video' },
  },
  items,
});

const mgAsset = (): MediaAsset => ({
  id: 'asset_mg',
  name: 'Generated MG',
  kind: 'motion-graphic',
  src: '',
  durationInFrames: 45,
  code: tpl.code,
});

const ordinaryVideoAsset = (): MediaAsset => ({
  id: 'asset_video',
  name: 'Ordinary video',
  kind: 'video',
  src: '/media/ordinary.mp4',
  durationInFrames: 30,
});

// Automatic UI/store placement reuses the empty top visual lane, names it, and
// keeps using it for subsequent MG clips.
{
  const draft = makeDraft(docFromTimeline(stateWith([video('main', 'visual_main')])));
  const firstTrack = draft.commands.addMotionGraphic(tpl);
  const secondTrack = draft.commands.addMotionGraphic(tpl);
  assert.equal(firstTrack, 'visual_top');
  assert.equal(secondTrack, firstTrack);
  assert.equal(draft.getState().tracks?.[firstTrack]?.name, MOTION_GRAPHIC_TRACK_NAME);
  assert.ok(isPureMotionGraphicTrack(draft.getState(), firstTrack));
  assert.equal(timelineTrackIds(draft.getState()).length, 2, 'reusing MG lane must not create duplicates');
  const videoItemId = draft.commands.addMediaItem(ordinaryVideoAsset());
  const videoItem = draft.getState().items.find((entry) => entry.id === videoItemId);
  assert.equal(videoItem?.track, 'visual_main', 'ordinary video must not auto-place on the named MG lane');
}

// A user-named empty lane is intentional and must never be hijacked/renamed.
{
  const state = stateWith([video('main', 'visual_main')]);
  state.tracks!.visual_top = { kind: 'video', name: 'B-roll' };
  const draft = makeDraft(docFromTimeline(state));
  const track = draft.commands.addMotionGraphic(tpl);
  assert.notEqual(track, 'visual_top');
  assert.equal(draft.getState().tracks?.visual_top?.name, 'B-roll');
  assert.equal(draft.getState().tracks?.[track]?.name, MOTION_GRAPHIC_TRACK_NAME);
}

// Pool/generated MG assets use the same automatic lane path as templates.
{
  const draft = makeDraft(docFromTimeline(stateWith([video('main', 'visual_main')])));
  const asset = mgAsset();
  draft.commands.addAsset(asset);
  const itemId = draft.commands.addMediaItem(asset);
  const item = draft.getState().items.find((entry) => entry.id === itemId);
  assert.equal(item?.track, 'visual_top');
  assert.equal(draft.getState().tracks?.visual_top?.name, MOTION_GRAPHIC_TRACK_NAME);
  const ordinaryId = draft.commands.addMediaItem(ordinaryVideoAsset());
  assert.equal(draft.getState().items.find((item) => item.id === ordinaryId)?.track, 'visual_main',
    'ordinary media must not enter an unnamed legacy pure-MG lane');
}

// Seed-style projects keep MG above the main V1 lane.
{
  const seedState: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    trackOrder: ['V2', 'V1'],
    tracks: {
      V2: { kind: 'video', name: MOTION_GRAPHIC_TRACK_NAME },
      V1: { kind: 'video' },
    },
    items: [{
      id: 'seed_mg', track: 'V2', startFrame: 0, durationInFrames: 30,
      name: 'Seed MG', kind: 'motion-graphic', code: tpl.code,
    }],
  };
  const draft = makeDraft(docFromTimeline(seedState));
  const ordinaryId = draft.commands.addMediaItem(ordinaryVideoAsset());
  const ordinaryTrack = draft.getState().items.find((item) => item.id === ordinaryId)?.track;
  assert.ok(ordinaryTrack);
  assert.equal(trackAlias(draft.getState(), ordinaryTrack), 'V1');
  assert.notEqual(draft.getState().tracks?.[ordinaryTrack]?.name, MOTION_GRAPHIC_TRACK_NAME);
}

// Explicit targets fail loudly instead of returning success for a missing or
// locked lane whose reducer would reject the add.
{
  const missing = makeDraft(docFromTimeline(stateWith([])));
  assert.throws(() => missing.commands.addMotionGraphic(tpl, { track: 'missing' }), /not found/);

  const lockedState = stateWith([]);
  lockedState.tracks!.visual_top = { kind: 'video', locked: true };
  const locked = makeDraft(docFromTimeline(lockedState));
  assert.throws(() => locked.commands.addMotionGraphic(tpl, { track: 'visual_top' }), /locked/);
}

// An explicit target is user intent: place there without renaming the video lane.
{
  const draft = makeDraft(docFromTimeline(stateWith([video('main', 'visual_main')])));
  const track = draft.commands.addMotionGraphic(tpl, { track: 'visual_main' });
  assert.equal(track, 'visual_main');
  assert.equal(draft.getState().tracks?.visual_main?.name, undefined);
}

// If every visual lane is occupied, automatic placement creates a new top
// video-kind lane whose semantic name is MG 动画.
{
  const draft = makeDraft(docFromTimeline(stateWith([
    video('top', 'visual_top'),
    video('main', 'visual_main'),
  ])));
  const track = draft.commands.addMotionGraphic(tpl);
  assert.notEqual(track, 'visual_top');
  assert.notEqual(track, 'visual_main');
  assert.equal(trackKind(draft.getState(), track), 'video');
  assert.equal(draft.getState().tracks?.[track]?.name, MOTION_GRAPHIC_TRACK_NAME);
  assert.equal(timelineTrackIds(draft.getState())[0], track, 'new MG overlay lane is topmost');
}

// Old unnamed pure-MG lanes are recognized and upgraded instead of duplicated.
{
  const legacyMg: TimelineItem = {
    id: 'legacy_mg',
    track: 'visual_top',
    startFrame: 0,
    durationInFrames: 30,
    name: 'Legacy MG',
    kind: 'motion-graphic',
    code: tpl.code,
  };
  const draft = makeDraft(docFromTimeline(stateWith([legacyMg, video('main', 'visual_main')])));
  assert.ok(isPureMotionGraphicTrack(draft.getState(), 'visual_top'));
  const track = draft.commands.addMotionGraphic(tpl);
  assert.equal(track, 'visual_top');
  assert.equal(draft.getState().tracks?.visual_top?.name, MOTION_GRAPHIC_TRACK_NAME);
}

// Generic edit_item validation leaves an omitted MG track unresolved so the
// central store selector can choose the named lane; explicit targets stay exact.
{
  const state = stateWith([video('main', 'visual_main')]);
  const asset = mgAsset();
  const automatic = validateGenericAdd(state, [asset], { type: 'motion-graphic', assetId: asset.id });
  assert.equal(automatic.plan, 'addMedia');
  assert.equal(Object.hasOwn(automatic, 'track'), false);
  const explicit = validateGenericAdd(state, [asset], {
    type: 'motion-graphic', assetId: asset.id, trackId: 'visual_main',
  });
  assert.equal(explicit.track, 'visual_main');
  const invalid = validateGenericAdd(state, [asset], {
    type: 'motion-graphic', assetId: asset.id, trackId: 'missing',
  });
  assert.match(String(invalid.error), /no compatible video track/);

  const videoAsset = ordinaryVideoAsset();
  const automaticVideo = validateGenericAdd(state, [videoAsset], {
    type: 'video', assetId: videoAsset.id,
  });
  assert.equal(Object.hasOwn(automaticVideo, 'track'), false,
    'ordinary auto-placement also delegates to the central lane selector');
  const lockedState = stateWith([]);
  lockedState.tracks!.visual_main = { kind: 'video', locked: true };
  const locked = validateGenericAdd(lockedState, [videoAsset], {
    type: 'video', assetId: videoAsset.id, trackId: 'visual_main',
  });
  assert.match(String(locked.error), /locked/);
}

console.log('motionGraphicTrack.verify: ok');
