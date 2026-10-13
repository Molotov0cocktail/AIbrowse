import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

// Bounded native timing probe. No third-party userscript is evaluated.
const root = process.env.AIBROWSE_QUALIFIED_PROBE_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('需要独立绝对路径探针目录');
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', path.join(root, 'profile'));
interface Observation {
  before: string | null;
  hadRoot: string | null;
  atInline: string;
  hasRequire: string;
  hasElectron: string;
}
const result: {
  completed: boolean;
  passed: boolean;
  requests: number;
  observed: Observation | null;
  error: string | null;
} = {
  completed: false,
  passed: false,
  requests: 0,
  observed: null,
  error: null,
};
let window: BrowserWindow | undefined;
let server: http.Server | undefined;
let closing = false;
const finish = (error?: unknown): void => {
  if (closing) return;
  closing = true;
  if (error) result.error = String(error);
  result.completed = true;
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  if (window && !window.isDestroyed()) window.destroy();
  server?.close();
  app.exit(result.passed ? 0 : 1);
};
setTimeout(() => finish('30秒资格预算耗尽'), 30000).unref();
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
const preload = path.join(root, 'preload.cjs');
fs.writeFileSync(
  preload,
  `const { webFrame } = require('electron');
webFrame.executeJavaScriptInIsolatedWorld(2400, [{code: 'const startedAt = document.readyState; const hadRoot = !!document.documentElement; document.addEventListener("qualified-probe-first-inline", () => { document.documentElement.dataset.qualifiedBeforeInline = startedAt; document.documentElement.dataset.qualifiedHadRoot = String(hadRoot); }, {once:true});'}], false);
`,
);
void app
  .whenReady()
  .then(async () => {
    const localServer = http.createServer((_request, response) => {
      result.requests++;
      if (result.requests > 3) {
        finish('本地请求预算超过3');
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        '<!doctype html><html><head><script>document.dispatchEvent(new Event("qualified-probe-first-inline"));window.probeResult={before:document.documentElement.dataset.qualifiedBeforeInline||null,hadRoot:document.documentElement.dataset.qualifiedHadRoot||null,atInline:document.readyState,hasRequire:typeof require,hasElectron:typeof window.electron};</script></head><body>资格探针</body></html>',
      );
    });
    server = localServer;
    await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
    const address = localServer.address();
    if (!address || typeof address === 'string') throw new Error('本地探针监听失败');
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await window.loadURL(`http://127.0.0.1:${address.port}/`);
    result.observed = (await window.webContents.executeJavaScript(
      'window.probeResult',
    )) as Observation;
    result.passed =
      result.observed?.before === 'loading' &&
      result.observed?.atInline === 'loading' &&
      result.observed?.hasRequire === 'undefined' &&
      result.observed?.hasElectron === 'undefined';
    finish();
  })
  .catch(finish);
