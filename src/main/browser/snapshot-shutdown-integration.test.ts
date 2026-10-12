import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { expect, it, vi } from 'vitest';
import { ConversationServiceImpl } from '../ai/conversation-service';
import { ConversationStore } from '../ai/conversation-store';
import { ConfigStore } from '../ai/config-store';
import type { SecureCredentialStore } from '../ai/credential-store';
import { MaintenanceAdmission } from '../storage/maintenance-admission';
import { RuntimeShutdown } from '../storage/runtime-shutdown';
import { PageReader } from './page-reader';

vi.mock('../logger', () => ({ logDebug: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}

it('批准退休仅解除快照阻塞，实际 Conversation/root/usage 仍按正常链完成再关闭数据', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'snapshot-shutdown-'));
  const native = deferred<unknown>();
  const usage = deferred<void>();
  const reader = new PageReader();
  const admission = new MaintenanceAdmission();
  const writerRelease = admission.enter()!;
  const snapshotRelease = admission.enter()!;
  const closed = vi.fn();
  const contents = Object.assign(new EventEmitter(), {
    destroyed: false,
    getURL: () => 'https://example.test/',
    getTitle: () => '合成页面',
    isDestroyed: () => contents.destroyed,
    isCrashed: () => false,
    isLoadingMainFrame: () => false,
    executeJavaScriptInIsolatedWorld: vi.fn(() => native.promise),
    close: vi.fn(() => {
      contents.destroyed = true;
      contents.emit('destroyed');
    }),
  });
  const credentials: SecureCredentialStore = {
    isAvailable: () => true,
    has: async () => false,
    get: async () => null,
    set: async () => false,
    delete: async () => false,
  };
  const service = new ConversationServiceImpl({
    store: new ConversationStore(directory),
    configStore: new ConfigStore(directory, credentials),
    credentials,
    browser: {
      getActiveTab: async () => ({
        id: 'synthetic',
        url: 'https://example.test/',
        title: '',
        active: true,
        state: 'ready',
      }),
      getPageSnapshot: async (_tabId, signal) =>
        (await reader.snapshot(contents as unknown as WebContents, 1, signal)).snapshot,
    },
  });
  const shutdown = new RuntimeShutdown({
    roots: [admission],
    producers: [service],
    waitForUsage: () => usage.promise,
    cleanupWorkspace: async () => ({ ok: true, retainedCount: 0 }),
    closeResources: closed,
  });
  let nativeSettled = false;
  void native.promise.then(() => (nativeSettled = true));
  const preview = service.previewContext().finally(snapshotRelease);
  const handledPreview = preview.catch(() => undefined);
  try {
    await flush();
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
    contents.destroyed = true;
    contents.emit('destroyed');
    reader.beginSnapshotShutdown();
    const draining = shutdown.shutdown();
    await flush();
    expect(service.getPendingOperationCounts().previewContext).toBe(1);
    expect(shutdown.getPhase()).toBe('draining');
    expect(closed).not.toHaveBeenCalled();
    await reader.stopSnapshotsForShutdown();
    await handledPreview;
    expect(nativeSettled).toBe(false);
    expect(service.getPendingOperationCounts().previewContext).toBe(0);
    expect(closed).not.toHaveBeenCalled();
    writerRelease();
    await flush();
    expect(closed).not.toHaveBeenCalled();
    usage.resolve();
    await draining;
    expect(shutdown.getPhase()).toBe('closed');
    expect(closed).toHaveBeenCalledOnce();
    expect(nativeSettled).toBe(false);
  } finally {
    native.resolve(null);
    writerRelease();
    usage.resolve();
    await handledPreview;
    await service.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});
