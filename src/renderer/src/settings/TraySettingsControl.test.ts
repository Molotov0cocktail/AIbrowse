import { Children, isValidElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { TraySettingsControl } from './TraySettingsControl';

const tray = vi.hoisted(() => ({
  controller: {
    settings: { runInTray: false, available: true, error: null },
    loading: false,
    saving: false,
    notice: null as string | null,
    setRunInTray: vi.fn(),
  },
}));

vi.mock('./useTraySettings', () => ({ useTraySettings: () => tray.controller }));

interface Props {
  children?: ReactNode;
  type?: string;
  checked?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  onChange?: (event: { currentTarget: { checked: boolean } }) => void;
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

beforeEach(() => {
  tray.controller.settings = { runInTray: false, available: true, error: null };
  tray.controller.loading = false;
  tray.controller.saving = false;
  tray.controller.notice = null;
  tray.controller.setRunInTray.mockReset();
});

it('呈现完整托盘与退出边界文案并按主进程状态切换', () => {
  const tree = TraySettingsControl();
  const body = text(tree);
  expect(body).toContain('托盘运行');
  expect(body).toContain('关闭主窗口后继续运行监控任务');
  expect(body).toContain('可从系统托盘重新打开窗口，或选择退出 AIbrowse 结束运行');
  expect(body).toContain('退出 AIbrowse 或关闭 Windows 后，监控任务不会继续运行');

  const checkbox = nodes(tree).find(
    (node) => node.type === 'input' && node.props.type === 'checkbox',
  )!;
  expect(checkbox.props.checked).toBe(false);
  expect(checkbox.props.disabled).toBe(false);
  expect(checkbox.props['aria-label']).toBe('关闭窗口后在系统托盘运行');
  checkbox.props.onChange?.({ currentTarget: { checked: true } });
  expect(tray.controller.setRunInTray).toHaveBeenCalledExactlyOnceWith(true);
});

it('只呈现hook提供的固定错误文案', () => {
  tray.controller.notice = '托盘设置保存失败，请稍后重试';
  const body = text(TraySettingsControl());
  expect(body).toContain('托盘设置保存失败，请稍后重试');
  expect(body).not.toContain('private detail');
});

it.each([
  { loading: true, saving: false, available: true },
  { loading: false, saving: true, available: true },
  { loading: false, saving: false, available: false },
])('加载、保存或不可用时禁用checkbox：%j', (state) => {
  tray.controller.loading = state.loading;
  tray.controller.saving = state.saving;
  tray.controller.settings = { runInTray: true, available: state.available, error: null };
  const checkbox = nodes(TraySettingsControl()).find(
    (node) => node.type === 'input' && node.props.type === 'checkbox',
  )!;
  expect(checkbox.props.disabled).toBe(true);
  expect(checkbox.props.checked).toBe(true);
});
