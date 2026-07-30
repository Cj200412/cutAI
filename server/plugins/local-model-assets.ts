import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  LOCAL_TRANSCRIPTION_DOWNLOAD_FILES,
  isLocalTranscriptionModel,
} from '../../shared/local-transcription-assets.ts';
import type { LocalTranscriptionModel } from '../../shared/transcription-providers.ts';

type FetchLike = typeof fetch;

interface HuggingFaceSibling {
  rfilename?: unknown;
  size?: unknown;
}

export interface LocalModelManifest {
  model: LocalTranscriptionModel;
  expectedBytes: number;
  files: Array<{ path: string; bytes: number }>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export async function fetchLocalModelManifest(
  model: LocalTranscriptionModel,
  fetchImpl: FetchLike = fetch,
): Promise<LocalModelManifest> {
  const response = await fetchImpl(`https://huggingface.co/api/models/${model}?blobs=true`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Hugging Face HTTP ${response.status}`);
  const body = await response.json() as { siblings?: HuggingFaceSibling[] };
  const wanted = new Set<string>(LOCAL_TRANSCRIPTION_DOWNLOAD_FILES);
  const files = (body.siblings ?? []).flatMap((entry) => {
    const path = typeof entry.rfilename === 'string' ? entry.rfilename : '';
    const bytes = typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0;
    return wanted.has(path) && bytes > 0 ? [{ path, bytes }] : [];
  });
  if (!files.length) throw new Error('Hugging Face 未返回 q4 模型文件大小');
  return {
    model,
    expectedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

function requestedModel(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  return url.searchParams.get('model')?.trim() ?? '';
}

export function localModelAssetsPlugin(fetchImpl: FetchLike = fetch): Plugin {
  return {
    name: 'openchatcut-local-model-assets',
    configureServer(server) {
      server.middlewares.use('/api/local-model-assets', async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, message: 'Method not allowed' });
          return;
        }
        const model = requestedModel(req);
        if (!isLocalTranscriptionModel(model)) {
          sendJson(res, 400, { ok: false, message: '不支持的本地模型' });
          return;
        }
        try {
          sendJson(res, 200, { ok: true, ...(await fetchLocalModelManifest(model, fetchImpl)) });
        } catch (reason) {
          sendJson(res, 502, {
            ok: false,
            message: reason instanceof Error ? reason.message : String(reason),
          });
        }
      });
    },
  };
}
