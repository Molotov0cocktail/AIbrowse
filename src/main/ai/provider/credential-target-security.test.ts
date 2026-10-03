import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, normalizeBaseUrl } from '../config-store';
import { SecureCredentialStoreImpl, type CipherBackend } from '../credential-store';
import { OpenAICompatibleProvider } from './openai-compatible';
import type { ProviderConfig } from '../../../shared/types/conversation';

const roots: string[] = [];
const cipher: CipherBackend = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(text).toString('base64'),
  decrypt: (text) => Buffer.from(text, 'base64').toString(),
};
const config: ProviderConfig = {
  providerId: 'openai-compatible',
  baseUrl: 'https://original.example.test/v1',
  model: 'synthetic-model',
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aibrowse-e1-target-'));
  roots.push(root);
  const credentials = new SecureCredentialStoreImpl(root, cipher);
  return { root, credentials, configs: new ConfigStore(root, credentials) };
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('E1 Provider 已有凭据目标反例', () => {
  it.each([
    'https://name:password@example.test/v1',
    'https://example.test/v1?target=other',
    'https://example.test/v1#fragment',
    'https://example.test/v1\\other',
  ])('拒绝无法成为确定性目标的地址 %s', (input) => {
    expect(normalizeBaseUrl(input)).toBeNull();
  });

  it('配置持久化失败不改变可读取的内存配置', () => {
    const { root, configs } = fixture();
    expect(configs.set(config)).toBe(true);
    mkdirSync(join(root, 'provider-config.json.tmp'));
    expect(configs.set({ ...config, baseUrl: 'https://attacker.example.test/v1' })).toBe(false);
    expect(configs.get(config.providerId)?.baseUrl).toBe(config.baseUrl);
  });

  it('仅改变既有 providerId 的端点不能将已有 Key 发送到新目标', async () => {
    const { credentials, configs } = fixture();
    await credentials.set(config.providerId, 'synthetic-existing-secret');
    configs.set(config);
    configs.set({ ...config, baseUrl: 'https://attacker.example.test/v1' });
    const fetch = vi.fn(async () => new Response('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetch);
    const provider = new OpenAICompatibleProvider(configs.get(config.providerId)!, credentials);
    for await (const event of provider.stream(
      { requestId: 'synthetic-request', model: config.model, system: 'synthetic', messages: [] },
      new AbortController().signal,
    ))
      void event;
    expect(fetch).not.toHaveBeenCalled();
  });
});
