import assert from 'node:assert/strict';
import type { DisplayMessage } from '../../agent/useAgent';
import { groupMessages } from './message-groups';
import {
  aggregateToolResultStates,
  classifyToolResult,
  extractToolMedia,
  hasToolResultError,
  presentToolResult,
} from './tool-result';

assert.equal(hasToolResultError(undefined), false);
assert.equal(hasToolResultError('.cutai/project.json'), false);
assert.equal(hasToolResultError(['.cutai/project.json']), false);
assert.equal(hasToolResultError({ status: 'completed' }), false);
assert.equal(hasToolResultError({ error: 'failed' }), true);
assert.equal(classifyToolResult({ status: 'queued' }), 'pending');
assert.equal(classifyToolResult({ denied: true, note: 'No' }), 'denied');
assert.equal(classifyToolResult({ ok: true, reports: [{ status: 'failed', error: 'render failed' }] }), 'failed');
assert.equal(classifyToolResult({ ok: true, reports: [{ status: 'succeeded' }, { status: 'failed' }] }), 'partial');
assert.equal(classifyToolResult({ ok: true, status: 'partial' }), 'partial');
assert.equal(classifyToolResult({ ok: true, assets: [{ status: 'running' }] }), 'pending');
assert.equal(classifyToolResult({ ok: false, assets: [{ status: 'running' }], stillRunning: ['a'] }), 'pending');
assert.equal(classifyToolResult({ ok: false, assets: [{ status: 'succeeded' }] }), 'partial');
assert.equal(classifyToolResult({ ok: true, assets: [{ status: 'succeeded' }, { status: 'failed' }] }), 'partial');
assert.equal(classifyToolResult({ ok: true, jobs: [{ status: 'failed', error: 'render failed' }] }), 'failed');
assert.equal(classifyToolResult({ ok: true, jobs: [{ status: 'running' }, { status: 'completed' }] }), 'partial');
assert.equal(classifyToolResult({ ok: true, jobs: [{ status: 'completed' }, { error: 'not found' }] }), 'partial');
assert.equal(classifyToolResult({ ok: true, jobs: [{ error: 'not found' }] }), 'failed');
assert.equal(classifyToolResult({ failed: 2, succeeded: 0, results: [{ success: false }, { success: false }] }), 'failed');
assert.equal(classifyToolResult({ failed: 1, succeeded: 1 }), 'partial');
assert.equal(classifyToolResult({ ok: true, exported: ['one'], failed: [{ error: 'two failed' }] }), 'partial');
assert.equal(classifyToolResult({ ok: true, errors: ['one row failed'] }), 'partial');
assert.equal(aggregateToolResultStates([{ status: 'queued' }, { status: 'queued' }]), 'pending');
assert.equal(aggregateToolResultStates([{ status: 'completed' }, { status: 'failed' }]), 'partial');
assert.equal(presentToolResult('track_export', {
  ok: true, jobs: [{ status: 'failed', error: 'batch render failed' }],
}).message, 'batch render failed');

assert.deepEqual(extractToolMedia('submit_image', {
  ok: true,
  generated: [
    { assetId: 'image-1', name: 'Hero', src: '/media/hero.png', width: 1024, height: 1024 },
    { assetId: 'image-missing-src', name: 'Incomplete' },
  ],
}), [{
  key: 'image-1', kind: 'image', assetId: 'image-1', name: 'Hero',
  src: '/media/hero.png', width: 1024, height: 1024,
}]);
assert.equal(extractToolMedia('read_project', { src: '/media/private.png', kind: 'image' }).length, 0,
  'read/diagnostic fields must never become generated previews');
assert.equal(extractToolMedia('submit_voice', {
  ok: true, assetId: 'voice-1', name: 'Narration', src: '/media/voice.mp3',
})[0]?.kind, 'audio');
assert.deepEqual(extractToolMedia('track_progress', {
  ok: true,
  reports: [{ status: 'succeeded', result: { assetId: 'hidden', src: '/media/hidden.mp4', kind: 'video' } }],
  addedAssets: [{ assetId: 'video-1', name: 'Shot', src: '/media/shot.mp4', kind: 'video' }],
}).map((item) => item.assetId), ['video-1']);
assert.equal(presentToolResult('submit_image', {
  error: 'provider failed', generated: [{ assetId: 'bad', src: '/media/bad.png' }],
}).media.length, 0, 'failed generation must not render a finished media card');
assert.equal(presentToolResult('submit_image', {
  denied: true, generated: [{ assetId: 'denied', src: '/media/denied.png' }],
}).media.length, 0, 'denied generation must not render a finished media card');
assert.deepEqual(extractToolMedia('create_motion_graphic_from_code', {
  ok: true, assetId: 'mg-1', name: 'Data Card', kind: 'motion-graphic',
}).map((item) => [item.kind, item.assetId]), [['motion-graphic', 'mg-1']]);
assert.equal(extractToolMedia('create_motion_graphic_from_code', {
  error: 'sandbox rejected', assetId: 'mg-bad', kind: 'motion-graphic',
}).length, 0);

const toolMessage = (name: string, result: unknown): DisplayMessage => ({
  role: 'tool', text: '', tool: { name, args: {}, result },
});
assert.equal(groupMessages([
  toolMessage('read_project', { ok: true }),
  toolMessage('read_project', { ok: true }),
  toolMessage('read_project', { ok: true }),
])[0]?.kind, 'toolgroup');
assert.deepEqual(groupMessages([
  toolMessage('submit_image', { ok: true, generated: [] }),
  toolMessage('submit_image', { ok: true, generated: [{ assetId: 'visible', src: '/media/visible.png' }] }),
  toolMessage('submit_image', { ok: true, generated: [] }),
]).map((item) => item.kind), ['single', 'single', 'single'], 'finished media must stay visible outside collapsed groups');

console.log('tool-result.verify: ok');
