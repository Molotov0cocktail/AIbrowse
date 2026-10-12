import { Children, isValidElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BrowserLibraryPage } from './BrowserLibraryPage';
import { applyForCurrentLibraryView } from './view-epoch';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useEffect: () => undefined,
    useRef: (initial: unknown) => ({ current: initial }),
    useState: (initial: unknown) => [initial, vi.fn()],
  };
});

interface Props {
  children?: ReactNode;
  onClick?: () => void;
  role?: string;
  'aria-selected'?: boolean;
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

describe('浏览资料页静态隐私契约与导航', () => {
  it('异步修改完成时拒绝覆盖已切换的分类或搜索视图', async () => {
    let currentEpoch = 4;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applied = vi.fn();
    const completion = pending.then(() => applyForCurrentLibraryView(currentEpoch, 4, applied));

    currentEpoch = 5;
    release();

    await expect(completion).resolves.toBe(false);
    expect(applied).not.toHaveBeenCalled();
  });

  it('历史页明确本地保留、后台任务排除与清空隔离', () => {
    const onModeChange = vi.fn();
    const tree = BrowserLibraryPage({
      mode: 'history',
      onModeChange,
      onBack: vi.fn(),
      onOpenUrl: vi.fn(),
      onBookmarksChanged: vi.fn(),
    });
    const body = text(tree);
    expect(body).toContain('一直保存在本机');
    expect(body).toContain('Research');
    expect(body).toContain('Watch');
    const bookmarks = nodes(tree).find((node) => text(node.props.children) === '书签')!;
    bookmarks.props.onClick?.();
    expect(onModeChange).toHaveBeenCalledExactlyOnceWith('bookmarks');
  });

  it('书签页明确与Sources和AI隔离', () => {
    const body = text(
      BrowserLibraryPage({
        mode: 'bookmarks',
        onModeChange: vi.fn(),
        onBack: vi.fn(),
        onOpenUrl: vi.fn(),
        onBookmarksChanged: vi.fn(),
      }),
    );
    expect(body).toContain('独立于 Sources');
    expect(body).toContain('AI 无法读取或管理书签');
  });
});
