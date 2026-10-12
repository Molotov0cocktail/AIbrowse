import { Children, isValidElement, type KeyboardEvent, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TabBar } from './TabBar';

interface Props {
  role?: string;
  children?: ReactNode;
  'aria-label'?: string;
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
