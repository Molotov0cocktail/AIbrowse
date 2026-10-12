import { app, BaseWindow, session, webContents } from 'electron';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserControllerImpl } from '../../src/main/browser/browser-controller';
import { ConversationServiceImpl } from '../../src/main/ai/conversation-service';
import { ConversationStore } from '../../src/main/ai/conversation-store';
import { ConfigStore } from '../../src/main/ai/config-store';
import type { SecureCredentialStore } from '../../src/main/ai/credential-store';

// Diagnostic only: real product classes and synchronous snapshot template, synthetic profile.
const root = app.getAppPath();
app.setPath('userData', join(root, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-http-cache');
const credentials: SecureCredentialStore = {
  isAvailable: () => true,
  has: async () => false,
  get: async () => null,
  set: async () => false,
  delete: async () => false,
};
type Receipt = { name: string; state: 'pending' | 'fulfilled' | 'rejected'; at: number | null };
const originals: Receipt[] = [];
let current = 'startup';
let records = 0;
let origin = '';
const windows = new Set<BaseWindow>();
const sockets = new Set<Socket>();
const held = new Map<string, ServerResponse>();
function record(event: string, detail: unknown = null): void {
  if (++records > 600) throw new Error('诊断事件预算耗尽');
  appendFileSync(
    join(root, 'events.jsonl'),
    JSON.stringify({ case: current, event, detail, ms: performance.now() }) + '\n',
  );
}
function observe<T>(name: string, promise: Promise<T>): Receipt {
  const receipt: Receipt = { name: current + ':' + name, state: 'pending', at: null };
  originals.push(receipt);
  void promise.then(
    () => {
      receipt.state = 'fulfilled';
      receipt.at = performance.now();
      record('settled', { ...receipt });
    },
    () => {
      receipt.state = 'rejected';
      receipt.at = performance.now();
      record('settled', { ...receipt });
    },
  );
  return receipt;
}
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(test: () => boolean): Promise<void> {
  const end = performance.now() + 2500;
  while (!test()) {
    if (performance.now() >= end) throw new Error('场景前提超时');
    await delay(5);
  }
}
function answer(response: ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end('<!doctype html><title>合成退出诊断</title><p>固定短正文</p>');
}
const server = createServer((request, response) => {
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  if (request.url === '/held') {
    held.set(current, response);
    record('held-request');
    return;
  }
  answer(response);
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
const cases = [
  'normal',
  'loading-abort',
  'dispatch-close',
  'dispatch-immediate-close',
  'dispatch-navigate',
  'settled-close',
] as const;
async function runCase(kind: (typeof cases)[number]): Promise<void> {
  current = kind;
  const win = new BaseWindow({ show: false });
  windows.add(win);
  win.on('closed', () => windows.delete(win));
  const partition = session.fromPartition('shutdown-diagnostic-' + kind);
  partition.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  partition.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: details.url !== 'about:blank' && !details.url.startsWith(origin + '/') }),
  );
  const controller = new BrowserControllerImpl({
    ownerWindow: win,
    sessionManager: { getSession: () => partition },
    getFallbackBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  });
  await controller.createTab();
  const tab = await controller.createTab(origin + (kind === 'loading-abort' ? '/held' : '/ready'));
  const wcId = controller.getOwnedWebContentsId(tab.id);
  const wc = wcId === null ? undefined : webContents.fromId(wcId);
  if (!wc) throw new Error('精确Tab实体缺失');
  let generation = 0;
  const wcEvent = (event: string): void => {
    if (event === 'did-navigate') generation++;
    record('wc-event', { wcId, event, generation, destroyed: wc.isDestroyed() });
  };
  wc.on('did-start-navigation', () => wcEvent('did-start-navigation'));
  wc.on('did-navigate', () => wcEvent('did-navigate'));
  wc.on('did-stop-loading', () => wcEvent('did-stop-loading'));
  wc.on('destroyed', () => wcEvent('destroyed'));
  wc.on('render-process-gone', () => wcEvent('render-process-gone'));
  if (kind === 'loading-abort') await until(() => held.has(kind) && wc.isLoadingMainFrame());
  else await until(() => !wc.isLoadingMainFrame() && wc.getURL() !== '');
  const scope = join(root, kind);
  mkdirSync(scope);
  const service = new ConversationServiceImpl({
    store: new ConversationStore(scope),
    configStore: new ConfigStore(scope, credentials),
    credentials,
    browser: {
      getActiveTab: () => controller.getActiveTab(),
      getPageSnapshot: (tabId, signal) => {
        record('snapshot-request', { tabId, wcId, generation });
        signal?.addEventListener('abort', () => record('snapshot-abort', { tabId, wcId }), {
          once: true,
        });
        const promise = controller.getPageSnapshot(tabId, signal);
        observe('controller', promise);
        return promise;
      },
    },
  });
  let dispatches = 0;
  const execute = wc.executeJavaScriptInIsolatedWorld.bind(wc);
  wc.executeJavaScriptInIsolatedWorld = (...args) => {
    dispatches++;
    record('native-dispatch', {
      tabId: tab.id,
      wcId,
      generation,
      dispatches,
      loading: wc.isLoadingMainFrame(),
      destroyed: wc.isDestroyed(),
    });
    const raw = execute(...args);
    observe('native-' + dispatches, raw);
    if (dispatches === 1 && kind === 'dispatch-close')
      observe('close', controller.closeTab(tab.id));
    if (dispatches === 1 && kind === 'dispatch-immediate-close')
      setImmediate(() => observe('close', controller.closeTab(tab.id)));
    if (dispatches === 1 && kind === 'dispatch-navigate')
      observe('navigate', controller.navigate(tab.id, origin + '/next'));
    return raw;
  };
  const preview = observe('preview', service.previewContext());
  if (kind === 'loading-abort') {
    await delay(50);
    service.beginShutdown();
    observe('early-drain', service.drainBeforeClose());
    await until(() => preview.state !== 'pending');
    if (dispatches !== 0 || preview.state !== 'rejected')
      throw new Error('加载取消对照没有在原页面继续加载时完成');
    held.get(kind)?.destroy();
  } else if (kind === 'normal' || kind === 'settled-close') {
    await until(() => preview.state !== 'pending');
    if (preview.state !== 'fulfilled') throw new Error('正常快照控制失败');
    if (kind === 'settled-close') await controller.closeTab(tab.id);
  } else await until(() => dispatches > 0);
  await delay(500);
  service.beginShutdown();
  const drain = observe('drain', service.drainBeforeClose());
  await delay(200);
  record('case-observation', {
    tabId: tab.id,
    wcId,
    generation,
    dispatches,
    preview,
    drain,
    pending: service.getPendingOperationCounts(),
    originals: originals.filter((receipt) => receipt.name.startsWith(kind + ':')),
  });
  controller.dispose();
  win.destroy();
}
app.on('window-all-closed', () => undefined);
const watchdog = setTimeout(() => {
  record('watchdog');
  app.exit(2);
}, 20000);
void app
  .whenReady()
  .then(async () => {
    if (process.versions.electron !== '43.7.7') throw new Error('Electron版本不符');
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('夹具地址缺失');
    origin = `http://127.0.0.1:${address.port}`;
    for (const kind of cases) await runCase(kind);
    record('completed', originals);
    writeFileSync(
      join(root, 'completed.json'),
      JSON.stringify({
        completed: true,
        cases: cases.length,
        originals,
        interpretation: '工具完成，不授未结原Promise或产品退出通过',
      }),
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
