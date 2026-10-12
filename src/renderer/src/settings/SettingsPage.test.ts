import { Children, isValidElement, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { SettingsPage, type SettingsSection } from './SettingsPage';

interface Props {
  children?: ReactNode;
  onClick?: () => void;
  'aria-current'?: string;
}

function nodes(value: ReactNode): Array<{ type: unknown; props: Props }> {
  const found: Array<{ type: unknown; props: Props }> = [];
  for (const child of Children.toArray(value)) {
    if (!isValidElement<Props>(child)) continue;
    found.push({ type: child.type, props: child.props });
    found.push(...nodes(child.props.children));
  }
  return found;
}

function text(value: ReactNode): string {
  if (typeof value === 'string') return value;
  return Children.toArray(value)
    .map((child) => (isValidElement<Props>(child) ? text(child.props.children) : String(child)))
    .join('');
}

it('设置页提供四个分类并将数据故障标在常驻分类入口', () => {
  const onSectionChange = vi.fn<(section: SettingsSection) => void>();
  const tree = SettingsPage({
    section: 'appearance',
    onSectionChange,
    onBack: vi.fn(),
    appearance: { appearance: 'system', setAppearance: vi.fn() },
    localData: {
      status: null,
      storage: null,
      notice: null,
      storageNotice: null,
      starting: false,
      controlling: false,
      issue: '需要处理',
      start: vi.fn(),
      control: vi.fn(),
    },
    browserDataIssue: null,
    onOpenDiagnostics: vi.fn(),
    onOpenPageDebug: vi.fn(),
    onWatchCurrentPage: vi.fn(),
  });
  const body = text(tree);
  for (const label of ['外观', 'AI 配置', '本地数据', '高级']) expect(body).toContain(label);
  expect(body).toContain('!');
  const data = nodes(tree).find(
    (node) => node.type === 'button' && text(node.props.children).includes('本地数据'),
  )!;
  data.props.onClick?.();
  expect(onSectionChange).toHaveBeenCalledExactlyOnceWith('data');
});

it('浏览库故障也标在本地数据分类入口', () => {
  const tree = SettingsPage({
    section: 'appearance',
    onSectionChange: vi.fn(),
    onBack: vi.fn(),
    appearance: { appearance: 'system', setAppearance: vi.fn() },
    localData: {
      status: null,
      storage: null,
      notice: null,
      storageNotice: null,
      starting: false,
      controlling: false,
      issue: null,
      start: vi.fn(),
      control: vi.fn(),
    },
    browserDataIssue: '浏览数据暂不可用',
    onOpenDiagnostics: vi.fn(),
    onOpenPageDebug: vi.fn(),
    onWatchCurrentPage: vi.fn(),
  });

  expect(text(tree)).toContain('!');
});
