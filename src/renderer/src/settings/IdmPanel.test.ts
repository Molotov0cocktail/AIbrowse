import { Children, isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdmToolResult, IdmToolStatus } from '../../../shared/types/downloads';
import { IdmPanel } from './IdmPanel';

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
  value?: string;
  disabled?: boolean;
  onChange?: (event: { currentTarget: { value: string } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
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
  return IdmPanel();
}

function input(): Node {
  const found = nodes(render()).find((node) => node.type === 'input');
  if (found === undefined) throw new Error('未找到下载链接输入框');
  return found;
}

function submitButton(): Node {
  const found = nodes(render()).find(
    (node) => node.type === 'button' && node.props.type === 'submit',
  );
  if (found === undefined) throw new Error('未找到发送按钮');
  return found;
}

function submit(): void {
  const found = nodes(render()).find((node) => node.type === 'form');
  if (found === undefined) throw new Error('未找到 IDM 表单');
  found.props.onSubmit?.({ preventDefault: vi.fn() });
}

async function drain(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const cleanups: Array<() => void> = [];

function mount(getStatus = vi.fn(async (): Promise<IdmToolStatus> => ({ available: true }))) {
  const bridge = {
    getStatus,
    sendToIdm: vi.fn(async (): Promise<IdmToolResult> => ({ ok: true })),
  };
  vi.stubGlobal('window', { aibrowse: { downloads: bridge } });
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

describe('IDM 面板交互边界', () => {
  it('检测期间和未安装状态都阻止发送', async () => {
    const status = deferred<IdmToolStatus>();
    const bridge = mount(vi.fn(() => status.promise));

    input().props.onChange?.({ currentTarget: { value: 'https://example.test/file.zip' } });
    expect(submitButton().props.disabled).toBe(true);
    submit();
    expect(bridge.sendToIdm).not.toHaveBeenCalled();

    status.resolve({ available: false });
    await drain();
    expect(text(render())).toContain('未检测到 IDM');
    expect(submitButton().props.disabled).toBe(true);
    submit();
    expect(bridge.sendToIdm).not.toHaveBeenCalled();
  });

  it('把去除首尾空白后的链接发送给 IDM', async () => {
    const bridge = mount();
    await drain();

    input().props.onChange?.({ currentTarget: { value: '  https://example.test/file.zip  ' } });
    expect(submitButton().props.disabled).toBe(false);
    submit();
    await drain();

    expect(bridge.sendToIdm).toHaveBeenCalledExactlyOnceWith('https://example.test/file.zip');
  });

  it('请求未完成时重复提交只派发一次', async () => {
    const request = deferred<IdmToolResult>();
    const bridge = mount();
    bridge.sendToIdm.mockImplementation(() => request.promise);
    await drain();

    input().props.onChange?.({ currentTarget: { value: 'https://example.test/file.zip' } });
    submit();
    submit();

    expect(bridge.sendToIdm).toHaveBeenCalledOnce();
    expect(submitButton().props.disabled).toBe(true);
    expect(text(render())).toContain('正在发送…');

    request.resolve({ ok: true });
    await drain();
  });

  it('成功只说明请求已发送，不声称下载完成', async () => {
    mount();
    await drain();

    input().props.onChange?.({ currentTarget: { value: 'https://example.test/file.zip' } });
    submit();
    await drain();

    const body = text(render());
    expect(body).toContain('已发送请求，请在 IDM 中确认下载。');
    expect(body).not.toContain('下载完成');
    expect(body).not.toContain('下载成功');
  });

  it('显示主进程拒绝消息和调用异常消息', async () => {
    const bridge = mount();
    await drain();
    input().props.onChange?.({ currentTarget: { value: 'https://example.test/file.zip' } });

    bridge.sendToIdm.mockResolvedValue({
      ok: false,
      code: 'invalid-url',
      message: '仅支持 HTTP / HTTPS 下载链接。',
    });
    submit();
    await drain();
    expect(text(render())).toContain('仅支持 HTTP / HTTPS 下载链接。');

    bridge.sendToIdm.mockRejectedValue(new Error('bridge closed'));
    submit();
    await drain();
    expect(text(render())).toContain('请求未能发送到 IDM，请稍后重试。');
  });

  it('卸载后忽略迟到的发送结果', async () => {
    const request = deferred<IdmToolResult>();
    const bridge = mount();
    bridge.sendToIdm.mockImplementation(() => request.promise);
    await drain();

    input().props.onChange?.({ currentTarget: { value: 'https://example.test/file.zip' } });
    submit();
    const stateBeforeUnmount = hooks.values.slice(0, 5);
    cleanups.pop()?.();

    request.resolve({ ok: false, code: 'failed', message: '迟到结果不应显示' });
    await drain();

    expect(hooks.values.slice(0, 5)).toEqual(stateBeforeUnmount);
  });
});
