import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { BrowserControllerImpl } from './browser/browser-controller';
import { AppSessionManager } from './browser/session-manager';
import { initLogger, logDebug, logEnvironment, logError, logInfo, logWarn } from './logger';
import { runSmokeScenario } from './smoke';
import { resolveUiNavigationAllowed, type UiNavigationPolicy } from './ui-navigation-policy';
import { resolveAddressBarInput } from '../shared/url';
import { IPC } from '../shared/types/ipc';
import type { AppInfo } from '../shared/types/app';
import type {
  ContentBounds,
  NavNavigatePayload,
  TabIdPayload,
  TabsCreatePayload,
} from '../shared/types/ipc';

// 冒烟自检模式：窗口创建 + 渲染进程就绪后驱动浏览器核心场景（smoke.ts），全部断言通过后正常退出
const SMOKE_MODE = process.env.AIBROWSE_SMOKE === '1';

// 开发期日志写项目根目录 log/（AGENTS.md §3 红线）；打包后写入用户数据目录（asar 只读）
initLogger(app.isPackaged ? app.getPath('userData') : app.getAppPath());
logEnvironment();

// 单窗口假设（detailed-design 决议 #14）：当前阶段仅一个 UI 窗口；IPC 调用时解引用。
// 内部持有实现类：setContentBounds（§6 UI 接线）是类方法，不属于 §2.1 AI 契约接口
let browserController: BrowserControllerImpl | null = null;
let mainWindow: BrowserWindow | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  logWarn('main', '检测到另一实例正在运行，本实例退出');
  app.quit();
} else {
  logInfo('main', SMOKE_MODE ? '应用启动（冒烟自检模式）' : '应用启动');

  let smokeStarted = false;

  // 冒烟模式兜底：30 秒内渲染进程未就绪视为失败
  if (SMOKE_MODE) {
    setTimeout(() => {
      logError('main', '冒烟超时：渲染进程未在 30 秒内就绪');
      app.exit(1);
    }, 30_000);
  }

  app.whenReady().then(() => {
    registerIpcHandlers();
    logDebug(
      'main',
      `日志文件目录：${app.isPackaged ? app.getPath('userData') : app.getAppPath()}/log`,
    );
    createBrowserWindow();
    app.on('activate', () => {
      // macOS 惯例：点击 Dock 图标且无窗口时重建窗口（当前目标平台为 Windows，保留兼容）
      if (BrowserWindow.getAllWindows().length === 0) createBrowserWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    // 退出路径兜底清理（幂等）；主路径为窗口 closed → dispose（§5）
    browserController?.dispose();
    logInfo('main', '应用退出');
  });

  // 纵深防御（§3.2）：React UI 主窗口是 IPC 的唯一合法调用方；sender 为主窗口且为主帧
  function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent, win: BrowserWindow): boolean {
    return event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  }

  function registerIpcHandlers(): void {
    // invoke 通道：未授权调用一律拒绝 + warn（handler 只注册一次，调用时解引用当前窗口）
    const handle = (channel: string, fn: (payload: unknown) => unknown): void => {
      ipcMain.handle(channel, (event, payload: unknown) => {
        if (mainWindow === null || !isTrustedSender(event, mainWindow)) {
          logWarn('main', `拒绝非主窗口的 IPC 调用：${channel}`);
          throw new Error('未授权的 IPC 调用');
        }
        return fn(payload);
      });
    };

    const readTabId = (payload: unknown): string | null =>
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as TabIdPayload).tabId === 'string'
        ? (payload as TabIdPayload).tabId
        : null;

    handle(IPC.AppGetInfo, (): AppInfo => ({
      appVersion: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      platform: `${process.platform}-${process.arch}`,
    }));

    handle(IPC.TabsList, () => browserController?.getTabs() ?? []);

    handle(IPC.TabsCreate, (payload) => {
      // §9：原始地址栏输入在 main 侧统一规范化；无法解析 → 创建空白 Tab + warn
      const input =
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as TabsCreatePayload).url === 'string'
          ? (payload as TabsCreatePayload).url
          : undefined;
      const url = input === undefined ? undefined : resolveAddressBarInput(input);
      if (input !== undefined && url === '') {
        logWarn('main', `tabs:create 输入无法解析，创建空白标签页：${input}`);
      }
      return browserController?.createTab(url === '' ? undefined : url);
    });

    handle(IPC.TabsClose, (payload) => {
      const tabId = readTabId(payload);
      if (tabId === null) return false;
      return browserController?.closeTab(tabId) ?? false;
    });

    handle(IPC.TabsActivate, (payload) => {
      const tabId = readTabId(payload);
      if (tabId === null) return false;
      return browserController?.activateTab(tabId) ?? false;
    });

    handle(IPC.NavNavigate, (payload) => {
      const p = payload as NavNavigatePayload;
      const tabId = typeof p?.tabId === 'string' ? p.tabId : null;
      const input = typeof p?.input === 'string' ? p.input : null;
      if (tabId === null || input === null) return false;
      const url = resolveAddressBarInput(input); // §9：导航输入在 main 侧统一规范化
      if (url === '') {
        logWarn('main', `nav:navigate 输入无法解析（tabId=${tabId}）：${input}`);
        return false;
      }
      return browserController?.navigate(tabId, url) ?? false;
    });

    handle(IPC.NavBack, (payload) => {
      const tabId = readTabId(payload);
      return tabId !== null ? (browserController?.goBack(tabId) ?? false) : false;
    });
    handle(IPC.NavForward, (payload) => {
      const tabId = readTabId(payload);
      return tabId !== null ? (browserController?.goForward(tabId) ?? false) : false;
    });
    handle(IPC.NavReload, (payload) => {
      const tabId = readTabId(payload);
      return tabId !== null ? (browserController?.reload(tabId) ?? false) : false;
    });

    handle(IPC.PageSnapshot, (payload) => {
      const tabId = readTabId(payload);
      return tabId !== null ? browserController?.getPageSnapshot(tabId) : null;
    });

    // send 通道（单向无回执）：未授权消息忽略 + warn
    ipcMain.on(IPC.UiContentBounds, (event, payload: unknown) => {
      if (mainWindow === null || !isTrustedSender(event, mainWindow)) {
        logWarn('main', `拒绝非主窗口的 IPC 消息：${IPC.UiContentBounds}`);
        return;
      }
      browserController?.setContentBounds(payload as ContentBounds); // 非法值在 controller 内忽略 + warn
    });
    ipcMain.on(IPC.AppRendererReady, (event) => {
      if (mainWindow === null || !isTrustedSender(event, mainWindow)) {
        logWarn('main', '拒绝非主窗口的 renderer-ready 消息');
        return;
      }
      logInfo('main', '渲染进程就绪（React 已挂载，preload bridge 链路正常）');
      if (SMOKE_MODE && !smokeStarted && browserController !== null) {
        smokeStarted = true;
        const loadUrl = process.env['AIBROWSE_SMOKE_URL'];
        runSmokeScenario(browserController, {
          loadUrl: loadUrl === '' ? undefined : loadUrl,
          uiWindow: mainWindow, // T3：导航保护拦截与 bounds 上报生效验证
        })
          .then(() => {
            logInfo('main', '冒烟自检通过，正常退出');
            app.quit();
          })
          .catch(() => {
            app.exit(1); // 失败原因已由 runSmokeScenario 记录 error 日志
          });
      }
    });
  }
}

function createBrowserWindow(): void {
  const win = createMainWindow();
  mainWindow = win;
  const controller = new BrowserControllerImpl({
    ownerWindow: win,
    sessionManager: new AppSessionManager(),
    getFallbackBounds: () => {
      // chrome 高度上报（T3）前按窗口内容区兜底设 bounds（§6）
      const [width, height] = win.getContentSize();
      return { x: 0, y: 0, width, height };
    },
    onTabsStateChanged: (state) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC.TabsUpdated, state);
      }
    },
  });
  browserController = controller;
  void controller.createTab(); // 初始空白标签页（浏览器常驻形态）
  win.on('closed', () => {
    controller.dispose(); // 退出路径全量清理（幂等，§2.1）
    if (mainWindow === win) mainWindow = null;
    logInfo('main', '主窗口已关闭');
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'AIbrowse',
    // 安全默认值：本项目自身 React UI 同样不开启 Node 集成（安全红线，第一版起生效）
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    logInfo('main', '主窗口已显示');
  });
  win.webContents.setWindowOpenHandler(() => {
    logWarn('main', '已拦截 window.open 新窗口请求');
    return { action: 'deny' };
  });

  // UI 窗口自身导航保护（§9，安全红线，preload bridge 扩展硬前提）：
  // UI 窗口 preload 随该窗口任何导航加载——若主框架被导航到远程页面，远程页面将获得
  // window.aibrowse bridge（含 page.snapshot）。will-navigate 覆盖页面发起导航
  // （含 location.replace，Electron 43.4.0 实测触发），will-redirect 覆盖服务器重定向
  // （程序化导航遇 302 时唯一拦截点）；两处 handler 共用同一「自身来源」判定。
  const navPolicy = buildUiNavigationPolicy();
  const onUiWillNavigate = (
    details: Electron.Event<Electron.WebContentsWillNavigateEventParams>,
  ): void => {
    if (!resolveUiNavigationAllowed(details.url, navPolicy)) {
      details.preventDefault();
      logWarn('main', `已拦截 UI 窗口导航（自身来源判定失败）：${details.url}`);
    }
  };
  const onUiWillRedirect = (
    details: Electron.Event<Electron.WebContentsWillRedirectEventParams>,
  ): void => {
    if (!resolveUiNavigationAllowed(details.url, navPolicy)) {
      details.preventDefault();
      logWarn('main', `已拦截 UI 窗口重定向（自身来源判定失败）：${details.url}`);
    }
  };
  win.webContents.on('will-navigate', onUiWillNavigate);
  win.webContents.on('will-redirect', onUiWillRedirect);
  win.webContents.on('did-finish-load', () => {
    logInfo('main', '渲染进程页面加载完成');
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    win.loadURL(devUrl).catch((err: unknown) => logError('main', '开发服务器页面加载失败', err));
  } else {
    win
      .loadFile(join(__dirname, '../renderer/index.html'))
      .catch((err: unknown) => logError('main', '本地页面加载失败', err));
  }
  return win;
}

// UI 窗口导航保护的「自身来源」策略（§9）：开发模式仅放行 ELECTRON_RENDERER_URL 的
// origin（重定向目标同样过该判定）；生产仅放行 file: 入口（按入口文件路径前缀匹配）。
function buildUiNavigationPolicy(): UiNavigationPolicy {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    return { selfOrigin: new URL(devUrl).origin, selfFilePrefix: null };
  }
  return {
    selfOrigin: null,
    selfFilePrefix: pathToFileURL(join(__dirname, '../renderer/index.html')).href,
  };
}

process.on('uncaughtException', (err) => {
  logError('process', '未捕获异常', err);
});
process.on('unhandledRejection', (reason) => {
  logError('process', '未处理的 Promise 拒绝', reason);
});
