import {
  LLM_PROVIDER_PRESETS,
  defaultModelForProvider,
  llmProviderConfigNames,
  normalizeLlmProvider,
  type LlmProvider,
} from '../../shared/llm-providers';
import { setLlmConfig } from './client';

interface KeyStateLike {
  readonly configured: boolean;
}

export interface AgentModelChoice {
  readonly id: string;
  readonly provider: LlmProvider;
  readonly providerLabel: string;
  readonly model: string;
}

export interface AgentModelSnapshot {
  readonly activeId: string;
  readonly choices: readonly AgentModelChoice[];
  readonly loaded: boolean;
}

const EMPTY: AgentModelSnapshot = { activeId: '', choices: [], loaded: false };
let snapshot = EMPTY;
let catalogs: Record<string, readonly string[]> = {};
const listeners = new Set<() => void>();

function emit(next: AgentModelSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function subscribeAgentModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAgentModelSnapshot(): AgentModelSnapshot {
  return snapshot;
}

export function applyAgentModelStatus(
  keys: Record<string, KeyStateLike>,
  models: Record<string, string>,
): void {
  const choices = LLM_PROVIDER_PRESETS.flatMap((preset): AgentModelChoice[] => {
    const names = llmProviderConfigNames(preset.id);
    if (!keys[names.apiKey]?.configured) return [];
    const configured = models[names.model]?.trim() || defaultModelForProvider(preset.id);
    const available = [...new Set([configured, ...(catalogs[preset.id] ?? [])])].filter(Boolean);
    return available.map((model) => ({
      id: `${preset.id}:${model}`,
      provider: preset.id,
      providerLabel: preset.label,
      model,
    }));
  });
  const savedProvider = normalizeLlmProvider(models.LLM_PROVIDER);
  const savedModel = models[llmProviderConfigNames(savedProvider).model]?.trim();
  const active = choices.find((choice) => choice.provider === savedProvider && (!savedModel || choice.model === savedModel))
    ?? choices.find((choice) => choice.provider === savedProvider)
    ?? choices[0];
  if (active) setLlmConfig(active.provider, active.model, models.LLM_OPENAI_API_MODE);
  emit({ activeId: active?.id ?? '', choices, loaded: true });
}

export function applyAgentModelCatalogs(
  nextCatalogs: Record<string, readonly string[]>,
  keys: Record<string, KeyStateLike>,
  models: Record<string, string>,
): void {
  catalogs = { ...catalogs, ...nextCatalogs };
  applyAgentModelStatus(keys, models);
}

export function selectAgentModel(id: string): void {
  const active = snapshot.choices.find((choice) => choice.id === id);
  if (!active || active.id === snapshot.activeId) return;
  setLlmConfig(active.provider, active.model);
  emit({ ...snapshot, activeId: active.id });
  void fetch('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      LLM_PROVIDER: active.provider,
      [llmProviderConfigNames(active.provider).model]: active.model,
    }),
  }).catch(() => {
    // The in-memory selection remains usable for this session if persistence fails.
  });
}
