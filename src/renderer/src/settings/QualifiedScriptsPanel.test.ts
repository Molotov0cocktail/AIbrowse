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
              ? (next as (value: unknown) => unknown)(hooks.values[index])
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
  checked?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
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

const ac: QualifiedScriptStatus = {
  id: 'ac-baidu',
  name: 'AC-baidu',
  version: '27.20',
  installed: true,
  enabled: true,
  issue: null,
};
const github: QualifiedScriptStatus = {
  id: 'github-zh',
  name: 'GitHub 中文化插件',
  version: '1.9.2.4',
  installed: true,
  enabled: false,
  issue: null,
};
const cleanups: Array<() => void> = [];
function mount(initial: QualifiedScriptStatus[] = [ac, github]) {
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

describe('内置网页增强面板', () => {
  it('只显示两个内置开关，不提供安装、本地导入或卸载', async () => {
    const bridge = mount();
    await drain();
    const body = text(render());
    expect(body).toContain('无需联网下载或导入文件');
    expect(body).toContain('AC-baidu版本 27.20 · 内置 · 已启用');
    expect(body).toContain('GitHub 中文化插件版本 1.9.2.4 · 内置 · 已停用');
    expect(body).not.toContain('从本地安装');
    expect(body).not.toContain('卸载');
    expect(checkbox(ac.name).props.checked).toBe(true);
    expect(checkbox(github.name).props.checked).toBe(false);
    expect(bridge.install).not.toHaveBeenCalled();
    expect(bridge.installFile).not.toHaveBeenCalled();
    expect(bridge.remove).not.toHaveBeenCalled();
  });

  it('切换后刷新真实状态，停用文案说明设置继续保留', async () => {
    const bridge = mount();
    await drain();
    bridge.list.mockResolvedValue([{ ...ac, enabled: false }, github]);
    checkbox(ac.name).props.onChange?.({ currentTarget: { checked: false } });
    await drain();
    expect(bridge.setEnabled).toHaveBeenCalledExactlyOnceWith('ac-baidu', false);
    expect(checkbox(ac.name).props.checked).toBe(false);
    expect(text(render())).toContain('停用不会删除设置');
  });

  it('内置资源异常时显示固定错误并禁用开关', async () => {
    const issue = '内置脚本资源缺失、损坏或与固定版本不一致；本次运行已安全停用。';
    mount([{ ...ac, installed: false, enabled: false, issue }]);
    await drain();
    expect(text(render())).toContain(issue);
    expect(checkbox(ac.name).props.disabled).toBe(true);
  });
});
