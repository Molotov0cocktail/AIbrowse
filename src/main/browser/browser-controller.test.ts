import { EventEmitter } from 'node:events';
import type { BaseWindow, Session } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserControllerImpl, type BrowserControllerOptions } from './browser-controller';
import type { SessionManager } from './session-manager';

interface PendingLoad {
  url: string;
  resolve(): void;
  reject(reason: Error): void;
}

interface TestWebContents extends EventEmitter {
  windowOpen: (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse;
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
  createGuest: null as (() => TestWebContents) | null,
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
    windowOpen: (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse = () => ({
      action: 'deny',
    });
    setWindowOpenHandler(handler: typeof this.windowOpen): void {
      this.windowOpen = handler;
    }
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
      readonly webContents: MockWebContents;
      readonly preferences: Record<string, unknown>;
      readonly setVisible = vi.fn();
      readonly setBounds = vi.fn();

      constructor(options: {
        webPreferences?: Record<string, unknown>;
        webContents?: MockWebContents;
      }) {
        this.webContents = options.webContents ?? new MockWebContents();
        electronMock.createGuest = () => new MockWebContents();
        this.preferences = options.webPreferences ?? {};
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

function harness(observers: Partial<BrowserControllerOptions> = {}): {
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
      ...observers,
    }),
    ownerWindow,
  };
}

const originalElectronVersion = Object.getOwnPropertyDescriptor(process.versions, 'electron');

beforeEach(() => {
  Object.defineProperty(process.versions, 'electron', { value: '43.8.4', configurable: true });
  electronMock.instances.length = 0;
  electronMock.pending.length = 0;
  electronMock.deferredUrls.length = 0;
  electronMock.noCommitUrls.length = 0;
  electronMock.syncFailureUrls.length = 0;
  electronMock.deferBlankLoads = false;
});

afterEach(() => {
  if (originalElectronVersion)
    Object.defineProperty(process.versions, 'electron', originalElectronVersion);
  else Reflect.deleteProperty(process.versions, 'electron');
});

describe('用户标签分组', () => {
  it('完整UI快照保留分组；任务Tab加入与创建均拒绝且不改变活动页', async () => {
    const onTabsStateChanged = vi.fn();
    const { controller } = harness({ onTabsStateChanged });
    const user = await controller.createTab();
    const task = await controller.createTaskTab('https://example.com/task');
    expect(controller.createTabGroup({ tabId: user.id, name: ' 阅读 ', color: 'blue' })).toBe(true);
    const state = controller.getTabsState();
    const group = state.groups![0]!;
    expect(state.userTabIds).toEqual([user.id]);
    expect(group.name).toBe('阅读');
    expect(state.activeTabId).toBe(task.id);
    expect(onTabsStateChanged).toHaveBeenLastCalledWith(state);
    expect(controller.createTabGroup({ tabId: task.id, name: '任务', color: 'red' })).toBe(false);
    expect(controller.setTabGroup({ tabId: task.id, groupId: group.id })).toBe(false);
    expect(controller.getTabsState()).toEqual(state);
    expect(await controller.activateTab(user.id)).toBe(true);
    expect(
      controller.updateTabGroup({
        groupId: group.id,
        name: '已折叠',
        color: 'green',
        collapsed: true,
      }),
    ).toBe(true);
    expect(controller.getTabsState().activeTabId).toBe(user.id);
    expect(electronMock.instances[0]!.setVisible).toHaveBeenLastCalledWith(true);
    expect(controller.ungroupTabs(group.id)).toBe(true);
    expect(await controller.getTabs()).toHaveLength(2);
    controller.dispose();
  });

  it('关闭及意外销毁都清除组成员，dispose后不能修改或泄漏组', async () => {
    const { controller } = harness();
    const first = await controller.createTab();
    const second = await controller.createTab();
    controller.createTabGroup({ tabId: first.id, name: '分组', color: 'grey' });
    const groupId = controller.getTabsState().groups![0]!.id;
    controller.setTabGroup({ tabId: second.id, groupId });
    await controller.closeTab(first.id);
    expect(controller.getTabsState().groups![0]!.tabIds).toEqual([second.id]);
    electronMock.instances[1]!.webContents.destroyUnexpectedly();
    expect(controller.getTabsState().groups).toEqual([]);
    const third = await controller.createTab();
    controller.createTabGroup({ tabId: third.id, name: '分组', color: 'yellow' });
    controller.dispose();
    expect(controller.getTabsState()).toEqual({
      tabs: [],
      activeTabId: null,
      groups: [],
      userTabIds: [],
    });
    expect(controller.createTabGroup({ tabId: third.id, name: '分组', color: 'yellow' })).toBe(
      false,
    );
    expect(controller.ungroupTabs(groupId)).toBe(false);
  });

  it('用户创建观察在首次加载前且不接触任务Tab，异常不遗留未登记资源', async () => {
    const onUserTabCreated = vi.fn((wc: Electron.WebContents) => {
      expect(wc.loadURL).not.toHaveBeenCalled();
      throw new Error('受控观察异常');
    });
    const { controller } = harness({ onUserTabCreated });
    const user = await controller.createTab('https://example.com/user');
    await controller.createTaskTab('https://example.com/task');
    expect(onUserTabCreated).toHaveBeenCalledTimes(1);
    expect(controller.getTabsState().userTabIds).toEqual([user.id]);
    expect(await controller.getTabs()).toHaveLength(2);
    controller.dispose();
    expect(electronMock.instances.every((view) => view.webContents.destroyed)).toBe(true);
  });
});

describe('网页原生关闭后的用户标签生命周期', () => {
  it.each([false, true])('任务页销毁恢复幸存用户页=%s，且不创建用户空白页', async (withUserTab) => {
    const { controller } = harness();
    const user = withUserTab ? await controller.createTab('https://user.example/') : null;
    const task = await controller.createTaskTab('https://task.example/');
    const taskView = electronMock.instances.at(-1)!;
    taskView.webContents.destroyUnexpectedly();
    expect(controller.getTabsState().activeTabId).toBe(user?.id ?? null);
    expect(controller.getTabsState().activeTabId).not.toBe(task.id);
    expect(await controller.getTabs()).toHaveLength(withUserTab ? 1 : 0);
    expect(electronMock.instances).toHaveLength(withUserTab ? 2 : 1);
    controller.dispose();
  });

  it('活动普通页销毁后选择存活邻页并移除视图及监听器', async () => {
    const { controller, ownerWindow } = harness();
    const first = await controller.createTab('https://first.example/');
    const second = await controller.createTab('https://second.example/');
    const secondView = electronMock.instances[1]!;
    secondView.webContents.destroyUnexpectedly();
    expect(await controller.getActiveTab()).toMatchObject({ id: first.id, active: true });
    expect(await controller.getTabs()).toHaveLength(1);
    expect(controller.getTabsState().activeTabId).not.toBe(second.id);
    expect(ownerWindow.contentView.removeChildView).toHaveBeenCalledWith(secondView);
    expect(secondView.webContents.listenerCount('did-navigate')).toBe(0);
    expect(secondView.webContents.close).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('后台普通页销毁不抢活动页，最后页销毁只补一个空白页', async () => {
    const { controller, ownerWindow } = harness();
    await controller.createTab('https://background.example/');
    const active = await controller.createTab('https://active.example/');
    const backgroundView = electronMock.instances[0]!;
    const activeView = electronMock.instances[1]!;
    backgroundView.webContents.destroyUnexpectedly();
    expect((await controller.getActiveTab())?.id).toBe(active.id);
    activeView.webContents.destroyUnexpectedly();
    activeView.webContents.emit('destroyed');
    const replacement = (await controller.getActiveTab())!;
    expect(replacement).toMatchObject({ url: 'about:blank', active: true });
    expect(replacement.id).not.toBe(active.id);
    expect(await controller.getTabs()).toHaveLength(1);
    expect(electronMock.instances).toHaveLength(3);
    expect(ownerWindow.contentView.removeChildView).toHaveBeenCalledTimes(2);
    controller.dispose();
    expect(electronMock.instances).toHaveLength(3);
    expect(await controller.getTabs()).toHaveLength(0);
  });
});

it('只有普通标签主框架提交写历史；后台、失败和子框架不会写入', async () => {
  const onNavigationCommitted = vi.fn(() => 'visit-1');
  const { controller } = harness({ onNavigationCommitted });
  await controller.createTaskTab('https://example.com/task');
  await controller.createTab();
  const wc = electronMock.instances[1]!.webContents;
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  wc.emit('did-fail-load', {}, -105, '', 'https://failure.test', true);
  wc.emit('did-navigate-in-page', {}, 'https://example.com/frame', false);
  expect(onNavigationCommitted).not.toHaveBeenCalled();
  wc.emit('did-navigate', {}, 'https://example.com/final');
  expect(onNavigationCommitted).toHaveBeenCalledWith({
    url: 'https://example.com/final',
    title: '',
  });
  wc.emit('did-navigate-in-page', {}, 'https://example.com/final#one', true);
  expect(onNavigationCommitted).toHaveBeenCalledTimes(2);
  controller.dispose();
});

it('标题更新只携带已提交访问标识，导航开始后旧标题失效', async () => {
  const onVisitTitleChanged = vi.fn();
  const { controller } = harness({ onNavigationCommitted: () => 'visit-1', onVisitTitleChanged });
  await controller.createTab('https://example.com/');
  const wc = electronMock.instances[0]!.webContents;
  wc.emit('page-title-updated', {}, '网页一');
  expect(onVisitTitleChanged).toHaveBeenCalledWith({
    id: 'visit-1',
    url: 'https://example.com/',
    title: '网页一',
  });
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  wc.emit('page-title-updated', {}, '迟到标题');
  expect(onVisitTitleChanged).toHaveBeenCalledTimes(1);
  controller.dispose();
});

function popupDetails(
  url = 'https://www.bilibili.com/',
  disposition: Electron.HandlerDetails['disposition'] = 'foreground-tab',
): Electron.HandlerDetails {
  return {
    url,
    disposition,
    frameName: '_blank',
    features: '',
    referrer: { url: '', policy: 'default' },
  };
}

function userClick(wc: TestWebContents): void {
  wc.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left', x: 10, y: 10 });
}

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture';

function nativeLink(wc: TestWebContents, details: Electron.HandlerDetails, sandboxFlags = 0) {
  const navigate = vi.fn<(contents: Electron.WebContents) => void>();
  wc.emit(
    '-new-window',
    { preventDefault: vi.fn() },
    details.url,
    details.frameName,
    details.disposition,
    details.features,
    details.referrer,
    details.postBody?.data,
    sandboxFlags,
    navigate,
  );
  return navigate;
}

function adoptPopup(response: Electron.WindowOpenHandlerResponse): TestWebContents {
  expect(response.action).toBe('allow');
  expect(response.outlivesOpener).toBe(true);
  const guest = electronMock.createGuest!();
  const nativeOptions = {
    ...response.overrideBrowserWindowOptions,
    webContents: guest as unknown as Electron.WebContents,
  };
  expect(response.createWindow!(nativeOptions)).toBe(guest);
  return guest;
}

function openUserPopup(
  source: TestWebContents,
  details = popupDetails(GOOGLE_AUTH, 'new-window'),
): TestWebContents {
  userClick(source);
  return adoptPopup(source.windowOpen(details));
}

describe('用户弹窗保留原生浏览器关系', () => {
  it.each([
    ['https://x.com/i/flow/login', GOOGLE_AUTH],
    ['https://app.example/', 'https://idp.example/login'],
    ['http://localhost:4321/', 'http://localhost:4322/form'],
  ])('来源 %s 原窗口收编到 %s，不创建替身或再次 loadURL', async (origin, target) => {
    const onUserTabCreated = vi.fn();
    const { controller, ownerWindow } = harness({ onUserTabCreated });
    try {
      const source = await controller.createTab(origin);
      const guest = openUserPopup(electronMock.instances[0]!.webContents, popupDetails(target));
      expect(await controller.getTabs()).toHaveLength(2);
      expect((await controller.getTabs())[1]).toMatchObject({ url: target, active: true });
      expect(electronMock.instances[1]!.webContents).toBe(guest);
      expect(guest.loadURL).not.toHaveBeenCalled();
      expect(onUserTabCreated).toHaveBeenLastCalledWith(guest);
      guest.destroyUnexpectedly();
      expect(await controller.getTabs()).toHaveLength(1);
      expect((await controller.getActiveTab())?.id).toBe(source.id);
      expect(electronMock.instances[0]!.setVisible).toHaveBeenLastCalledWith(true);
      expect(ownerWindow.contentView.removeChildView).toHaveBeenCalledWith(
        electronMock.instances[1],
      );
      expect(guest.listenerCount('did-navigate')).toBe(0);
    } finally {
      controller.dispose();
    }
  });

  it('弹窗安全偏好在 Chromium 创建前固定，网页 features 不增加权限或 preload', async () => {
    const { controller } = harness({ qualifiedScriptPreload: 'D:/fixed-script.js' });
    try {
      await controller.createTab('https://app.example/');
      const wc = electronMock.instances[0]!.webContents;
      userClick(wc);
      const response = wc.windowOpen({
        ...popupDetails('https://idp.example/', 'new-window'),
        features:
          'nodeIntegration=yes,webviewTag=yes,contextIsolation=no,webSecurity=no,preload=C:/evil.js',
      });
      expect(response.action).toBe('allow');
      expect(response.overrideBrowserWindowOptions?.webPreferences).toMatchObject({
        session: electronMock.instances[0]!.preferences.session,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        preload: 'D:/fixed-script.js',
      });
    } finally {
      controller.dispose();
    }
  });

  it.each(['navigation', 'crash', 'close', 'destroy'] as const)(
    '来源 %s 不误关已经建立的普通子页',
    async (operation) => {
      const { controller } = harness();
      try {
        const source = await controller.createTab('https://app.example/');
        const wc = electronMock.instances[0]!.webContents;
        const guest = openUserPopup(wc);
        const child = (await controller.getActiveTab())!;
        if (operation === 'navigation')
          await controller.navigate(source.id, 'https://other.example/');
        else if (operation === 'crash') wc.emit('render-process-gone');
        else if (operation === 'close') await controller.closeTab(source.id);
        else wc.destroyUnexpectedly();
        expect(guest.destroyed).toBe(false);
        expect((await controller.getActiveTab())?.id).toBe(child.id);
        guest.destroyUnexpectedly();
        expect(await controller.getActiveTab()).not.toBeNull();
      } finally {
        controller.dispose();
      }
    },
  );

  it('源页同文档及子帧导航不关闭子页，关闭后台子页不抢焦点', async () => {
    const { controller } = harness();
    try {
      await controller.createTab('https://app.example/');
      const wc = electronMock.instances[0]!.webContents;
      const guest = openUserPopup(wc);
      wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
      wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
      expect(guest.destroyed).toBe(false);
      const other = await controller.createTab('https://other.example/');
      guest.destroyUnexpectedly();
      expect((await controller.getActiveTab())?.id).toBe(other.id);
    } finally {
      controller.dispose();
    }
  });

  it('跨文档在途即使收到旧页面 hash 提交和新点击，也不能建立弹窗', async () => {
    const { controller } = harness();
    try {
      await controller.createTab('https://app.example/');
      const wc = electronMock.instances[0]!.webContents;
      wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      wc.emit('did-navigate-in-page', {}, 'https://app.example/#old', true);
      userClick(wc);
      expect(wc.windowOpen(popupDetails(GOOGLE_AUTH))).toEqual({ action: 'deny' });
    } finally {
      controller.dispose();
    }
  });

  it.each(['navigation', 'hidden', 'blur', 'ai', 'closed'] as const)(
    '原生创建前 %s 撤销入口，迟到 guest 释放且无登记残留',
    async (operation) => {
      const { controller } = harness();
      try {
        const source = await controller.createTab('https://app.example/');
        const wc = electronMock.instances[0]!.webContents;
        userClick(wc);
        const response = wc.windowOpen(popupDetails(GOOGLE_AUTH));
        expect(response.action).toBe('allow');
        if (operation === 'navigation')
          await controller.navigate(source.id, 'https://other.example/');
        else if (operation === 'hidden') {
          controller.setContentVisible(false);
          controller.setContentVisible(true);
        } else if (operation === 'blur') wc.emit('blur');
        else if (operation === 'ai') await controller.scrollTab(source.id, 10);
        else await controller.closeTab(source.id);
        const guest = electronMock.createGuest!();
        const nativeOptions = {
          show: false,
          webContents: guest as unknown as Electron.WebContents,
        };
        response.createWindow!(nativeOptions);
        await Promise.resolve();
        expect(guest.destroyed).toBe(true);
        expect(await controller.getTabs()).toHaveLength(1);
      } finally {
        controller.dispose();
      }
    },
  );

  it('AI 操作即使同步触发鼠标事件也不能建立原生子页', async () => {
    const { controller } = harness();
    try {
      const source = await controller.createTab('https://app.example/');
      const wc = electronMock.instances[0]!.webContents;
      const snapshot = await controller.getPageSnapshot(source.id);
      wc.collectScript.mockImplementation(async () => {
        userClick(wc);
        expect(wc.windowOpen(popupDetails(GOOGLE_AUTH))).toEqual({ action: 'deny' });
        return { ok: true, tag: 'a', text: '登录' };
      });
      userClick(wc);
      await controller.clickElement(source.id, 'el-1', 'nav', snapshot!.meta.documentId);
      expect(wc.windowOpen(popupDetails(GOOGLE_AUTH))).toEqual({ action: 'deny' });
      expect(await controller.getTabs()).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  it('精确 about:blank 作为原生脚本引导页保留，不自行覆盖 DOM', async () => {
    const { controller } = harness();
    try {
      await controller.createTab('https://app.example/');
      const guest = openUserPopup(
        electronMock.instances[0]!.webContents,
        popupDetails('about:blank'),
      );
      expect((await controller.getActiveTab())?.url).toBe('about:blank');
      expect(guest.loadURL).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  });

  it('没有原生 guest 的后台链接只调用原生闭包，不重放 referrer 或 POST', async () => {
    const { controller } = harness();
    try {
      const source = await controller.createTab('https://app.example/');
      const wc = electronMock.instances[0]!.webContents;
      userClick(wc);
      const details = {
        ...popupDetails('https://form.example/submit', 'background-tab'),
        referrer: {
          url: 'https://app.example/',
          policy: 'strict-origin-when-cross-origin' as const,
        },
        postBody: {
          data: [{ type: 'rawData' as const, bytes: Buffer.from('fixture=value') }],
          contentType: 'multipart/form-data',
          boundary: 'fixture-boundary',
        },
      };
      const navigate = nativeLink(wc, details);
      const response = wc.windowOpen(details);
      expect(response.action).toBe('allow');
      const child = response.createWindow!({}) as unknown as TestWebContents;
      expect(navigate).toHaveBeenCalledExactlyOnceWith(child);
      expect(child.loadURL).not.toHaveBeenCalled();
      expect((await controller.getActiveTab())?.id).toBe(source.id);
      expect(child.focus).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  });

  it('原生 POST guest 不经应用重放或改成 GET', async () => {
    const { controller } = harness();
    try {
      await controller.createTab('https://app.example/');
      const guest = openUserPopup(electronMock.instances[0]!.webContents, {
        ...popupDetails('https://form.example/submit'),
        postBody: {
          data: [{ type: 'rawData', bytes: Buffer.from('fixture=value') }],
          contentType: 'application/x-www-form-urlencoded',
        },
      });
      expect(guest.loadURL).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  });

  it('无 guest 分支白名单保留原生子帧沙箱标记，不继承未受控偏好', async () => {
    const { controller } = harness();
    try {
      await controller.createTab('https://app.example/');
      const wc = electronMock.instances[0]!.webContents;
      userClick(wc);
      const details = popupDetails('https://other.example/', 'background-tab');
      const navigate = nativeLink(wc, details, 123);
      const response = wc.windowOpen(details);
      const nativeOptions = {
        webPreferences: {
          openerSandboxFlags: 123,
          preload: 'C:/evil.js',
          nodeIntegration: true,
          sandbox: false,
        },
      };
      response.createWindow!(nativeOptions);
      expect(electronMock.instances[1]!.preferences).toMatchObject({
        openerSandboxFlags: 123,
        nodeIntegration: false,
        sandbox: true,
      });
      expect(electronMock.instances[1]!.preferences.preload).toBeUndefined();
      expect(navigate).toHaveBeenCalledOnce();
    } finally {
      controller.dispose();
    }
  });

  it.each([-1, 1.5, 0x100000000, '123', null])(
    '非法原生沙箱标记 %s 不登记、不导航并释放内容',
    async (openerSandboxFlags) => {
      const { controller } = harness();
      try {
        await controller.createTab('https://app.example/');
        const wc = electronMock.instances[0]!.webContents;
        userClick(wc);
        const response = wc.windowOpen(popupDetails('https://other.example/', 'background-tab'));
        const nativeOptions = { webPreferences: { openerSandboxFlags, sandbox: true } };
        const cancelled = response.createWindow!(nativeOptions) as unknown as TestWebContents;
        await Promise.resolve();
        expect(cancelled.destroyed).toBe(true);
        expect(cancelled.loadURL).not.toHaveBeenCalled();
        expect(await controller.getTabs()).toHaveLength(1);
      } finally {
        controller.dispose();
      }
    },
  );

  it.each([
    'about:blank#fragment',
    'about:blank?query',
    'about:srcdoc',
    'https://user:password@example.org/',
  ])('拒绝非网页或凭据目标 %s', async (url) => {
    const { controller } = harness();
    try {
      await controller.createTab('https://app.example/');
      const wc = electronMock.instances[0]!.webContents;
      userClick(wc);
      expect(wc.windowOpen(popupDetails(url))).toEqual({ action: 'deny' });
    } finally {
      controller.dispose();
    }
  });

  it.each(['about:blank', 'file:///C:/fixture', 'https://user:password@example.org/'])(
    '不合格已提交来源 %s 不获得弹窗能力',
    async (url) => {
      const { controller } = harness();
      try {
        await controller.createTab(url);
        const wc = electronMock.instances[0]!.webContents;
        userClick(wc);
        expect(wc.windowOpen(popupDetails(GOOGLE_AUTH))).toEqual({ action: 'deny' });
      } finally {
        controller.dispose();
      }
    },
  );
});
describe('BrowserController 手动下载边界', () => {
  it('用户输入不提供下载凭据采集或自动交接入口', async () => {
    const { controller } = harness();
    try {
      await controller.createTab('https://example.com/');
      userClick(electronMock.instances[0]!.webContents);
      expect('getDownloadCaptureContext' in controller).toBe(false);
      expect('isUserDownloadFrame' in controller).toBe(false);
      expect('consumeDownloadLease' in controller).toBe(false);
    } finally {
      controller.dispose();
    }
  });
});

describe('BrowserController 用户新标签导航安全边界', () => {
  it('AI点击与填充撤销用户额度并阻止在途/迟到popup', async () => {
    const { controller } = harness();
    try {
      const source = await controller.createTab('https://example.com/');
      const wc = electronMock.instances[0]!.webContents;
      const snapshot = await controller.getPageSnapshot(source.id);
      expect(snapshot).not.toBeNull();
      wc.collectScript.mockImplementation(async () => {
        userClick(wc);
        wc.windowOpen(popupDetails());
        return { ok: true, tag: 'a', text: '链接' };
      });
      userClick(wc);
      await controller.clickElement(source.id, 'el-1', 'nav', snapshot!.meta.documentId);
      wc.windowOpen(popupDetails());
      userClick(wc);
      await controller.fillElement(source.id, 'el-1', 'test', snapshot!.meta.documentId);
      wc.windowOpen(popupDetails());
      await Promise.resolve();
      expect(await controller.getTabs()).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  it('队列中的popup在隐藏再恢复后仍撤销，后台旧页输入无效', async () => {
    const { controller } = harness();
    try {
      await controller.createTab('https://example.com/');
      const wc = electronMock.instances[0]!.webContents;
      userClick(wc);
      wc.windowOpen(popupDetails());
      controller.setContentVisible(false);
      controller.setContentVisible(true);
      await Promise.resolve();
      expect(await controller.getTabs()).toHaveLength(1);
      await controller.createTab('https://example.org/');
      userClick(wc);
      wc.windowOpen(popupDetails());
      await Promise.resolve();
      expect(await controller.getTabs()).toHaveLength(2);
    } finally {
      controller.dispose();
    }
  });
  it('用户点击 target=_blank 收编原生内容并在应用内打开安全目标', async () => {
    const { controller } = harness();
    try {
      const source = await controller.createTab('https://www.bing.com/search?q=bilibili');
      const wc = electronMock.instances[0]!.webContents;
      userClick(wc);
      adoptPopup(wc.windowOpen(popupDetails()));
      await Promise.resolve();
      const tabs = await controller.getTabs();
      expect(tabs).toHaveLength(2);
      expect(tabs[0]?.id).toBe(source.id);
      expect(tabs[1]).toMatchObject({ url: 'https://www.bilibili.com/', active: true });
      expect(electronMock.instances[1]?.preferences).toMatchObject({
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      });
      expect(electronMock.instances[1]?.preferences.preload).toBeUndefined();
    } finally {
      controller.dispose();
    }
  });

  it('Ctrl/中键后台打开不夺走活动页面且同次输入只开一个标签', async () => {
    const { controller } = harness();
    try {
      const source = await controller.createTab('https://example.com/');
      const wc = electronMock.instances[0]!.webContents;
      userClick(wc);
      const details = popupDetails('https://example.org/', 'background-tab');
      nativeLink(wc, details);
      const response = wc.windowOpen(details);
      expect(response.action).toBe('allow');
      response.createWindow!({});
      expect(wc.windowOpen(popupDetails('https://example.net/', 'background-tab'))).toEqual({
        action: 'deny',
      });
      await Promise.resolve();
      expect(await controller.getTabs()).toHaveLength(2);
      expect((await controller.getActiveTab())?.id).toBe(source.id);
      expect(electronMock.instances[1]?.webContents.focus).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  });

  it.each([
    'javascript:alert(1)',
    'file:///C:/private',
    'data:text/html,x',
    'mailto:a@example.com',
    'https://u:p@example.com/',
  ])('即使用户输入也拒绝危险/非网页目标 %s', async (url) => {
    const { controller } = harness();
    try {
      await controller.createTab('https://example.com/');
      const wc = electronMock.instances[0]!.webContents;
      userClick(wc);
      expect(wc.windowOpen(popupDetails(url))).toEqual({ action: 'deny' });
      await Promise.resolve();
      expect(await controller.getTabs()).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  it('无输入脚本、失焦和隐藏页面不能获得新标签能力', async () => {
    const { controller } = harness();
    try {
      await controller.createTab('https://example.com/');
      const wc = electronMock.instances[0]!.webContents;
      wc.windowOpen(popupDetails());
      userClick(wc);
      wc.emit('blur');
      wc.windowOpen(popupDetails());
      userClick(wc);
      controller.setContentVisible(false);
      wc.windowOpen(popupDetails());
      await Promise.resolve();
      expect(await controller.getTabs()).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  it('任务所有标签即使处于活动可见状态并收到输入仍拒绝popup', async () => {
    const { controller } = harness();
    try {
      await controller.createTaskTab('https://example.com/');
      const wc = electronMock.instances[0]!.webContents;
      userClick(wc);
      wc.windowOpen(popupDetails());
      await Promise.resolve();
      expect(await controller.getTabs()).toHaveLength(1);
    } finally {
      controller.dispose();
    }
  });

  it('过期额度、在途文档中的 POST 与已关闭源均拒绝', async () => {
    const { controller } = harness();
    const now = vi.spyOn(performance, 'now').mockReturnValue(100);
    try {
      const source = await controller.createTab('https://example.com/');
      const wc = electronMock.instances[0]!.webContents;
      userClick(wc);
      now.mockReturnValue(1101);
      wc.windowOpen(popupDetails());
      userClick(wc);
      wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      wc.windowOpen(popupDetails());
      userClick(wc);
      wc.windowOpen({
        ...popupDetails(),
        postBody: { data: [], contentType: 'application/x-www-form-urlencoded' },
      });
      userClick(wc);
      wc.windowOpen(popupDetails());
      await controller.closeTab(source.id);
      await Promise.resolve();
      expect(await controller.getTabs()).toHaveLength(1);
      expect((await controller.getActiveTab())?.url).toBe('about:blank');
    } finally {
      now.mockRestore();
      controller.dispose();
    }
  });

  it('键盘Enter用户输入可打开链接，重复按键不授予额度', async () => {
    const { controller } = harness();
    try {
      await controller.createTab('https://example.com/');
      const wc = electronMock.instances[0]!.webContents;
      wc.emit('before-input-event', {}, { type: 'keyDown', key: 'Enter', isAutoRepeat: true });
      wc.windowOpen(popupDetails());
      await Promise.resolve();
      expect(await controller.getTabs()).toHaveLength(1);
      wc.emit('before-input-event', {}, { type: 'keyDown', key: 'Enter', isAutoRepeat: false });
      adoptPopup(wc.windowOpen(popupDetails()));
      await Promise.resolve();
      expect(await controller.getTabs()).toHaveLength(2);
    } finally {
      controller.dispose();
    }
  });
});

describe('BrowserController 默认空白 view 延迟物化', () => {
  it('退出封闭快照准入，批准仅撤销空白物化读者而不谎报共享 load 完成', async () => {
    electronMock.deferBlankLoads = true;
    const { controller } = harness();
    const tab = await controller.createTab();
    const wc = electronMock.instances[0]!.webContents;
    const snapshot = controller.getPageSnapshot(tab.id);
    expect(controller.getPendingSnapshotCount()).toBe(1);
    controller.beginSnapshotShutdown();
    expect(await controller.getPageSnapshot(tab.id)).toBeNull();
    expect(controller.getPendingSnapshotCount()).toBe(1);
    await controller.stopSnapshotsForShutdown();
    expect(await snapshot).toBeNull();
    expect(controller.getPendingSnapshotCount()).toBe(0);
    expect(wc.close).not.toHaveBeenCalled();
    expect(wc.collectScript).not.toHaveBeenCalled();
    electronMock.pending[0]!.resolve();
    await Promise.resolve();
    expect(wc.collectScript).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('物化 Promise 交接时退出不能再派发快照', async () => {
    electronMock.deferBlankLoads = true;
    const { controller } = harness();
    const tab = await controller.createTab();
    const wc = electronMock.instances[0]!.webContents;
    const snapshot = controller.getPageSnapshot(tab.id);
    electronMock.pending[0]!.resolve();
    controller.beginSnapshotShutdown();
    expect(await snapshot).toBeNull();
    expect(wc.collectScript).not.toHaveBeenCalled();
    expect(controller.getPendingSnapshotCount()).toBe(0);
    controller.dispose();
  });

  it.each([false, true])(
    '已摘除 Tab 的快照仍登记在途，退出批准状态=%s 后不再创建标签',
    async (shutdownBeforeClose) => {
      const { controller } = harness();
      const tab = await controller.createTab('https://example.com/');
      const wc = electronMock.instances[0]!.webContents;
      wc.collectScript.mockReturnValue(new Promise(() => undefined));
      const snapshot = controller.getPageSnapshot(tab.id);
      for (let i = 0; i < 12; i++) await Promise.resolve();
      if (shutdownBeforeClose) controller.beginSnapshotShutdown();
      wc.destroyUnexpectedly();
      controller.beginSnapshotShutdown();
      expect(controller.getPendingSnapshotCount()).toBe(1);
      expect(await controller.getTabs()).toHaveLength(shutdownBeforeClose ? 0 : 1);
      await controller.stopSnapshotsForShutdown();
      expect(await snapshot).toBeNull();
      expect(controller.getPendingSnapshotCount()).toBe(0);
      expect(await controller.getTabs()).toHaveLength(shutdownBeforeClose ? 0 : 1);
      expect(electronMock.instances).toHaveLength(shutdownBeforeClose ? 1 : 2);
      controller.dispose();
    },
  );

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
    expect(await second.controller.getActiveTab()).toMatchObject({ url: 'about:blank' });
    expect((await second.controller.getActiveTab())?.id).not.toBe(destroyedTab.id);
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
