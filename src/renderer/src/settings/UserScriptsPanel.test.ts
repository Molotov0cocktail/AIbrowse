import { Children, isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserScriptResult, UserScriptSummary } from '../../../shared/types/userscripts';
import { UserScriptsPanel } from './UserScriptsPanel';

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
  return UserScriptsPanel();
}

function button(label: string): Node {
  const found = nodes(render()).find(
    (node) => node.type === 'button' && text(node.props.children) === label,
  );
  if (found === undefined) throw new Error(`未找到按钮：${label}`);
  return found;
}

function checkbox(name: string): Node {
  const found = nodes(render()).find(
    (node) => node.type === 'input' && node.props['aria-label'] === `启用脚本 ${name}`,
  );
  if (found === undefined) throw new Error(`未找到脚本开关：${name}`);
  return found;
}

function ok<T>(value: T): UserScriptResult<T> {
  return { ok: true, value };
}

function failure(message: string): UserScriptResult<never> {
  return { ok: false, code: 'storage-error', message };
}

const script: UserScriptSummary = {
  id: '8f7399d1-2bd7-45bb-afb2-9c2366d54f99',
  name: '阅读增强',
  namespace: 'test',
  version: '1.0.0',
  description: '测试脚本',
  matches: ['https://example.test/*'],
  excludes: [],
  includes: [],
  excludeGlobs: [],
  grants: [],
  runAt: 'document-idle',
  enabled: false,
  sourceBytes: 128,
  installedAt: '2026-10-13T00:00:00.000Z',
};

async function drain(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

const cleanups: Array<() => void> = [];

function mount(list = vi.fn(async () => ok<UserScriptSummary[]>([script]))) {
  const bridge = {
    list,
    importScript: vi.fn(async () => ok<UserScriptSummary | null>(script)),
    setEnabled: vi.fn(async () => ok({ ...script, enabled: true })),
    remove: vi.fn(async () => ok(null)),
  };
  vi.stubGlobal('window', { aibrowse: { userscripts: bridge } });
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

describe('用户脚本面板异步状态边界', () => {
  it('读取失败显示错误且不伪装成空列表', async () => {
    mount(vi.fn(async () => failure('脚本存储不可用')));
    await drain();

    const body = text(render());
    expect(body).toContain('脚本存储不可用');
    expect(body).not.toContain('还没有安装脚本');
  });

  it('导入取消只说明取消，不声称脚本安装成功', async () => {
    const bridge = mount(vi.fn(async () => ok<UserScriptSummary[]>([])));
    bridge.importScript.mockResolvedValue(ok(null));
    await drain();

    button('导入脚本').props.onClick?.();
    await drain();

    const body = text(render());
    expect(body).toContain('已取消导入。');
    expect(body).not.toContain('脚本已安装并启用');
  });

  it('启用失败保留主进程列表状态，不乐观切换开关', async () => {
    const bridge = mount();
    bridge.setEnabled.mockResolvedValue(failure('启用脚本失败'));
    await drain();

    const toggle = checkbox(script.name);
    expect(toggle.props.checked).toBe(false);
    toggle.props.onChange?.({ currentTarget: { checked: true } });
    await drain();

    expect(checkbox(script.name).props.checked).toBe(false);
    expect(text(render())).toContain('启用脚本失败');
    expect(bridge.list).toHaveBeenCalledOnce();
  });

  it('删除需要组件内二次确认，第一次点击不调用主进程', async () => {
    const bridge = mount();
    await drain();

    button('删除').props.onClick?.();
    expect(bridge.remove).not.toHaveBeenCalled();
    expect(text(render())).toContain('确定删除这个脚本？');

    button('确认删除').props.onClick?.();
    await drain();
    expect(bridge.remove).toHaveBeenCalledExactlyOnceWith(script.id);
  });

  it('同一 tick 重复操作只派发一次', async () => {
    const bridge = mount();
    let resolve!: (result: UserScriptResult<UserScriptSummary>) => void;
    bridge.setEnabled.mockImplementation(
      () =>
        new Promise((accept) => {
          resolve = accept;
        }),
    );
    await drain();

    const toggle = checkbox(script.name);
    toggle.props.onChange?.({ currentTarget: { checked: true } });
    toggle.props.onChange?.({ currentTarget: { checked: true } });
    expect(bridge.setEnabled).toHaveBeenCalledExactlyOnceWith(script.id, true);

    resolve(ok({ ...script, enabled: true }));
    await drain();
  });
});
