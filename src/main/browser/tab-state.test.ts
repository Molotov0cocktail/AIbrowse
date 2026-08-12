import { describe, expect, it } from 'vitest';
import type { TabInfo } from '../../shared/types/browser';
import { selectNextActive, transition } from './tab-state';

// 契约源：doc/detailed-design.md §2.6/§5（Tab 状态机与关闭策略）+ §10 测试规格
function tab(id: string): Pick<TabInfo, 'id'> {
  return { id };
}

describe('transition（Tab 状态机纯函数）', () => {
  it('主框架 start-loading → loading（任意状态出发）', () => {
    for (const from of ['idle', 'ready', 'error'] as const) {
      expect(transition(from, { type: 'start-loading', isMainFrame: true })).toBe('loading');
    }
  });

  it('主框架 finish-load → ready', () => {
    expect(transition('loading', { type: 'finish-load', isMainFrame: true })).toBe('ready');
  });

  it('主框架 fail-load（非 -3）→ error', () => {
    expect(transition('loading', { type: 'fail-load', isMainFrame: true, errorCode: -105 })).toBe(
      'error',
    );
  });

  it('主框架 fail-load 错误码 -3（ERR_ABORTED，被新导航取代）→ 原状态不变', () => {
    expect(transition('loading', { type: 'fail-load', isMainFrame: true, errorCode: -3 })).toBe(
      'loading',
    );
    expect(transition('ready', { type: 'fail-load', isMainFrame: true, errorCode: -3 })).toBe(
      'ready',
    );
  });

  it('子框架的加载事件一律不影响 Tab 状态', () => {
    expect(transition('ready', { type: 'start-loading', isMainFrame: false })).toBe('ready');
    expect(transition('loading', { type: 'finish-load', isMainFrame: false })).toBe('loading');
    expect(transition('ready', { type: 'fail-load', isMainFrame: false, errorCode: -105 })).toBe(
      'ready',
    );
  });

  it('error 状态经 start-loading 恢复为 loading（重新导航）', () => {
    expect(transition('error', { type: 'start-loading', isMainFrame: true })).toBe('loading');
  });
});

describe('selectNextActive（关闭标签页后的激活选择）', () => {
  const tabs = [tab('a'), tab('b'), tab('c')];

  it('关闭的不是活动 Tab → 原 activeTabId 不变', () => {
    expect(selectNextActive(tabs, 'a', 'b')).toBe('a');
  });

  it('closedTabId 不在列表 → 原 activeTabId 不变（无操作）', () => {
    expect(selectNextActive(tabs, 'a', 'unknown')).toBe('a');
  });

  it('关闭活动 Tab（中间）→ 右邻接管', () => {
    expect(selectNextActive(tabs, 'b', 'b')).toBe('c');
  });

  it('关闭活动 Tab（首）→ 右邻接管', () => {
    expect(selectNextActive(tabs, 'a', 'a')).toBe('b');
  });

  it('关闭活动 Tab（末，无右邻）→ 左邻接管', () => {
    expect(selectNextActive(tabs, 'c', 'c')).toBe('b');
  });

  it('关闭列表中唯一的 Tab → null（触发最后 Tab 策略）', () => {
    expect(selectNextActive([tab('only')], 'only', 'only')).toBeNull();
  });

  it('activeTabId 为 null（异常状态）→ null，交最后 Tab 策略恢复', () => {
    expect(selectNextActive(tabs, null, 'b')).toBeNull();
  });

  it('空列表 → 原 activeTabId 不变', () => {
    expect(selectNextActive([], 'a', 'a')).toBe('a');
  });
});
