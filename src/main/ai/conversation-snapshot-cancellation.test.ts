import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ConversationServiceImpl } from './conversation-service';
import { ConversationStore } from './conversation-store';
import { ConfigStore } from './config-store';
import type { SecureCredentialStore } from './credential-store';
import type { PageSnapshot, TabInfo } from '../../shared/types/browser';

const root = mkdtempSync(join(tmpdir(), 'conversation-snapshot-cancel-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  has: async () => false,
  get: async () => null,
  set: async () => false,
  delete: async () => false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const tab: TabInfo = {
  id: 'synthetic-tab',
  url: 'https://example.com',
  title: '合成',
  active: true,
  state: 'loading',
};

it.each([false, true])('正常服务中预览错误保留原归属（UI中断：%s）', async (interrupted) => {
  const entered = deferred<AbortSignal | undefined>();
  const snapshotFailure = new Error('合成原生快照故障');
  let rejectSnapshot!: (error: Error) => void;
  const raw = new Promise<PageSnapshot | null>((_resolve, reject) => {
    rejectSnapshot = reject;
  });
  const dir = join(root, crypto.randomUUID());
  const service = new ConversationServiceImpl({
    store: new ConversationStore(dir),
    configStore: new ConfigStore(dir, credentials),
    credentials,
    browser: {
      getActiveTab: async () => tab,
      getPageSnapshot: (_id, signal) => {
        entered.resolve(signal);
        return raw;
      },
    },
  });
  const preview = service.previewContext();
  const rejected = expect(preview).rejects.toBe(snapshotFailure);
  const signal = await entered.promise;
  try {
    if (interrupted) service.interruptUiRequests();
    expect(signal?.aborted).toBe(interrupted);
    rejectSnapshot(snapshotFailure);
    await rejected;
    expect(service.getPendingOperationCounts().previewContext).toBe(0);
  } finally {
    rejectSnapshot(snapshotFailure);
    await preview.catch(() => undefined);
    await service.shutdown();
  }
});

describe.each(['maintenance', 'shutdown'] as const)('%s 页面采集取消', (boundary) => {
  it.each(['ask', 'agentAsk', 'previewContext'] as const)(
    '%s 仅在排水阶段取消等待，已发出原操作未退出不得清账',
    async (kind) => {
      const dir = join(root, crypto.randomUUID());
      const entered = deferred<AbortSignal | undefined>();
      const raw = deferred<PageSnapshot | null>();
      const snapshot = vi.fn((_tabId: string, signal?: AbortSignal) => {
        entered.resolve(signal);
        return raw.promise;
      });
      const service = new ConversationServiceImpl({
        store: new ConversationStore(dir),
        configStore: new ConfigStore(dir, credentials),
        credentials,
        browser: { getActiveTab: async () => tab, getPageSnapshot: snapshot },
      });
      const session = await service.createSession();
      if (!session) throw new Error('夹具失败');
      const operation =
        kind === 'previewContext'
          ? service.previewContext().catch(() => undefined)
          : service[kind]({ sessionId: session.id, question: '合成', goal: '合成' });
      const signal = await entered.promise;
      try {
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(snapshot).toHaveBeenCalledExactlyOnceWith(tab.id, signal);
        if (boundary === 'maintenance') expect(service.pauseForMaintenance(1)).toBe(true);
        else service.beginShutdown();
        expect(signal!.aborted).toBe(false);
        let drained = false;
        const drain =
          boundary === 'maintenance' ? service.drainForMaintenance(1) : service.drainBeforeClose();
        void drain.then(() => {
          drained = true;
        });
        expect(signal!.aborted).toBe(true);
        await Promise.resolve();
        expect(drained).toBe(false);
        expect(service.getPendingOperationCounts()[kind]).toBe(1);
        raw.resolve(null);
        await operation;
        await drain;
        expect(service.getPendingOperationCounts()[kind]).toBe(0);
      } finally {
        raw.resolve(null);
        await operation;
        await service.shutdown();
      }
    },
  );

  it('两个预览各自取消可取消的readiness原等待，结算后才能恢复', async () => {
    const dir = join(root, crypto.randomUUID());
    const signals: (AbortSignal | undefined)[] = [];
    const releases: (() => void)[] = [];
    const entered = deferred<void>();
    const service = new ConversationServiceImpl({
      store: new ConversationStore(dir),
      configStore: new ConfigStore(dir, credentials),
      credentials,
      browser: {
        getActiveTab: async () => tab,
        getPageSnapshot: (_id: string, signal?: AbortSignal) =>
          new Promise((resolve) => {
            signals.push(signal);
            const release = () => resolve(null);
            releases.push(release);
            signal?.addEventListener('abort', release, { once: true });
            if (signals.length === 2) entered.resolve();
          }),
      },
    });
    const operations = [service.previewContext(), service.previewContext()].map((p) =>
      p.catch(() => undefined),
    );
    await entered.promise;
    try {
      expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
      expect(signals[0]).not.toBe(signals[1]);
      if (boundary === 'maintenance') service.pauseForMaintenance(1);
      else service.beginShutdown();
      expect(signals.every((signal) => !signal!.aborted)).toBe(true);
      const drain =
        boundary === 'maintenance' ? service.drainForMaintenance(1) : service.drainBeforeClose();
      expect(signals.every((signal) => signal!.aborted)).toBe(true);
      await Promise.all(operations);
      await drain;
      expect(service.getPendingOperationCounts().previewContext).toBe(0);
      if (boundary === 'maintenance') {
        expect(service.prepareResumeAfterMaintenance(1)).toBe(true);
        expect(service.resumeAfterMaintenance(1)).toBe(true);
      }
    } finally {
      releases.forEach((release) => release());
      await Promise.all(operations);
      await service.shutdown();
    }
  });
});
