import { app, BrowserWindow } from 'electron';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PageReader } from '../../../src/main/browser/page-reader';
import { PAGE_READER_WORLD_ID } from '../../../src/main/browser/document-binding-script';

// Isolated mechanism qualification: no application main, Stores, Provider or real profile.
const root = app.getAppPath();
app.setPath('userData', join(root, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');
let current = 'startup',
  records = 0;
const windows = new Set<BrowserWindow>();
const sockets = new Set<Socket>();
const originals: Array<{ name: string; state: string; settledAt: number | null }> = [];
function record(event: string, detail: unknown = null): void {
  if (++records > 200) throw new Error('诊断事件超限');
  appendFileSync(
    join(root, 'events.jsonl'),
    JSON.stringify({ case: current, event, detail, ms: performance.now() }) + '\n',
  );
}
function observe<T>(name: string, promise: Promise<T>) {
  const receipt = { name, state: 'pending', settledAt: null as number | null };
  originals.push(receipt);
  void promise.then(
    () => {
      receipt.state = 'fulfilled';
      receipt.settledAt = performance.now();
      record('original-settled', { ...receipt });
    },
    () => {
      receipt.state = 'rejected';
      receipt.settledAt = performance.now();
      record('original-settled', { ...receipt });
    },
  );
  return receipt;
}
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(test: () => boolean, ms = 2500): Promise<void> {
  const end = performance.now() + ms;
  while (!test()) {
    if (performance.now() >= end) throw new Error('场景前提或正常控制没有按期完成');
    await delay(10);
  }
}
let held: ServerResponse | null = null;
const server = createServer((request, response) => {
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  if (request.url === '/held') {
    held = response;
    record('held-request');
    return;
  }
  if (request.url !== '/ready' && request.url !== '/next') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(
    '<!doctype html><html><head><title>受控诊断</title></head><body><p>固定短文本</p></body></html>',
  );
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
let origin = '';
function windowFixture() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: 'page-reader-exit-qualification',
    },
  });
  windows.add(win);
  win.on('closed', () => windows.delete(win));
  const wc = win.webContents;
  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  wc.session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith(origin + '/') }),
  );
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  let injected = false;
  wc.on('console-message', (details) => {
    if (details.message === 'PAGE_READER_QUALIFICATION_INJECTED') {
      injected = true;
      record('injected');
    }
  });
  wc.on('destroyed', () => record('webcontents-destroyed'));
  wc.on('did-stop-loading', () => record('did-stop-loading'));
  const execute = wc.executeJavaScriptInIsolatedWorld.bind(wc);
  return { win, wc, execute, injected: () => injected };
}
async function normal(): Promise<void> {
  current = 'normal-real-reader';
  const f = windowFixture();
  const load = observe('normal-load', f.win.loadURL(origin + '/ready'));
  await until(() => load.state !== 'pending');
  if (load.state !== 'fulfilled') throw new Error('正常加载控制失败');
  f.wc.executeJavaScriptInIsolatedWorld = (...args) => {
    const raw = f.execute(...args);
    observe('normal-native-execute', raw);
    return raw;
  };
  const snapshot = new PageReader().snapshot(f.wc, 1);
  const reader = observe('normal-reader', snapshot);
  await until(() => reader.state !== 'pending');
  const value = await snapshot;
  if (reader.state !== 'fulfilled' || value.snapshot.meta.degraded === 'main-process-only')
    throw new Error('真实PageReader正常控制失败');
  record('control-complete', { degraded: value.snapshot.meta.degraded });
  f.win.destroy();
}
async function beforeInjection(): Promise<void> {
  current = 'loading-before-injection-destroy';
  const f = windowFixture();
  observe('held-load', f.win.loadURL(origin + '/held'));
  await until(() => held !== null && f.wc.isLoadingMainFrame());
  let rawReceipt: ReturnType<typeof observe> | null = null;
  f.wc.executeJavaScriptInIsolatedWorld = (world, scripts, userGesture) => {
    const marked = scripts.map((script) => ({
      ...script,
      code: 'console.info("PAGE_READER_QUALIFICATION_INJECTED");\n' + script.code,
    }));
    const raw = f.execute(world, marked, userGesture);
    rawReceipt = observe('held-native-execute', raw);
    return raw;
  };
  const reader = observe('held-reader', new PageReader().snapshot(f.wc, 2));
  await delay(250);
  if (f.injected() || reader.state !== 'pending' || rawReceipt === null)
    throw new Error('尚未注入的场景前提不成立');
  record('before-destroy', {
    raw: rawReceipt,
    reader,
    injected: f.injected(),
    loading: f.wc.isLoadingMainFrame(),
  });
  f.win.destroy();
  await delay(500);
  record('after-destroy-observation', { raw: rawReceipt, reader, injected: f.injected() });
  held?.destroy();
}
async function afterInjection(action: 'navigate' | 'destroy'): Promise<void> {
  current = 'injected-native-promise-' + action;
  const f = windowFixture();
  const load = observe(action + '-load', f.win.loadURL(origin + '/ready'));
  await until(() => load.state !== 'pending');
  if (load.state !== 'fulfilled') throw new Error('已注入场景加载前提失败');
  // A deliberately pending renderer Promise distinguishes post-injection API behavior.
  // This is not the product's synchronous snapshot template.
  const raw = observe(
    action + '-native-execute',
    f.execute(
      PAGE_READER_WORLD_ID,
      [{ code: 'console.info("PAGE_READER_QUALIFICATION_INJECTED");new Promise(()=>{})' }],
      false,
    ),
  );
  await until(f.injected);
  if (raw.state !== 'pending') throw new Error('已注入且未结算的场景前提失败');
  record('before-action', { raw, injected: true });
  if (action === 'destroy') f.win.destroy();
  else {
    const next = observe('next-load', f.win.loadURL(origin + '/next'));
    await until(() => next.state !== 'pending');
    if (next.state !== 'fulfilled') throw new Error('导航对照没有完成');
  }
  await delay(500);
  record('after-action-observation', { raw, action });
  if (!f.win.isDestroyed()) f.win.destroy();
}
app.on('window-all-closed', () => undefined);
const watchdog = setTimeout(() => {
  record('watchdog-expired');
  app.exit(2);
}, 15000);
void app
  .whenReady()
  .then(async () => {
    if (process.versions.electron !== '43.7.7') throw new Error('Electron版本不符');
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('受控loopback地址未取得');
    origin = `http://127.0.0.1:${address.port}`;
    record('started', { electron: process.versions.electron, cases: 4 });
    await normal();
    await beforeInjection();
    await afterInjection('navigate');
    await afterInjection('destroy');
    record('completed', originals);
    writeFileSync(
      join(root, 'completed.json'),
      JSON.stringify({ completed: true, cases: 4, originals }),
      { flag: 'wx' },
    );
    clearTimeout(watchdog);
    for (const socket of sockets) socket.destroy();
    server.close();
    app.exit(0);
  })
  .catch(() => {
    record('unexpected-failure', originals);
    clearTimeout(watchdog);
    for (const win of windows) win.destroy();
    for (const socket of sockets) socket.destroy();
    server.close();
    app.exit(2);
  });
