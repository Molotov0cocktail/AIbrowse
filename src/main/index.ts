import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { initLogger, logDebug, logEnvironment, logError, logInfo, logWarn } from './logger';
import type { AppInfo } from '../shared/types/app';

// 冒烟自检模式：窗口创建 + 渲染进程就绪后自动正常退出（供 CI / 脚本化验证）
const SMOKE_MODE = process.env.AIBROWSE_SMOKE === '1';

// 开发期日志写项目根目录 log/（AGENTS.md §3 红线）；打包后写入用户数据目录（asar 只读）
initLogger(app.isPackaged ? app.getPath('userData') : app.getAppPath());
logEnvironment();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  logWarn('main', '检测到另一实例正在运行，本实例退出');
  app.quit();
} else {
  logInfo('main', SMOKE_MODE ? '应用启动（冒烟自检模式）' : '应用启动');

  let smokeQuitScheduled = false;
  ipcMain.on('app:renderer-ready', () => {
    logInfo('main', '渲染进程就绪（React 已挂载，preload bridge 链路正常）');
    if (SMOKE_MODE && !smokeQuitScheduled) {
      smokeQuitScheduled = true;
      // 冒烟自检通过后正常退出（app.quit 走完整退出流程，不用 process.exit 强杀）
      setTimeout(() => {
        logInfo('main', '冒烟自检通过，正常退出');
        app.quit();
      }, 1000);
    }
  });

  // 冒烟模式兜底：30 秒内渲染进程未就绪视为失败
  if (SMOKE_MODE) {
    setTimeout(() => {
      logError('main', '冒烟超时：渲染进程未在 30 秒内就绪');
      app.exit(1);
    }, 30_000);
  }

  app.whenReady().then(() => {
    ipcMain.handle('app:get-info', (): AppInfo => ({
      appVersion: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      platform: `${process.platform}-${process.arch}`,
    }));
    logDebug(
      'main',
      `日志文件目录：${app.isPackaged ? app.getPath('userData') : app.getAppPath()}/log`,
    );
    createMainWindow();
    app.on('activate', () => {
      // macOS 惯例：点击 Dock 图标且无窗口时重建窗口（当前目标平台为 Windows，保留兼容）
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    logInfo('main', '应用退出');
  });
}

function createMainWindow(): void {
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
  win.webContents.on('did-finish-load', () => {
    logInfo('main', '渲染进程页面加载完成');
  });
  win.on('closed', () => {
    logInfo('main', '主窗口已关闭');
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    win.loadURL(devUrl).catch((err: unknown) => logError('main', '开发服务器页面加载失败', err));
  } else {
    win
      .loadFile(join(__dirname, '../renderer/index.html'))
      .catch((err: unknown) => logError('main', '本地页面加载失败', err));
  }
}

process.on('uncaughtException', (err) => {
  logError('process', '未捕获异常', err);
});
process.on('unhandledRejection', (reason) => {
  logError('process', '未处理的 Promise 拒绝', reason);
});
