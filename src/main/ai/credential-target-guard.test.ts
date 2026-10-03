import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  ConfigStore,
  getProviderAuthorization,
  isProviderAuthorized,
  normalizeBaseUrl,
} from './config-store';
import { SecureCredentialStoreImpl, type CipherBackend } from './credential-store';
import { CredentialTargetGuard, type CredentialTargetProposal } from './credential-target-guard';
import { OpenAICompatibleProvider } from './provider/openai-compatible';
import { resolveProvider } from './provider/llm-provider';
import type {
  ProviderConfig,
  ProviderEvent,
  ProviderRequest,
} from '../../shared/types/conversation';

const roots: string[] = [];
const cipher: CipherBackend = {
  isAvailable: () => true,
  encrypt: (text) => Buffer.from(text).toString('base64'),
  decrypt: (text) => Buffer.from(text, 'base64').toString(),
};
const CONFIG: ProviderConfig = {
  providerId: 'openai-compatible',
  baseUrl: 'https://provider.example.test/v1',
  model: 'synthetic-model',
};
const CHANGED: ProviderConfig = { ...CONFIG, baseUrl: 'https://other.example.test/v2' };
const REQUEST: ProviderRequest = {
  requestId: 'synthetic-request',
  model: CONFIG.model,
  system: 'synthetic',
  messages: [],
};
const lifecycle = { isCurrent: () => true };
function fixture(
  confirm: (proposal: CredentialTargetProposal) => Promise<boolean> = async () => true,
) {
  const root = mkdtempSync(join(tmpdir(), 'aibrowse-target-guard-'));
  roots.push(root);
  const credentials = new SecureCredentialStoreImpl(root, cipher);
  const configStore = new ConfigStore(root, credentials);
  const guard = new CredentialTargetGuard({ configStore, credentials, confirm });
  return { root, credentials, configStore, guard };
}
async function drain(provider: OpenAICompatibleProvider): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(REQUEST, new AbortController().signal))
    events.push(event);
  return events;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('合成接收器地址无效');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Provider 目标规范化与主进程确认', () => {
  it('大小写和默认端口归一，路径和非默认端口参与目标身份', () => {
    expect(normalizeBaseUrl('HTTPS://Example.TEST:443/v1///')).toBe('https://example.test/v1');
    expect(normalizeBaseUrl('http://[::1]:8080/v2/')).toBe('http://[::1]:8080/v2');
    expect(normalizeBaseUrl('https://example.test/v1/../v2')).toBeNull();
    expect(normalizeBaseUrl('https://example.test/%2e%2e/private')).toBeNull();
  });

  it('没有 Key 时允许保存配置，但没有任何可用的网络授权', async () => {
    const confirm = vi.fn<(proposal: CredentialTargetProposal) => Promise<boolean>>(
      async () => true,
    );
    const f = fixture(confirm);
    expect(await f.guard.updateConfig(CONFIG, lifecycle)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(await resolveProvider(f.configStore.get(CONFIG.providerId), f.credentials)).toBeNull();
  });

  it('新 Key 首次确认并持久化目标，同目标改模型不重复确认', async () => {
    const confirm = vi.fn<(proposal: CredentialTargetProposal) => Promise<boolean>>(
      async () => true,
    );
    const f = fixture(confirm);
    await f.credentials.set(CONFIG.providerId, 'synthetic-secret');
    expect(await f.guard.updateConfig(CONFIG, lifecycle)).toBe(true);
    const proposal = confirm.mock.calls[0]![0] as CredentialTargetProposal;
    expect(proposal).toMatchObject({
      operation: 'bind-provider-target',
      target: CONFIG.baseUrl,
      previousTarget: null,
      transport: 'https',
    });
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(JSON.stringify(proposal)).not.toContain('synthetic-secret');
    expect(await f.guard.updateConfig({ ...CONFIG, model: 'next-model' }, lifecycle)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    const restarted = new ConfigStore(f.root, new SecureCredentialStoreImpl(f.root, cipher));
    expect(isProviderAuthorized(restarted.get(CONFIG.providerId)!, f.credentials)).toBe(true);
  });

  it('旧 v1 配置/凭据无隐式授权，首次确认不重写凭据明文', async () => {
    const confirm = vi.fn<(proposal: CredentialTargetProposal) => Promise<boolean>>(
      async () => true,
    );
    const f = fixture(confirm);
    writeFileSync(
      join(f.root, 'provider-config.json'),
      JSON.stringify({ version: 1, providers: [CONFIG] }),
    );
    writeFileSync(
      join(f.root, 'credentials.json'),
      JSON.stringify({
        version: 1,
        providers: { [CONFIG.providerId]: cipher.encrypt('legacy-synthetic-secret') },
      }),
    );
    expect(await resolveProvider(f.configStore.get(CONFIG.providerId), f.credentials)).toBeNull();
    const oldCredentials = readFileSync(join(f.root, 'credentials.json'), 'utf8');
    expect(await f.guard.updateConfig(CONFIG, lifecycle)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(isProviderAuthorized(f.configStore.get(CONFIG.providerId)!, f.credentials)).toBe(true);
    expect(readFileSync(join(f.root, 'credentials.json'), 'utf8')).toBe(oldCredentials);
  });

  it('取消确认零配置或绑定提交，HTTP 目标在主进程提案中明确', async () => {
    const confirm = vi.fn<(proposal: CredentialTargetProposal) => Promise<boolean>>(
      async () => false,
    );
    const f = fixture(confirm);
    await f.credentials.set(CONFIG.providerId, 'synthetic-secret');
    f.configStore.set(CONFIG);
    const before = readFileSync(join(f.root, 'provider-config.json'), 'utf8');
    expect(
      await f.guard.updateConfig({ ...CHANGED, baseUrl: 'http://localhost:8080/v1' }, lifecycle),
    ).toBe(false);
    expect(confirm.mock.calls[0]![0]).toMatchObject({
      previousTarget: CONFIG.baseUrl,
      transport: 'http',
    });
    expect(readFileSync(join(f.root, 'provider-config.json'), 'utf8')).toBe(before);
    expect(getProviderAuthorization(f.configStore.get(CONFIG.providerId)!)).toBeNull();
  });

  it('renderer 的 approved 或任何额外字段不能成为确认', async () => {
    const f = fixture();
    await f.credentials.set(CONFIG.providerId, 'synthetic-secret');
    expect(await f.guard.updateConfig({ ...CONFIG, approved: true }, lifecycle)).toBe(false);
    expect(f.configStore.get(CONFIG.providerId)).toBeNull();
  });
});

describe('确认并发、世代与原子持久化', () => {
  it.each(['config', 'replace', 'delete', 'document', 'time'] as const)(
    '确认期间 %s 改变，旧提案不能提交',
    async (change) => {
      const pending = deferred<boolean>();
      const shown = deferred<void>();
      const f = fixture();
      await f.credentials.set(CONFIG.providerId, 'synthetic-secret');
      f.configStore.set(CONFIG);
      let current = true;
      let now = 100;
      const guard = new CredentialTargetGuard({
        configStore: f.configStore,
        credentials: f.credentials,
        confirm: () => {
          shown.resolve();
          return pending.promise;
        },
        now: () => now,
        confirmationTtlMs: 50,
      });
      const result = guard.updateConfig(CHANGED, { isCurrent: () => current });
      await shown.promise;
      expect(await guard.updateConfig(CONFIG, lifecycle)).toBe(false);
      if (change === 'config') f.configStore.set({ ...CONFIG, model: 'concurrent-model' });
      if (change === 'replace') await f.credentials.set(CONFIG.providerId, 'synthetic-replacement');
      if (change === 'delete') await f.credentials.delete(CONFIG.providerId);
      if (change === 'document') current = false;
      if (change === 'time') now = 150;
      const before = readFileSync(join(f.root, 'provider-config.json'), 'utf8');
      pending.resolve(true);
      expect(await result).toBe(false);
      expect(readFileSync(join(f.root, 'provider-config.json'), 'utf8')).toBe(before);
      expect(f.configStore.get(CONFIG.providerId)?.baseUrl).toBe(CONFIG.baseUrl);
    },
  );

  it('失败的 Key 替换也作废未完成的确认', async () => {
    const pending = deferred<boolean>();
    const shown = deferred<void>();
    const f = fixture(() => {
      shown.resolve();
      return pending.promise;
    });
    await f.credentials.set(CONFIG.providerId, 'synthetic-secret');
    const result = f.guard.updateConfig(CONFIG, lifecycle);
    await shown.promise;
    mkdirSync(join(f.root, 'credentials.json.tmp'));
    expect(await f.credentials.set(CONFIG.providerId, 'replacement')).toBe(false);
    pending.resolve(true);
    expect(await result).toBe(false);
    expect(f.configStore.get(CONFIG.providerId)).toBeNull();
  });

  it('绑定写失败保留原配置与原绑定，重启后也不出现新授权', async () => {
    const f = fixture();
    await f.credentials.set(CONFIG.providerId, 'synthetic-secret');
    expect(await f.guard.updateConfig(CONFIG, lifecycle)).toBe(true);
    const before = readFileSync(join(f.root, 'provider-config.json'), 'utf8');
    mkdirSync(join(f.root, 'provider-config.json.tmp'));
    expect(await f.guard.updateConfig(CHANGED, lifecycle)).toBe(false);
    expect(readFileSync(join(f.root, 'provider-config.json'), 'utf8')).toBe(before);
    expect(isProviderAuthorized(f.configStore.get(CONFIG.providerId)!, f.credentials)).toBe(true);
    expect(new ConfigStore(f.root, f.credentials).get(CONFIG.providerId)?.baseUrl).toBe(
      CONFIG.baseUrl,
    );
  });

  it('相同明文 Key 替换产生新世代，旧授权重启后仍失效', async () => {
    const f = fixture();
    await f.credentials.set(CONFIG.providerId, 'synthetic-secret');
    expect(await f.guard.updateConfig(CONFIG, lifecycle)).toBe(true);
    const oldGeneration = f.credentials.getGeneration(CONFIG.providerId);
    await f.credentials.set(CONFIG.providerId, 'synthetic-secret');
    expect(f.credentials.getGeneration(CONFIG.providerId)).not.toBe(oldGeneration);
    expect(
      isProviderAuthorized(
        new ConfigStore(f.root, f.credentials).get(CONFIG.providerId)!,
        f.credentials,
      ),
    ).toBe(false);
  });

  it('恶意声明绑定字段、复制配置对象和过期快照均不能授权新请求', async () => {
    const f = fixture();
    await f.credentials.set(CONFIG.providerId, 'synthetic-secret');
    await f.guard.updateConfig(CONFIG, lifecycle);
    const snapshot = f.configStore.get(CONFIG.providerId)!;
    expect(isProviderAuthorized({ ...snapshot }, f.credentials)).toBe(false);
    await f.guard.updateConfig(CHANGED, lifecycle);
    expect(isProviderAuthorized(snapshot, f.credentials)).toBe(false);
    expect(isProviderAuthorized(f.configStore.get(CONFIG.providerId)!, f.credentials)).toBe(true);
  });

  it('内存降级 Key 仍需原生确认，并且不能跨进程继承授权', async () => {
    const f = fixture();
    const credentials = new SecureCredentialStoreImpl(f.root, {
      ...cipher,
      isAvailable: () => false,
    });
    const configStore = new ConfigStore(f.root, credentials);
    const confirm = vi.fn<(proposal: CredentialTargetProposal) => Promise<boolean>>(
      async () => true,
    );
    const guard = new CredentialTargetGuard({ configStore, credentials, confirm });
    expect(await credentials.set(CONFIG.providerId, 'synthetic-memory-secret')).toBe(false);
    expect(await guard.updateConfig(CONFIG, lifecycle)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(isProviderAuthorized(configStore.get(CONFIG.providerId)!, credentials)).toBe(true);
    const restartedCredentials = new SecureCredentialStoreImpl(f.root, {
      ...cipher,
      isAvailable: () => false,
    });
    expect(
      isProviderAuthorized(
        new ConfigStore(f.root, restartedCredentials).get(CONFIG.providerId)!,
        restartedCredentials,
      ),
    ).toBe(false);
  });

  it('输入长度、控制字符和路径编码均在确认前受限，超界零提交', async () => {
    const confirm = vi.fn<(proposal: CredentialTargetProposal) => Promise<boolean>>(
      async () => true,
    );
    const f = fixture(confirm);
    await f.credentials.set(CONFIG.providerId, 'synthetic-secret');
    for (const invalid of [
      { ...CONFIG, baseUrl: `https://example.test/${'x'.repeat(2048)}` },
      { ...CONFIG, baseUrl: 'https://example.test/v1%0Aforged' },
      { ...CONFIG, model: 'x'.repeat(257) },
      { ...CONFIG, model: 'name\nforged' },
      { ...CONFIG, providerId: 'x'.repeat(129) },
    ])
      expect(await f.guard.updateConfig(invalid, lifecycle)).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(f.configStore.get(CONFIG.providerId)).toBeNull();
  });
});

describe('真实适配器只消费准确目标快照', () => {
  it.each([302, 307, 308])('真实 HTTP %s 不向同源其他路径或另一接收器转移请求', async (status) => {
    let firstCount = 0;
    let destinationCount = 0;
    const received: string[] = [];
    const destination = createServer((request, response) => {
      destinationCount += 1;
      received.push(request.headers.authorization ?? '');
      response.end('data: [DONE]\n\n');
    });
    const destinationUrl = await listen(destination);
    let crossOrigin = false;
    const origin = createServer((request, response) => {
      if (request.url === '/v1/chat/completions') {
        firstCount += 1;
        response.writeHead(status, {
          Location: crossOrigin ? `${destinationUrl}/stolen` : '/stolen',
        });
        response.end();
      } else {
        destinationCount += 1;
        received.push(request.headers.authorization ?? '');
        response.end('data: [DONE]\n\n');
      }
    });
    const originUrl = await listen(origin);
    try {
      const f = fixture();
      await f.credentials.set(CONFIG.providerId, 'synthetic-redirect-secret');
      await f.guard.updateConfig({ ...CONFIG, baseUrl: `${originUrl}/v1` }, lifecycle);
      const provider = new OpenAICompatibleProvider(
        f.configStore.get(CONFIG.providerId)!,
        f.credentials,
      );
      expect((await drain(provider))[0]).toMatchObject({
        type: 'error',
        error: { code: 'network' },
      });
      crossOrigin = true;
      expect((await drain(provider))[0]).toMatchObject({
        type: 'error',
        error: { code: 'network' },
      });
      expect(firstCount).toBe(2);
      expect(destinationCount).toBe(0);
      expect(received).toEqual([]);
    } finally {
      await close(origin);
      await close(destination);
    }
  });

  it('获准请求携带准确 Key 和 redirect:error，修改外部副本不会漂移目标', async () => {
    const f = fixture();
    await f.credentials.set(CONFIG.providerId, 'synthetic-secret');
    await f.guard.updateConfig(CONFIG, lifecycle);
    const snapshot = f.configStore.get(CONFIG.providerId)!;
    const provider = new OpenAICompatibleProvider(snapshot, f.credentials);
    snapshot.baseUrl = CHANGED.baseUrl;
    snapshot.providerId = 'other';
    const fetch = vi.fn(async () => new Response('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetch);
    await drain(provider);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([
      `${CONFIG.baseUrl}/chat/completions`,
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: 'Bearer synthetic-secret' }),
      }),
    ]);
  });

  it('获取 Key 的异步边界发生配置切换，旧请求零网络', async () => {
    const f = fixture();
    await f.credentials.set(CONFIG.providerId, 'synthetic-secret');
    await f.guard.updateConfig(CONFIG, lifecycle);
    const provider = new OpenAICompatibleProvider(
      f.configStore.get(CONFIG.providerId)!,
      f.credentials,
    );
    const key = deferred<string | null>();
    vi.spyOn(f.credentials, 'getBound').mockReturnValueOnce(key.promise);
    const fetch = vi.fn(async () => new Response('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetch);
    const result = drain(provider);
    await f.guard.updateConfig(CHANGED, lifecycle);
    key.resolve('synthetic-secret');
    expect((await result)[0]).toMatchObject({ type: 'error', error: { code: 'not-configured' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('已经发出的请求在配置切换后仍使用原目标，后续轮次拒绝旧快照', async () => {
    const f = fixture();
    await f.credentials.set(CONFIG.providerId, 'synthetic-secret');
    await f.guard.updateConfig(CONFIG, lifecycle);
    const provider = new OpenAICompatibleProvider(
      f.configStore.get(CONFIG.providerId)!,
      f.credentials,
    );
    const response = deferred<Response>();
    const sent = deferred<void>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      sent.resolve();
      return response.promise;
    });
    vi.stubGlobal('fetch', fetch);
    const result = drain(provider);
    await sent.promise;
    await f.guard.updateConfig(CHANGED, lifecycle);
    response.resolve(new Response('data: [DONE]\n\n'));
    await result;
    expect(fetch.mock.calls[0]?.[0]).toBe(`${CONFIG.baseUrl}/chat/completions`);
    expect((await drain(provider))[0]).toMatchObject({
      type: 'error',
      error: { code: 'not-configured' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
