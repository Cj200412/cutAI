import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  cancelEditorOwner,
  connectedProjectIds,
  isProjectConnected,
  invokeEditorTool,
  nextEditorCall,
  onRegisteredToolsChanged,
  registerEditor,
  releaseEditorOwner,
  resolveProjectId,
  settleEditorCall,
} from './broker.ts';

function stoppedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

const projectId = 'project-check';
const editorId = 'editor-check';
let toolChanges = 0;
const stopWatchingTools = onRegisteredToolsChanged(() => { toolChanges += 1; });
registerEditor(projectId, editorId, [{
  name: 'read_timeline',
  input_schema: { type: 'object', properties: {} },
}]);
assert.equal(toolChanges, 1, 'first editor registration announces the expanded tool list');
registerEditor(projectId, editorId, [{
  name: 'read_timeline',
  input_schema: { type: 'object', properties: {} },
}]);
assert.equal(toolChanges, 1, 'heartbeats with the same schemas do not spam list-changed');
stopWatchingTools();
assert.deepEqual(connectedProjectIds(), [projectId]);
assert.equal(resolveProjectId(undefined), projectId);

const resultPromise = invokeEditorTool(projectId, 'read_timeline', {});
const call = await nextEditorCall(projectId, editorId, new AbortController().signal);
assert.equal(call?.name, 'read_timeline');
assert.equal(isProjectConnected(projectId, Date.now() + 60_000), true, 'in-flight calls keep a busy editor connected');
assert.equal(settleEditorCall(call!.id, true, { fps: 30 }), true);
assert.equal(isProjectConnected(projectId, Date.now() + 60_000), false, 'settled calls no longer mask an offline editor');
assert.deepEqual(await resultPromise, { fps: 30 });

const queuedProject = `queued-cancel-${randomUUID()}`;
const queuedEditor = 'queued-editor';
const queuedOwner = randomUUID();
registerEditor(queuedProject, queuedEditor, []);
const neverDispatchedId = randomUUID();
const queuedPromise = invokeEditorTool(
  queuedProject,
  'begin_edit_session',
  { editSessionId: neverDispatchedId },
  { ownerId: queuedOwner },
);
assert.deepEqual(cancelEditorOwner(queuedOwner), { queued: 1, dispatched: 0, cleanupQueued: 0 });
await assert.rejects(queuedPromise, (error: unknown) => error instanceof Error && error.name === 'AbortError');
assert.equal(
  await nextEditorCall(queuedProject, queuedEditor, stoppedSignal()),
  null,
  'a cancelled queued begin is removed and does not create a discard for a session that never existed',
);
assert.throws(
  () => invokeEditorTool(queuedProject, 'read_project', {}, { ownerId: queuedOwner }),
  (error: unknown) => error instanceof Error && error.name === 'AbortError',
  'an already-authorized MCP handler cannot enqueue another call after its run was cancelled',
);

const timeoutProject = `queued-timeout-${randomUUID()}`;
registerEditor(timeoutProject, 'timeout-editor', []);
await assert.rejects(
  invokeEditorTool(timeoutProject, 'read_project', {}, 1_000),
  /timed out/,
);
assert.equal(
  await nextEditorCall(timeoutProject, 'timeout-editor', stoppedSignal()),
  null,
  'a timed-out queued call must not remain available to a later editor poll',
);

const dispatchedProject = `dispatched-cancel-${randomUUID()}`;
const dispatchedEditor = 'dispatched-editor';
const dispatchedOwner = randomUUID();
const dispatchedSessionId = randomUUID();
registerEditor(dispatchedProject, dispatchedEditor, []);
const dispatchedPromise = invokeEditorTool(
  dispatchedProject,
  'begin_edit_session',
  { approvalMode: 'manual', editSessionId: dispatchedSessionId },
  { ownerId: dispatchedOwner },
);
const dispatchedBegin = await nextEditorCall(dispatchedProject, dispatchedEditor, new AbortController().signal);
assert.equal(dispatchedBegin?.arguments.editSessionId, dispatchedSessionId);
assert.deepEqual(cancelEditorOwner(dispatchedOwner), { queued: 0, dispatched: 1, cleanupQueued: 1 });
await assert.rejects(dispatchedPromise, (error: unknown) => error instanceof Error && error.name === 'AbortError');
assert.equal(
  settleEditorCall(dispatchedBegin!.id, true, { editSessionId: dispatchedSessionId, status: 'drafting' }),
  true,
  'late results for cancelled dispatched calls are acknowledged by their tombstone',
);
const cleanup = await nextEditorCall(dispatchedProject, dispatchedEditor, new AbortController().signal);
assert.equal(cleanup?.name, 'discard_edit_session');
assert.equal(cleanup?.arguments.editSessionId, dispatchedSessionId);
assert.equal(settleEditorCall(cleanup!.id, true, { status: 'discarded' }), true);

const reviewProject = `review-cancel-${randomUUID()}`;
const reviewEditor = 'review-editor';
const reviewOwner = randomUUID();
const reviewSessionId = randomUUID();
registerEditor(reviewProject, reviewEditor, []);
const reviewBeginPromise = invokeEditorTool(
  reviewProject,
  'begin_edit_session',
  { editSessionId: reviewSessionId },
  { ownerId: reviewOwner },
);
const reviewBegin = await nextEditorCall(reviewProject, reviewEditor, new AbortController().signal);
settleEditorCall(reviewBegin!.id, true, { editSessionId: reviewSessionId });
await reviewBeginPromise;
const reviewPromise = invokeEditorTool(
  reviewProject,
  'review_edit_session',
  { editSessionId: reviewSessionId },
  { ownerId: reviewOwner },
);
const reviewCall = await nextEditorCall(reviewProject, reviewEditor, new AbortController().signal);
assert.deepEqual(cancelEditorOwner(reviewOwner), { queued: 0, dispatched: 1, cleanupQueued: 1 });
await assert.rejects(reviewPromise, (error: unknown) => error instanceof Error && error.name === 'AbortError');
assert.equal(settleEditorCall(reviewCall!.id, true, { status: 'awaiting_review' }), true);
const reviewCleanup = await nextEditorCall(reviewProject, reviewEditor, new AbortController().signal);
assert.equal(reviewCleanup?.name, 'discard_edit_session');
assert.equal(reviewCleanup?.arguments.editSessionId, reviewSessionId);
assert.equal(settleEditorCall(reviewCleanup!.id, true, { status: 'discarded' }), true);

const retryProject = `cleanup-retry-${randomUUID()}`;
const retryEditor = 'cleanup-retry-editor';
const retryOwner = randomUUID();
const retrySessionId = randomUUID();
registerEditor(retryProject, retryEditor, []);
const retryBeginPromise = invokeEditorTool(
  retryProject,
  'begin_edit_session',
  { editSessionId: retrySessionId },
  { ownerId: retryOwner },
);
const retryBegin = await nextEditorCall(retryProject, retryEditor, new AbortController().signal);
assert.equal(settleEditorCall(retryBegin!.id, true, { editSessionId: retrySessionId }), true);
await retryBeginPromise;
assert.equal(cancelEditorOwner(retryOwner).cleanupQueued, 1);
const failedCleanup = await nextEditorCall(retryProject, retryEditor, new AbortController().signal);
assert.equal(failedCleanup?.name, 'discard_edit_session');
assert.equal(settleEditorCall(failedCleanup!.id, false, 'temporary discard failure'), true);
const retriedCleanup = await nextEditorCall(retryProject, retryEditor, AbortSignal.timeout(2_000));
assert.equal(retriedCleanup?.name, 'discard_edit_session', 'a failed discard retries automatically without another cancel or editor registration');
assert.equal(retriedCleanup?.arguments.editSessionId, retrySessionId);
assert.equal(settleEditorCall(retriedCleanup!.id, true, { status: 'discarded' }), true);

const signalProject = `signal-cancel-${randomUUID()}`;
const signalEditor = 'signal-editor';
registerEditor(signalProject, signalEditor, []);
const controller = new AbortController();
const signalledPromise = invokeEditorTool(signalProject, 'read_project', {}, { signal: controller.signal });
const signalledCall = await nextEditorCall(signalProject, signalEditor, controller.signal);
controller.abort();
await assert.rejects(signalledPromise, (error: unknown) => error instanceof Error && error.name === 'AbortError');
assert.equal(settleEditorCall(signalledCall!.id, true, { ignored: true }), true);

const unfinishedProject = `unfinished-owner-${randomUUID()}`;
const unfinishedEditor = 'unfinished-editor';
const unfinishedOwner = randomUUID();
const unfinishedSessionId = randomUUID();
registerEditor(unfinishedProject, unfinishedEditor, []);
const unfinishedPromise = invokeEditorTool(
  unfinishedProject,
  'begin_edit_session',
  { editSessionId: unfinishedSessionId },
  { ownerId: unfinishedOwner },
);
const unfinishedBegin = await nextEditorCall(unfinishedProject, unfinishedEditor, new AbortController().signal);
assert.equal(settleEditorCall(unfinishedBegin!.id, true, { editSessionId: unfinishedSessionId }), true);
await unfinishedPromise;
releaseEditorOwner(unfinishedOwner);
const unfinishedCleanup = await nextEditorCall(
  unfinishedProject,
  unfinishedEditor,
  new AbortController().signal,
);
assert.equal(unfinishedCleanup?.name, 'discard_edit_session');
assert.equal(unfinishedCleanup?.arguments.editSessionId, unfinishedSessionId);
assert.equal(settleEditorCall(unfinishedCleanup!.id, false, 'temporary release cleanup failure'), true);
await new Promise((resolve) => setTimeout(resolve, 0));
registerEditor(unfinishedProject, unfinishedEditor, []);
const unfinishedRetry = await nextEditorCall(
  unfinishedProject,
  unfinishedEditor,
  new AbortController().signal,
);
assert.equal(unfinishedRetry?.name, 'discard_edit_session');
assert.equal(unfinishedRetry?.arguments.editSessionId, unfinishedSessionId);
assert.equal(settleEditorCall(unfinishedRetry!.id, true, { status: 'discarded' }), true);

const releasedProject = `released-owner-${randomUUID()}`;
const releasedEditor = 'released-editor';
const releasedOwner = randomUUID();
const releasedSessionId = randomUUID();
registerEditor(releasedProject, releasedEditor, []);
const releasedBeginPromise = invokeEditorTool(
  releasedProject,
  'begin_edit_session',
  { editSessionId: releasedSessionId },
  { ownerId: releasedOwner },
);
const releasedBegin = await nextEditorCall(releasedProject, releasedEditor, new AbortController().signal);
assert.equal(settleEditorCall(releasedBegin!.id, true, { editSessionId: releasedSessionId }), true);
await releasedBeginPromise;
const releasedReviewPromise = invokeEditorTool(
  releasedProject,
  'review_edit_session',
  { editSessionId: releasedSessionId },
  { ownerId: releasedOwner },
);
const releasedReview = await nextEditorCall(releasedProject, releasedEditor, new AbortController().signal);
assert.equal(settleEditorCall(releasedReview!.id, true, { status: 'awaiting_review' }), true);
await releasedReviewPromise;
releaseEditorOwner(releasedOwner);
assert.equal(
  await nextEditorCall(releasedProject, releasedEditor, stoppedSignal()),
  null,
  'a normally released owner preserves a reviewed proposal instead of scheduling discard',
);
await import('./mcp.verify.ts');
console.log('external-agent broker check passed');
