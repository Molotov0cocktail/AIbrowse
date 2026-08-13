// LLMProvider interface + provider factory registry + resolveProvider.
// Contract source: doc/stage2/detailed-design.md §3.3 (signature calibrated to Promise,
// resolution #17). resolveProvider is async because the key-presence check goes through
// SecureCredentialStore.has() (async per §3.4).
import type { ProviderConfig } from '../../../shared/types/conversation';
import type {
  ProviderEvent,
  ProviderMetadata,
  ProviderRequest,
} from '../../../shared/types/conversation';
import type { SecureCredentialStore } from '../credential-store';
import { OpenAICompatibleProvider } from './openai-compatible';

// stream: signal = abort; timeouts are composed inside the adapter (§8.2).
// The iteration ends with an error event and produces nothing after it.
export interface LLMProvider {
  readonly metadata: ProviderMetadata;
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export const PROVIDER_KIND_OPENAI_COMPATIBLE = 'openai-compatible';

export interface ProviderFactory {
  readonly kind: string;
  create(config: ProviderConfig, store: SecureCredentialStore): LLMProvider;
}

const providerFactories = new Map<string, ProviderFactory>();

export function registerProviderFactory(factory: ProviderFactory): void {
  providerFactories.set(factory.kind, factory);
}

export function listProviderKinds(): string[] {
  return [...providerFactories.keys()];
}

// S1 registers the only real provider kind (design Q1); future adapters register here.
registerProviderFactory({
  kind: PROVIDER_KIND_OPENAI_COMPATIBLE,
  create: (config, store) => new OpenAICompatibleProvider(config, store),
});

// Unconfigured / missing key → null (caller normalizes to not-configured, no network request).
export async function resolveProvider(
  config: ProviderConfig | null,
  store: SecureCredentialStore,
): Promise<LLMProvider | null> {
  if (config === null) return null;
  const factory = providerFactories.get(config.providerId);
  if (factory === undefined) return null;
  const hasKey = await store.has(config.providerId);
  if (!hasKey) return null;
  return factory.create(config, store);
}
