// ConfigStore: provider config JSON persistence (non-secret; API keys are NOT stored here —
// SecureCredentialStore alone holds them). Contract source:
// doc/stage2/detailed-design.md §3.5 (list() signature calibrated to Promise, resolution #17).
// list() is async because hasKey goes through the async SecureCredentialStore.has() (§3.4).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logWarn } from '../logger';
import type { SecureCredentialStore } from './credential-store';
import type { ProviderConfig, ProviderInfo } from '../../shared/types/conversation';

// ProviderInfo 定义于 shared（S4 起 renderer/preload 直接复用），此处重导出保持既有导入路径
export type { ProviderConfig, ProviderInfo } from '../../shared/types/conversation';

const PROVIDER_LABELS: Record<string, string> = {
  'openai-compatible': 'OpenAI 兼容',
};

// Validation rule (§3.5 / S1 task): http/https only (file:/custom schemes rejected),
// trailing '/' stripped; empty inputs rejected. Safe return null, never throws.
export function normalizeBaseUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return trimmed.replace(/\/+$/, '');
}

export function validateProviderConfig(input: unknown): ProviderConfig | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.providerId !== 'string' || record.providerId.trim() === '') return null;
  if (typeof record.model !== 'string' || record.model.trim() === '') return null;
  const baseUrl = normalizeBaseUrl(record.baseUrl as string);
  if (baseUrl === null) return null;
  return { providerId: record.providerId.trim(), baseUrl, model: record.model.trim() };
}

export class ConfigStore {
  private readonly filePath: string;
  private loaded: Map<string, ProviderConfig> | null = null;

  constructor(
    userDataDir: string,
    private readonly credentials: SecureCredentialStore,
  ) {
    this.filePath = join(userDataDir, 'provider-config.json');
  }

  // Loaded entries are shape-validated at load time (invalid → dropped + warn); returns a
  // copy so callers cannot mutate internal state.
  get(providerId: string): ProviderConfig | null {
    const config = this.ensureLoaded().get(providerId);
    return config === undefined ? null : { ...config };
  }

  // Validation failure → false (no write). Upsert by providerId; atomic write.
  set(config: ProviderConfig): boolean {
    const valid = validateProviderConfig(config);
    if (valid === null) {
      logWarn('config', 'Provider 配置校验失败（baseUrl 仅 http/https、model 非空）');
      return false;
    }
    const map = this.ensureLoaded();
    map.set(valid.providerId, valid);
    try {
      this.writeFile([...map.values()]);
      return true;
    } catch (error) {
      logWarn('config', 'Provider 配置写入失败', error);
      return false;
    }
  }

  // Async deviation from the design's sync sketch: hasKey must await SecureCredentialStore.has().
  async list(): Promise<ProviderInfo[]> {
    const configs = [...this.ensureLoaded().values()];
    return Promise.all(
      configs.map(async (config) => ({
        providerId: config.providerId,
        label: PROVIDER_LABELS[config.providerId] ?? config.providerId,
        baseUrl: config.baseUrl,
        model: config.model,
        hasKey: await this.credentials.has(config.providerId),
      })),
    );
  }

  private ensureLoaded(): Map<string, ProviderConfig> {
    if (this.loaded === null) {
      const map = new Map<string, ProviderConfig>();
      try {
        const text = readFileSync(this.filePath, 'utf8');
        const raw: unknown = JSON.parse(text);
        if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
          const record = raw as Record<string, unknown>;
          const providers = record.providers;
          if (record.version === 1 && Array.isArray(providers)) {
            for (const entry of providers) {
              const valid = validateProviderConfig(entry);
              if (valid === null) {
                logWarn('config', 'provider-config.json 中一条非法配置已忽略');
                continue;
              }
              map.set(valid.providerId, valid);
            }
          } else {
            logWarn('config', 'provider-config.json 形状不符，按空处理（fail-closed）');
          }
        } else {
          logWarn('config', 'provider-config.json 损坏，按空处理（fail-closed）');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logWarn('config', 'provider-config.json 读取失败', error);
        }
      }
      this.loaded = map;
    }
    return this.loaded;
  }

  private writeFile(configs: ProviderConfig[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ version: 1, providers: configs }, null, 2), 'utf8');
    renameSync(tmpPath, this.filePath); // Atomic replace
  }
}
