import { EventEmitter } from 'node:events';
import type { BaseWindow, Session, WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabManager, type TabEntry } from '../../src/main/browser/tab-manager';

interface Contents extends EventEmitter {
  handler(details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse;
  destroyed: boolean;
  loadURL: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn<() => void>>;
}
interface View {
  webContents: Contents;
  preferences: Record<string, unknown>;
}
const mock = vi.hoisted(() => ({ views: [] as View[], dropDestroyedViewContents: false }));

vi.mock('electron', async () => {
  const { EventEmitter: Events } = await import('node:events');
  class MockContents extends Events {
    destroyed = false;
    handler: Contents['handler'] = () => ({ action: 'deny' });
    setWindowOpenHandler(handler: Contents['handler']): void {
      this.handler = handler;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    loadURL = vi.fn(async () => {});
    close = vi.fn(() => {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('destroyed');
    });
  }
  return {
    WebContentsView: class {
      private readonly ownedContents: Contents;
      preferences: Record<string, unknown>;
      constructor(options: { webContents?: Contents; webPreferences?: Record<string, unknown> }) {
        this.ownedContents = options.webContents ?? new MockContents();
        this.preferences = options.webPreferences ?? {};
        mock.views.push(this);
      }
      get webContents(): Contents {
        // Electron's runtime clears the view handle before firing destroyed,
        // despite the public TypeScript getter being non-optional.
        return mock.dropDestroyedViewContents && this.ownedContents.destroyed
          ? (undefined as unknown as Contents)
          : this.ownedContents;
      }
      setVisible(): void {}
    },
  };
});
vi.mock('../../src/main/logger', () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

let electronVersionDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  mock.views.length = 0;
  mock.dropDestroyedViewContents = false;
  electronVersionDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: '43.8.4', configurable: true });
});
afterEach(() => {
  if (electronVersionDescriptor)
    Object.defineProperty(process.versions, 'electron', electronVersionDescriptor);
  else Reflect.deleteProperty(process.versions, 'electron');
});

function fixture(onTabCloseRequested?: (tabId: string) => void): {
  manager: TabManager;
  parent: TabEntry;
  source: Contents;
  open(sandboxFlags?: number): Electron.WindowOpenHandlerResponse;
  navigate: ReturnType<typeof vi.fn<(target: WebContents) => void>>;
  hide(): void;
} {
  let interactive = true;
  const manager = new TabManager({
    ownerWindow: {
      isDestroyed: () => false,
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    } as unknown as BaseWindow,
    session: {} as Session,
    qualifiedScriptPreload: 'D:/AIbrowse/out/preload/qualified-userscripts.js',
    onChanged: vi.fn(),
    onTabCloseRequested,
    isUserTabInteractive: () => interactive,
  });
  const parent = manager.createTab('https://source.example/', { allowUserPopupRouting: true });
  const source = mock.views[0]!.webContents;
  source.emit('did-navigate', {}, 'https://source.example/');
  const navigate = vi.fn<(target: WebContents) => void>();
  return {
    manager,
    parent,
    source,
    navigate,
    open: (sandboxFlags = 0) => {
      source.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
      const details: Electron.HandlerDetails = {
        url: 'https://target.example/',
        disposition: 'background-tab',
        frameName: '_blank',
        features: 'nodeIntegration=yes,sandbox=no,preload=C:/evil.js',
        referrer: { url: 'https://source.example/', policy: 'strict-origin' },
      };
      source.emit(
        '-new-window',
        { preventDefault: vi.fn() },
        details.url,
        details.frameName,
        details.disposition,
        details.features,
        details.referrer,
        undefined,
        sandboxFlags,
        navigate,
      );
      return source.handler(details);
    },
    hide: () => {
      interactive = false;
    },
  };
}

describe('独立审核：通用子窗口安全及生命周期', () => {
  it('浏览器原生无guest路径保留frame的继承sandbox flags，忽略其他偏好', () => {
    const { manager, open } = fixture();
    try {
      const response = open(32768);
      expect(response.action).toBe('allow');
      const options: Electron.BrowserWindowConstructorOptions = {
        webPreferences: {
          nodeIntegration: true,
          sandbox: false,
          preload: 'C:/evil.js',
          openerSandboxFlags: 32768,
        } as Electron.WebPreferences,
      };
      response.createWindow!(options);
      expect(mock.views[1]!.preferences).toMatchObject({
        openerSandboxFlags: 32768,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      });
      expect(mock.views[1]!.preferences.preload).not.toBe('C:/evil.js');
    } finally {
      manager.dispose();
    }
  });

  it('无guest复用一次原生navigate，不使用loadURL重新构造请求', () => {
    const { manager, open, navigate } = fixture();
    try {
      const response = open();
      const child = response.createWindow!({});
      expect(navigate).toHaveBeenCalledExactlyOnceWith(child);
      expect(mock.views[1]!.webContents.loadURL).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it.each(['unqualified-version', 'missing-dispatch', 'expired-dispatch'] as const)(
    '%s 不允许无guest路径退回主进程请求重放',
    async (reason) => {
      const { manager, source, open, navigate } = fixture();
      try {
        if (reason === 'unqualified-version')
          Object.defineProperty(process.versions, 'electron', {
            value: '43.7.8',
            configurable: true,
          });
        let response: Electron.WindowOpenHandlerResponse;
        if (reason === 'missing-dispatch') {
          source.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
          response = source.handler({
            url: 'https://target.example/',
            disposition: 'background-tab',
            frameName: '_blank',
            features: '',
            referrer: { url: '', policy: 'default' },
          });
        } else response = open();
        if (reason === 'expired-dispatch') await Promise.resolve();
        const result = response.createWindow!({}) as unknown as Contents;
        await Promise.resolve();
        expect(result.destroyed).toBe(true);
        expect(navigate).not.toHaveBeenCalled();
        expect(result.loadURL).not.toHaveBeenCalled();
        expect(manager.list()).toHaveLength(1);
      } finally {
        manager.dispose();
      }
    },
  );

  it('原生导航抛错时回收视图和登记，不能留下假成功标签', () => {
    const { manager, open, navigate } = fixture();
    try {
      navigate.mockImplementation(() => {
        throw new Error('受控原生导航失败');
      });
      const response = open();
      const result = response.createWindow!({}) as unknown as Contents;
      expect(result.destroyed).toBe(true);
      expect(result.listenerCount('-new-window')).toBe(0);
      expect(manager.list()).toHaveLength(1);
      expect(result.loadURL).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it('Electron销毁时清空view getter仍能按保存的WebContents引用完成清理', () => {
    const { manager, open } = fixture();
    try {
      const child = open().createWindow!({}) as unknown as Contents;
      mock.dropDestroyedViewContents = true;
      expect(() => child.close()).not.toThrow();
      expect(mock.views[1]!.webContents).toBeUndefined();
      expect(manager.list()).toHaveLength(1);
      expect(child.listenerCount('-new-window')).toBe(0);
      expect(child.listenerCount('did-navigate')).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('普通用户页意外销毁只委托Controller一次以修复活动页和最后空白策略', () => {
    const closeRequested = vi.fn();
    const { manager, parent, source } = fixture(closeRequested);
    try {
      mock.dropDestroyedViewContents = true;
      source.close();
      source.emit('destroyed');
      expect(closeRequested).toHaveBeenCalledExactlyOnceWith(parent.info.id);
      expect(manager.list()).toHaveLength(0);
      expect(source.listenerCount('-new-window')).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('任务页意外销毁也委托Controller修复活动态，只回收任务自身', () => {
    const closeRequested = vi.fn();
    const { manager, parent } = fixture(closeRequested);
    try {
      const task = manager.createTab('https://task.example/', { taskOwned: true });
      const taskContents = task.webContents as unknown as Contents;
      taskContents.close();
      expect(closeRequested).toHaveBeenCalledExactlyOnceWith(task.info.id);
      expect(manager.list().map((entry) => entry.info.id)).toEqual([parent.info.id]);
      expect(taskContents.listenerCount('-new-window')).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('显式关闭和dispose不重复委托Controller或触发用户页替补', () => {
    const closeRequested = vi.fn();
    const { manager, parent } = fixture(closeRequested);
    manager.createTab('https://other.example/');
    manager.closeTab(parent.info.id);
    manager.dispose();
    expect(closeRequested).not.toHaveBeenCalled();
    expect(manager.list()).toHaveLength(0);
  });

  it('同一原生创建回调不能再次创建或发送请求', async () => {
    const { manager, open, navigate } = fixture();
    try {
      const response = open();
      response.createWindow!({});
      const repeated = response.createWindow!({}) as unknown as Contents;
      await Promise.resolve();
      expect(repeated.destroyed).toBe(true);
      expect(navigate).toHaveBeenCalledOnce();
      expect(manager.list()).toHaveLength(2);
    } finally {
      manager.dispose();
    }
  });

  it('用户新标签继续加载固定资格脚本preload，不接受网页preload', () => {
    const { manager, open } = fixture();
    try {
      const response = open();
      expect(response.overrideBrowserWindowOptions?.webPreferences?.preload).toBe(
        'D:/AIbrowse/out/preload/qualified-userscripts.js',
      );
      response.createWindow!({});
      expect(mock.views[1]!.preferences.preload).toBe(
        'D:/AIbrowse/out/preload/qualified-userscripts.js',
      );
    } finally {
      manager.dispose();
    }
  });

  it.each(['hide', 'navigate', 'crash', 'close', 'dispose', 'suppress'] as const)(
    '允许决定后 %s 撤销未收编child，绝不加载或登记',
    async (action) => {
      const { manager, parent, source, open, hide } = fixture();
      try {
        const response = open();
        expect(response.action).toBe('allow');
        if (action === 'hide') hide();
        if (action === 'navigate')
          source.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
        if (action === 'crash') source.emit('render-process-gone');
        if (action === 'close') manager.closeTab(parent.info.id);
        if (action === 'dispose') manager.dispose();
        if (action === 'suppress') manager.suppressUserPopups(parent.info.id)();
        const before = manager.list().length;
        const cancelled = response.createWindow!({}) as unknown as Contents;
        await Promise.resolve();
        expect(cancelled.destroyed).toBe(true);
        expect(cancelled.loadURL).not.toHaveBeenCalled();
        expect(manager.list()).toHaveLength(before);
      } finally {
        manager.dispose();
      }
    },
  );

  it('普通子页不随父Tab生命周期关闭，并独立拦截本地scheme导航', () => {
    const { manager, parent, source, open } = fixture();
    try {
      const response = open();
      expect(response.outlivesOpener).toBe(true);
      const child = response.createWindow!({}) as unknown as Contents;
      source.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      manager.closeTab(parent.info.id);
      expect(child.destroyed).toBe(false);
      for (const event of ['will-navigate', 'will-redirect']) {
        const preventDefault = vi.fn();
        child.emit(event, { url: 'file:///C:/fixture', preventDefault });
        expect(preventDefault).toHaveBeenCalledOnce();
      }
      child.close();
      expect(manager.list()).toHaveLength(0);
    } finally {
      manager.dispose();
    }
  });

  it('原生guest被撤销时返回同一实例并释放，不能偷换WebContents', async () => {
    const { manager, open, hide } = fixture();
    try {
      const response = open();
      const other = manager.createTab('https://other.example/');
      const guest = mock.views[1]!.webContents;
      hide();
      expect(
        response.createWindow!({
          webContents: guest as unknown as WebContents,
        } as Electron.BrowserWindowConstructorOptions),
      ).toBe(guest);
      await Promise.resolve();
      expect(guest.destroyed).toBe(true);
      expect(manager.get(other.info.id)).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });
});
