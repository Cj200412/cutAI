import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CutaiSecretStore } from './secret-store.ts';

const PROXY_ORIGIN = 'http://127.0.0.1:15722';
const PROXY_BASE_URL = `${PROXY_ORIGIN}/v1`;

interface BootstrapState {
  apiKeyRef?: string;
}

interface ModelCatalog {
  data?: Array<{ id?: unknown }>;
}

async function readState(path: string): Promise<BootstrapState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as BootstrapState : {};
  } catch {
    return {};
  }
}

async function saveState(path: string, state: BootstrapState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state)}\n`, 'utf8');
}

async function fetchLocal(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${PROXY_ORIGIN}${path}`, {
    ...init,
    signal: AbortSignal.timeout(2_500),
  });
}

async function discoverModel(): Promise<string> {
  const response = await fetchLocal('/v1/models?format=openai');
  if (!response.ok) return 'claude-sonnet-5';
  const catalog = await response.json() as ModelCatalog;
  const models = (catalog.data ?? [])
    .map((entry) => typeof entry.id === 'string' ? entry.id : '')
    .filter(Boolean);
  // Prefer a concrete OpenAI-chat-compatible route. The virtual
  // Claude-fable-3 auto alias may currently include Anthropic-only candidates,
  // which cannot serve CutAI's OpenAI chat tool loop.
  return models.find((id) => id.toLowerCase() === 'claude-sonnet-5')
    ?? models[0]
    ?? 'claude-sonnet-5';
}

async function provisionClientKey(): Promise<string | null> {
  const response = await fetchLocal('/admin/proxy-keys', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: PROXY_ORIGIN,
    },
    body: JSON.stringify({ name: 'CutAI desktop', rate_limit_rpm: 120 }),
  });
  if (!response.ok) return null;
  const body = await response.json() as { key?: unknown };
  return typeof body.key === 'string' && body.key.startsWith('sk-proxy-')
    ? body.key
    : null;
}

/**
 * Connect to the user's local llm-proxy without exposing its client key to the
 * renderer or writing it to .env.local. A new dedicated key is provisioned only
 * when the local admin endpoint explicitly permits same-machine access.
 */
export async function bootstrapLocalLlmProxy(
  statePath: string,
  secrets: CutaiSecretStore,
): Promise<Record<string, string>> {
  try {
    const health = await fetchLocal('/health');
    if (!health.ok) return {};

    const state = await readState(statePath);
    let key = state.apiKeyRef
      ? await secrets.getForMainProcess(state.apiKeyRef)
      : null;

    if (!key) {
      key = await provisionClientKey();
      if (!key) return {};
      const apiKeyRef = await secrets.set(key, state.apiKeyRef);
      await saveState(statePath, { apiKeyRef });
    }

    return {
      LLM_PROVIDER: 'llm-proxy',
      LLM_LLM_PROXY_API_KEY: key,
      LLM_LLM_PROXY_BASE_URL: PROXY_BASE_URL,
      LLM_LLM_PROXY_MODEL: await discoverModel(),
    };
  } catch {
    return {};
  }
}
