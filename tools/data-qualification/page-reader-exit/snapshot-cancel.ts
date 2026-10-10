import { app, BrowserWindow, type WebContents } from 'electron';
import { getEventListeners } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PageReader } from '../../../src/main/browser/page-reader';

// Four fixed functional cases. No product main, Store, Provider or external network.
const root = app.getAppPath();
app.setPath('userData', join(root, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');
let current = 'startup',
  records = 0,
  origin = '';
const windows = new Set<BrowserWindow>();
const sockets = new Set<Socket>();
const held = new Map<string, ServerResponse>();
const originals: Array<{ name: string; state: string; settledAt: number | null }> = [];
function record(event: string, detail: unknown = null) {
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
function state(receipt: ReturnType<typeof observe>): string {
  return receipt.state;
}
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(test: () => boolean, ms = 2500) {
  const end = performance.now() + ms;
  while (!test()) {
    if (performance.now() >= end) throw new Error('固定场景未按期完成');
    await delay(10);
  }
}
function answer(response: ServerResponse) {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(
    '<!doctype html><html><head><title>独审受控页面</title></head><body><p>独审固定短文本</p></body></html>',
  );
}
const server = createServer((request, response) => {
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  const path = request.url ?? '';
  if (['/held-abort', '/held-destroy', '/held-release'].includes(path)) {
    if (held.has(path)) throw new Error('固定请求重复');
    held.set(path, response);
    record('held-request', { path });
    return;
  }
  if (path === '/ready') answer(response);
  else response.writeHead(404).end();
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
const events = ['did-stop-loading', 'destroyed', 'render-process-gone'] as const;
function counts(wc: WebContents) {
  return events.map((event) => wc.listenerCount(event));
}
function windowFixture() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: 'snapshot-cancel-qualification',
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
  const execute = wc.executeJavaScriptInIsolatedWorld.bind(wc);
  let dispatched = 0;
  wc.executeJavaScriptInIsolatedWorld = (...args) => {
    dispatched++;
    const raw = execute(...args);
    observe(current + '-native-' + dispatched, raw);
    record('native-dispatch', { wcId: wc.id, dispatched, loading: wc.isLoadingMainFrame() });
    return raw;
  };
  return { win, wc, dispatched: () => dispatched };
}
async function normal() {
  current = 'normal-control';
  const f = windowFixture();
  const load = observe(current + '-load', f.win.loadURL(origin + '/ready'));
  await until(() => load.state !== 'pending');
  if (load.state !== 'fulfilled') throw new Error('正常加载失败');
  const pending = new PageReader().snapshot(f.wc, 1);
  const reader = observe(current + '-reader', pending);
  await until(() => reader.state !== 'pending');
  const value = await pending;
  if (
    reader.state !== 'fulfilled' ||
    f.dispatched() !== 1 ||
    value.token === null ||
    value.snapshot.meta.degraded !== 'none' ||
    !(value.snapshot.visibleText ?? '').includes('独审固定短文本')
  )
    throw new Error('正常采集控制失败');
  record('case-pass', { dispatched: f.dispatched(), degraded: value.snapshot.meta.degraded });
  f.win.destroy();
}
async function loading(action: 'abort' | 'destroy' | 'release') {
  current = 'loading-' + action;
  const f = windowFixture();
  const path = '/held-' + action;
  const load = observe(current + '-load', f.win.loadURL(origin + path));
  await until(() => held.has(path) && f.wc.isLoadingMainFrame());
  const baseline = counts(f.wc);
  const controller = new AbortController();
  const pending = new PageReader().snapshot(f.wc, 2, controller.signal);
  const reader = observe(current + '-reader', pending);
  await delay(250);
  if (f.dispatched() !== 0 || reader.state !== 'pending' || load.state !== 'pending')
    throw new Error('固定加载中前提不成立');
  record('before-action', {
    wcId: f.wc.id,
    reader,
    load,
    dispatched: f.dispatched(),
    baseline,
    listeners: counts(f.wc),
  });
  const response = held.get(path);
  if (!response) throw new Error('固定响应丢失');
  if (action === 'abort') controller.abort();
  else if (action === 'destroy') f.win.destroy();
  else answer(response);
  await until(() => reader.state !== 'pending');
  const value = await pending;
  if (state(reader) !== 'fulfilled') throw new Error('原reader未真实完成');
  const actual = counts(f.wc);
  if (
    getEventListeners(controller.signal, 'abort').length !== 0 ||
    actual.some((count, i) => count > baseline[i]!)
  )
    throw new Error('自有监听未释放');
  if (action === 'release') {
    await until(() => load.state !== 'pending');
    if (
      state(load) !== 'fulfilled' ||
      f.dispatched() !== 1 ||
      value.token === null ||
      value.snapshot.meta.degraded !== 'none' ||
      !(value.snapshot.visibleText ?? '').includes('独审固定短文本')
    )
      throw new Error('就绪后实际采集失败');
  } else {
    if (
      f.dispatched() !== 0 ||
      value.token !== null ||
      value.snapshot.meta.degraded !== 'main-process-only'
    )
      throw new Error('取消导致迟到注入或返回绑定');
    if (action === 'abort') {
      if (f.win.isDestroyed() || !f.wc.isLoadingMainFrame() || load.state !== 'pending')
        throw new Error('取消读者错误终止共享页面加载');
      answer(response);
      await until(() => load.state !== 'pending');
      if (state(load) !== 'fulfilled') throw new Error('取消后的原页面加载失败');
      await delay(100);
      if (f.dispatched() !== 0) throw new Error('撤销的读者被后到就绪追认');
    } else {
      await until(() => load.state !== 'pending');
      response.destroy();
    }
  }
  record('case-pass', {
    dispatched: f.dispatched(),
    degraded: value.snapshot.meta.degraded,
    reader,
    load,
    baseline,
    listeners: actual,
  });
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
    if (!address || typeof address === 'string') throw new Error('loopback地址不可用');
    origin = `http://127.0.0.1:${address.port}`;
    record('started', { electron: process.versions.electron, cases: 4 });
    await normal();
    await loading('abort');
    await loading('destroy');
    await loading('release');
    if (originals.some((item) => item.state === 'pending'))
      throw new Error('本轮仍存在未结算原Promise');
    record('completed', originals);
    writeFileSync(
      join(root, 'completed.json'),
      JSON.stringify({ completed: true, cases: 4, mode: 'snapshot-cancel', originals }),
      { flag: 'wx' },
    );
    clearTimeout(watchdog);
    for (const socket of sockets) socket.destroy();
    server.close();
    app.exit(0);
  })
  .catch((error: unknown) => {
    record('unexpected-failure', {
      reason: error instanceof Error ? error.message : '未知失败',
      originals,
    });
    clearTimeout(watchdog);
    for (const win of windows) win.destroy();
    for (const socket of sockets) socket.destroy();
    server.close();
    app.exit(2);
  });
