import { EventEmitter } from 'node:events';
import type { BaseWindow, Session } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserControllerImpl } from './browser-controller';
import type { SessionManager } from './session-manager';

interface PendingLoad {
  url: string;
  resolve(): void;
  reject(reason: Error): void;
}

interface TestWebContents extends EventEmitter {
  currentUrl: string;
  destroyed: boolean;
  loadURL: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  collectScript: ReturnType<typeof vi.fn<(source: string) => Promise<unknown>>>;
  executeJavaScriptInIsolatedWorld: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  navigationHistory: {
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack: ReturnType<typeof vi.fn>;
    goForward: ReturnType<typeof vi.fn>;
  };
  stop: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  destroyUnexpectedly(): void;
}

interface TestView {
  webContents: TestWebContents;
  preferences: Record<string, unknown>;
  setVisible: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
}

const electronMock = vi.hoisted(() => ({
  instances: [] as TestView[],
  deferBlankLoads: false,
  deferredUrls: [] as string[],
  noCommitUrls: [] as string[],
  syncFailureUrls: [] as string[],
  pending: [] as PendingLoad[],
}));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');

  class MockWebContents extends Emitter {
    currentUrl = '';
    destroyed = false;
    private loading = false;
    override emit(name: string | symbol, ...args: unknown[]): boolean {
      if (name === 'did-start-loading') this.loading = true;
      if (name === 'did-finish-load' || name === 'did-stop-loading') this.loading = false;
      return super.emit(name, ...args);
    }
    private loadSerial = 0;
    private pendingReject: ((reason: Error) => void) | null = null;
    readonly navigationHistory = {
      canGoBack: () => true,
      canGoForward: () => true,
      goBack: vi.fn(),
      goForward: vi.fn(),
    };

    loadURL = vi.fn((url: string): Promise<void> => {
      if (electronMock.syncFailureUrls.includes(url)) {
        throw new Error(`controlled synchronous load failure: ${url}`);
      }
      const serial = ++this.loadSerial;
      this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      this.emit('did-start-loading');
      const commit = (): void => {
        if (serial !== this.loadSerial || this.destroyed) return;
        this.currentUrl = url;
        this.emit('did-navigate', {}, url);
        this.emit('did-finish-load');
      };
      if (
        (url === 'about:blank' && electronMock.deferBlankLoads) ||
        electronMock.deferredUrls.includes(url)
      ) {
        return new Promise<void>((resolve, reject) => {
          this.pendingReject = reject;
          electronMock.pending.push({
            url,
            resolve: () => {
              this.pendingReject = null;
              commit();
              resolve();
            },
            reject,
          });
        });
      }
      if (electronMock.noCommitUrls.includes(url)) return Promise.resolve();
      commit();
      return Promise.resolve();
    });

    collectScript = vi.fn((source: string): Promise<unknown> => {
      if (source.includes('window.scrollBy')) {
        return Promise.resolve({
          ok: true,
          viewport: { scrollX: 0, scrollY: 25, width: 1024, height: 768 },
        });
      }
      return Promise.resolve({
        ok: true,
        url: this.currentUrl,
        title: '',
        readyState: 'complete',
        viewport: { scrollX: 0, scrollY: 0, width: 1024, height: 768 },
        selection: '',
        visibleText: '',
        headings: [],
        links: [],
        buttons: [],
        inputs: [],
        tables: [],
        iframes: { total: 0, crossOrigin: 0 },
        truncated: [],
      });
    });
    executeJavaScriptInIsolatedWorld = vi.fn(
      async (_world: number, scripts: Array<{ code: string }>) => {
        const source = scripts[0]?.code;
        if (source === undefined) throw new Error('缺少隔离脚本');
        const raw = await this.collectScript(source);
        return typeof raw === 'object' && raw !== null && 'readyState' in raw
          ? { token: '0'.repeat(32), snapshot: raw }
          : raw;
      },
    );
    reload = vi.fn();
    focus = vi.fn();
    stop = vi.fn(() => {
      this.loadSerial += 1;
      this.pendingReject?.(new Error('ERR_ABORTED'));
      this.pendingReject = null;
    });
    setWindowOpenHandler(): void {}
    isLoadingMainFrame(): boolean {
      return this.loading;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isCrashed(): boolean {
      return false;
    }
    getURL(): string {
      return this.currentUrl;
    }
    getTitle(): string {
      return '';
    }
    close = vi.fn(() => {
      if (this.destroyed) return;
      this.destroyed = true;
      this.stop();
      this.emit('destroyed');
    });
    destroyUnexpectedly(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.stop();
      this.emit('destroyed');
    }
  }

  return {
    WebContentsView: class {
      readonly webContents = new MockWebContents();
      readonly preferences: Record<string, unknown>;
      readonly setVisible = vi.fn();
      readonly setBounds = vi.fn();

      constructor(options: { webPreferences: Record<string, unknown> }) {
        this.preferences = options.webPreferences;
        electronMock.instances.push(this as unknown as TestView);
      }
    },
  };
});

vi.mock('../logger', () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

function harness(): {
  controller: BrowserControllerImpl;
  ownerWindow: BaseWindow;
} {
  const ownerWindow = {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    isDestroyed: () => false,
  } as unknown as BaseWindow;
  const sessionManager = {
    getSession: () => ({}) as Session,
  } as SessionManager;
  return {
    controller: new BrowserControllerImpl({
      ownerWindow,
      sessionManager,
      getFallbackBounds: () => ({ x: 0, y: 80, width: 1200, height: 720 }),
    }),
    ownerWindow,
  };
}

beforeEach(() => {
  electronMock.instances.length = 0;
  electronMock.pending.length = 0;
  electronMock.deferredUrls.length = 0;
  electronMock.noCommitUrls.length = 0;
  electronMock.syncFailureUrls.length = 0;
  electronMock.deferBlankLoads = false;
});

describe('BrowserController 默认空白 view 延迟物化', () => {
  it.each(['reload', 'goBack', 'goForward', 'page'] as const)(
    '%s 替代加载后，旧 ERR_ABORTED 在新导航开始及完成后回调均不覆盖状态',
    async (method) => {
      for (const finished of [false, true]) {
        const target = 'https://example.com/pending';
        electronMock.deferredUrls.push(target);
        const { controller } = harness();
        try {
          const tab = await controller.createTab(target);
          const wc = electronMock.instances.at(-1)?.webContents;
          const oldLoad = electronMock.pending.at(-1);
          if (wc === undefined || oldLoad === undefined) throw new Error('未创建测试加载');
          const replace = (): void => {
            wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', target, true);
            wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
            if (finished) {
              wc.currentUrl = target;
              wc.emit('did-navigate', {}, target);
              wc.emit('did-finish-load');
            }
          };
          if (method === 'page') replace();
          else {
            const action = method === 'reload' ? wc.reload : wc.navigationHistory[method];
            action.mockImplementationOnce(replace);
            expect(await controller[method](tab.id)).toBe(true);
          }
          oldLoad.reject(
            Object.assign(new Error('ERR_ABORTED'), { errno: -3, code: 'ERR_ABORTED' }),
          );
          await Promise.resolve();
          expect((await controller.getTabs())[0]?.state).toBe(finished ? 'ready' : 'loading');
        } finally {
          controller.dispose();
        }
      }
    },
  );

  it('旧 blank 完成提前 resolve 目标 loadURL 时，跨提交快照必须重采且绑定目标世代', async () => {
    electronMock.deferBlankLoads = true;
    const { controller } = harness();
    try {
      const tab = await controller.createTab();
      const wc = electronMock.instances[0]?.webContents;
      if (wc === undefined) throw new Error('未创建测试 webContents');
      const snapshot = controller.getPageSnapshot(tab.id);
      const target = 'https://example.com/target';
      wc.loadURL.mockImplementationOnce(() => {
        wc.currentUrl = 'about:blank';
        wc.emit('did-navigate', {}, 'about:blank');
        wc.emit('did-finish-load');
        wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
        return Promise.resolve();
      });
      const collect = wc.collectScript.getMockImplementation();
      if (collect === undefined) throw new Error('缺少测试采集脚本');
      wc.collectScript.mockImplementationOnce(async (source) => {
        // Electron defers isolated-world injection until did-stop-loading, after the new commit.
        await Promise.resolve();
        wc.currentUrl = target;
        wc.emit('did-navigate', {}, target);
        wc.emit('did-finish-load');
        wc.emit('did-stop-loading');
        return collect(source);
      });
      expect(await controller.navigate(tab.id, target)).toBe(true);
      const first = await snapshot;
      const stable = await controller.getPageSnapshot(tab.id);
      expect(first?.url).toBe(target);
      expect(first?.meta.documentId).toBe(2);
      expect(first?.meta.documentId).toBe(stable?.meta.documentId);
      expect(wc.collectScript).toHaveBeenCalledTimes(3);
    } finally {
      controller.dispose();
    }
  });

  it('同 URL 刷新跨越采集时丢弃旧结果，连续两次跨提交返回 null', async () => {
    const { controller } = harness();
    try {
      const tab = await controller.createTab('https://example.com/same-url');
      const wc = electronMock.instances[0]?.webContents;
      if (wc === undefined) throw new Error('未创建测试 webContents');
      const collect = wc.collectScript.getMockImplementation();
      if (collect === undefined) throw new Error('缺少测试采集脚本');
      wc.collectScript.mockImplementation(async (source) => {
        const oldResult = await collect(source);
        wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
        wc.emit('did-navigate', {}, wc.currentUrl);
        wc.emit('did-finish-load');
        return oldResult;
      });
      expect(await controller.getPageSnapshot(tab.id)).toBeNull();
      expect(wc.collectScript).toHaveBeenCalledTimes(2);
    } finally {
      controller.dispose();
    }
  });

  it('采集开始后只有新主框架导航起点也丢弃结果，重复起点使采集有界失败', async () => {
    const { controller } = harness();
    try {
      const tab = await controller.createTab('https://example.com/start-only');
      const wc = electronMock.instances[0]?.webContents;
      if (wc === undefined) throw new Error('未创建测试 webContents');
      const collect = wc.collectScript.getMockImplementation();
      if (collect === undefined) throw new Error('缺少测试采集脚本');
      wc.collectScript.mockImplementation(async (source) => {
        const raw = await collect(source);
        wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
        return raw;
      });
      expect(await controller.getPageSnapshot(tab.id)).toBeNull();
      expect(wc.collectScript).toHaveBeenCalledTimes(2);
    } finally {
      controller.dispose();
    }
  });

  it('首次物化被页面导航取消后不重启 blank，不覆盖后继 loading 或注入 generation 0', async () => {
    electronMock.deferBlankLoads = true;
    const { controller } = harness();
    try {
      const tab = await controller.createTab();
      const wc = electronMock.instances[0]?.webContents;
      if (wc === undefined) throw new Error('未创建测试 webContents');
      const snapshot = controller.getPageSnapshot(tab.id);
      wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      electronMock.pending[0]?.reject(
        Object.assign(new Error('ERR_ABORTED'), { errno: -3, code: 'ERR_ABORTED' }),
      );
      expect(await snapshot).toBeNull();
      expect(await controller.getPageSnapshot(tab.id)).toBeNull();
      expect((await controller.getTabs())[0]?.state).toBe('loading');
      expect(wc.loadURL).toHaveBeenCalledOnce();
      expect(wc.collectScript).not.toHaveBeenCalled();

      wc.currentUrl = 'https://example.com/page-navigation';
      wc.emit('did-navigate', {}, wc.currentUrl);
      wc.emit('did-finish-load');
      expect(await controller.getPageSnapshot(tab.id)).toMatchObject({
        url: wc.currentUrl,
        meta: { documentId: 1, degraded: 'none' },
      });
      expect(wc.loadURL).toHaveBeenCalledOnce();
    } finally {
      controller.dispose();
    }
  });

  it('同 URL 刷新后重新读取新内容，不给旧采集结果重盖新 documentId', async () => {
    const { controller } = harness();
    try {
      const tab = await controller.createTab('https://example.com/same-url');
      const wc = electronMock.instances[0]?.webContents;
      if (wc === undefined) throw new Error('未创建测试 webContents');
      const collect = wc.collectScript.getMockImplementation();
      if (collect === undefined) throw new Error('缺少测试采集脚本');
      wc.collectScript.mockImplementation(async (source) => ({
        ...((await collect(source)) as Record<string, unknown>),
        visibleText: '新文档正文',
      }));
      wc.collectScript.mockImplementationOnce(async (source) => {
        const oldResult = await collect(source);
        wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
        wc.emit('did-navigate', {}, wc.currentUrl);
        wc.emit('did-finish-load');
        return { ...(oldResult as Record<string, unknown>), visibleText: '旧文档正文' };
      });
      expect(await controller.getPageSnapshot(tab.id)).toMatchObject({
        visibleText: '新文档正文',
        meta: { documentId: 3 },
      });
      expect(wc.collectScript).toHaveBeenCalledTimes(2);
    } finally {
      controller.dispose();
    }
  });

  it('采集期间同页与子框架导航不改变文档绑定，也不触发无意义重采', async () => {
    const { controller } = harness();
    try {
      const tab = await controller.createTab('https://example.com/same-document');
      const wc = electronMock.instances[0]?.webContents;
      if (wc === undefined) throw new Error('未创建测试 webContents');
      const collect = wc.collectScript.getMockImplementation();
      if (collect === undefined) throw new Error('缺少测试采集脚本');
      wc.collectScript.mockImplementationOnce(async (source) => {
        wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
        wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
        return collect(source);
      });
      expect(await controller.getPageSnapshot(tab.id)).toMatchObject({ meta: { documentId: 2 } });
      expect(wc.collectScript).toHaveBeenCalledOnce();
    } finally {
      controller.dispose();
    }
  });

  it.each(['close', 'destroy'] as const)('采集返回前 %s 不交付已销毁标签的快照', async (action) => {
    const { controller } = harness();
    try {
      const tab = await controller.createTab('https://example.com/closing');
      const wc = electronMock.instances[0]?.webContents;
      if (wc === undefined) throw new Error('未创建测试 webContents');
      const collect = wc.collectScript.getMockImplementation();
      if (collect === undefined) throw new Error('缺少测试采集脚本');
      wc.collectScript.mockImplementationOnce(async (source) => {
        const raw = await collect(source);
        if (action === 'close') await controller.closeTab(tab.id);
        else wc.destroyUnexpectedly();
        return raw;
      });
      expect(await controller.getPageSnapshot(tab.id)).toBeNull();
      expect(wc.collectScript).toHaveBeenCalledOnce();
    } finally {
      controller.dispose();
    }
  });

  it('无参数和空字符串创建真实可见 view，但不触发 about:blank 加载；显式 about:blank 仍加载', async () => {
    const { controller, ownerWindow } = harness();
    try {
      const omitted = await controller.createTab();
      const empty = await controller.createTab('');
      const explicit = await controller.createTab('about:blank');

      expect(omitted).toMatchObject({ url: 'about:blank', state: 'ready' });
      expect(empty).toMatchObject({ url: 'about:blank', state: 'ready' });
      expect(explicit.url).toBe('about:blank');
      expect(electronMock.instances[0]?.webContents.loadURL).not.toHaveBeenCalled();
      expect(electronMock.instances[1]?.webContents.loadURL).not.toHaveBeenCalled();
      expect(electronMock.instances[2]?.webContents.loadURL).toHaveBeenCalledOnce();
      expect(electronMock.instances[2]?.webContents.loadURL).toHaveBeenCalledWith('about:blank');
      expect(ownerWindow.contentView.addChildView).toHaveBeenCalledTimes(3);
      expect(electronMock.instances[1]?.setVisible).toHaveBeenLastCalledWith(false);
      expect(electronMock.instances[2]?.setVisible).toHaveBeenLastCalledWith(true);
      expect(electronMock.instances[2]?.webContents.focus).toHaveBeenCalled();
      expect(electronMock.instances[0]?.preferences).toMatchObject({
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      });
    } finally {
      controller.dispose();
    }
  });

  it('并发首次 snapshot/reload/scroll 共用一次物化，完成后返回真实 DOM 元数据', async () => {
    electronMock.deferBlankLoads = true;
    const { controller } = harness();
    try {
      const tab = await controller.createTab();
      const wc = electronMock.instances[0]?.webContents;
      if (wc === undefined) throw new Error('未创建测试 webContents');

      const snapshotPromise = controller.getPageSnapshot(tab.id);
      const reloadPromise = controller.reload(tab.id);
      const scrollPromise = controller.scrollTab(tab.id, 25);
      expect(wc.loadURL).toHaveBeenCalledTimes(1);
      expect(wc.loadURL).toHaveBeenCalledWith('about:blank');
      expect(wc.collectScript).not.toHaveBeenCalled();

      electronMock.pending[0]?.resolve();
      const [snapshot, reload, scroll] = await Promise.all([
        snapshotPromise,
        reloadPromise,
        scrollPromise,
      ]);
      expect(snapshot).toMatchObject({
        url: 'about:blank',
        meta: { readyState: 'complete', degraded: 'none', documentId: 1 },
      });
      expect(reload).toBe(true);
      expect(wc.reload).not.toHaveBeenCalled();
      expect(scroll).toEqual({
        ok: true,
        viewport: { scrollX: 0, scrollY: 25, width: 1024, height: 768 },
      });
      expect(wc.loadURL).toHaveBeenCalledTimes(1);
    } finally {
      controller.dispose();
    }
  });

  it('撤销一个快照读者不结束共享物化、不停止用户Tab，其余读者仍获得实际结果', async () => {
    electronMock.deferBlankLoads = true;
    const { controller } = harness();
    try {
      const tab = await controller.createTab();
      const wc = electronMock.instances[0]!.webContents;
      const cancellation = new AbortController();
      const first = controller.getPageSnapshot(tab.id, cancellation.signal);
      let secondSettled = false;
      const second = controller.getPageSnapshot(tab.id);
      void second.then(() => (secondSettled = true));
      cancellation.abort();
      expect(await first).toBeNull();
      expect(secondSettled).toBe(false);
      expect(wc.loadURL).toHaveBeenCalledOnce();
      expect(wc.stop).not.toHaveBeenCalled();
      expect(wc.close).not.toHaveBeenCalled();
      expect(wc.collectScript).not.toHaveBeenCalled();
      electronMock.pending[0]!.resolve();
      expect(await second).toMatchObject({ url: 'about:blank', meta: { documentId: 1 } });
      expect(wc.collectScript).toHaveBeenCalledOnce();
    } finally {
      controller.dispose();
    }
  });

  it('已撤销快照不启动空白物化', async () => {
    const { controller } = harness();
    try {
      const tab = await controller.createTab();
      const cancellation = new AbortController();
      cancellation.abort();
      expect(await controller.getPageSnapshot(tab.id, cancellation.signal)).toBeNull();
      expect(electronMock.instances[0]!.webContents.loadURL).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  });

  it('首次物化未完成时后续 navigate 取消空白加载，迟到空白不会覆盖目标页', async () => {
    electronMock.deferBlankLoads = true;
    const { controller } = harness();
    try {
      const tab = await controller.createTab();
      const wc = electronMock.instances[0]?.webContents;
      if (wc === undefined) throw new Error('未创建测试 webContents');

      const snapshotPromise = controller.getPageSnapshot(tab.id);
      const navigatePromise = controller.navigate(tab.id, 'https://example.com/target');
      expect(wc.stop).toHaveBeenCalledOnce();
      expect(await navigatePromise).toBe(true);
      const snapshot = await snapshotPromise;
      expect(snapshot?.url).toBe('https://example.com/target');
      expect(wc.currentUrl).toBe('https://example.com/target');
      expect(wc.loadURL.mock.calls.map(([url]) => url)).toEqual([
        'about:blank',
        'https://example.com/target',
      ]);
      electronMock.pending.find((item) => item.url === 'about:blank')?.resolve();
      await Promise.resolve();
      expect(wc.currentUrl).toBe('https://example.com/target');
    } finally {
      controller.dispose();
    }
  });

  it('blank 物化被同步失败导航替代时，reload 与 navigate 都返回 false 并保留失败终态', async () => {
    electronMock.deferBlankLoads = true;
    electronMock.syncFailureUrls.push('https://example.com/sync-failure');
    const { controller } = harness();
    try {
      const tab = await controller.createTab();
      const reloadPromise = controller.reload(tab.id);
      const navigatePromise = controller.navigate(tab.id, 'https://example.com/sync-failure');

      expect(await navigatePromise).toBe(false);
      expect(await reloadPromise).toBe(false);
      expect((await controller.getTabs()).find((item) => item.id === tab.id)?.state).toBe('error');
    } finally {
      controller.dispose();
    }
  });

  it('blank 物化被异步失败导航替代时，所有旧等待者跟随最新失败且不注入脚本', async () => {
    const target = 'https://example.com/async-failure';
    electronMock.deferBlankLoads = true;
    electronMock.deferredUrls.push(target);
    const { controller } = harness();
    try {
      const tab = await controller.createTab();
      const wc = electronMock.instances[0]?.webContents;
      if (wc === undefined) throw new Error('未创建测试 webContents');

      const snapshotPromise = controller.getPageSnapshot(tab.id);
      const reloadPromise = controller.reload(tab.id);
      const scrollPromise = controller.scrollTab(tab.id, 10);
      const navigatePromise = controller.navigate(tab.id, target);
      const targetLoad = electronMock.pending.find((item) => item.url === target);
      if (targetLoad === undefined) throw new Error('未找到异步目标加载');
      targetLoad.reject(new Error('controlled asynchronous load failure'));

      expect(await navigatePromise).toBe(false);
      expect(await reloadPromise).toBe(false);
      expect(await snapshotPromise).toBeNull();
      expect(await scrollPromise).toEqual({ ok: false, reason: '空白标签页加载失败，无法滚动' });
      expect(wc.collectScript).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  });

  it('连续替代只采信最后一次导航，旧完成回调不能覆盖最终文档', async () => {
    const firstTarget = 'https://example.com/first';
    const finalTarget = 'https://example.com/final';
    electronMock.deferBlankLoads = true;
    electronMock.deferredUrls.push(firstTarget, finalTarget);
    const { controller } = harness();
    try {
      const tab = await controller.createTab();
      const wc = electronMock.instances[0]?.webContents;
      if (wc === undefined) throw new Error('未创建测试 webContents');

      const reloadPromise = controller.reload(tab.id);
      const firstNavigation = controller.navigate(tab.id, firstTarget);
      const finalNavigation = controller.navigate(tab.id, finalTarget);
      expect(await firstNavigation).toBe(false);

      electronMock.pending.find((item) => item.url === firstTarget)?.resolve();
      expect(wc.currentUrl).toBe('');
      electronMock.pending.find((item) => item.url === finalTarget)?.resolve();

      expect(await finalNavigation).toBe(true);
      expect(await reloadPromise).toBe(true);
      expect(wc.currentUrl).toBe(finalTarget);
      electronMock.pending.find((item) => item.url === 'about:blank')?.resolve();
      await Promise.resolve();
      expect(wc.currentUrl).toBe(finalTarget);
    } finally {
      controller.dispose();
    }
  });

  it('首次 blank 加载失败返回诚实失败，下一次读取可重新物化并取得真实快照', async () => {
    electronMock.deferBlankLoads = true;
    const { controller } = harness();
    try {
      const tab = await controller.createTab();
      const wc = electronMock.instances[0]?.webContents;
      if (wc === undefined) throw new Error('未创建测试 webContents');

      const snapshotPromise = controller.getPageSnapshot(tab.id);
      const reloadPromise = controller.reload(tab.id);
      const scrollPromise = controller.scrollTab(tab.id, 10);
      electronMock.pending[0]?.reject(new Error('controlled blank load failure'));

      expect(await snapshotPromise).toBeNull();
      expect(await reloadPromise).toBe(false);
      expect(await scrollPromise).toEqual({ ok: false, reason: '空白标签页加载失败，无法滚动' });
      expect(wc.collectScript).not.toHaveBeenCalled();

      electronMock.deferBlankLoads = false;
      const recovered = await controller.getPageSnapshot(tab.id);
      expect(recovered).toMatchObject({
        url: 'about:blank',
        meta: { readyState: 'complete', degraded: 'none', documentId: 1 },
      });
      expect(wc.loadURL).toHaveBeenCalledTimes(2);
    } finally {
      controller.dispose();
    }
  });

  it('blank loadURL 虽 resolve 但没有主框架提交时仍按物化失败处理', async () => {
    electronMock.noCommitUrls.push('about:blank');
    const { controller } = harness();
    try {
      const tab = await controller.createTab();
      const wc = electronMock.instances[0]?.webContents;
      if (wc === undefined) throw new Error('未创建测试 webContents');

      expect(await controller.getPageSnapshot(tab.id)).toBeNull();
      expect(wc.collectScript).not.toHaveBeenCalled();
      expect((await controller.getTabs()).find((item) => item.id === tab.id)?.state).toBe('error');
    } finally {
      controller.dispose();
    }
  });

  it('closeTab 与独立 destroyed 都会结束在途物化，且不在已销毁 view 注入', async () => {
    electronMock.deferBlankLoads = true;
    const first = harness();
    const closeTab = await first.controller.createTab();
    const firstWc = electronMock.instances[0]?.webContents;
    if (firstWc === undefined) throw new Error('未创建首个测试 webContents');
    const closeSnapshot = first.controller.getPageSnapshot(closeTab.id);
    expect(await first.controller.closeTab(closeTab.id)).toBe(true);
    expect(await closeSnapshot).toBeNull();
    expect(firstWc.collectScript).not.toHaveBeenCalled();
    expect((await first.controller.getTabs()).length).toBe(1);
    first.controller.dispose();

    electronMock.deferBlankLoads = true;
    const second = harness();
    const destroyedTab = await second.controller.createTab();
    const secondWc = electronMock.instances.at(-1)?.webContents;
    if (secondWc === undefined) throw new Error('未创建第二个测试 webContents');
    const destroyedSnapshot = second.controller.getPageSnapshot(destroyedTab.id);
    secondWc.destroyUnexpectedly();
    expect(await destroyedSnapshot).toBeNull();
    expect(secondWc.collectScript).not.toHaveBeenCalled();
    expect(await second.controller.getActiveTab()).toBeNull();
    second.controller.dispose();
  });

  it('未物化空白页不接受 elementId 注入；等待中的读取遇 dispose 返回 null 且关闭幂等', async () => {
    electronMock.deferBlankLoads = true;
    const { controller, ownerWindow } = harness();
    const tab = await controller.createTab();
    const wc = electronMock.instances[0]?.webContents;
    if (wc === undefined) throw new Error('未创建测试 webContents');

    const click = await controller.clickElement(tab.id, 'el-1', 'nav', 0);
    expect(click).toMatchObject({ ok: false, errorCode: 'execution-failed' });
    expect(wc.collectScript).not.toHaveBeenCalled();

    const snapshotPromise = controller.getPageSnapshot(tab.id);
    controller.dispose();
    controller.dispose();
    expect(await snapshotPromise).toBeNull();
    expect(wc.close).toHaveBeenCalledOnce();
    expect(ownerWindow.contentView.removeChildView).toHaveBeenCalledOnce();
  });
});
