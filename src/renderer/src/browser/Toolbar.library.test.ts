import { Children, createRef, isValidElement, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { Toolbar } from './Toolbar';

interface Props {
  children?: ReactNode;
  onClick?: () => void;
  'aria-label'?: string;
}

function find(node: ReactNode, label: string): Props {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Props>(child)) continue;
    if (child.props['aria-label'] === label) return child.props;
    try {
      return find(child.props.children, label);
    } catch {
      // Continue with siblings.
    }
  }
  throw new Error(`未找到 ${label}`);
}

it('工具栏直接提供历史、书签、设置和当前页收藏入口', () => {
  const onOpenHistory = vi.fn();
  const onOpenBookmarks = vi.fn();
  const onOpenSettings = vi.fn();
  const onToggleBookmark = vi.fn();
  const tree = Toolbar({
    activeTab: null,
    onNavigate: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onToggleAiPanel: vi.fn(),
    onToggleSourcesPanel: vi.fn(),
    onToggleResearchPanel: vi.fn(),
    onOpenWatch: vi.fn(),
    onOpenHistory,
    onOpenBookmarks,
    onOpenSettings,
    onToggleBookmark,
    addressBarRef: createRef<HTMLInputElement>(),
  });
  find(tree, '历史记录').onClick?.();
  find(tree, '书签').onClick?.();
  find(tree, '设置').onClick?.();
  find(tree, '将当前页加入书签').onClick?.();
  expect(onOpenHistory).toHaveBeenCalledOnce();
  expect(onOpenBookmarks).toHaveBeenCalledOnce();
  expect(onOpenSettings).toHaveBeenCalledOnce();
  expect(onToggleBookmark).toHaveBeenCalledOnce();
});
