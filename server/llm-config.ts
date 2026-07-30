import {
  defaultModelForProvider,
  llmProviderConfigNames,
  llmProviderPreset,
  normalizeLlmProvider,
  protocolForProvider,
  providerApiPath,
  type LlmProvider,
} from '../shared/llm-providers.ts';

export type ServerLlmProvider = LlmProvider;
export const normalizeServerLlmProvider = normalizeLlmProvider;

/**
 * AI SDK providers append their own operation path (`/messages`, `/responses`,
 * `/chat/completions`). The configured Base URL is therefore the API prefix,
 * including any provider-specific version path.
 */
export const AI_SDK_BASE_URL_FORMAT = 'ai-sdk-prefix';

export interface ResolvedLlmProviderConfig {
  readonly provider: LlmProvider;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

function operationSuffixes(provider: LlmProvider): readonly string[] {
  const protocol = protocolForProvider(provider);
  if (protocol === 'anthropic') return ['/messages'];
  if (protocol === 'openai') return ['/responses', '/chat/completions'];
  if (protocol === 'openai-compatible') return ['/chat/completions'];
  return [];
}

/**
 * Accept either an AI SDK prefix or a complete operation URL. The SDK still
 * appends its operation path, so a complete URL is reduced to the equivalent
 * prefix once, preserving query parameters used by compatible gateways.
 */
export function normalizeLlmEndpointPrefix(providerValue: unknown, configuredValue: string): string {
  const provider = normalizeServerLlmProvider(providerValue);
  const tailIndex = configuredValue.search(/[?#]/);
  const path = (tailIndex < 0 ? configuredValue : configuredValue.slice(0, tailIndex)).replace(/\/+$/, '');
  const tail = tailIndex < 0 ? '' : configuredValue.slice(tailIndex);
  const lower = path.toLowerCase();
  for (const suffix of operationSuffixes(provider)) {
    if (lower.endsWith(suffix)) return `${path.slice(0, -suffix.length).replace(/\/+$/, '')}${tail}`;
  }
  return `${path}${tail}`;
}

export function resolveLlmBaseUrl(
  providerValue: unknown,
  configuredValue: unknown,
  formatValue: unknown = AI_SDK_BASE_URL_FORMAT,
): string {
  const provider = normalizeServerLlmProvider(providerValue);
  const configured = typeof configuredValue === 'string'
    ? normalizeLlmEndpointPrefix(provider, configuredValue.trim())
    : '';
  if (configured) {
    // Before the AI SDK migration the UI required a service root without /v1,
    // and the client always inserted /v1. An absent format marker identifies
    // that persisted convention even when the root contains a path.
    if (formatValue !== AI_SDK_BASE_URL_FORMAT
      && normalizeLlmEndpointPrefix(provider, String(configuredValue).trim())
        === String(configuredValue).trim().replace(/\/+$/, '')) {
      return /\/v1$/i.test(configured) ? configured : `${configured}/v1`;
    }
    return configured;
  }
  return llmProviderPreset(provider).baseUrl;
}

export function llmOperationPath(providerValue: unknown): string {
  return providerApiPath(providerValue);
}

/** Resolve one independently saved vendor configuration without exposing it to the browser. */
export function resolveLlmProviderConfig(
  providerValue: unknown,
  get: (name: string) => string,
): ResolvedLlmProviderConfig {
  const provider = normalizeServerLlmProvider(providerValue);
  const names = llmProviderConfigNames(provider);
  return {
    provider,
    apiKey: get(names.apiKey),
    baseUrl: resolveLlmBaseUrl(provider, get(names.baseUrl), AI_SDK_BASE_URL_FORMAT),
    model: get(names.model) || defaultModelForProvider(provider),
  };
}

/** Switching vendors must not carry a provider-specific model or Base URL. */
export function expandLlmProviderPatch(
  patch: ReadonlyMap<string, string>,
  currentProviderValue: unknown,
): Map<string, string> {
  const expanded = new Map(patch);
  if (!expanded.has('LLM_PROVIDER')) return expanded;
  const current = normalizeServerLlmProvider(currentProviderValue);
  const next = normalizeServerLlmProvider(expanded.get('LLM_PROVIDER'));
  if (current === next) return expanded;
  if (!expanded.has('LLM_MODEL')) expanded.set('LLM_MODEL', '');
  if (!expanded.has('LLM_BASE_URL')) expanded.set('LLM_BASE_URL', '');
  return expanded;
}
