import assert from 'node:assert/strict';
import { projectReduce } from '../editor/reduce';
import type { ProjectDoc, Timeline } from '../editor/types';
import { buildOperation, buildProposal, compactOperations, previewProposalSelection } from './proposal';

const denoise = (src: string | null) => buildOperation(
  'isolate_voice',
  { itemId: 'clip-1' },
  [{ type: 'setItemDenoise', id: 'clip-1', denoisedSrc: src, strength: 10 }],
);

const compacted = compactOperations([
  denoise('/voice-a.m4a'),
  denoise(null),
  denoise('/voice-b.m4a'),
  denoise(null),
]);
assert.equal(compacted.length, 1);
assert.equal(compacted[0].callCount, 4);
assert.equal(compacted[0].actions.length, 4);
assert.equal(compacted[0].action, '人声隔离');
assert.equal(compacted[0].impact, '4 处改动');

const distinctArguments = compactOperations([
  buildOperation('edit_captions', { itemId: 'clip-1', text: 'First' }, [{ type: 'setItemDenoise', id: 'clip-1', denoisedSrc: '/first.m4a', strength: 10 }]),
  buildOperation('edit_captions', { text: 'Second', itemId: 'clip-1' }, [{ type: 'setItemDenoise', id: 'clip-1', denoisedSrc: '/second.m4a', strength: 10 }]),
]);
assert.equal(distinctArguments.length, 2, 'different edits to one target must remain separately reviewable');

const reorderedArguments = compactOperations([
  buildOperation('edit_captions', { itemId: 'clip-1', text: 'Same' }, [{ type: 'setItemDenoise', id: 'clip-1', denoisedSrc: '/first.m4a', strength: 10 }]),
  buildOperation('edit_captions', { text: 'Same', itemId: 'clip-1' }, [{ type: 'setItemDenoise', id: 'clip-1', denoisedSrc: '/second.m4a', strength: 10 }]),
]);
assert.equal(reorderedArguments.length, 1, 'argument key order must not prevent duplicate compaction');

const separated = compactOperations([
  denoise('/voice-a.m4a'),
  buildOperation('move_item', { itemId: 'clip-1' }, [{ type: 'move', id: 'clip-1', startFrame: 10 }]),
  denoise(null),
]);
assert.equal(separated.length, 3);

const timeline = { id: 'tl-1', name: 'Timeline', order: 0 } as Timeline;
const doc: ProjectDoc = {
  version: 3,
  assets: [],
  mediaFolders: [],
  timelines: [timeline],
  activeTimelineId: timeline.id,
};
assert.equal(projectReduce(doc, { type: 'tl.switch', id: timeline.id }), doc);

const previewTimeline: Timeline = {
  id: 'tl-preview',
  name: 'Preview',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['V1'],
  tracks: { V1: { kind: 'video' } },
  items: [],
};
const previewDoc: ProjectDoc = {
  version: 3,
  assets: [],
  mediaFolders: [],
  timelines: [previewTimeline],
  activeTimelineId: previewTimeline.id,
};
const first = buildOperation('edit_item', { name: 'First' }, [{
  type: 'add',
  startFrame: 0,
  item: {
    id: 'first', track: 'V1', durationInFrames: 30, name: 'First', kind: 'solid',
    width: 1920, height: 1080, props: { color: '#111111' },
  },
}]);
const second = buildOperation('edit_item', { name: 'Second' }, [{
  type: 'add',
  startFrame: 30,
  item: {
    id: 'second', track: 'V1', durationInFrames: 30, name: 'Second', kind: 'solid',
    width: 1920, height: 1080, props: { color: '#222222' },
  },
}]);
const previewProposal = buildProposal([first, second], 'Preview selection', previewDoc, previewTimeline);
assert.deepEqual(previewProposalSelection(previewProposal, new Set([0])).items.map((item) => item.id), ['first']);
assert.deepEqual(previewProposalSelection(previewProposal, new Set([1])).items.map((item) => item.id), ['second']);
assert.deepEqual(previewProposalSelection(previewProposal, new Set()).items, [],
  'clearing every checkbox must restore the proposal base preview');
assert.deepEqual(previewProposalSelection(previewProposal, new Set([0, 1])).items.map((item) => item.id), ['first', 'second']);

console.log('proposal compaction checks passed');
