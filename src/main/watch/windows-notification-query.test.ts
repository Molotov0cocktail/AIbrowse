import { describe, expect, it, vi } from 'vitest';
import type { WatchRepository } from './repository/watch-repository';
import { WatchQueryService } from './watch-query-service';

const target = {
  id: '00000000-0000-4000-8000-000000000001',
  ruleId: '00000000-0000-4000-8000-000000000002',
  sourceId: '00000000-0000-4000-8000-000000000003',
  eventKind: 'changed',
  importance: 'normal',
  firstObservedAt: '2026-10-10T18:32:43.198Z',
  lastObservedAt: '2026-10-10T18:32:43.198Z',
  itemCount: 1,
  readAt: null,
};

describe('原生点击精确事件读取', () => {
  it.each([target.id, '00000000-0000-4000-8000-000000000004', null])(
    '当前列表过滤不改变指定详情，缺失或空选择不回落其它事件：%s',
    (selectedEventId) => {
      const getEvent = vi.fn((id: string) => (id === target.id ? target : null));
      const listEventItems = vi.fn(() => []);
      const repo = {
        listRules: () => [{ id: target.ruleId }],
        listEventsByRule: () => [target],
        getEvent,
        listEventItems,
      } as unknown as WatchRepository;
      const query = new WatchQueryService(
        () => repo,
        () => ({ mode: 'running', activeCount: 0 }),
        () => ({ windowsNotification: 'available', windowsReason: null }),
        () => '合成来源',
      );
      const result = query.listEvents({
        page: 1,
        pageSize: 50,
        filter: {
          ruleId: null,
          sourceId: null,
          eventKind: null,
          importance: null,
          readState: 'read',
          fromInclusive: null,
          toExclusive: null,
        },
        selectedEventId,
      });
      expect(result?.items).toEqual([]);
      expect(result?.selected?.id ?? null).toBe(selectedEventId === target.id ? target.id : null);
      if (selectedEventId === null) expect(getEvent).not.toHaveBeenCalled();
      else expect(getEvent).toHaveBeenCalledExactlyOnceWith(selectedEventId);
      expect(listEventItems.mock.calls).toHaveLength(selectedEventId === target.id ? 1 : 0);
    },
  );
});
