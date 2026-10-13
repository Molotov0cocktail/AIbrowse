import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TabGroupInfo, TabInfo } from '../../../shared/types/browser';
import { TabGroupEditor } from './TabGroupEditor';

const tabs: TabInfo[] = [
  { id: 'tab-a', title: '文档', url: 'https://a.test/', state: 'ready', active: true },
  { id: 'tab-b', title: '搜索', url: 'https://b.test/', state: 'ready', active: false },
  { id: 'task-a', title: '任务', url: 'https://task.test/', state: 'ready', active: false },
];
const groups: TabGroupInfo[] = [
  { id: 'group-a', name: '资料', color: 'blue', collapsed: false, tabIds: ['tab-a'] },
];

function markup(selectedTabId: string) {
  return renderToStaticMarkup(
    createElement(TabGroupEditor, {
      tabs,
      groups,
      userTabIds: ['tab-a', 'tab-b'],
      selectedTabId,
      onClose: vi.fn(),
      onSelectTab: vi.fn(),
      onCreate: vi.fn(),
      onUpdate: vi.fn(),
      onSetGroup: vi.fn(),
      onUngroup: vi.fn(),
    }),
  );
}

describe('标签分组编辑面板', () => {
  it('已分组标签提供重命名、六色、折叠、移出和取消分组', () => {
    const html = markup('tab-a');
    expect(html).toContain('编辑分组');
    expect(html).toContain('value="资料"');
    expect(html.match(/type="radio"/g)).toHaveLength(6);
    expect(html).toContain('折叠分组');
    expect(html).toContain('移出此标签');
    expect(html).toContain('取消分组');
  });

  it('未分组标签提供创建和加入入口，任务标签不进入选择列表', () => {
    const html = markup('tab-b');
    expect(html).toContain('创建新分组');
    expect(html).toContain('加入“资料”');
    expect(html).not.toContain('任务');
  });
});
