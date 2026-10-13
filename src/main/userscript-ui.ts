import { app, dialog, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { UserScriptService } from './userscripts/service';
import { UserScriptRuntime } from './userscripts/runtime';

/** Native dialogs own file selection; the UI never supplies a path or script source. */
export function createUserScriptFeature(win: BrowserWindow, dataRoot: string) {
  const service = new UserScriptService({
    storeDirectory: join(dataRoot, 'userscripts'),
    dialogs: {
      chooseFile: async () => {
        if (win.isDestroyed()) return null;
        const result = await dialog.showOpenDialog(win, {
          title: '导入用户脚本',
          buttonLabel: '查看脚本',
          filters: [{ name: '油猴脚本（.user.js）', extensions: ['js'] }],
          properties: ['openFile'],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      confirmImport: async (script) => {
        if (win.isDestroyed()) return false;
        const sites = [...script.matches, ...script.includes].join('\n');
        const excluded = [...script.excludes, ...script.excludeGlobs].join('\n');
        const result = await dialog.showMessageBox(win, {
          type: 'warning',
          title: '安装并启用用户脚本',
          message: `安装“${script.name}”？`,
          detail: [
            `版本：${script.version || '未提供'}`,
            `适用网站：\n${sites}`,
            ...(excluded ? [`排除网站：\n${excluded}`] : []),
            `脚本能力：${script.grants.join('、') || '网页 DOM'}`,
            '脚本能够读取和修改匹配网页，也可能通过网页正常能力影响同源登录和存储状态。请仅安装你信任的脚本。',
            '在页面加载后隔离运行，不向研究或监控任务页面注入。安装后刷新网页生效。',
          ].join('\n\n'),
          buttons: ['取消', '安装并启用'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return result.response === 1 && !win.isDestroyed();
      },
    },
  });
  const runtime = new UserScriptRuntime(service);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    runtime.dispose();
    service.dispose();
    app.removeListener('will-quit', dispose);
    win.removeListener('closed', dispose);
  };
  app.once('will-quit', dispose);
  win.once('closed', dispose);
  return { service, runtime };
}
