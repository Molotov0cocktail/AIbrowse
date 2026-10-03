import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecureCredentialStoreImpl, type CipherBackend } from './credential-store';
import { ConfigStore } from './config-store';

const dirs: string[] = [];
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aibrowse-budget-'));
  dirs.push(dir);
  return dir;
}
function cipher(available = true): CipherBackend {
  return {
    isAvailable: () => available,
    encrypt: (value) => Buffer.from(value).toString('base64'),
    decrypt: (value) => Buffer.from(value, 'base64').toString(),
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Provider 存储配额与原件保留', () => {
  it('最长Key保留读写能力，超限Key不覆盖原值', async () => {
    const store = new SecureCredentialStoreImpl(directory(), cipher());
    const maximum = '汉'.repeat(16_384);
    expect(await store.set('p', maximum)).toBe(true);
    expect(await store.get('p')).toBe(maximum);
    expect(await store.set('p', maximum + '字')).toBe(false);
    expect(await store.get('p')).toBe(maximum);
  });

  it('旧文件解密后Key超限时普通与绑定读取都拒绝', async () => {
    const dir = directory();
    writeFileSync(
      join(dir, 'credentials.json'),
      JSON.stringify({
        version: 1,
        providers: { p: Buffer.from('x'.repeat(16_385)).toString('base64') },
      }),
    );
    const store = new SecureCredentialStoreImpl(dir, cipher());
    const generation = store.getGeneration('p');
    expect(generation).not.toBeNull();
    expect(await store.get('p')).toBeNull();
    expect(await store.getBound('p', generation!)).toBeNull();
  });

  it('已有65项凭据文件整体拒绝，保留原件', async () => {
    const dir = directory();
    const path = join(dir, 'credentials.json');
    const original = JSON.stringify({
      version: 1,
      providers: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`p${index}`, 'a2V5']),
      ),
    });
    writeFileSync(path, original);
    const store = new SecureCredentialStoreImpl(dir, cipher());
    expect(await store.get('p0')).toBeNull();
    expect(await store.set('p0', 'replacement')).toBe(false);
    expect(await store.delete('p0')).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('持续删除不同空ID不分配ID映射，同时使旧确认过期', async () => {
    const store = new SecureCredentialStoreImpl(directory(), cipher());
    const before = store.getMutationVersion('p');
    for (let i = 0; i < 1024; i++) expect(await store.delete(`absent${i}`)).toBe(true);
    expect(store.getMutationVersion('p')).toBeGreaterThan(before);
    // Own Map fields contain only the bounded memory credentials and generations.
    const maps = Object.values(store).filter(
      (value): value is Map<unknown, unknown> => value instanceof Map,
    );
    expect(maps.every((map) => map.size <= 64)).toBe(true);
    expect(await store.set('p', 'key')).toBe(true);
  });

  it('写失败不替换文件，也不清除有效内存回退', async () => {
    const dir = directory();
    const backend = cipher();
    const store = new SecureCredentialStoreImpl(dir, backend);
    await store.set('p', 'disk');
    const original = readFileSync(join(dir, 'credentials.json'), 'utf8');
    backend.isAvailable = () => false;
    await store.set('p', 'memory');
    backend.isAvailable = () => true;
    mkdirSync(join(dir, 'credentials.json.tmp'));
    expect(await store.set('p', 'replacement')).toBe(false);
    expect(await store.delete('p')).toBe(false);
    expect(await store.get('p')).toBe('memory');
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).toBe(original);
  });

  it('缓存配置后出现未知文件内容时不覆盖原件', () => {
    const dir = directory();
    const store = new ConfigStore(dir, new SecureCredentialStoreImpl(dir, cipher()));
    expect(store.get('p')).toBeNull();
    const path = join(dir, 'provider-config.json');
    writeFileSync(path, 'unknown existing file');
    expect(store.set({ providerId: 'p', baseUrl: 'https://example.test', model: 'm' })).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('unknown existing file');
  });

  it.each([true, false])('凭据持久化/内存最多64项（safeStorage=%s）', async (available) => {
    const store = new SecureCredentialStoreImpl(directory(), cipher(available));
    for (let i = 0; i < 64; i++) await store.set(`p${i}`, 'key');
    expect(await store.set('overflow', 'key')).toBe(false);
    expect(await store.get('overflow')).toBeNull();
    expect(await store.get('p0')).toBe('key');
    await store.set('p0', 'replacement');
    expect(await store.get('p0')).toBe('replacement');
    expect(await store.delete('p1')).toBe(true);
    await store.set('replacement', 'key');
    expect(await store.get('replacement')).toBe('key');
  });

  it('磁盘与内存共享64项预算', async () => {
    const dir = directory();
    const backend = cipher();
    const store = new SecureCredentialStoreImpl(dir, backend);
    for (let i = 0; i < 64; i++) await store.set(`p${i}`, 'key');
    backend.isAvailable = () => false;
    await store.set('overflow', 'key');
    expect(await store.get('overflow')).toBeNull();
    await store.set('p0', 'memory');
    expect(await store.get('p0')).toBe('memory');
  });

  it.each([
    'not json{{',
    JSON.stringify({ version: 1, providers: { p: '!!!' } }),
    ' '.repeat(9 * 1024 * 1024 + 1),
  ])('损坏或超限凭据不被写删覆盖（%#）', async (original) => {
    const dir = directory();
    const file = join(dir, 'credentials.json');
    writeFileSync(file, original);
    const store = new SecureCredentialStoreImpl(dir, cipher());
    expect(await store.get('p')).toBeNull();
    expect(await store.set('p', 'key')).toBe(false);
    expect(await store.delete('p')).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it.each([
    'not json{{',
    JSON.stringify({
      version: 1,
      providers: [{ providerId: 'p', baseUrl: 'file:///x', model: 'm' }],
    }),
    ' '.repeat(256 * 1024 + 1),
  ])('损坏或超限配置不被覆盖（%#）', (original) => {
    const dir = directory();
    const file = join(dir, 'provider-config.json');
    writeFileSync(file, original);
    const store = new ConfigStore(dir, new SecureCredentialStoreImpl(dir, cipher()));
    expect(store.get('p')).toBeNull();
    expect(store.set({ providerId: 'p', baseUrl: 'https://example.test', model: 'm' })).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('拒绝单密文超过128KiB，保留旧凭据', async () => {
    const dir = directory();
    const backend = cipher();
    const store = new SecureCredentialStoreImpl(dir, backend);
    await store.set('p', 'old');
    const original = readFileSync(join(dir, 'credentials.json'), 'utf8');
    backend.encrypt = () => 'A'.repeat(128 * 1024 + 1);
    expect(await store.set('p', 'new')).toBe(false);
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).toBe(original);
  });
});
