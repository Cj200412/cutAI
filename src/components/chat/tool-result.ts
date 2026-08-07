export type ToolResultState = 'pending' | 'success' | 'partial' | 'failed' | 'denied';

export type ToolMediaKind = 'image' | 'video' | 'audio' | 'motion-graphic';

export interface ToolMediaPreview {
  key: string;
  kind: ToolMediaKind;
  assetId?: string;
  name?: string;
  src?: string;
  width?: number;
  height?: number;
}

export interface ToolResultPresentation {
  state: ToolResultState;
  media: ToolMediaPreview[];
  message?: string;
}

type UnknownRecord = Record<string, unknown>;

const IMAGE_TOOLS = new Set(['submit_image', 'generate_image', 'submit_image_generation']);
const AUDIO_TOOLS = new Set([
  'submit_voice', 'generate_voice', 'submit_voice_generation',
  'submit_sound', 'generate_sound', 'submit_sound_generation',
]);
const MG_TOOLS = new Set([
  'submit_motion_graphic', 'create_motion_graphic', 'create_motion_graphic_from_code',
]);
const PROGRESS_TOOLS = new Set(['track_progress']);

const PENDING_STATUSES = new Set(['pending', 'queued', 'running', 'processing', 'starting', 'downloading']);
const SUCCESS_STATUSES = new Set(['success', 'succeeded', 'complete', 'completed', 'done']);
const PARTIAL_STATUSES = new Set(['partial', 'partially_completed']);
const FAILED_STATUSES = new Set(['failed', 'error', 'not_found', 'missing', 'cancelled', 'canceled', 'timed_out']);

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function kindOf(value: unknown): ToolMediaKind | undefined {
  return value === 'image' || value === 'video' || value === 'audio' || value === 'motion-graphic'
    ? value
    : undefined;
}

function mediaFromRecord(value: unknown, forcedKind?: ToolMediaKind): ToolMediaPreview | null {
  const record = recordOf(value);
  if (!record) return null;
  const kind = forcedKind ?? kindOf(record.kind);
  if (!kind) return null;
  const src = stringOf(record.src) ?? stringOf(record.path);
  // Code-backed MG assets have no media URL; every other preview must have a
  // concrete source returned by the allow-listed generation contract.
  if (kind !== 'motion-graphic' && !src) return null;
  const assetId = stringOf(record.assetId) ?? stringOf(record.id);
  const name = stringOf(record.name);
  return {
    key: assetId ?? src ?? `${kind}:${name ?? 'result'}`,
    kind,
    assetId,
    name,
    src,
    width: numberOf(record.width),
    height: numberOf(record.height),
  };
}

function dedupeMedia(items: ToolMediaPreview[]): ToolMediaPreview[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}\u0000${item.assetId ?? ''}\u0000${item.src ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extract only user-facing media from explicit generation result contracts.
 * Never promote arbitrary `src`/`path` fields returned by read or diagnostic tools.
 */
export function extractToolMedia(toolName: string, result: unknown): ToolMediaPreview[] {
  const record = recordOf(result);
  if (!record) return [];
  const media: ToolMediaPreview[] = [];

  if (IMAGE_TOOLS.has(toolName)) {
    for (const value of Array.isArray(record.generated) ? record.generated : []) {
      const item = mediaFromRecord(value, 'image');
      if (item) media.push(item);
    }
  } else if (AUDIO_TOOLS.has(toolName)) {
    const item = mediaFromRecord(record, 'audio');
    if (item) media.push(item);
  } else if (MG_TOOLS.has(toolName)) {
    if (record.ok !== false && !record.error && !record.denied) {
      const item = mediaFromRecord(record, 'motion-graphic');
      if (item?.assetId) media.push(item);
    }
  } else if (PROGRESS_TOOLS.has(toolName)) {
    for (const value of Array.isArray(record.addedAssets) ? record.addedAssets : []) {
      const item = mediaFromRecord(value);
      if (item) media.push(item);
    }
  }

  return dedupeMedia(media);
}

function statusesOf(record: UnknownRecord): string[] {
  const statuses: string[] = [];
  const own = stringOf(record.status);
  if (own) statuses.push(own.toLowerCase());
  for (const key of ['reports', 'assets', 'jobs'] as const) {
    for (const value of Array.isArray(record[key]) ? record[key] : []) {
      const row = recordOf(value);
      const status = stringOf(row?.status);
      if (status) statuses.push(status.toLowerCase());
      else if (stringOf(row?.error)) statuses.push('failed');
    }
  }
  return statuses;
}

function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function batchCounts(record: UnknownRecord): { succeeded: number; failed: number } {
  let succeeded = countOf(record.succeeded) + countOf(record.exported);
  let failed = countOf(record.failed);
  for (const value of Array.isArray(record.results) ? record.results : []) {
    const row = recordOf(value);
    if (row?.success === true) succeeded += 1;
    else if (row?.success === false) failed += 1;
  }
  return { succeeded, failed };
}

function nestedError(record: UnknownRecord): string | undefined {
  for (const key of ['reports', 'assets', 'jobs'] as const) {
    for (const value of Array.isArray(record[key]) ? record[key] : []) {
      const message = stringOf(recordOf(value)?.error);
      if (message) return message;
    }
  }
  return undefined;
}

export function classifyToolResult(result: unknown): ToolResultState {
  const record = recordOf(result);
  if (!record) return 'success';
  if (record.denied === true) return 'denied';
  if (stringOf(record.error)) return 'failed';

  const statuses = statusesOf(record);
  const failed = statuses.some((status) => FAILED_STATUSES.has(status));
  const pending = statuses.some((status) => PENDING_STATUSES.has(status));
  const succeeded = statuses.some((status) => SUCCESS_STATUSES.has(status));
  const partial = statuses.some((status) => PARTIAL_STATUSES.has(status));
  if (partial || [failed, pending, succeeded].filter(Boolean).length > 1) return 'partial';
  if (failed) return 'failed';
  if (pending) return 'pending';
  if (succeeded) return record.ok === false ? 'partial' : 'success';

  const counts = batchCounts(record);
  if (counts.failed && counts.succeeded) return 'partial';
  if (counts.failed) return 'failed';
  if (counts.succeeded) return 'success';
  if (Array.isArray(record.errors) && record.errors.length) {
    return record.ok === true ? 'partial' : 'failed';
  }
  return record.ok === false ? 'failed' : 'success';
}

/** Summarize several tool rows without turning mixed/pending work green. */
export function aggregateToolResultStates(results: readonly unknown[]): ToolResultState {
  const states = new Set(results.map(classifyToolResult));
  if (!states.size) return 'success';
  if (states.size === 1) return states.values().next().value ?? 'success';
  return 'partial';
}

export function presentToolResult(toolName: string, result: unknown): ToolResultPresentation {
  const record = recordOf(result);
  const state = classifyToolResult(result);
  const media = state === 'failed' || state === 'denied' ? [] : extractToolMedia(toolName, result);
  const message = record
    ? state === 'denied'
      ? stringOf(record.note) ?? 'User denied this operation.'
      : stringOf(record.error) ?? nestedError(record)
    : undefined;
  return { state, media, message };
}

export function hasRenderableToolMedia(toolName: string, result: unknown): boolean {
  return presentToolResult(toolName, result).media.length > 0;
}

export function hasToolResultError(result: unknown): result is Record<string, unknown> {
  const state = classifyToolResult(result);
  return state === 'failed' || state === 'denied';
}
