import {
  Children,
  isValidElement,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TabGroupInfo, TabInfo } from '../../../shared/types/browser';
import { buildTabBarLayout } from './tab-group-layout';
import { TabBar } from './TabBar';

interface Props {
  role?: string;
  children?: ReactNode;
  'aria-label'?: string;
  'aria-expanded'?: boolean;
  onClick?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}

function findProps(node: ReactNode, predicate: (props: Props) => boolean): Props | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Props>(child)) continue;
    if (predicate(child.props)) return child.props;
    const found = findProps(child.props.children, predicate);
    if (found) return found;
  }
  return undefined;
}

function rendered() {
  const onActivate = vi.fn();
  const element = TabBar({
    tabs: [
      { id: 'tab-a', title: '测试页', url: 'https://example.test/', state: 'error', active: true },
    ],
    activeTabId: 'tab-a',
    onActivate,
    onClose: vi.fn(),
    onReload: vi.fn(),
  });
  const tab = findProps(element, (props) => props.role === 'tab');
  expect(tab).toBeDefined();
  return { element, tab: tab!, onActivate };
}

describe('独审：标签键盘事件不得阻断内部按钮的原生激活', () => {
  it.each([
    ['关闭标签页 测试页', 'Enter'],
    ['关闭标签页 测试页', ' '],
    ['重新加载标签页 测试页', 'Enter'],
    ['重新加载标签页 测试页', ' '],
  ])('%s 的 %s 保持默认按钮行为', (label, key) => {
    const { element, tab, onActivate } = rendered();
    expect(findProps(element, (props) => props['aria-label'] === label)).toBeDefined();
    const preventDefault = vi.fn();
    tab.onKeyDown?.({
      key,
      target: { tagName: 'BUTTON' },
      currentTarget: { tagName: 'DIV' },
      preventDefault,
    } as unknown as KeyboardEvent<HTMLElement>);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])('标签自身的 %s 仍激活标签', (key) => {
    const { tab, onActivate } = rendered();
    const currentTarget = { tagName: 'DIV' };
    const preventDefault = vi.fn();
    tab.onKeyDown?.({
      key,
      target: currentTarget,
      currentTarget,
      preventDefault,
    } as unknown as KeyboardEvent<HTMLElement>);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onActivate).toHaveBeenCalledExactlyOnceWith('tab-a');
  });
});

const tabs: TabInfo[] = [
  { id: 'tab-a', title: 'A', url: 'https://a.test/', state: 'ready', active: false },
  { id: 'tab-b', title: 'B', url: 'https://b.test/', state: 'ready', active: false },
  { id: 'tab-c', title: 'C', url: 'https://c.test/', state: 'ready', active: false },
  { id: 'tab-d', title: 'D', url: 'https://d.test/', state: 'ready', active: false },
];

const group: TabGroupInfo = {
  id: 'group-a',
  name: '资料',
  color: 'blue',
  collapsed: false,
  tabIds: ['tab-c', 'tab-a'],
};

describe('标签分组布局', () => {
  it('按首个成员位置锚定组，并保持组内标签原顺序', () => {
    expect(
      buildTabBarLayout(
        tabs,
        [group],
        tabs.map((tab) => tab.id),
        null,
      ).map((item) => (item.kind === 'group' ? `group:${item.group.id}` : item.tab.id)),
    ).toEqual(['group:group-a', 'tab-a', 'tab-c', 'tab-b', 'tab-d']);
  });

  it('折叠时只保留活动成员；活动页不在组内时隐藏全部成员', () => {
    const collapsed = { ...group, collapsed: true };
    expect(
      buildTabBarLayout(
        tabs,
        [collapsed],
        tabs.map((tab) => tab.id),
        'tab-c',
      ).map((item) => (item.kind === 'group' ? `group:${item.group.id}` : item.tab.id)),
    ).toEqual(['group:group-a', 'tab-c', 'tab-b', 'tab-d']);
    expect(
      buildTabBarLayout(
        tabs,
        [collapsed],
        tabs.map((tab) => tab.id),
        'tab-b',
      ).map((item) => (item.kind === 'group' ? `group:${item.group.id}` : item.tab.id)),
    ).toEqual(['group:group-a', 'tab-b', 'tab-d']);
  });

  it('旧状态缺少 groups 或 userTabIds 时退化为原标签顺序', () => {
    expect(buildTabBarLayout(tabs, undefined, undefined, null)).toEqual(
      tabs.map((tab) => ({ kind: 'tab', tab })),
    );
    expect(buildTabBarLayout(tabs, [group], undefined, null)).toEqual(
      tabs.map((tab) => ({ kind: 'tab', tab })),
    );
  });

  it('折叠后的方向键只遍历当前可见标签', () => {
    const onActivate = vi.fn();
    const element = TabBar({
      tabs,
      activeTabId: 'tab-c',
      groups: [{ ...group, collapsed: true }],
      userTabIds: tabs.map((tab) => tab.id),
      onActivate,
      onClose: vi.fn(),
      onReload: vi.fn(),
    });
    const tab = findProps(
      element,
      (props) => props.role === 'tab' && props['aria-label'] === undefined,
    );
    expect(tab).toBeDefined();
    const currentTarget = {
      parentElement: { querySelectorAll: () => [{ focus: vi.fn() }, { focus: vi.fn() }] },
    };
    tab!.onKeyDown?.({
      key: 'ArrowRight',
      target: currentTarget,
      currentTarget,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent<HTMLElement>);
    expect(onActivate).toHaveBeenCalledExactlyOnceWith('tab-b');
  });

  it('分组头可折叠和编辑，用户标签右键可打开分组编辑器', () => {
    const onToggleGroup = vi.fn();
    const onEditGroup = vi.fn();
    const onEditTabGroup = vi.fn();
    const element = TabBar({
      tabs,
      activeTabId: 'tab-a',
      groups: [group],
      userTabIds: tabs.map((tab) => tab.id),
      onActivate: vi.fn(),
      onClose: vi.fn(),
      onReload: vi.fn(),
      onToggleGroup,
      onEditGroup,
      onEditTabGroup,
    });
    findProps(element, (props) => props['aria-label'] === '折叠分组 资料')?.onClick?.();
    findProps(element, (props) => props['aria-label'] === '编辑分组 资料')?.onClick?.();
    const firstTab = findProps(element, (props) => props.role === 'tab');
    const preventDefault = vi.fn();
    firstTab?.onContextMenu?.({ preventDefault } as unknown as MouseEvent<HTMLElement>);

    expect(onToggleGroup).toHaveBeenCalledExactlyOnceWith(group);
    expect(onEditGroup).toHaveBeenCalledExactlyOnceWith('group-a');
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onEditTabGroup).toHaveBeenCalledExactlyOnceWith('tab-a');
  });
});
