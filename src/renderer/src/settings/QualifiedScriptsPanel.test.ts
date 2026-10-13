import { Children, isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  QualifiedScriptResult,
  QualifiedScriptStatus,
} from '../../../shared/types/qualified-userscripts';
import { QualifiedScriptsPanel } from './QualifiedScriptsPanel';

const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
  effects: [] as Array<() => (() => void) | void>,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = initial;
      return [
        hooks.values[index],
        (next: unknown) => {
          hooks.values[index] =
            typeof next === 'function'
              ? (next as (current: unknown) => unknown)(hooks.values[index])
              : next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useEffect: (effect: () => (() => void) | void) => hooks.effects.push(effect),
  };
});

interface Props {
  children?: ReactNode;
  type?: string;
  role?: string;
  checked?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  onClick?: () => void;
  onChange?: (event: { currentTarget: { checked: boolean } }) => void;
}

interface Node {
  type: unknown;
  props: Props;
}

function nodes(value: ReactNode): Node[] {
  const found: Node[] = [];
  for (const child of Children.toArray(value)) {
    if (!isValidElement<Props>(child)) continue;
    found.push({ type: child.type, props: child.props });
    found.push(...nodes(child.props.children));
  }
  return found;
}

function text(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return Children.toArray(value)
    .map((child) => (isValidElement<Props>(child) ? text(child.props.children) : String(child)))
    .join('');
}

function render(): ReactNode {
  hooks.cursor = 0;
  return QualifiedScriptsPanel();
}

function buttons(label: string): Node[] {
  return nodes(render()).filter(
    (node) => node.type === 'button' && text(node.props.children) === label,
  );
}

function button(label: string): Node {
  const found = buttons(label)[0];
  if (found === undefined) throw new Error(`未找到按钮：${label}`);
  return found;
}

function checkbox(name: string): Node {
  const found = nodes(render()).find(
    (node) => node.type === 'input' && node.props['aria-label'] === `启用 ${name}`,
  );
  if (found === undefined) throw new Error(`未找到脚本开关：${name}`);
  return found;
}

async function drain(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const acUninstalled: QualifiedScriptStatus = {
  id: 'ac-baidu',
  name: 'AC-baidu',
  version: '27.20',
  installed: false,
  enabled: false,
  issue: null,
};

const githubInstalled: QualifiedScriptStatus = {
  id: 'github-zh',
  name: 'GitHub 中文化插件',
  version: '1.9.2.4',
  installed: true,
  enabled: true,
  issue: null,
};

const cleanups: Array<() => void> = [];

function mount(initial: QualifiedScriptStatus[] = [acUninstalled, githubInstalled]) {
  const bridge = {
    list: vi.fn(async () => initial),
    install: vi.fn(async (): Promise<QualifiedScriptResult> => ({ ok: true })),
    installFile: vi.fn(async (): Promise<QualifiedScriptResult> => ({ ok: true })),
    setEnabled: vi.fn(async (): Promise<QualifiedScriptResult> => ({ ok: true })),
    remove: vi.fn(async (): Promise<QualifiedScriptResult> => ({ ok: true })),
    showMenu: vi.fn(async () => true),
  };
  vi.stubGlobal('window', { aibrowse: { qualifiedScripts: bridge } });
  render();
  const cleanup = hooks.effects[0]?.();
  if (cleanup !== undefined) cleanups.push(cleanup);
  return bridge;
}

beforeEach(() => {
  hooks.cursor = 0;
  hooks.values = [];
  hooks.effects = [];
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

describe('指定油猴脚本面板交互边界', () => {
  it('本地安装仅传固定标识，完成后刷新状态', async () => {
    const bridge = mount();
    await drain();
    button('从本地安装').props.onClick?.();
    await drain();
    expect(bridge.installFile).toHaveBeenCalledWith('ac-baidu');
    expect(bridge.install).not.toHaveBeenCalled();
    expect(text(render())).toContain('已从本地安装并启用');
  });
  it('区分未安装与已安装脚本并只为已安装项显示开关和卸载', async () => {
    mount();
    await drain();

    const body = text(render());
    expect(body).toContain('AC-baidu版本 27.20 · 未安装');
    expect(body).toContain('GitHub 中文化插件版本 1.9.2.4 · 已启用');
    expect(buttons('安装')).toHaveLength(1);
    expect(buttons('卸载')).toHaveLength(1);
    expect(checkbox(githubInstalled.name).props.checked).toBe(true);
  });

  it('损坏状态保持停用并提供明确的重新安装入口', async () => {
    const issue = '脚本安装包损坏，原文件已保留且脚本已停用。';
    mount([{ ...acUninstalled, issue }]);
    await drain();

    expect(text(render())).toContain(issue);
    expect(nodes(render()).some((node) => node.type === 'input')).toBe(false);
    expect(button('重新安装').props.disabled).toBe(false);
  });

  it('安装取消刷新真实列表且不声称安装成功', async () => {
    const bridge = mount([acUninstalled]);
    bridge.install.mockResolvedValue({ ok: true, cancelled: true });
    await drain();
    bridge.list.mockResolvedValue([acUninstalled]);

    button('安装').props.onClick?.();
    await drain();

    const body = text(render());
    expect(body).toContain('已取消安装。');
    expect(body).toContain('未安装');
    expect(body).not.toContain('已安装并启用');
    expect(bridge.list).toHaveBeenCalledTimes(2);
  });

  it('操作promise未完成时阻止重复安装', async () => {
    const operation = deferred<QualifiedScriptResult>();
    const bridge = mount([acUninstalled]);
    bridge.install.mockImplementation(() => operation.promise);
    await drain();

    const install = button('安装');
    install.props.onClick?.();
    install.props.onClick?.();

    expect(bridge.install).toHaveBeenCalledExactlyOnceWith('ac-baidu');
    expect(button('安装').props.disabled).toBe(true);
    expect(text(render())).toContain('正在处理');

    operation.resolve({ ok: true, cancelled: true });
    await drain();
  });

  it('切换启用状态后刷新列表，不乐观改写旧状态', async () => {
    const disabled = { ...githubInstalled, enabled: false };
    const bridge = mount([disabled]);
    await drain();
    bridge.list.mockResolvedValue([githubInstalled]);

    const toggle = checkbox(githubInstalled.name);
    expect(toggle.props.checked).toBe(false);
    toggle.props.onChange?.({ currentTarget: { checked: true } });
    expect(checkbox(githubInstalled.name).props.checked).toBe(false);
    await drain();

    expect(bridge.setEnabled).toHaveBeenCalledExactlyOnceWith('github-zh', true);
    expect(checkbox(githubInstalled.name).props.checked).toBe(true);
    expect(text(render())).toContain('已启用，请刷新匹配网页。');
  });

  it('卸载成功后以刷新列表移除开关和卸载入口', async () => {
    const removed = { ...githubInstalled, installed: false, enabled: false };
    const bridge = mount([githubInstalled]);
    await drain();
    bridge.list.mockResolvedValue([removed]);

    button('卸载').props.onClick?.();
    await drain();

    expect(bridge.remove).toHaveBeenCalledExactlyOnceWith('github-zh');
    expect(text(render())).toContain('未安装');
    expect(buttons('卸载')).toHaveLength(0);
    expect(buttons('安装')).toHaveLength(1);
  });

  it('网络安装失败显示主进程消息并保留未安装状态', async () => {
    const bridge = mount([acUninstalled]);
    bridge.install.mockResolvedValue({ ok: false, message: '固定资源下载失败。' });
    await drain();

    button('安装').props.onClick?.();
    await drain();

    const body = text(render());
    expect(body).toContain('固定资源下载失败。');
    expect(body).toContain('未安装');
    expect(body).not.toContain('已安装并启用');
    expect(bridge.list).toHaveBeenCalledOnce();
  });

  it('组件卸载后忽略迟到操作结果且不刷新列表', async () => {
    const operation = deferred<QualifiedScriptResult>();
    const bridge = mount([acUninstalled]);
    bridge.install.mockImplementation(() => operation.promise);
    await drain();

    button('安装').props.onClick?.();
    const stateBeforeUnmount = hooks.values.slice(0, 5);
    cleanups.pop()?.();
    operation.resolve({ ok: false, message: '迟到错误不应显示' });
    await drain();

    expect(hooks.values.slice(0, 5)).toEqual(stateBeforeUnmount);
    expect(bridge.list).toHaveBeenCalledOnce();
  });
});
