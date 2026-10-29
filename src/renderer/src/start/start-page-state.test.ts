import { describe, expect, it } from 'vitest';
import type { TabInfo, TabsState } from '../../../shared/types/browser';
import { isStartPageTab, startWatchItems } from './start-page-state';

describe('起始页的用户标签边界', () => {
  const tab: TabInfo = { id: 'user', active: true, title: '', url: 'about:blank', state: 'ready' };
  const state: TabsState = { tabs: [tab], activeTabId: tab.id, userTabIds: [tab.id] };
  it('只覆盖已确定归属的普通用户空白标签', () => {
    expect(isStartPageTab(tab, state)).toBe(true);
    expect(isStartPageTab({ ...tab, url: '' }, state)).toBe(true);
    expect(isStartPageTab(tab, { ...state, userTabIds: [] })).toBe(false);
    expect(isStartPageTab(tab, { ...state, userTabIds: undefined })).toBe(false);
    expect(isStartPageTab(null, state)).toBe(false);
    expect(isStartPageTab(tab, null)).toBe(false);
  });
  it('实际网页、正在加载和错误页保持原生视图', () => {
    for (const url of ['https://example.test', 'about:blank#content', 'file:///test']) {
      expect(isStartPageTab({ ...tab, url }, state)).toBe(false);
    }
    for (const status of ['loading', 'error'] as const) {
      expect(isStartPageTab({ ...tab, state: status }, state)).toBe(false);
    }
  });
});

describe('起始页监视有界摘要', () => {
  const rule = {
    id: 'one',
    sourceName: '示例',
    state: 'enabled',
    health: 'healthy',
    secret: '不投影',
  };
  it('仅投影所需字段并保持真实空集合', () => {
    expect(startWatchItems({ items: [] })).toEqual([]);
    expect(startWatchItems({ items: [rule] })).toEqual([
      { id: 'one', sourceName: '示例', state: 'enabled', health: 'healthy' },
    ]);
  });
  it('拒绝异常或超量数据，不能当作无监视任务', () => {
    for (const value of [
      null,
      {},
      { items: 'bad' },
      { items: [null] },
      { items: [{ ...rule, health: 'unknown' }] },
      { items: Array(5).fill(rule) },
    ]) {
      expect(startWatchItems(value)).toBeNull();
    }
  });
});
