import { describe, expect, it, vi } from 'vitest';
import { WatchPreviewService } from './watch-preview-service';
import { WatchPreviewStore } from './watch-preview-store';
import type { WatchAcquisitionService } from './watch-acquisition-service';
import { WatchExportService } from './watch-export-service';
import type { WatchQueryService } from './watch-query-service';
import {
  WatchNotificationService,
  type NotificationRepository,
} from './watch-notification-service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('维护中的独立 Watch 入口', () => {
  it.each(['maintenance', 'shutdown'] as const)(
    '%s预览取消后仍等待原采集，不启动后续发现或发布旧句柄',
    async (mode) => {
      const pending = deferred<Awaited<ReturnType<WatchAcquisitionService['run']>>>();
      let signal: AbortSignal | undefined;
      const discover = vi.fn();
      const service = new WatchPreviewService({
        store: new WatchPreviewStore(),
        source: () => ({
          status: 'found',
          projection: {
            sourceId: '00000000-0000-4000-8000-000000000001',
            rowVersion: 1,
            enabled: true,
            deletedAt: null,
            scope: 'page',
            canonicalKey: 'https://example.com/',
          },
        }),
        acquisition: () =>
          ({
            run: (input: { signal: AbortSignal }) => {
              signal = input.signal;
              return pending.promise;
            },
          }) as unknown as WatchAcquisitionService,
        discoveryTarget: discover,
        browser: () => null,
        reader: () => null,
        grants: () => null,
      });
      const preview = service.previewFeed({
        mode: 'source',
        sourceId: '00000000-0000-4000-8000-000000000001',
      });
      if (mode === 'maintenance') expect(service.pauseForMaintenance(1)).toBe(true);
      else service.beginShutdown();
      expect(signal?.aborted).toBe(false);
      let drained = false;
      const drain = (
        mode === 'maintenance' ? service.drainForMaintenance(1) : service.drainBeforeClose()
      ).then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(signal?.aborted).toBe(true);
      expect(drained).toBe(false);
      expect(await service.previewFeed({ mode: 'source', sourceId: 'x' })).toEqual({
        ok: false,
        errorCode: 'unavailable',
      });
      pending.resolve({
        ok: false,
        health: 'parse_changed',
        retryable: false,
        retryAfterSeconds: null,
        disposition: 'parse',
      });
      expect(await preview).toEqual({ ok: false, errorCode: 'unavailable' });
      await drain;
      expect(discover).not.toHaveBeenCalled();
      expect(service.resumeAfterMaintenance(1)).toBe(mode === 'maintenance');
    },
  );

  it.each(['maintenance', 'shutdown'] as const)(
    '%s导出对话框跨越维护后返回，旧导出不得写入文件',
    async (mode) => {
      const selected = deferred<string | null>();
      const write = vi.fn(async () => undefined);
      const service = new WatchExportService(
        { listEvents: () => ({ items: [], total: 0 }) } as unknown as WatchQueryService,
        {
          showSaveDialog: () => selected.promise,
          write,
        },
      );
      const exporting = service.exportEventsCsv({});
      if (mode === 'maintenance') service.pauseForMaintenance(1);
      else service.beginShutdown();
      let drained = false;
      const drain = (
        mode === 'maintenance' ? service.drainForMaintenance(1) : service.drainBeforeClose()
      ).then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      selected.resolve('synthetic.csv');
      expect(await exporting).toEqual({ ok: false, errorCode: 'cancelled' });
      await drain;
      expect(write).not.toHaveBeenCalled();
    },
  );

  it.each(['maintenance', 'shutdown'] as const)(
    '%s已经开始写入的导出必须等原写入结束才可排水',
    async (mode) => {
      const pendingWrite = deferred<void>();
      const entered = deferred<void>();
      const service = new WatchExportService(
        { listEvents: () => ({ items: [], total: 0 }) } as unknown as WatchQueryService,
        {
          showSaveDialog: async () => 'synthetic.csv',
          write: () => {
            entered.resolve();
            return pendingWrite.promise;
          },
        },
      );
      const exporting = service.exportEventsCsv({});
      await entered.promise;
      if (mode === 'maintenance') service.pauseForMaintenance(1);
      else service.beginShutdown();
      let drained = false;
      const drain = (
        mode === 'maintenance' ? service.drainForMaintenance(1) : service.drainBeforeClose()
      ).then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      pendingWrite.resolve();
      await exporting;
      await drain;
      expect(drained).toBe(true);
    },
  );

  it('通知暂停不发送未claim项，当前同步投递写完终态再排水', async () => {
    const rows = ['n1', 'n2'].map((id) => ({
      id,
      ruleId: null,
      subjectType: 'event' as const,
      subjectId: id,
      channel: 'in-app' as const,
      dedupeKey: id,
      createdAt: '2026-10-04T00:00:00Z',
      privacyJson: JSON.stringify({ eventKind: 'changed', importance: 'normal', itemCount: 1 }),
    }));
    const claimed: string[] = [];
    const finished: string[] = [];
    const repository: NotificationRepository = {
      listPendingNotifications: () => rows,
      claimPendingNotification: (id) => {
        claimed.push(id);
        return true;
      },
      finishClaimedNotification: (id) => {
        finished.push(id);
        return true;
      },
      getRule: () => null,
    };
    const service = new WatchNotificationService(
      () => repository,
      () => {
        service.pauseForMaintenance(1);
        return true;
      },
      () => undefined,
    );
    await service.drain();
    await service.drainForMaintenance(1);
    await service.drain();
    expect(claimed).toEqual(['n1']);
    expect(finished).toEqual(['n1']);
    expect(service.resumeAfterMaintenance(2)).toBe(false);
  });

  it.each(['false', 'throw'] as const)(
    '通知终态%s失败保持锁存，不能重发或授予维护成功',
    async (failure) => {
      const deliver = vi.fn(() => true);
      const audit = vi.fn();
      const repository: NotificationRepository = {
        listPendingNotifications: () => [
          {
            id: 'n1',
            ruleId: null,
            subjectType: 'event',
            subjectId: 'e1',
            channel: 'in-app',
            dedupeKey: 'n1',
            privacyJson: '{"eventKind":"changed","importance":"normal","itemCount":1}',
            createdAt: '2026-10-04T00:00:00Z',
          },
        ],
        claimPendingNotification: () => true,
        finishClaimedNotification: () => {
          if (failure === 'throw') throw new Error('合成持久化失败');
          return false;
        },
        getRule: () => null,
      };
      const service = new WatchNotificationService(() => repository, deliver, audit);
      await expect(service.drain()).rejects.toThrow();
      expect(service.pauseForMaintenance(1)).toBe(true);
      await expect(service.drainForMaintenance(1)).rejects.toThrow();
      expect(service.prepareResumeAfterMaintenance(1)).toBe(false);
      expect(service.resumeAfterMaintenance(1)).toBe(false);
      await expect(service.drain()).rejects.toThrow();
      expect(deliver).toHaveBeenCalledOnce();
      expect(audit).not.toHaveBeenCalledWith('sent');
      service.beginShutdown();
      await expect(service.drainBeforeClose()).rejects.toThrow();
    },
  );
});
