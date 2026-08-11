import { randomUUID } from 'node:crypto';

export interface ExternalToolSchema {
  name: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

interface EditorRegistration {
  editorId: string;
  lastSeen: number;
  tools: ExternalToolSchema[];
}

interface QueuedCall {
  id: string;
  projectId: string;
  name: string;
  arguments: Record<string, unknown>;
  state: 'queued' | 'dispatched' | 'cancelled' | 'settled';
  ownerId?: string;
  cleanupOwnerId?: string;
  cleanupSessionId?: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface ExternalEditorCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface InvokeEditorToolOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Opaque per-run owner. Local CLI calls use their short-lived MCP token. */
  ownerId?: string;
}

export interface CancelEditorOwnerResult {
  queued: number;
  dispatched: number;
  cleanupQueued: number;
}

interface OwnerState {
  projectId?: string;
  status: 'active' | 'cancelled' | 'released';
  sessionIds: Set<string>;
  reviewedSessionIds: Set<string>;
  cleanupQueued: Set<string>;
  cleanupRetryAttempts: Map<string, number>;
  cleanupRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

const ONLINE_MS = 35_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;
const CANCELLED_CALL_TOMBSTONE_MS = 60_000;
const OWNER_TOMBSTONE_MS = MAX_TIMEOUT_MS + CANCELLED_CALL_TOMBSTONE_MS;
const CLEANUP_RETRY_BASE_MS = 250;
const CLEANUP_RETRY_MAX_MS = 30_000;
const editors = new Map<string, EditorRegistration>();
const queues = new Map<string, QueuedCall[]>();
const pending = new Map<string, QueuedCall>();
const owners = new Map<string, OwnerState>();
const waiters = new Map<string, () => void>();
const toolChangeListeners = new Set<() => void>();
// ponytail: one local user's selected project. Use MCP-session scoped targets if this
// endpoint becomes a multi-user hosted service.
let targetProjectId: string | null = null;

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function sessionIdOf(args: Record<string, unknown>): string | undefined {
  const value = args.editSessionId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function removeFromQueue(call: QueuedCall): void {
  const queue = queues.get(call.projectId);
  if (!queue) return;
  const index = queue.indexOf(call);
  if (index >= 0) queue.splice(index, 1);
  if (!queue.length) queues.delete(call.projectId);
}

function clearCallResources(call: QueuedCall): void {
  if (call.timer) clearTimeout(call.timer);
  if (call.signal && call.onAbort) call.signal.removeEventListener('abort', call.onAbort);
  call.onAbort = undefined;
}

function ownerForInvocation(ownerId: string, projectId: string): OwnerState {
  let owner = owners.get(ownerId);
  if (!owner) {
    owner = {
      projectId,
      status: 'active',
      sessionIds: new Set(),
      reviewedSessionIds: new Set(),
      cleanupQueued: new Set(),
      cleanupRetryAttempts: new Map(),
      cleanupRetryTimers: new Map(),
    };
    owners.set(ownerId, owner);
  }
  if (owner.projectId && owner.projectId !== projectId) {
    throw new Error('A CLI Agent run cannot target more than one CutAI project');
  }
  owner.projectId = projectId;
  if (owner.status !== 'active') throw abortError('CLI Agent run is no longer active');
  return owner;
}

function scheduleOwnerExpiry(ownerId: string, owner: OwnerState): void {
  clearTimeout(owner.expiryTimer);
  owner.expiryTimer = setTimeout(() => {
    if (owners.get(ownerId) !== owner) return;
    for (const timer of owner.cleanupRetryTimers.values()) clearTimeout(timer);
    owner.cleanupRetryTimers.clear();
    owner.cleanupRetryAttempts.clear();
    owners.delete(ownerId);
  }, OWNER_TOMBSTONE_MS);
  owner.expiryTimer.unref?.();
}

function clearCleanupRetry(owner: OwnerState, editSessionId: string): void {
  const timer = owner.cleanupRetryTimers.get(editSessionId);
  if (timer) clearTimeout(timer);
  owner.cleanupRetryTimers.delete(editSessionId);
  owner.cleanupRetryAttempts.delete(editSessionId);
}

function scheduleCleanupRetry(ownerId: string, owner: OwnerState, editSessionId: string): void {
  if (
    owner.status === 'active'
    || !owner.projectId
    || !owner.sessionIds.has(editSessionId)
    || owner.cleanupQueued.has(editSessionId)
    || owner.cleanupRetryTimers.has(editSessionId)
  ) return;
  const attempt = owner.cleanupRetryAttempts.get(editSessionId) ?? 0;
  const delay = Math.min(CLEANUP_RETRY_MAX_MS, CLEANUP_RETRY_BASE_MS * (2 ** Math.min(attempt, 16)));
  owner.cleanupRetryAttempts.set(editSessionId, attempt + 1);
  const timer = setTimeout(() => {
    owner.cleanupRetryTimers.delete(editSessionId);
    if (owners.get(ownerId) !== owner || owner.status === 'active' || !owner.sessionIds.has(editSessionId)) return;
    queueOwnerCleanup(ownerId, owner, editSessionId);
  }, delay);
  owner.cleanupRetryTimers.set(editSessionId, timer);
  timer.unref?.();
}

function finishCleanup(call: QueuedCall, completed: boolean): void {
  if (!call.cleanupOwnerId || !call.cleanupSessionId) return;
  const owner = owners.get(call.cleanupOwnerId);
  if (!owner) return;
  owner.cleanupQueued.delete(call.cleanupSessionId);
  if (completed) {
    clearCleanupRetry(owner, call.cleanupSessionId);
    owner.sessionIds.delete(call.cleanupSessionId);
    owner.reviewedSessionIds.delete(call.cleanupSessionId);
  } else scheduleCleanupRetry(call.cleanupOwnerId, owner, call.cleanupSessionId);
}

function cancelCall(call: QueuedCall, error: Error): void {
  if (call.state === 'cancelled') return;
  const wasQueued = call.state === 'queued';
  call.state = 'cancelled';
  clearCallResources(call);
  call.reject(error);
  if (wasQueued) {
    removeFromQueue(call);
    pending.delete(call.id);
    finishCleanup(call, false);
    return;
  }
  // The editor may already be executing this call. Keep a short tombstone so
  // its late /result is acknowledged without resolving the cancelled caller.
  call.timer = setTimeout(() => {
    pending.delete(call.id);
    finishCleanup(call, false);
  }, CANCELLED_CALL_TOMBSTONE_MS);
  call.timer.unref?.();
}

interface EnqueueOptions extends InvokeEditorToolOptions {
  requireConnected?: boolean;
  priority?: boolean;
  unrefTimeout?: boolean;
  cleanupOwnerId?: string;
  cleanupSessionId?: string;
}

function enqueueEditorTool(
  projectId: string,
  name: string,
  args: Record<string, unknown>,
  options: EnqueueOptions,
): Promise<unknown> {
  if (options.signal?.aborted) return Promise.reject(abortError(`OpenChatCut tool ${name} was cancelled`));
  if (options.ownerId) {
    const owner = ownerForInvocation(options.ownerId, projectId);
    const editSessionId = sessionIdOf(args);
    if (editSessionId && name !== 'begin_edit_session') owner.sessionIds.add(editSessionId);
  }
  if (options.requireConnected !== false && !connectedProjectIds().includes(projectId)) {
    throw new Error(`Project ${projectId} is not open in a connected OpenChatCut editor.`);
  }
  return new Promise((resolve, reject) => {
    const call: QueuedCall = {
      id: randomUUID(),
      projectId,
      name,
      arguments: args,
      state: 'queued',
      ownerId: options.ownerId,
      cleanupOwnerId: options.cleanupOwnerId,
      cleanupSessionId: options.cleanupSessionId,
      resolve,
      reject,
      signal: options.signal,
    };
    call.timer = setTimeout(() => {
      cancelCall(call, new Error(`OpenChatCut tool ${name} timed out`));
    }, Math.min(MAX_TIMEOUT_MS, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
    if (options.unrefTimeout) call.timer.unref?.();
    if (options.signal) {
      call.onAbort = () => cancelCall(call, abortError(`OpenChatCut tool ${name} was cancelled`));
      options.signal.addEventListener('abort', call.onAbort, { once: true });
    }
    const queue = queues.get(projectId) ?? [];
    if (options.priority) queue.unshift(call);
    else queue.push(call);
    queues.set(projectId, queue);
    pending.set(call.id, call);
    waiters.get(projectId)?.();
  });
}

function queueOwnerCleanup(ownerId: string, owner: OwnerState, editSessionId: string): boolean {
  if (!owner.projectId || owner.cleanupQueued.has(editSessionId)) return false;
  const retryTimer = owner.cleanupRetryTimers.get(editSessionId);
  if (retryTimer) clearTimeout(retryTimer);
  owner.cleanupRetryTimers.delete(editSessionId);
  owner.cleanupQueued.add(editSessionId);
  void enqueueEditorTool(owner.projectId, 'discard_edit_session', { editSessionId }, {
    timeoutMs: MAX_TIMEOUT_MS,
    requireConnected: false,
    priority: true,
    unrefTimeout: true,
    cleanupOwnerId: ownerId,
    cleanupSessionId: editSessionId,
  }).catch(() => undefined);
  return true;
}

function queueInactiveOwnerCleanup(projectId: string): void {
  for (const [ownerId, owner] of owners) {
    if (owner.status === 'active' || owner.projectId !== projectId) continue;
    for (const editSessionId of owner.sessionIds) queueOwnerCleanup(ownerId, owner, editSessionId);
  }
}

export function registerEditor(
  projectId: string,
  editorId: string,
  tools: ExternalToolSchema[],
): void {
  const before = JSON.stringify(registeredTools());
  editors.set(projectId, { editorId, lastSeen: Date.now(), tools });
  if (JSON.stringify(registeredTools()) !== before) {
    for (const listener of toolChangeListeners) listener();
  }
  queueInactiveOwnerCleanup(projectId);
  waiters.get(projectId)?.();
}

export function onRegisteredToolsChanged(listener: () => void): () => void {
  toolChangeListeners.add(listener);
  return () => toolChangeListeners.delete(listener);
}

export function touchEditor(projectId: string, editorId: string): boolean {
  const editor = editors.get(projectId);
  if (!editor || editor.editorId !== editorId) return false;
  editor.lastSeen = Date.now();
  return true;
}

export function connectedProjectIds(): string[] {
  const now = Date.now();
  return [...editors.entries()]
    .filter(([projectId]) => isProjectConnected(projectId, now))
    .map(([projectId]) => projectId);
}

export function isProjectConnected(projectId: string, now = Date.now()): boolean {
  const editor = editors.get(projectId);
  if (!editor) return false;
  if (now - editor.lastSeen < ONLINE_MS) return true;
  return [...pending.values()].some((call) => call.projectId === projectId && call.state === 'dispatched');
}

export function editorStatuses(): Array<{
  projectId: string;
  editorId: string;
  connected: boolean;
  toolCount: number;
}> {
  const now = Date.now();
  return [...editors.entries()].map(([projectId, editor]) => ({
    projectId,
    editorId: editor.editorId,
    connected: isProjectConnected(projectId, now),
    toolCount: editor.tools.length,
  }));
}

export function registeredTools(projectId?: string): ExternalToolSchema[] {
  if (projectId) return editors.get(projectId)?.tools ?? [];
  const first = editors.values().next().value as EditorRegistration | undefined;
  return first?.tools ?? [];
}

export function setTargetProject(projectId: string): void {
  targetProjectId = projectId;
}

export function resolveProjectId(requested?: unknown): string {
  if (typeof requested === 'string' && requested.trim()) return requested.trim();
  if (targetProjectId) return targetProjectId;
  const connected = connectedProjectIds();
  if (connected.length === 1) return connected[0];
  if (connected.length === 0) {
    throw new Error('No OpenChatCut editor is connected. Open the target project in OpenChatCut first.');
  }
  throw new Error('Multiple OpenChatCut projects are open; pass editorProjectId or call target_project.');
}

export function invokeEditorTool(
  projectId: string,
  name: string,
  args: Record<string, unknown>,
  input: number | InvokeEditorToolOptions = {},
): Promise<unknown> {
  const options = typeof input === 'number' ? { timeoutMs: input } : input;
  return enqueueEditorTool(projectId, name, args, { ...options, requireConnected: true });
}

/** Cancel every queued/in-flight editor call owned by one local CLI run. */
export function cancelEditorOwner(ownerId: string, reason = 'CLI Agent run was cancelled'): CancelEditorOwnerResult {
  let owner = owners.get(ownerId);
  if (!owner) {
    owner = {
      status: 'cancelled',
      sessionIds: new Set(),
      reviewedSessionIds: new Set(),
      cleanupQueued: new Set(),
      cleanupRetryAttempts: new Map(),
      cleanupRetryTimers: new Map(),
    };
    owners.set(ownerId, owner);
  } else owner.status = 'cancelled';
  scheduleOwnerExpiry(ownerId, owner);
  let queued = 0;
  let dispatched = 0;
  for (const call of [...pending.values()]) {
    if (call.ownerId !== ownerId || call.state === 'cancelled') continue;
    if (call.state === 'queued') queued += 1;
    else dispatched += 1;
    cancelCall(call, abortError(reason));
  }
  let cleanupQueued = 0;
  for (const editSessionId of owner.sessionIds) {
    if (queueOwnerCleanup(ownerId, owner, editSessionId)) cleanupQueued += 1;
  }
  return { queued, dispatched, cleanupQueued };
}

/** Keep reviewed proposals from a successful run and discard unfinished drafts. */
export function releaseEditorOwner(ownerId: string): void {
  const owner = owners.get(ownerId);
  if (!owner) return;
  if (owner.status === 'cancelled') return;
  owner.status = 'released';
  for (const editSessionId of [...owner.sessionIds]) {
    if (owner.reviewedSessionIds.has(editSessionId)) {
      clearCleanupRetry(owner, editSessionId);
      owner.sessionIds.delete(editSessionId);
      owner.reviewedSessionIds.delete(editSessionId);
      continue;
    }
    queueOwnerCleanup(ownerId, owner, editSessionId);
  }
  scheduleOwnerExpiry(ownerId, owner);
}

export async function nextEditorCall(
  projectId: string,
  editorId: string,
  signal: AbortSignal,
): Promise<ExternalEditorCall | null> {
  if (!touchEditor(projectId, editorId)) return null;
  if (signal.aborted) return null;
  const take = (): QueuedCall | undefined => {
    const queue = queues.get(projectId);
    while (queue?.length) {
      const candidate = queue.shift()!;
      if (pending.get(candidate.id) === candidate && candidate.state === 'queued') return candidate;
    }
    if (queue && !queue.length) queues.delete(projectId);
    return undefined;
  };
  let call = take();
  if (!call) {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        waiters.delete(projectId);
        resolve();
      };
      waiters.set(projectId, done);
      timer = setTimeout(done, 25_000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        done();
      }, { once: true });
    });
    call = take();
  }
  if (!call) return null;
  call.state = 'dispatched';
  if (call.ownerId && call.name === 'begin_edit_session') {
    const editSessionId = sessionIdOf(call.arguments);
    if (editSessionId) owners.get(call.ownerId)?.sessionIds.add(editSessionId);
  }
  return { id: call.id, name: call.name, arguments: call.arguments };
}

export function settleEditorCall(
  id: string,
  ok: boolean,
  value: unknown,
): boolean {
  const call = pending.get(id);
  if (!call) return false;
  pending.delete(id);
  clearCallResources(call);
  if (call.state === 'cancelled') {
    finishCleanup(call, ok);
    return true;
  }
  call.state = 'settled';
  if (call.ownerId && ok && call.name === 'review_edit_session') {
    const editSessionId = sessionIdOf(call.arguments);
    if (editSessionId) owners.get(call.ownerId)?.reviewedSessionIds.add(editSessionId);
  }
  if (call.ownerId && ok && call.name === 'discard_edit_session') {
    const editSessionId = sessionIdOf(call.arguments);
    if (editSessionId) {
      owners.get(call.ownerId)?.sessionIds.delete(editSessionId);
      owners.get(call.ownerId)?.reviewedSessionIds.delete(editSessionId);
    }
  }
  finishCleanup(call, ok);
  if (ok) call.resolve(value);
  else call.reject(new Error(typeof value === 'string' ? value : JSON.stringify(value)));
  return true;
}
