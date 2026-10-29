import { describe, expect, it } from 'vitest';
import { browserBookmarkGroupFromTabs } from './browser-bookmark-group';
import type { TabsState } from '../shared/types/browser';

describe('保存书签组使用主进程用户标签事实', () => {
  const state: TabsState = {
    activeTabId: 'one',
    userTabIds: ['one', 'two'],
    tabs: [
      {
        id: 'one',
        url: 'https://example.test/one',
        title: '一\u0000',
        active: true,
        state: 'ready',
      },
      { id: 'two', url: 'https://example.test/two', title: '二', active: false, state: 'ready' },
    ],
    groups: [
      { id: 'group', name: '阅读', color: 'blue', collapsed: false, tabIds: ['one', 'two'] },
    ],
  };
  it('保留名称颜色成员并净化网页标题', () => {
    expect(browserBookmarkGroupFromTabs(state, 'group')).toEqual({
      name: '阅读',
      color: 'blue',
      bookmarks: [
        { url: 'https://example.test/one', title: '一' },
        { url: 'https://example.test/two', title: '二' },
      ],
    });
  });
  it('未知、过期、任务成员与不可收藏页整体拒绝，不静默少存', () => {
    expect(browserBookmarkGroupFromTabs(null, 'group')).toBeNull();
    expect(browserBookmarkGroupFromTabs(state, 'missing')).toBeNull();
    expect(browserBookmarkGroupFromTabs({ ...state, userTabIds: ['one'] }, 'group')).toBeNull();
    expect(
      browserBookmarkGroupFromTabs({ ...state, tabs: state.tabs.slice(0, 1) }, 'group'),
    ).toBeNull();
    expect(
      browserBookmarkGroupFromTabs(
        { ...state, tabs: state.tabs.map((tab) => ({ ...tab, url: 'about:blank' })) },
        'group',
      ),
    ).toBeNull();
  });
});
