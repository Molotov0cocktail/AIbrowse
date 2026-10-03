import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabInfo, TabsState } from '../../../shared/types/browser';
import type { ContextPreview } from '../../../shared/types/conversation';
import { ContextBadge } from './ContextBadge';

const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  published: [] as unknown[],
  initialized: false,
  state: undefined as unknown,
}));

// Exercise the real component's bridge and effect lifecycle without a DOM runtime.
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    if (!hooks.initialized) {
      hooks.initialized = true;
      hooks.state = initial;
    }
    return [
      hooks.state,
      (value: unknown) => {
        hooks.state = value;
        hooks.published.push(value);
      },
    ];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));

interface PendingPreview {
  resolve(value: ContextPreview | null): void;
  reject(reason: Error): void;
}

interface PendingList {
  resolve(tabs: TabInfo[]): void;
  reject(reason: Error): void;
}

function tab(id: string, state: TabInfo['state'] = 'ready'): TabInfo {
  return { id, state, title: id, url: `https://${id}.test/`, active: true };
}

function preview(id: string, selectionLength = 0): ContextPreview {
  return {
    tabId: id,
    url: `https://${id}.test/`,
    title: id,
    readyState: 'complete',
    mode: selectionLength > 0 ? 'selection' : 'snapshot',
    hasSelection: selectionLength > 0,
    selectionLength,
    thin: false,
    degraded: false,
  };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function badgeLabel(): unknown {
  const tree = ContextBadge() as {
    props: { children: [{ props: { children: unknown } }, unknown] };
  };
  return tree.props.children[0].props.children;
}

function mount(initial: TabInfo[] = [tab('a')], deferList = false) {
  const pending: PendingPreview[] = [];
  const pendingLists: PendingList[] = [];
  const read = vi.fn(
    () =>
      new Promise<ContextPreview | null>((resolve, reject) => pending.push({ resolve, reject })),
  );
  const tabListeners = new Set<(state: TabsState) => void>();
  const focusListeners = new Set<() => void>();
  vi.stubGlobal('window', {
    aibrowse: {
      conversation: { preview: read },
      tabs: {
        list: vi.fn(() =>
          deferList
            ? new Promise<TabInfo[]>((resolve, reject) => pendingLists.push({ resolve, reject }))
            : Promise.resolve(initial),
        ),
        onUpdated: (listener: (state: TabsState) => void) => {
          tabListeners.add(listener);
          return () => tabListeners.delete(listener);
        },
      },
    },
    addEventListener: (_event: string, listener: () => void) => focusListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => focusListeners.delete(listener),
  });
  ContextBadge();
  const setup = hooks.effects.at(-1);
  if (setup === undefined) throw new Error('徽标未注册 effect');
  const cleanup = setup();
  if (cleanup === undefined) throw new Error('徽标未注册清理');
  return {
    read,
    pending,
    pendingLists,
    tabListeners,
    focusListeners,
    cleanup,
    setup,
    update(active: TabInfo, other: TabInfo[] = []): void {
      const state = { activeTabId: active.id, tabs: [active, ...other] };
      for (const listener of tabListeners) listener(state);
    },
    focus(): void {
      for (const listener of focusListeners) listener();
    },
  };
}

beforeEach(() => {
  hooks.effects.length = 0;
  hooks.published.length = 0;
  hooks.initialized = false;
  hooks.state = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ContextBadge 预览刷新生命周期', () => {
  it('初次列表拒绝结束加载提示，焦点不误报无标签页且后续状态可恢复', async () => {
    vi.useFakeTimers();
    const fixture = mount([], true);
    fixture.pendingLists[0]!.reject(new Error('受控列表读取失败'));
    await drain();
    expect(badgeLabel()).toBe('预览暂不可用，提问时实时采集');
    expect(fixture.read).not.toHaveBeenCalled();
    fixture.focus();
    await vi.advanceTimersByTimeAsync(300);
    expect(badgeLabel()).toBe('预览暂不可用，提问时实时采集');
    fixture.update(tab('a'));
    fixture.pending[0]!.resolve(preview('a'));
    await drain();
    expect(badgeLabel()).toBe('当前网页');
    fixture.cleanup();
  });

  it('旧 effect 列表拒绝晚到不得覆盖重建后的可用预览', async () => {
    const fixture = mount([], true);
    fixture.cleanup();
    const cleanupAgain = fixture.setup();
    fixture.pendingLists[1]!.resolve([tab('b')]);
    await drain();
    fixture.pending[0]!.resolve(preview('b', 6));
    await drain();
    const published = [...hooks.published];
    fixture.pendingLists[0]!.reject(new Error('受控旧列表读取失败'));
    await drain();
    expect(hooks.published).toEqual(published);
    expect(badgeLabel()).toBe('选中文本（6 字）');
    cleanupAgain?.();
  });

  it('当前 effect 列表拒绝晚于 tabs 更新时不覆盖新状态', async () => {
    const fixture = mount([], true);
    fixture.update(tab('b'));
    fixture.pending[0]!.resolve(preview('b'));
    await drain();
    const published = [...hooks.published];
    fixture.pendingLists[0]!.reject(new Error('受控过时列表读取失败'));
    await drain();
    expect(hooks.published).toEqual(published);
    expect(badgeLabel()).toBe('当前网页');
    fixture.cleanup();
  });

  it('同目标连续更新保持一个在途请求，旧结果不展示且只补读一次', async () => {
    const fixture = mount();
    await drain();
    expect(fixture.read).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 30; i += 1) fixture.update(tab('a'));
    expect(fixture.read).toHaveBeenCalledTimes(1);
    fixture.pending[0]!.resolve(preview('a', 1));
    await drain();
    expect(hooks.published).not.toContainEqual(preview('a', 1));
    expect(fixture.read).toHaveBeenCalledTimes(2);
    fixture.pending[1]!.resolve(preview('a', 2));
    await drain();
    expect(hooks.published.at(-1)).toEqual(preview('a', 2));
    expect(fixture.read).toHaveBeenCalledTimes(2);
    fixture.cleanup();
  });

  it('旧目标永不完成也不阻塞新目标，旧目标迟到不得盖住新结果', async () => {
    const fixture = mount();
    await drain();
    fixture.update(tab('b'), [tab('a')]);
    await drain();
    expect(fixture.read).toHaveBeenCalledTimes(2);
    fixture.pending[1]!.resolve(preview('b'));
    await drain();
    expect(hooks.published.at(-1)).toEqual(preview('b'));
    fixture.pending[0]!.resolve(preview('a'));
    await drain();
    expect(hooks.published.at(-1)).toEqual(preview('b'));
    expect(fixture.read).toHaveBeenCalledTimes(2);
    fixture.cleanup();
  });

  it('加载时不调用预览，就绪后再读；初始列表不得覆盖更新事件', async () => {
    const fixture = mount();
    fixture.update(tab('b', 'loading'));
    await drain();
    for (let i = 0; i < 30; i += 1) fixture.update(tab('b', 'loading'));
    expect(fixture.read).not.toHaveBeenCalled();
    fixture.update(tab('b'));
    await drain();
    expect(fixture.read).toHaveBeenCalledTimes(1);
    fixture.pending[0]!.resolve(preview('b'));
    await drain();
    expect(hooks.published.at(-1)).toEqual(preview('b'));
    fixture.cleanup();
  });

  it('未完成请求跨目标往返仍每个目标最多一个，返回后只补最新一轮', async () => {
    const fixture = mount();
    await drain();
    for (let i = 0; i < 15; i += 1) {
      fixture.update(tab('b'), [tab('a')]);
      fixture.update(tab('a'), [tab('b')]);
    }
    expect(fixture.read).toHaveBeenCalledTimes(2);
    fixture.pending[0]!.resolve(preview('a', 1));
    await drain();
    expect(fixture.read).toHaveBeenCalledTimes(3);
    fixture.pending[2]!.resolve(preview('a', 2));
    fixture.pending[1]!.resolve(preview('b'));
    await drain();
    expect(hooks.published.at(-1)).toEqual(preview('a', 2));
    expect(fixture.read).toHaveBeenCalledTimes(3);
    fixture.cleanup();
  });

  it('请求拒绝后只执行已有尾读，没有更新时不循环重试', async () => {
    const fixture = mount();
    await drain();
    fixture.update(tab('a'));
    fixture.pending[0]!.reject(new Error('受控拒绝'));
    await drain();
    expect(fixture.read).toHaveBeenCalledTimes(2);
    fixture.pending[1]!.reject(new Error('受控拒绝'));
    await drain();
    expect(fixture.read).toHaveBeenCalledTimes(2);
    fixture.cleanup();
  });

  it('采集期间再次加载丢弃旧结果，等待 ready 后才启动下一次', async () => {
    const fixture = mount();
    await drain();
    fixture.update(tab('a', 'loading'));
    fixture.pending[0]!.resolve(preview('a', 1));
    await drain();
    expect(hooks.published).not.toContainEqual(preview('a', 1));
    expect(fixture.read).toHaveBeenCalledTimes(1);
    fixture.update(tab('a'));
    await drain();
    expect(fixture.read).toHaveBeenCalledTimes(2);
    fixture.pending[1]!.resolve(preview('a', 2));
    await drain();
    expect(hooks.published.at(-1)).toEqual(preview('a', 2));
    fixture.cleanup();
  });

  it('目标关闭后旧请求不能启动尾读，也不能发布属于其他目标的响应', async () => {
    const fixture = mount();
    await drain();
    fixture.update(tab('a'));
    fixture.update(tab('b'));
    fixture.pending[0]!.resolve(preview('a'));
    fixture.pending[1]!.resolve(preview('c'));
    await drain();
    expect(hooks.published).not.toContainEqual(preview('a'));
    expect(hooks.published).not.toContainEqual(preview('c'));
    expect(fixture.read).toHaveBeenCalledTimes(2);
    fixture.cleanup();
  });

  it('焦点事件保持 300ms 防抖并合并到当前请求的一次尾读', async () => {
    vi.useFakeTimers();
    const fixture = mount();
    await drain();
    for (let i = 0; i < 30; i += 1) fixture.focus();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(299);
    fixture.pending[0]!.resolve(preview('a', 1));
    await drain();
    expect(fixture.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.read).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 30; i += 1) fixture.focus();
    await vi.advanceTimersByTimeAsync(300);
    expect(fixture.read).toHaveBeenCalledTimes(2);
    fixture.pending[1]!.resolve(preview('a', 2));
    await drain();
    expect(fixture.read).toHaveBeenCalledTimes(3);
    fixture.pending[2]!.resolve(preview('a', 3));
    await drain();
    expect(hooks.published.at(-1)).toEqual(preview('a', 3));
    expect(vi.getTimerCount()).toBe(0);
    fixture.cleanup();
  });

  it('无标签页显示无上下文，页面错误仅说明预览不可用且不排队执行脚本', async () => {
    const fixture = mount([]);
    await drain();
    expect(fixture.read).not.toHaveBeenCalled();
    expect(hooks.published.at(-1)).toMatchObject({ tabId: null, mode: 'none' });
    expect(badgeLabel()).toBe('无网页上下文');
    fixture.update(tab('a', 'error'));
    await drain();
    expect(fixture.read).not.toHaveBeenCalled();
    expect(hooks.published.at(-1)).toBe('unavailable');
    expect(badgeLabel()).toBe('预览暂不可用，提问时实时采集');
    fixture.cleanup();
  });

  it('首次预览拒绝后结束加载提示，后续更新可恢复实时预览', async () => {
    const fixture = mount();
    await drain();
    fixture.pending[0]!.reject(new Error('受控预览错误'));
    await drain();
    expect(hooks.published.at(-1)).toBe('unavailable');
    expect(badgeLabel()).toBe('预览暂不可用，提问时实时采集');
    expect(fixture.read).toHaveBeenCalledTimes(1);
    fixture.update(tab('a'));
    fixture.pending[1]!.resolve(preview('a'));
    await drain();
    expect(badgeLabel()).toBe('当前网页');
    expect(fixture.read).toHaveBeenCalledTimes(2);
    fixture.cleanup();
  });

  it('预览返回 null 时展示暂不可用，不保留永久加载提示', async () => {
    const fixture = mount();
    await drain();
    fixture.pending[0]!.resolve(null);
    await drain();
    expect(hooks.published.at(-1)).toBe('unavailable');
    expect(badgeLabel()).toBe('预览暂不可用，提问时实时采集');
    fixture.cleanup();
  });

  it('dispose未推送Tab事件时，焦点读取接受主进程明确的无活动Tab结果', async () => {
    vi.useFakeTimers();
    const fixture = mount();
    await drain();
    fixture.pending[0]!.resolve(preview('a'));
    await drain();
    fixture.focus();
    await vi.advanceTimersByTimeAsync(300);
    fixture.pending[1]!.resolve({
      ...preview('a'),
      tabId: null,
      url: null,
      title: null,
      readyState: null,
      mode: 'none',
    });
    await drain();
    expect(badgeLabel()).toBe('无网页上下文');
    fixture.cleanup();
  });

  it('旧请求的无活动Tab结果不能覆盖新Tab预览', async () => {
    const fixture = mount();
    await drain();
    fixture.update(tab('b'));
    fixture.pending[1]!.resolve(preview('b', 4));
    await drain();
    fixture.pending[0]!.resolve({ ...preview('a'), tabId: null, mode: 'none' });
    await drain();
    expect(badgeLabel()).toBe('选中文本（4 字）');
    fixture.cleanup();
  });

  it('旧目标请求拒绝不覆盖新预览，错误页恢复后仍可采集', async () => {
    const fixture = mount();
    await drain();
    fixture.update(tab('b'), [tab('a')]);
    fixture.pending[1]!.resolve(preview('b'));
    await drain();
    fixture.pending[0]!.reject(new Error('受控旧目标错误'));
    await drain();
    expect(badgeLabel()).toBe('当前网页');
    fixture.update(tab('b', 'error'));
    expect(badgeLabel()).toBe('预览暂不可用，提问时实时采集');
    expect(fixture.read).toHaveBeenCalledTimes(2);
    fixture.update(tab('b'));
    fixture.pending[2]!.resolve(preview('b', 4));
    await drain();
    expect(badgeLabel()).toBe('选中文本（4 字）');
    fixture.cleanup();
  });

  it('卸载清理事件与焦点定时器，待处理尾读和旧结果都失效', async () => {
    vi.useFakeTimers();
    const fixture = mount();
    await drain();
    fixture.update(tab('a'));
    fixture.focus();
    expect(vi.getTimerCount()).toBe(1);
    fixture.cleanup();
    expect(fixture.tabListeners.size).toBe(0);
    expect(fixture.focusListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const published = [...hooks.published];
    fixture.pending[0]!.resolve(preview('a'));
    await drain();
    expect(hooks.published).toEqual(published);
    expect(fixture.read).toHaveBeenCalledTimes(1);
  });

  it('effect 重建后旧请求失效，不得由共享 mounted 标记重新放行', async () => {
    const fixture = mount();
    await drain();
    fixture.cleanup();
    const cleanupAgain = fixture.setup();
    await drain();
    expect(fixture.read).toHaveBeenCalledTimes(2);
    fixture.pending[1]!.resolve(preview('a', 2));
    await drain();
    fixture.pending[0]!.resolve(preview('a', 1));
    await drain();
    expect(hooks.published.at(-1)).toEqual(preview('a', 2));
    cleanupAgain?.();
  });
});
