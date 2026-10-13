import { describe, expect, it, vi } from 'vitest';
import type { TabsState } from '../../../shared/types/browser';
import { subscribeTabsState } from './useTabsState';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const initial: TabsState = { tabs: [], activeTabId: null, groups: [], userTabIds: [] };
const pushed: TabsState = {
  tabs: [{ id: 'tab-a', title: 'A', url: 'https://a.test/', state: 'ready', active: true }],
  activeTabId: 'tab-a',
  groups: [],
  userTabIds: ['tab-a'],
};

describe('标签完整状态订阅', () => {
  it('先订阅再读取，期间推送不会被迟到初始快照覆盖', async () => {
    const pending = deferred<TabsState>();
    let listener: ((state: TabsState) => void) | undefined;
    const states: TabsState[] = [];
    subscribeTabsState(
      {
        getState: () => pending.promise,
        onUpdated: (next) => {
          listener = next;
          return vi.fn();
        },
      },
      (state) => states.push(state),
    );

    listener?.(pushed);
    pending.resolve(initial);
    await pending.promise;
    await Promise.resolve();

    expect(states).toEqual([pushed]);
  });

  it('读取先完成时采用完整状态，退订后忽略迟到结果', async () => {
    const states: TabsState[] = [];
    const unsubscribe = vi.fn();
    const stop = subscribeTabsState(
      { getState: async () => initial, onUpdated: () => unsubscribe },
      (state) => states.push(state),
    );
    await Promise.resolve();
    expect(states).toEqual([initial]);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();

    const pending = deferred<TabsState>();
    const late: TabsState[] = [];
    const stopLate = subscribeTabsState(
      { getState: () => pending.promise, onUpdated: () => vi.fn() },
      (state) => late.push(state),
    );
    stopLate();
    pending.resolve(initial);
    await pending.promise;
    await Promise.resolve();
    expect(late).toEqual([]);
  });

  it('旧测试桥仅有 list 时退化为无分组状态', async () => {
    const states: TabsState[] = [];
    subscribeTabsState(
      {
        list: async () => pushed.tabs,
        onUpdated: () => vi.fn(),
      },
      (state) => states.push(state),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(states).toEqual([{ tabs: pushed.tabs, activeTabId: 'tab-a' }]);
  });
});
