// smoke-activate-navigate unit tests (2026-08-16, B6/B8 补验夹具修复): the real
// Provider Sources scenarios 6/7 fixture used to call controller.navigate() on
// the entry tab and then wait for the ACTIVE tab URL — but after the real model's
// browser_open in scenario 5 (auto-visible contract) the active tab is the newly
// opened tab, and navigate() only loads the target tab without activating it
// (BrowserController contract). The fix extracts "activateTab before navigate"
// as minimal, directly testable SMOKE helper logic. Zero Electron imports —
// BrowserControllerImpl satisfies the structural interface (typecheck-enforced).
import { describe, expect, it } from 'vitest';
import { activateThenNavigate } from './smoke-activate-navigate';

interface FakeCall {
  method: 'activateTab' | 'navigate';
  tabId: string;
  url: string | null;
}

interface FakeOptions {
  activate?: 'ok' | 'fail' | 'throw';
  navigate?: 'ok' | 'fail' | 'throw';
  onActivate?: () => void; // e.g. abort the signal between activate and navigate
}

function makeFake(opts: FakeOptions = {}) {
  const calls: FakeCall[] = [];
  const controller = {
    async activateTab(tabId: string): Promise<boolean> {
      calls.push({ method: 'activateTab', tabId, url: null });
      opts.onActivate?.();
      if (opts.activate === 'fail') return false;
      if (opts.activate === 'throw') throw new Error('activate-boom');
      return true;
    },
    async navigate(tabId: string, url: string): Promise<boolean> {
      calls.push({ method: 'navigate', tabId, url });
      if (opts.navigate === 'fail') return false;
      if (opts.navigate === 'throw') throw new Error('navigate-boom');
      return true;
    },
  };
  return { controller, calls };
}

describe('activateThenNavigate（场景 6/7 导航夹具修复——激活必须先于导航）', () => {
  it('成功路径：activateTab 恰一次且先于 navigate（旧夹具仅 navigate 无激活，本组顺序断言下失败）', async () => {
    const { controller, calls } = makeFake();
    const ok = await activateThenNavigate(controller, 'tab-1', 'https://example.org/hostile');
    expect(ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ method: 'activateTab', tabId: 'tab-1', url: null });
    expect(calls[1]).toEqual({
      method: 'navigate',
      tabId: 'tab-1',
      url: 'https://example.org/hostile',
    });
  });

  it('场景 6/7 判别：目标 Tab 非活动（场景 5 browser_open 激活新 Tab 后）也必须先激活再导航', async () => {
    // 模拟场景 5 之后的状态：进入前 Tab 已不是活动 Tab——旧夹具直接 navigate
    // 只加载目标 Tab 不激活，活动 Tab URL 恒不变化（场景 6「敌对页未就绪」超时根因）。
    // 新辅助逻辑强制先 activateTab：调用序列第一个方法必须是 activateTab。
    let active = 'model-opened-tab';
    const calls: FakeCall[] = [];
    const controller = {
      async activateTab(tabId: string): Promise<boolean> {
        calls.push({ method: 'activateTab', tabId, url: null });
        active = tabId;
        return true;
      },
      async navigate(tabId: string, url: string): Promise<boolean> {
        calls.push({ method: 'navigate', tabId, url });
        return active === tabId; // 非活动 Tab 上导航 = 夹具旧缺陷路径（返回 false 模拟断言失败面）
      },
    };
    const ok = await activateThenNavigate(controller, 'entry-tab', 'https://example.org/x');
    expect(ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['activateTab', 'navigate']);
  });

  it('Tab 不存在/已销毁（activateTab false）→ 安全返回 false 且 navigate 零调用', async () => {
    const { controller, calls } = makeFake({ activate: 'fail' });
    const ok = await activateThenNavigate(controller, 'gone-tab', 'https://example.org/x');
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('activateTab');
  });

  it('激活失败不得继续导航（navigate 零调用——场景断言失败于发送任务之前，不触发 Provider）', async () => {
    const { controller, calls } = makeFake({ activate: 'fail' });
    const ok = await activateThenNavigate(controller, 'tab-1', 'https://example.org/x');
    expect(ok).toBe(false);
    expect(calls.some((c) => c.method === 'navigate')).toBe(false);
  });

  it('导航失败（activate true、navigate false）→ 安全返回 false（两方法各恰一次，顺序不变）', async () => {
    const { controller, calls } = makeFake({ navigate: 'fail' });
    const ok = await activateThenNavigate(controller, 'tab-1', 'https://example.org/x');
    expect(ok).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['activateTab', 'navigate']);
  });

  it('超时/取消：signal 进入时已中止 → 零调用安全终止', async () => {
    const { controller, calls } = makeFake();
    const aborted = new AbortController();
    aborted.abort();
    const ok = await activateThenNavigate(
      controller,
      'tab-1',
      'https://example.org/x',
      aborted.signal,
    );
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('超时/取消：激活成功后、导航前中止 → activate 恰一次、navigate 零调用', async () => {
    const controller = new AbortController();
    const { controller: fake, calls } = makeFake({ onActivate: () => controller.abort() });
    const ok = await activateThenNavigate(
      fake,
      'tab-1',
      'https://example.org/x',
      controller.signal,
    );
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('activateTab');
  });

  it('越界参数（空 tabId / 空 url）→ 零调用安全返回 false', async () => {
    const { controller, calls } = makeFake();
    expect(await activateThenNavigate(controller, '', 'https://example.org/x')).toBe(false);
    expect(await activateThenNavigate(controller, 'tab-1', '')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('未预期异常安全终止：activateTab reject → navigate 零调用返回 false', async () => {
    const { controller, calls } = makeFake({ activate: 'throw' });
    const ok = await activateThenNavigate(controller, 'tab-1', 'https://example.org/x');
    expect(ok).toBe(false);
    expect(calls.some((c) => c.method === 'navigate')).toBe(false);
  });

  it('未预期异常安全终止：navigate reject → 安全返回 false（activate 已恰一次）', async () => {
    const { controller, calls } = makeFake({ navigate: 'throw' });
    const ok = await activateThenNavigate(controller, 'tab-1', 'https://example.org/x');
    expect(ok).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['activateTab', 'navigate']);
  });

  it('激活幂等成功（activeTabId === tabId 时返回 true）透传后照常导航', async () => {
    const { controller, calls } = makeFake();
    const ok = await activateThenNavigate(controller, 'already-active', 'https://example.org/x');
    expect(ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe('activateTab');
  });
});
