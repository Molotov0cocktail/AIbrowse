// The renderer supplies only a provider DTO. The trusted main-process port owns
// native confirmation and the document lifetime predicate; no approval IPC exists.
import { performance } from 'node:perf_hooks';
import { ConfigStore, validateProviderConfig } from './config-store';
import type { SecureCredentialStore } from './credential-store';

export interface CredentialTargetProposal {
  readonly operation: 'bind-provider-target';
  readonly providerId: string;
  readonly previousTarget: string | null;
  readonly target: string;
  readonly transport: 'http' | 'https';
  readonly configurationVersion: number;
  readonly credentialGeneration: string;
  readonly expiresAt: number;
}

export interface CredentialTargetGuardOptions {
  configStore: ConfigStore;
  credentials: SecureCredentialStore;
  confirm(proposal: CredentialTargetProposal): Promise<boolean>;
  now?: () => number;
  confirmationTtlMs?: number;
}

export class CredentialTargetGuard {
  private active = false;
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(private readonly options: CredentialTargetGuardOptions) {
    this.now = options.now ?? (() => performance.now());
    this.ttl = options.confirmationTtlMs ?? 60_000;
    if (!Number.isFinite(this.ttl) || this.ttl <= 0 || this.ttl > 300_000) {
      throw new Error('Provider 确认期限无效');
    }
  }

  async updateConfig(input: unknown, lifecycle: { isCurrent(): boolean }): Promise<boolean> {
    const config = validateProviderConfig(input);
    if (config === null || this.active) return false;
    this.active = true;
    try {
      const { configStore, credentials } = this.options;
      const version = configStore.getVersion();
      const generation = credentials.getGeneration?.(config.providerId) ?? null;
      const mutation = credentials.getMutationVersion?.(config.providerId) ?? 0;
      const started = this.now();
      const expiresAt = started + this.ttl;
      const isCurrent = (): boolean => {
        const now = this.now();
        return (
          Number.isFinite(now) &&
          now >= started &&
          now < expiresAt &&
          lifecycle.isCurrent() &&
          configStore.getVersion() === version &&
          (credentials.getGeneration?.(config.providerId) ?? null) === generation &&
          (credentials.getMutationVersion?.(config.providerId) ?? 0) === mutation
        );
      };
      if (!isCurrent()) return false;
      const hasKey = await credentials.has(config.providerId);
      if (!isCurrent() || (hasKey && generation === null)) return false;
      if (
        hasKey &&
        generation !== null &&
        !configStore.isTargetAuthorized(config.providerId, config.baseUrl, generation)
      ) {
        const proposal: CredentialTargetProposal = Object.freeze({
          operation: 'bind-provider-target',
          providerId: config.providerId,
          previousTarget: configStore.get(config.providerId)?.baseUrl ?? null,
          target: config.baseUrl,
          transport: config.baseUrl.startsWith('https:') ? 'https' : 'http',
          configurationVersion: version,
          credentialGeneration: generation,
          expiresAt,
        });
        const approved = await this.options.confirm(proposal);
        if (approved !== true || !isCurrent()) return false;
      }
      if (!isCurrent()) return false;
      return configStore.commitAuthorized(config, version, hasKey ? generation : null);
    } catch {
      return false;
    } finally {
      this.active = false;
    }
  }
}
