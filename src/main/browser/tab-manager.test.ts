import { EventEmitter } from 'node:events';
import type { BaseWindow, Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { TabManager } from './tab-manager';

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class TestWebContents extends Emitter {
    loadingMainFrame = false;
    destroyed = false;
    isLoadingMainFrame(): boolean {
      return this.loadingMainFrame;
    }
    setWindowOpenHandler(): void {}
    isDestroyed(): boolean {
      return this.destroyed;
    }
    close(): void {
      this.destroyed = true;
      this.emit('destroyed');
    }
  }
  return {
    WebContentsView: class {
      webContents = new TestWebContents();
      setVisible(): void {}
    },
  };
});

interface TestWebContents extends EventEmitter {
  loadingMainFrame: boolean;
}

function harness() {
  const ownerWindow = {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    isDestroyed: () => false,
  };
  const manager = new TabManager({
    ownerWindow: ownerWindow as unknown as BaseWindow,
    session: {} as Session,
    onChanged: vi.fn(),
  });
  const created = manager.createTab('https://example.com/page');
  const entry = manager.get(created.info.id);
  if (entry === undefined) throw new Error('测试标签页未登记');
  const wc = entry.view.webContents as unknown as TestWebContents;
  return { manager, entry, wc, ownerWindow };
}

describe('TabManager 主框架加载状态与真实事件顺序', () => {
  it('新锚点和重复锚点仅有 start/in-page/stop 时保持 ready 与原文档世代', () => {
    const { manager, entry, wc } = harness();
    try {
      wc.emit('did-finish-load');
      const generation = entry.generation;
      for (let repeat = 0; repeat < 2; repeat += 1) {
        wc.loadingMainFrame = false;
        wc.emit('did-start-loading');
        wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
        wc.emit('did-navigate-in-page', {}, 'https://example.com/page#hash', true);
        wc.emit('did-stop-loading');
        expect(entry.info.state).toBe('ready');
        expect(entry.info.url).toBe('https://example.com/page#hash');
        expect(entry.generation).toBe(generation);
      }
    } finally {
      manager.dispose();
    }
  });

  it('只有子框架加载时不改变主框架状态、URL 或世代', () => {
    const { manager, entry, wc } = harness();
    try {
      wc.emit('did-finish-load');
      wc.loadingMainFrame = false;
      wc.emit('did-start-loading');
      wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
      wc.emit('did-navigate-in-page', {}, 'https://example.com/frame#hash', false);
      wc.emit('did-fail-load', {}, -105, '', '', false);
      wc.emit('did-stop-loading');
      expect(entry.info).toMatchObject({ state: 'ready', url: 'https://example.com/page' });
      expect(entry.generation).toBe(1);
    } finally {
      manager.dispose();
    }
  });

  it('子框架已启动 spinner 时主框架导航没有第二次 start-loading 仍立即进入 loading', () => {
    const { manager, entry, wc } = harness();
    try {
      wc.emit('did-finish-load');
      wc.loadingMainFrame = false;
      wc.emit('did-start-loading');
      wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
      expect(entry.info.state).toBe('ready');
      wc.loadingMainFrame = true;
      wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      expect(entry.info.state).toBe('loading');
      wc.emit('did-fail-load', {}, -105, '', '', true);
      wc.loadingMainFrame = false;
      wc.emit('did-stop-loading');
      expect(entry.info.state).toBe('error');
      expect(entry.generation).toBe(1);
    } finally {
      manager.dispose();
    }
  });

  it('单独同页或子框架 start-navigation 保持原状态，只有新主文档开始加载', () => {
    const { manager, entry, wc } = harness();
    try {
      for (const state of ['idle', 'ready', 'error'] as const) {
        entry.info.state = state;
        wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
        expect(entry.info.state).toBe(state);
        wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
        expect(entry.info.state).toBe(state);
        wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
        expect(entry.info.state).toBe('loading');
      }
    } finally {
      manager.dispose();
    }
  });

  it('主框架真实失败后 stop 或子框架 start 都不把 error 改成 ready/loading', () => {
    const { manager, entry, wc } = harness();
    try {
      wc.loadingMainFrame = true;
      wc.emit('did-start-loading');
      expect(entry.info.state).toBe('loading');
      wc.emit('did-fail-load', {}, -105, '', '', true);
      wc.loadingMainFrame = false;
      wc.emit('did-stop-loading');
      expect(entry.info.state).toBe('error');
      wc.emit('did-start-loading');
      expect(entry.info.state).toBe('error');
    } finally {
      manager.dispose();
    }
  });

  it('主框架仍在加载时同页提交不提前 ready，真实完成才切换并只在新文档增加世代', () => {
    const { manager, entry, wc } = harness();
    try {
      wc.loadingMainFrame = true;
      wc.emit('did-start-loading');
      wc.emit('did-navigate', {}, 'https://example.com/next');
      wc.emit('did-navigate-in-page', {}, 'https://example.com/next#hash', true);
      expect(entry.info.state).toBe('loading');
      expect(entry.generation).toBe(2);
      wc.emit('did-finish-load');
      expect(entry.info.state).toBe('ready');
    } finally {
      manager.dispose();
    }
  });

  it('被替代导航的 ERR_ABORTED 不将新导航改为错误，关闭逐一移除监听器且幂等', () => {
    const { manager, entry, wc, ownerWindow } = harness();
    wc.loadingMainFrame = true;
    wc.emit('did-start-loading');
    wc.emit('did-fail-load', {}, -3, '', '', true);
    expect(entry.info.state).toBe('loading');
    wc.emit('did-finish-load');
    expect(entry.info.state).toBe('ready');
    expect(wc.eventNames().length).toBeGreaterThan(0);
    manager.dispose();
    manager.dispose();
    expect(wc.eventNames()).toEqual([]);
    expect(ownerWindow.contentView.removeChildView).toHaveBeenCalledTimes(1);
  });
});
