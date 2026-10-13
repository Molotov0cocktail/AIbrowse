import { EventEmitter } from 'node:events';
import type { BaseWindow, Session } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabManager } from '../../src/main/browser/tab-manager';

interface Contents extends EventEmitter {
  open(details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse;
  loadURL: ReturnType<typeof vi.fn<() => Promise<void>>>;
  close(): void;
  isDestroyed(): boolean;
}

const mock = vi.hoisted(() => ({
  contents: [] as Contents[],
  createContents: null as (() => Contents) | null,
}));
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class TestContents extends Emitter {
    destroyed = false;
    loadURL = vi.fn(async () => {});
    open: Contents['open'] = () => ({ action: 'deny' });
    setWindowOpenHandler(handler: Contents['open']) {
      this.open = handler;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isLoadingMainFrame() {
      return false;
    }
    close() {
      this.destroyed = true;
      this.emit('destroyed');
    }
  }
  mock.createContents = () => new TestContents();
  return {
    WebContentsView: class {
      webContents: Contents;
      setVisible = vi.fn();
      setBounds = vi.fn();
      constructor(options: { webContents?: Contents }) {
        this.webContents = options.webContents ?? new TestContents();
        mock.contents.push(this.webContents);
      }
    },
  };
});
vi.mock('../../src/main/logger', () => ({ logWarn: vi.fn(), logError: vi.fn() }));

const managers: TabManager[] = [];
beforeEach(() => {
  mock.contents = [];
});
afterEach(() => {
  managers.splice(0).forEach((manager) => manager.dispose());
  vi.restoreAllMocks();
});

function fixture(allow = true) {
  let interactive = true;
  const onPopupTabCreated = vi.fn();
  const manager = new TabManager({
    ownerWindow: {
      isDestroyed: () => false,
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    } as unknown as BaseWindow,
    session: {} as Session,
    onChanged: vi.fn(),
    isUserTabInteractive: () => interactive,
    onPopupTabCreated,
  });
  managers.push(manager);
  const entry = manager.createTab('https://example.test/', {
    allowUserPopupRouting: allow,
    taskOwned: !allow,
  });
  const wc = mock.contents.at(-1)!;
  wc.emit('did-navigate', {}, 'https://example.test/');
  const mouse = () => wc.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
  const details: Electron.HandlerDetails = {
    url: 'https://target.test/path?q=value',
    disposition: 'foreground-tab',
    frameName: '_blank',
    features: 'nodeIntegration=yes,preload=file:///unsafe.js',
    referrer: { url: 'https://source.test/', policy: 'default' },
  };
  return {
    manager,
    entry,
    wc,
    mouse,
    details,
    onPopupTabCreated,
    adopt: (response: Electron.WindowOpenHandlerResponse) => {
      expect(response.action).toBe('allow');
      const guest = mock.createContents!();
      expect(
        response.createWindow!({
          ...response.overrideBrowserWindowOptions,
          webContents: guest,
        } as Electron.BrowserWindowConstructorOptions),
      ).toBe(guest);
      return guest;
    },
    hide: () => {
      interactive = false;
    },
  };
}

describe('独审：用户弹出路由的撤销、一次性和信任边界', () => {
  it('收编原生child并只回调标签标识与后台布尔值，网页features不增加权限', () => {
    const f = fixture();
    f.mouse();
    const response = f.wc.open({ ...f.details, disposition: 'background-tab' });
    expect(response.overrideBrowserWindowOptions?.webPreferences).toMatchObject({
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
      webSecurity: true,
    });
    expect(response.overrideBrowserWindowOptions?.webPreferences?.preload).toBeUndefined();
    const guest = f.adopt(response);
    const child = f.manager.list().find((entry) => entry.info.id !== f.entry.info.id)!;
    expect(f.onPopupTabCreated).toHaveBeenCalledExactlyOnceWith(child.info.id, true);
    expect(guest.loadURL).not.toHaveBeenCalled();
    expect(f.wc.open(f.details)).toEqual({ action: 'deny' });
    expect(f.onPopupTabCreated).toHaveBeenCalledOnce();
  });

  it.each(['blur', 'navigation', 'crash', 'close', 'hidden', 'suppress-and-restore'])(
    '排队后%s撤销额度',
    async (change) => {
      const f = fixture();
      f.mouse();
      const response = f.wc.open(f.details);
      if (change === 'blur') f.wc.emit('blur');
      if (change === 'navigation')
        f.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      if (change === 'crash') f.wc.emit('render-process-gone');
      if (change === 'close') f.manager.closeTab(f.entry.info.id);
      if (change === 'hidden') f.hide();
      if (change === 'suppress-and-restore') f.manager.suppressUserPopups(f.entry.info.id)();
      const guest = f.adopt(response);
      await Promise.resolve();
      expect(guest.isDestroyed()).toBe(true);
      expect(f.onPopupTabCreated).not.toHaveBeenCalled();
    },
  );

  it('嵌套AI动作必须全部退出，重复释放不提前恢复，完成后必须重新输入', async () => {
    const f = fixture();
    const releaseA = f.manager.suppressUserPopups(f.entry.info.id);
    const releaseB = f.manager.suppressUserPopups(f.entry.info.id);
    releaseA();
    releaseA();
    f.mouse();
    f.wc.open(f.details);
    await Promise.resolve();
    expect(f.onPopupTabCreated).not.toHaveBeenCalled();
    releaseB();
    f.wc.open(f.details);
    await Promise.resolve();
    expect(f.onPopupTabCreated).not.toHaveBeenCalled();
    f.mouse();
    f.adopt(f.wc.open(f.details));
    await Promise.resolve();
    expect(f.onPopupTabCreated).toHaveBeenCalledOnce();
  });

  it.each([
    'https://user:password@example.test/',
    'javascript:window.alert(1)',
    'file:///C:/unsafe',
    'data:text/html,unsafe',
    'about:blank#fragment',
    'ftp://example.test/',
    'not-a-url',
    'https://example.test/' + 'a'.repeat(8192),
  ])('真实输入也拒绝目标%#', async (url) => {
    const f = fixture();
    f.mouse();
    f.wc.open({ ...f.details, url });
    f.wc.open(f.details);
    await Promise.resolve();
    expect(f.onPopupTabCreated).not.toHaveBeenCalled();
  });

  it('精确about:blank允许原生引导且消耗该次额度', () => {
    const f = fixture();
    f.mouse();
    const guest = f.adopt(f.wc.open({ ...f.details, url: 'about:blank' }));
    expect(guest.loadURL).not.toHaveBeenCalled();
    expect(f.wc.open(f.details)).toEqual({ action: 'deny' });
    expect(f.onPopupTabCreated).toHaveBeenCalledOnce();
  });

  it('POST保留原生guest且消耗该次额度，随后GET不得复用', () => {
    const f = fixture();
    f.mouse();
    const response = f.wc.open({
      ...f.details,
      postBody: { data: [], contentType: 'application/x-www-form-urlencoded' },
    });
    const guest = f.adopt(response);
    expect(guest.loadURL).not.toHaveBeenCalled();
    expect(f.wc.open(f.details)).toEqual({ action: 'deny' });
    expect(f.onPopupTabCreated).toHaveBeenCalledOnce();
  });

  it('任务标签对鼠标和键盘实体输入都拒绝', async () => {
    const f = fixture(false);
    f.mouse();
    f.wc.open(f.details);
    f.wc.emit('before-input-event', {}, { type: 'keyDown', key: 'Enter', isAutoRepeat: false });
    f.wc.open(f.details);
    await Promise.resolve();
    expect(f.onPopupTabCreated).not.toHaveBeenCalled();
  });

  it('一秒边界到期即拒绝，不接受DOM click作为实体输入', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(100);
    const f = fixture();
    f.mouse();
    now.mockReturnValue(1100);
    f.wc.open(f.details);
    f.wc.emit('click', {});
    f.wc.open(f.details);
    await Promise.resolve();
    expect(f.onPopupTabCreated).not.toHaveBeenCalled();
  });

  it('关闭后解除新增输入/blur监听', () => {
    const f = fixture();
    f.manager.closeTab(f.entry.info.id);
    for (const name of ['before-mouse-event', 'before-input-event', 'blur']) {
      expect(f.wc.listenerCount(name)).toBe(0);
    }
  });
});
