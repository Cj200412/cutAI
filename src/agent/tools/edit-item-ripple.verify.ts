import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { TimelineState } from '../../editor/types';
import { genericAddPlacement, validateGenericAdd } from './edit-item-generic';
import { rippleBatchInsertionConflict } from './edit-item-ripple';

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['video_main'],
  tracks: { video_main: { kind: 'video' } },
  assets: [{
    id: 'pool_new',
    name: 'New pool clip',
    kind: 'video',
    src: '/media/new.mp4',
    durationInFrames: 30,
  }],
  items: [{
    id: 'existing',
    track: 'video_main',
    startFrame: 20,
    durationInFrames: 20,
    name: 'Existing',
    kind: 'video',
    src: '/media/existing.mp4',
  }],
};

const draft = makeDraft(docFromTimeline(state));
const asset = draft.getDoc().assets[0]!;
const plan = validateGenericAdd(draft.getState(), draft.getDoc().assets, {
  type: 'video', assetId: 'pool_new', trackId: 'video_main', fromFrame: 10,
});
assert.equal(plan.ok, true);
const options = genericAddPlacement(plan, true);
assert.deepEqual(options, { track: 'video_main', startFrame: 10, ripple: true });
draft.commands.addMediaItem(asset, options);
const after = draft.getState();
assert.equal(after.items.find((item) => item.id === 'existing')?.startFrame, 50,
  'pool media add forwards batch ripple and pushes the later clip');
assert.equal(after.items.find((item) => item.id !== 'existing')?.startFrame, 10);

const crossingState: TimelineState = {
  ...state,
  items: [{
    id: 'long-existing',
    track: 'video_main',
    startFrame: 0,
    durationInFrames: 100,
    name: 'Long existing',
    kind: 'video',
    src: '/media/long.mp4',
  }],
};
const crossingPlan = validateGenericAdd(crossingState, crossingState.assets ?? [], {
  type: 'video', assetId: 'pool_new', trackId: 'video_main', fromFrame: 50,
});
assert.match(
  rippleBatchInsertionConflict(crossingState, [crossingPlan], true)?.error ?? '',
  /inside item long-existing.*split the clip first/,
  'ripple insertion inside a long clip is rejected instead of creating an overlap',
);
assert.equal(rippleBatchInsertionConflict(crossingState, [{ ...crossingPlan, startFrame: 100 }], true), null,
  'touching the existing clip end is a legal ripple insertion boundary');

const emptyState: TimelineState = { ...state, items: [] };
const firstBatchAdd = validateGenericAdd(emptyState, emptyState.assets ?? [], {
  type: 'video', assetId: 'pool_new', trackId: 'video_main', fromFrame: 0, durationInFrames: 100,
});
const overlappingBatchAdd = validateGenericAdd(emptyState, emptyState.assets ?? [], {
  type: 'video', assetId: 'pool_new', trackId: 'video_main', fromFrame: 50, durationInFrames: 20,
});
assert.deepEqual(
  rippleBatchInsertionConflict(emptyState, [firstBatchAdd, overlappingBatchAdd], true),
  {
    planIndex: 1,
    error: 'ripple insertion frame 50 is inside item planned-add-0 on track video_main; choose an existing clip boundary or split the clip first',
  },
  'later adds in one ripple batch are validated against earlier planned clips',
);
assert.equal(
  rippleBatchInsertionConflict(emptyState, [overlappingBatchAdd, firstBatchAdd], true),
  null,
  'an earlier-frame insert may legally ripple a previously planned later clip forward',
);

const sequentialFirst = validateGenericAdd(state, state.assets ?? [], {
  type: 'video', assetId: 'pool_new', trackId: 'video_main', fromFrame: 0, durationInFrames: 20,
});
const sequentialSecond = validateGenericAdd(state, state.assets ?? [], {
  type: 'video', assetId: 'pool_new', trackId: 'video_main', fromFrame: 30, durationInFrames: 5,
});
assert.match(rippleBatchInsertionConflict(state, [sequentialSecond], true)?.error ?? '', /inside item existing/,
  'the original state alone would reject the second insertion');
assert.equal(rippleBatchInsertionConflict(state, [sequentialFirst, sequentialSecond], true), null,
  'ordered validation observes the first ripple shift before checking the second insertion');

const implicitMain = validateGenericAdd(emptyState, emptyState.assets ?? [], {
  type: 'video', assetId: 'pool_new', fromFrame: 0, durationInFrames: 100,
});
const implicitMg: Record<string, unknown> = {
  ok: true,
  kind: 'motion-graphic',
  plan: 'addMg',
  templateId: 'mg_test',
  startFrame: 50,
  durationInFrames: 20,
};
assert.equal(rippleBatchInsertionConflict(emptyState, [implicitMain, implicitMg], true), null,
  'implicit main media and MG dynamically select separate lanes after the first add');

console.log('edit-item-ripple.verify: ok (forwarding, boundaries, ordered state/lane simulation)');
