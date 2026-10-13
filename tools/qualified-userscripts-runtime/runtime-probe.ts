import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type {
  QualifiedPreparedScript,
  ScriptValue,
} from '../../src/shared/types/qualified-userscripts';

// Exercises the actual preload using synthetic local bytes, never downloaded scripts.
const root = process.env.AIBROWSE_QUALIFIED_PROBE_ROOT;
const preload = process.env.AIBROWSE_QUALIFIED_PRELOAD;
if (!root || !preload || !path.isAbsolute(root) || !path.isAbsolute(preload))
  throw new Error('资格探针路径无效');
app.setPath('userData', path.join(root, 'profile'));
const values: Record<string, ScriptValue> = {};
const result: {
  completed: boolean;
  passed: boolean;
  requests: number;
  prepares: number;
  writes: number;
  first: unknown;
  second: unknown;
  errors: string[];
  error: string | null;
} = {
  completed: false,
  passed: false,
  requests: 0,
  prepares: 0,
  writes: 0,
  first: null,
  second: null,
  errors: [],
  error: null,
};
let window: BrowserWindow | undefined;
let server: http.Server | undefined;
let closing = false;
let menu: { token: string; commandId: string } | undefined;
const finish = (error?: unknown): void => {
  if (closing) return;
  closing = true;
  result.completed = true;
  if (error) result.error = String(error);
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  window?.destroy();
  server?.close();
  app.exit(result.passed ? 0 : 1);
};
setTimeout(() => finish('30秒资格预算耗尽'), 30000).unref();
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
ipcMain.on('qualified-scripts:prepare', (event) => {
  result.prepares++;
  const prepared: QualifiedPreparedScript = {
    id: 'ac-baidu',
    token: `synthetic-document-${result.prepares}`,
    worldId: 20001,
    name: '本地合成资格脚本',
    version: '1',
    runAt: 'document-start',
    requires: ["var privateDependency = 'shared-dependency';"],
    resources: { style: 'fixture-resource' },
    values: { ...values },
    source: `document.addEventListener('first-inline', () => {
      document.documentElement.dataset.qualified = privateDependency + ':' + GM_getResourceText('style') + ':' + String(GM_getValue('saved', false));
    }, {once:true});
    GM_registerMenuCommand('写后刷新', () => { GM_setValue('saved', true); location.reload(); });`,
  };
  event.returnValue = [prepared];
});
ipcMain.on('qualified-scripts:sync', (event, input: unknown) => {
  if (!input || typeof input !== 'object') {
    event.returnValue = { ok: false };
    return;
  }
  const data = input as Record<string, unknown>;
  if (
    data.op === 'register-menu' &&
    typeof data.commandId === 'string' &&
    typeof data.token === 'string'
  ) {
    menu = { token: data.token, commandId: data.commandId };
  } else if (data.op === 'set-value' && data.key === 'saved' && data.value === true) {
    // A disk write is deliberately completed before the synchronous response.
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ saved: true }));
    values.saved = true;
    result.writes++;
  } else {
    event.returnValue = { ok: false };
    return;
  }
  event.returnValue = { ok: true };
});
void app
  .whenReady()
  .then(async () => {
    const localServer = http.createServer((_request, response) => {
      if (++result.requests > 3) {
        finish('本地请求超过3');
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        '<!doctype html><html><head><script>document.dispatchEvent(new Event("first-inline"));window.observed={qualified:document.documentElement.dataset.qualified||null,ready:document.readyState,require:typeof require,bridge:typeof window.__qualifiedHost,gm:typeof window.GM};</script><link rel="icon" href="data:,"></head><body>合成测试</body></html>',
      );
    });
    server = localServer;
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address();
    if (!address || typeof address === 'string') throw new Error('本地服务器失败');
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    window = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('console-message', (details) => {
      if (details.level === 'error') result.errors.push(details.message.slice(0, 500));
    });
    await win.loadURL(`http://127.0.0.1:${address.port}/`);
    result.first = await win.webContents.executeJavaScript('window.observed');
    if (!menu) throw new Error('脚本菜单没有注册，preload启动失败');
    const loaded = new Promise<void>((resolve) =>
      win.webContents.once('did-finish-load', () => resolve()),
    );
    win.webContents.send('qualified-scripts:event', { ...menu, kind: 'menu' });
    await loaded;
    result.second = await win.webContents.executeJavaScript('window.observed');
    const first = result.first as Record<string, unknown>;
    const second = result.second as Record<string, unknown>;
    result.passed =
      first.qualified === 'shared-dependency:fixture-resource:false' &&
      second.qualified === 'shared-dependency:fixture-resource:true' &&
      first.ready === 'loading' &&
      first.require === 'undefined' &&
      first.bridge === 'undefined' &&
      first.gm === 'undefined' &&
      result.writes === 1 &&
      result.errors.length === 0;
    finish();
  })
  .catch(finish);
