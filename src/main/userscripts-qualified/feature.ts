import { app, ipcMain, Menu, Notification, type BrowserWindow, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import type {
  QualifiedScriptId,
  QualifiedScriptResult,
} from '../../shared/types/qualified-userscripts';
import { QualifiedScriptStore } from './store';
import { QualifiedScriptNetwork } from './network';
import { QualifiedScriptRuntime } from './runtime';
import { getCatalogEntry } from './catalog';
import { readBuiltInQualifiedPackage } from './package';

const BUILT_IN_PACKAGE_NAMES = {
  'ac-baidu': 'ac-baidu.json',
  'github-zh': 'github-zh.json',
} as const satisfies Record<QualifiedScriptId, string>;

export function createQualifiedScriptFeature(options: {
  win: BrowserWindow;
  dataRoot: string;
  isOpen: () => boolean;
  canInitialize?: () => boolean;
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
  const builtInTexts = new Map<QualifiedScriptId, ReadonlyMap<string, string>>();
  const ready = (async (): Promise<void> => {
    for (const id of Object.keys(BUILT_IN_PACKAGE_NAMES) as QualifiedScriptId[]) {
      if (disposed) return;
      const entry = getCatalogEntry(id);
      let texts: ReadonlyMap<string, string>;
      try {
        texts = readBuiltInQualifiedPackage(
          join(app.getAppPath(), 'resources', 'qualified-userscripts', BUILT_IN_PACKAGE_NAMES[id]),
          entry,
        );
      } catch {
        store.setBuiltInIssue(id, '内置脚本资源缺失、损坏或与固定版本不一致；本次运行已安全停用。');
        continue;
      }
      builtInTexts.set(id, texts);
      store.setBuiltInIssue(id, null);
      const status = store.list().find((item) => item.id === id);
      const restoreMissing = store.canRestoreMissingBuiltIn(id);
      if (status?.installed || (status?.issue !== null && !restoreMissing)) continue;
      const result = await store.install(
        id,
        () => !disposed && (options.canInitialize?.() ?? options.isOpen()),
        texts,
        restoreMissing,
      );
      if (!result.ok)
        store.setBuiltInIssue(id, `内置脚本初始化失败；本次运行已安全停用：${result.message}`);
    }
  })();

  const setEnabled = async (
    id: QualifiedScriptId,
    enabled: boolean,
    isCurrent: () => boolean = () => true,
  ): Promise<QualifiedScriptResult> => {
    await ready;
    const active = (): boolean =>
      !disposed && !options.win.isDestroyed() && options.isOpen() && isCurrent();
    if (!active()) return { ok: false, message: '页面状态已变化，请重新操作。' };
    let status = store.list().find((item) => item.id === id);
    if (enabled && status?.installed !== true && status?.issue === null) {
      const texts = builtInTexts.get(id);
      if (texts === undefined)
        return { ok: false, message: '内置脚本资源当前不可用，已保持停用。' };
      const installed = await store.install(id, active, texts);
      if (!installed.ok || installed.cancelled) return installed;
      status = store.list().find((item) => item.id === id);
    }
    if (!active()) return { ok: false, message: '页面状态已变化，请重新操作。' };
    if (enabled && status?.installed !== true)
      return { ok: false, message: status?.issue ?? '内置脚本当前不可用，已保持停用。' };
    const result = store.setEnabled(id, enabled);
    if (result.ok && !enabled) runtime.revokeScript(id);
    return result;
  };

  return {
    store,
    runtime,
    ready,
    dispose,
    async install(
      id: QualifiedScriptId,
      isCurrent: () => boolean,
      fromFile = false,
    ): Promise<QualifiedScriptResult> {
      void fromFile;
      if (!isCurrent() || options.win.isDestroyed())
        return { ok: false, message: '页面已关闭，请重新操作。' };
      return setEnabled(id, true, isCurrent);
    },
    setEnabled,
    remove(id: QualifiedScriptId): QualifiedScriptResult {
      const result = store.setEnabled(id, false);
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
