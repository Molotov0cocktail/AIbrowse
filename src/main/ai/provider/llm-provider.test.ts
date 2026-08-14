// LLMProvider registry + resolveProvider tests: not-configured paths must resolve to
// null WITHOUT any network activity (resolve is pure wiring, no fetch involved).
// Contract source: doc/stage2/detailed-design.md §3.3.
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_KIND_OPENAI_COMPATIBLE,
  listProviderKinds,
  registerProviderFactory,
  resolveProvider,
  type LLMProvider,
} from './llm-provider';
import { FakeProvider } from './fake-provider';
import type { SecureCredentialStore } from '../credential-store';
import type { ProviderConfig } from '../../../shared/types/conversation';

class MemoryCredentials implements SecureCredentialStore {
  private readonly keys: Map<string, string>;
  constructor(initial: Record<string, string> = {}) {
    this.keys = new Map(Object.entries(initial));
  }
  isAvailable(): boolean {
    return true;
  }
  async set(providerId: string, apiKey: string): Promise<boolean> {
    this.keys.set(providerId, apiKey);
    return true;
  }
  async get(providerId: string): Promise<string | null> {
    return this.keys.get(providerId) ?? null;
  }
  async has(providerId: string): Promise<boolean> {
    return this.keys.has(providerId);
  }
  async delete(providerId: string): Promise<boolean> {
    this.keys.delete(providerId);
    return true;
  }
}

const CONFIG: ProviderConfig = {
  providerId: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1/',
  model: 'test-model',
};

describe('resolveProvider — 未配置/无 Key → null（→ not-configured，不发起网络请求）', () => {
  it('config 为 null → null', async () => {
    expect(await resolveProvider(null, new MemoryCredentials())).toBeNull();
  });

  it('配置存在但无 Key → null', async () => {
    expect(await resolveProvider(CONFIG, new MemoryCredentials())).toBeNull();
  });

  it('未注册 providerId → null', async () => {
    const store = new MemoryCredentials({ 'unknown-kind': 'sk-test-1234567890' });
    expect(await resolveProvider({ ...CONFIG, providerId: 'unknown-kind' }, store)).toBeNull();
  });

  it('配置 + Key → LLMProvider（metadata 取自配置）', async () => {
    const store = new MemoryCredentials({ 'openai-compatible': 'sk-test-1234567890' });
    const provider = await resolveProvider(CONFIG, store);
    expect(provider).not.toBeNull();
    const metadata = (provider as LLMProvider).metadata;
    expect(metadata.id).toBe('openai-compatible');
    expect(metadata.streaming).toBe(true);
    // A1 校准为真实端点能力（doc/stage3/detailed-design.md §3.1）
    expect(metadata.supportsToolCalling).toBe(true);
    expect(typeof metadata.defaultContextLimitTokens).toBe('number');
  });
});

describe('Provider 工厂注册表', () => {
  it('S1 已注册 openai-compatible 工厂', () => {
    expect(listProviderKinds()).toContain(PROVIDER_KIND_OPENAI_COMPATIBLE);
  });

  it('registerProviderFactory 注册自定义 kind（扩展点）', () => {
    registerProviderFactory({
      kind: 'test-kind',
      create: () => new FakeProvider(),
    });
    expect(listProviderKinds()).toContain('test-kind');
  });
});
