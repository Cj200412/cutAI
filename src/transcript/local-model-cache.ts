import {
  LOCAL_TRANSCRIPTION_REQUIRED_MODEL_FILES,
} from '../../shared/local-transcription-assets';
import {
  LOCAL_TRANSCRIPTION_CACHE_MODELS,
  type LocalTranscriptionModel,
  type LocalTranscriptionCacheModel,
} from '../../shared/transcription-providers';

export const TRANSFORMERS_CACHE_NAME = 'transformers-cache';

export interface LocalModelCacheStatus {
  state: 'downloaded' | 'partial' | 'not-downloaded' | 'unavailable';
  cachedBytes: number;
  cachedFiles: number;
}

export interface LocalModelDownloadFile {
  path: string;
  bytes: number;
}

export interface LocalModelCacheEntry {
  model: LocalTranscriptionCacheModel;
  cache: LocalModelCacheStatus;
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

export async function downloadLocalModel(
  model: LocalTranscriptionModel,
  files: readonly LocalModelDownloadFile[],
  onProgress?: (downloadedBytes: number, totalBytes: number) => void,
  storage: CacheStorage | null = browserCaches(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!storage) throw new Error('当前环境不支持浏览器模型缓存');
  const cache = await storage.open(TRANSFORMERS_CACHE_NAME);
  const totalBytes = files.reduce((sum, file) => sum + Math.max(0, file.bytes), 0);
  let downloadedBytes = 0;
  for (const file of files) {
    const request = new Request(`https://huggingface.co/${model}/resolve/main/${file.path}`);
    const cached = await cache.match(request);
    if (cached) {
      downloadedBytes += await responseBytes(cached);
      onProgress?.(downloadedBytes, totalBytes);
      continue;
    }
    const response = await fetchImpl(request);
    if (!response.ok) throw new Error(`${file.path}: HTTP ${response.status}`);
    await cache.put(request, response.clone());
    downloadedBytes += Math.max(file.bytes, await responseBytes(response));
    onProgress?.(downloadedBytes, totalBytes);
  }
}

export async function inspectLocalModelCache(
  model: LocalTranscriptionCacheModel,
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
  model: LocalTranscriptionCacheModel,
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

/** Inspect every model known to the settings UI so cleanup does not depend on
 * which model happens to be selected. */
export async function inspectAllLocalModelCaches(
  storage: CacheStorage | null = browserCaches(),
): Promise<LocalModelCacheEntry[]> {
  return Promise.all(LOCAL_TRANSCRIPTION_CACHE_MODELS.map(async (model) => ({
    model,
    cache: await inspectLocalModelCache(model, storage),
  })));
}

/** Remove all cached local model files while leaving unrelated browser caches
 * and the bundled Transformers.js runtime untouched. */
export async function deleteAllLocalModelCaches(
  storage: CacheStorage | null = browserCaches(),
): Promise<{ deletedFiles: number; freedBytes: number }> {
  const results = await Promise.all(LOCAL_TRANSCRIPTION_CACHE_MODELS.map((model) => deleteLocalModelCache(model, storage)));
  return results.reduce((total, result) => ({
    deletedFiles: total.deletedFiles + result.deletedFiles,
    freedBytes: total.freedBytes + result.freedBytes,
  }), { deletedFiles: 0, freedBytes: 0 });
}
