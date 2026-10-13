import {
  app,
  dialog,
  ipcMain,
  Menu,
  Notification,
  type BrowserWindow,
  type IpcMainEvent,
} from 'electron';
import { join } from 'node:path';
import type {
  QualifiedScriptId,
  QualifiedScriptResult,
} from '../../shared/types/qualified-userscripts';
import { QualifiedScriptStore } from './store';
import { QualifiedScriptNetwork } from './network';
import { QualifiedScriptRuntime } from './runtime';
import { getCatalogEntry } from './catalog';
import { readQualifiedPackage } from './package';

export function createQualifiedScriptFeature(options: {
  win: BrowserWindow;
  dataRoot: string;
  isOpen: () => boolean;
  getActiveUserContentsId: () => number | null;
  openUserTab: (url: string) => void;
}) {
  const network = new QualifiedScriptNetwork();
  const store = new QualifiedScriptStore({
    directory: join(options.dataRoot, 'qualified-userscripts'),
    fetchText: async (url, signal) =>
      (await network.request({ url, method: 'GET' }, signal)).responseText,
  });
  const runtime = new QualifiedScriptRuntime({
    store,
    network,
    isOpen: options.isOpen,
    isActiveUserTab: (id) => options.getActiveUserContentsId() === id,
    openUserTab: options.openUserTab,
    notify: (text) => {
      if (Notification.isSupported())
        new Notification({ title: '用户脚本', body: text, silent: true }).show();
    },
  });
  const prepare = (event: IpcMainEvent, payload: unknown): void => {
    try {
      event.returnValue = runtime.prepare(event, payload);
    } catch {
      event.returnValue = [];
    }
  };
  const sync = (event: IpcMainEvent, payload: unknown): void => {
    event.returnValue = runtime.sync(event, payload);
  };
  const cancel = (event: IpcMainEvent, payload: unknown): void => runtime.cancel(event, payload);
  ipcMain.on('qualified-scripts:prepare', prepare);
  ipcMain.on('qualified-scripts:sync', sync);
  ipcMain.on('qualified-scripts:cancel', cancel);
  ipcMain.handle('qualified-scripts:request', (event, payload: unknown) =>
    runtime.request(event, payload),
  );
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    runtime.dispose();
    store.dispose();
    network.dispose();
    ipcMain.removeListener('qualified-scripts:prepare', prepare);
    ipcMain.removeListener('qualified-scripts:sync', sync);
    ipcMain.removeListener('qualified-scripts:cancel', cancel);
    ipcMain.removeHandler('qualified-scripts:request');
    app.removeListener('will-quit', dispose);
    options.win.removeListener('closed', dispose);
  };
  app.once('will-quit', dispose);
  options.win.once('closed', dispose);
  return {
    store,
    runtime,
    dispose,
    async install(
      id: QualifiedScriptId,
      isCurrent: () => boolean,
      fromFile = false,
    ): Promise<QualifiedScriptResult> {
      if (disposed || !isCurrent() || options.win.isDestroyed())
        return { ok: false, message: '页面已关闭，请重新操作。' };
      const entry = getCatalogEntry(id);
      let texts: ReadonlyMap<string, string> | undefined;
      if (fromFile) {
        const selection = await dialog.showOpenDialog(options.win, {
          title: `选择“${entry.name}”本地脚本包`,
          properties: ['openFile'],
          filters: [{ name: 'AIbrowse 脚本包', extensions: ['json'] }],
        });
        if (disposed || !isCurrent() || options.win.isDestroyed())
          return { ok: false, message: '页面状态已变化，请重新操作。' };
        if (selection.canceled) return { ok: true, cancelled: true };
        if (selection.filePaths.length !== 1)
          return { ok: false, message: '请选择一个完整脚本包。' };
        try {
          texts = readQualifiedPackage(selection.filePaths[0]!, entry);
        } catch {
          return { ok: false, message: '本地脚本包校验失败，请确认选择了对应版本的完整文件。' };
        }
      }
      const confirmation = await dialog.showMessageBox(options.win, {
        type: 'warning',
        title: '安装指定用户脚本',
        message: `安装并启用“${entry.name}”？`,
        detail: [
          `版本：${entry.version}。${fromFile ? '本地脚本和依赖已通过完整性校验，安装无需联网' : '将下载并校验固定版本的脚本及依赖'}，后续不自动更新。`,
          '脚本只在匹配的普通浏览标签页运行，可以读取或修改网页，并在本机保存自己的设置。研究和监控任务页面不注入。',
          id === 'ac-baidu'
            ? 'AC-baidu 可向公网发起不携带浏览器登录信息的 GET/HEAD 请求。其官方设置网页可读取和修改 AC-baidu 配置。'
            : 'GitHub 界面汉化使用本地词库；附带的讯飞简介翻译已禁用，请使用 AI 共读翻译。',
          '网页变化可能影响 AI 共读内容；同一网站的登录和网页存储仍与现有浏览会话共享。安装后刷新匹配网页生效。',
        ].join('\n\n'),
        buttons: ['取消', '安装并启用'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return { ok: true, cancelled: true };
      if (disposed || !isCurrent()) return { ok: false, message: '页面状态已变化，请重新操作。' };
      return store.install(id, isCurrent, texts);
    },
    setEnabled(id: QualifiedScriptId, enabled: boolean): QualifiedScriptResult {
      const result = store.setEnabled(id, enabled);
      if (result.ok && !enabled) runtime.revokeScript(id);
      return result;
    },
    remove(id: QualifiedScriptId): QualifiedScriptResult {
      const result = store.remove(id);
      if (result.ok) runtime.revokeScript(id);
      return result;
    },
    showMenu(): boolean {
      if (disposed || !options.isOpen() || options.win.isDestroyed()) return false;
      const id = options.getActiveUserContentsId();
      const commands = id === null ? [] : runtime.menus(id);
      Menu.buildFromTemplate(
        commands.length === 0
          ? [{ label: '当前网页没有可用的脚本操作，请在匹配网页刷新后重试', enabled: false }]
          : commands.map((command) => ({
              label: command.label,
              click: () => {
                runtime.invokeMenu(command);
              },
            })),
      ).popup({ window: options.win });
      return true;
    },
  };
}

export type QualifiedScriptFeature = ReturnType<typeof createQualifiedScriptFeature>;
