// ConfigStore tests: JSON persistence + validation rules (baseUrl http/https only,
// trailing '/' stripped, non-empty model/providerId, fail-closed load).
// Contract source: doc/stage2/detailed-design.md §3.5.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLogger } from '../logger';
import { ConfigStore, normalizeBaseUrl, validateProviderConfig } from './config-store';
import type { SecureCredentialStore } from './credential-store';
import type { ProviderConfig } from '../../shared/types/conversation';

// In-memory credential stand-in: has() only, no Electron.
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

let baseDir: string;
beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'aibrowse-config-'));
  initLogger(join(baseDir, 'app'));
});
afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

const VALID: ProviderConfig = {
  providerId: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1/',
  model: 'test-model',
};

describe('normalizeBaseUrl / validateProviderConfig — 校验规则（§3.5）', () => {
  it('http/https 合法并去尾 /；路径保留', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl('https://api.example.com/v1///')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl('http://localhost:11434')).toBe('http://localhost:11434');
  });

  it('file:/自定义协议/非 URL/空串 → null', () => {
    expect(normalizeBaseUrl('file:///C:/x')).toBeNull();
    expect(normalizeBaseUrl('custom://evil')).toBeNull();
    expect(normalizeBaseUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBaseUrl('not a url')).toBeNull();
    expect(normalizeBaseUrl('')).toBeNull();
  });

  it('providerId/model 非空（trim 后存储）；形状非法 → null', () => {
    expect(validateProviderConfig({ ...VALID, model: '  ' })).toBeNull();
    expect(validateProviderConfig({ ...VALID, providerId: '' })).toBeNull();
    expect(validateProviderConfig({ ...VALID, model: ' gpt-4o ' })?.model).toBe('gpt-4o');
    expect(validateProviderConfig(null)).toBeNull();
    expect(validateProviderConfig([])).toBeNull();
    expect(validateProviderConfig('x')).toBeNull();
    expect(validateProviderConfig({ providerId: 'p' })).toBeNull();
  });
});

describe('ConfigStore — 读写与持久化', () => {
  it('set/get 往返（baseUrl 已去尾 /），get 返回副本', () => {
    const store = new ConfigStore(join(baseDir, 'case-roundtrip'), new MemoryCredentials());
    expect(store.set(VALID)).toBe(true);
    const got = store.get('openai-compatible');
    expect(got).toEqual({ ...VALID, baseUrl: 'https://api.example.com/v1' });
    got!.model = 'mutated';
    expect(store.get('openai-compatible')?.model).toBe('test-model');
  });

  it('校验失败 → set false，不落盘', () => {
    const dir = join(baseDir, 'case-invalid-set');
    const store = new ConfigStore(dir, new MemoryCredentials());
    expect(store.set({ providerId: 'p', baseUrl: 'file:///x', model: 'm' })).toBe(false);
    expect(store.set({ providerId: 'p', baseUrl: 'https://a.com', model: '' })).toBe(false);
    expect(existsSync(join(dir, 'provider-config.json'))).toBe(false);
  });

  it('持久化：新实例同目录读回已存配置', () => {
    const dir = join(baseDir, 'case-persist');
    new ConfigStore(dir, new MemoryCredentials()).set(VALID);
    const reloaded = new ConfigStore(dir, new MemoryCredentials());
    expect(reloaded.get('openai-compatible')?.baseUrl).toBe('https://api.example.com/v1');
  });

  it('同 providerId upsert 覆盖（不产生重复条目）', () => {
    const dir = join(baseDir, 'case-upsert');
    const store = new ConfigStore(dir, new MemoryCredentials());
    store.set(VALID);
    store.set({ ...VALID, model: 'new-model' });
    expect(store.get('openai-compatible')?.model).toBe('new-model');
    const parsed = JSON.parse(readFileSync(join(dir, 'provider-config.json'), 'utf8'));
    expect(parsed.providers).toHaveLength(1);
  });

  it('get 未配置 → null；原子写无 .tmp 残留', () => {
    const dir = join(baseDir, 'case-null');
    const store = new ConfigStore(dir, new MemoryCredentials());
    expect(store.get('nope')).toBeNull();
    store.set(VALID);
    expect(existsSync(join(dir, 'provider-config.json.tmp'))).toBe(false);
  });
});

describe('ConfigStore — 加载形状校验（fail-closed）', () => {
  it('文件损坏 → 视为空 + 可恢复写入', () => {
    const dir = join(baseDir, 'case-corrupt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'provider-config.json'), 'not json{{', 'utf8');
    const store = new ConfigStore(dir, new MemoryCredentials());
    expect(store.get('openai-compatible')).toBeNull();
    expect(store.set(VALID)).toBe(true);
    expect(store.get('openai-compatible')).not.toBeNull();
  });

  it('非法条目加载时丢弃，合法条目保留', () => {
    const dir = join(baseDir, 'case-drop-entry');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'provider-config.json'),
      JSON.stringify({
        version: 1,
        providers: [
          { providerId: 'bad-url', baseUrl: 'file:///x', model: 'm' },
          { ...VALID, baseUrl: 'https://api.example.com/v1' },
          { providerId: 'bad-model', baseUrl: 'https://a.com', model: '' },
        ],
      }),
      'utf8',
    );
    const store = new ConfigStore(dir, new MemoryCredentials());
    expect(store.get('bad-url')).toBeNull();
    expect(store.get('bad-model')).toBeNull();
    expect(store.get('openai-compatible')?.baseUrl).toBe('https://api.example.com/v1');
  });
});

describe('ConfigStore — list（hasKey 来自 SecureCredentialStore）', () => {
  it('hasKey 反映凭据存在性；label 有映射用映射、无映射用 providerId', async () => {
    const dir = join(baseDir, 'case-list');
    const store = new ConfigStore(
      dir,
      new MemoryCredentials({ 'openai-compatible': 'sk-test-1234567890' }),
    );
    store.set(VALID);
    store.set({ providerId: 'other', baseUrl: 'https://other.example.com', model: 'm2' });
    const list = await store.list();
    expect(list).toEqual([
      {
        providerId: 'openai-compatible',
        label: 'OpenAI 兼容',
        baseUrl: 'https://api.example.com/v1',
        model: 'test-model',
        hasKey: true,
      },
      {
        providerId: 'other',
        label: 'other',
        baseUrl: 'https://other.example.com',
        model: 'm2',
        hasKey: false,
      },
    ]);
  });
});
