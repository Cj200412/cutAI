import {
  LOCAL_TRANSCRIPTION_REQUIRED_MODEL_FILES,
} from '../../shared/local-transcription-assets';
import type { LocalTranscriptionModel } from '../../shared/transcription-providers';

export const TRANSFORMERS_CACHE_NAME = 'transformers-cache';

export interface LocalModelCacheStatus {
  state: 'downloaded' | 'partial' | 'not-downloaded' | 'unavailable';
  cachedBytes: number;
  cachedFiles: number;
}

function modelCachePath(model: string): string {
  return `/${model}/resolve/`;
}

function isModelRequest(request: Request, model: string): boolean {
  try {
    const url = new URL(request.url);
    return url.hostname === 'huggingface.co'
      && decodeURIComponent(url.pathname).startsWith(modelCachePath(model));
  } catch {
    return false;
  }
}

function cachedFilePath(request: Request, model: string): string {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  return pathname.slice(modelCachePath(model).length).replace(/^main\//, '');
}

async function responseBytes(response: Response | undefined): Promise<number> {
  if (!response) return 0;
  const header = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(header) && header >= 0) return header;
  return (await response.blob()).size;
}

function browserCaches(): CacheStorage | null {
  return typeof caches === 'undefined' ? null : caches;
}

export async function inspectLocalModelCache(
  model: LocalTranscriptionModel,
  storage: CacheStorage | null = browserCaches(),
): Promise<LocalModelCacheStatus> {
  if (!storage) return { state: 'unavailable', cachedBytes: 0, cachedFiles: 0 };
  const cache = await storage.open(TRANSFORMERS_CACHE_NAME);
  const requests = (await cache.keys()).filter((request) => isModelRequest(request, model));
  const paths = new Set(requests.map((request) => cachedFilePath(request, model)));
  let cachedBytes = 0;
  for (const request of requests) cachedBytes += await responseBytes(await cache.match(request));
  const complete = LOCAL_TRANSCRIPTION_REQUIRED_MODEL_FILES.every((file) => paths.has(file));
  return {
    state: complete ? 'downloaded' : requests.length ? 'partial' : 'not-downloaded',
    cachedBytes,
    cachedFiles: requests.length,
  };
}

export async function deleteLocalModelCache(
  model: LocalTranscriptionModel,
  storage: CacheStorage | null = browserCaches(),
): Promise<{ deletedFiles: number; freedBytes: number }> {
  if (!storage) return { deletedFiles: 0, freedBytes: 0 };
  const cache = await storage.open(TRANSFORMERS_CACHE_NAME);
  const requests = (await cache.keys()).filter((request) => isModelRequest(request, model));
  let freedBytes = 0;
  let deletedFiles = 0;
  for (const request of requests) {
    freedBytes += await responseBytes(await cache.match(request));
    if (await cache.delete(request)) deletedFiles += 1;
  }
  return { deletedFiles, freedBytes };
}
