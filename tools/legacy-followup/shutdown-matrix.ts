import { app, BaseWindow, dialog, session, webContents } from 'electron';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserControllerImpl } from '../../src/main/browser/browser-controller';
import { ConversationServiceImpl } from '../../src/main/ai/conversation-service';
import { ConversationStore } from '../../src/main/ai/conversation-store';
import { ConfigStore } from '../../src/main/ai/config-store';
import type { SecureCredentialStore } from '../../src/main/ai/credential-store';
import { RuntimeShutdown } from '../../src/main/storage/runtime-shutdown';
import { NormalQuitCoordinator, snapshotQuitMessage } from '../../src/main/storage/normal-quit';
import { runResearchCapture } from './research-capture';

// Real Electron transports and product lifecycle classes; isolated synthetic data only.
const root = app.getAppPath();
app.setPath('userData', join(root, 'profile'));
app.setPath('sessionData', join(root, 'profile'));
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
const reports: unknown[] = [];
let releaseFinalQuit!: () => void;
const finalQuitReady = new Promise<void>((done) => {
  releaseFinalQuit = done;
});
let current = 'startup';
let records = 0;
let origin = '';
const sockets = new Set<Socket>();
const held = new Map<string, ServerResponse>();
function record(event: string, detail: unknown = null): void {
  if (++records > 800) throw new Error('验收事件预算耗尽');
  appendFileSync(
    join(root, 'events.jsonl'),
    JSON.stringify({ case: current, event, detail, ms: performance.now() }) + '\n',
  );
}
function check(value: boolean, message: string): void {
  if (!value) throw new Error(message);
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
async function until(test: () => boolean, budget = 3000): Promise<void> {
  const end = performance.now() + budget;
  while (!test()) {
    if (performance.now() >= end) throw new Error('场景前提或结算超时');
    await delay(5);
  }
}
const server = createServer((request, response) => {
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  if (request.url === '/held') {
    held.set(current, response);
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(
    '<!doctype html><title>合成退出验收</title><p>固定短正文用于退出与研究捕获验证。</p>',
  );
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
const cases = [
  'dispatch-close',
  'dispatch-immediate-close',
  'live-approved',
  'normal',
  'settled-close',
  'loading-abort',
  'writer-gate',
  'native-dialog',
] as const;

async function researchCapture(): Promise<void> {
  current = 'research-goal-capture';
  const win = new BaseWindow({ show: false });
  const partition = session.fromPartition('shutdown-followup-research');
  partition.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  partition.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: details.url !== 'about:blank' && !details.url.startsWith(origin + '/') }),
  );
  const controller = new BrowserControllerImpl({
    ownerWindow: win,
    sessionManager: { getSession: () => partition },
    getFallbackBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  });
  try {
    await controller.createTab();
    const result = await runResearchCapture(controller, origin, root);
    record('research-capture', result);
    check(result.passed, '目标网址真实研究捕获验收失败');
    reports.push({ kind: current, ...result });
  } finally {
    controller.dispose();
    win.destroy();
  }
}

async function runCase(kind: (typeof cases)[number]): Promise<void> {
  current = kind;
  const win = new BaseWindow({ show: false });
  const partition = session.fromPartition('shutdown-followup-' + kind);
  partition.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  partition.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: details.url !== 'about:blank' && !details.url.startsWith(origin + '/') }),
  );
  const controller = new BrowserControllerImpl({
    ownerWindow: win,
    sessionManager: { getSession: () => partition },
    getFallbackBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  });
  const spare = await controller.createTab();
  const tab = await controller.createTab(origin + (kind === 'loading-abort' ? '/held' : '/ready'));
  const wcId = controller.getOwnedWebContentsId(tab.id);
  const wc = wcId === null ? undefined : webContents.fromId(wcId);
  if (!wc) throw new Error('精确Tab实体缺失');
  let destroyed = false;
  wc.on('destroyed', () => {
    destroyed = true;
    record('exact-destroyed', { wcId });
  });
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
    // The alive-target cases deliberately return a never-settling renderer promise.
    // Race cases keep the exact production synchronous snapshot script unchanged.
    if (kind === 'live-approved' || kind === 'writer-gate' || kind === 'native-dialog')
      args[1] = [{ code: 'new Promise(() => {})' }];
    const raw = execute(...args);
    observe('native-' + dispatches, raw);
    record('native-dispatch', {
      wcId,
      dispatches,
      controlledRendererPromise:
        kind === 'live-approved' || kind === 'writer-gate' || kind === 'native-dialog',
    });
    if (dispatches === 1 && kind === 'dispatch-close')
      observe('close', controller.closeTab(tab.id));
    if (dispatches === 1 && kind === 'dispatch-immediate-close')
      setImmediate(() => observe('close', controller.closeTab(tab.id)));
    return raw;
  };
  const preview = observe('preview', service.previewContext());
  if (kind === 'normal' || kind === 'settled-close') {
    await until(() => preview.state !== 'pending');
    check(preview.state === 'fulfilled', '自然快照控制未完成');
    if (kind === 'settled-close') await controller.closeTab(tab.id);
  } else if (kind === 'loading-abort') await delay(50);
  else await until(() => dispatches === 1);
  let releaseWrite!: () => void;
  const write = new Promise<void>((done) => {
    releaseWrite = done;
  });
  let closed = false;
  let finished = false;
  let failed = false;
  let promptCount = 0;
  let responseCount = 0;
  const runtime = new RuntimeShutdown({
    roots: [],
    producers: [
      service,
      ...(kind === 'writer-gate'
        ? [{ beginShutdown: () => undefined, drainBeforeClose: () => write }]
        : []),
    ],
    waitForUsage: async () => undefined,
    cleanupWorkspace: async () => ({ ok: true, retainedCount: 0 }),
    closeResources: () => {
      closed = true;
      record('resources-closed');
    },
  });
  const coordinator = new NormalQuitCoordinator({
    closeSnapshotAdmission: () => controller.beginSnapshotShutdown(),
    pendingSnapshots: () => controller.getPendingSnapshotCount(),
    askToStop: async (count, signal) => {
      const index = promptCount++;
      if (kind !== 'native-dialog') return 'wait';
      writeFileSync(join(root, `dialog-request-${index}.txt`), '合成原生按钮测试请求', {
        flag: 'wx',
      });
      const result = await dialog.showMessageBox(snapshotQuitMessage(count, signal));
      responseCount++;
      record('native-dialog-response', {
        index,
        response: result.response,
        selection: '精确PID原生按钮自动选择，非用户手点',
      });
      return result.response === 0 ? 'stop' : 'wait';
    },
    stopSnapshots: () => controller.stopSnapshotsForShutdown(),
    shutdown: () => runtime.shutdown(),
    finish: async () => {
      finished = true;
      record('coordinator-finished');
      if (kind === 'native-dialog') {
        await finalQuitReady;
        app.quit();
      }
    },
    isFailureActive: () => failed,
    reportFailure: () => {
      failed = true;
    },
  });
  coordinator.request();
  const drain = observe('runtime-drain', runtime.shutdown());
  await delay(250);
  const before = {
    preview: { ...preview },
    drain: { ...drain },
    pendingSnapshots: controller.getPendingSnapshotCount(),
    native: originals
      .filter((item) => item.name.startsWith(kind + ':native'))
      .map((item) => ({ ...item })),
    destroyed,
    closed,
  };
  record('before-approval', before);
  if (kind === 'normal' || kind === 'settled-close' || kind === 'loading-abort') {
    await until(() => finished);
    if (kind === 'loading-abort') {
      check(dispatches === 0 && preview.state === 'rejected', '准备阶段取消发生了注入或未终止');
      held.get(kind)?.destroy();
    }
    if (kind === 'normal') check(!destroyed, '自然结束多余销毁了目标页面');
  } else {
    check(
      preview.state === 'pending' &&
        drain.state === 'pending' &&
        !closed &&
        controller.getPendingSnapshotCount() === 1,
      '未批准前已提前退休或竞态本场未复现',
    );
    check(
      before.native.length === 1 && before.native[0]?.state === 'pending',
      '原生传输没有保持待定',
    );
    if (kind === 'native-dialog') {
      await until(() => responseCount === 1);
      check(!destroyed && preview.state === 'pending' && !closed, '原生继续等待错误授权取消');
      coordinator.request();
      await until(() => promptCount === 2);
    } else await controller.stopSnapshotsForShutdown();
    await until(() => controller.getPendingSnapshotCount() === 0 && preview.state !== 'pending');
    check(destroyed, '快照取消没有精确实体销毁证据');
    if (kind === 'writer-gate') {
      await delay(100);
      check(!closed && !finished && drain.state === 'pending', '其它写入尚未结束时提前关闭');
      record('writer-still-pending', runtime.getPending());
      releaseWrite();
    }
    await until(() => finished);
    check(preview.state === 'rejected', '批准取消的预览未拒绝');
  }
  check(!failed && closed && runtime.getPhase() === 'closed', '正常关闭状态不符');
  check(controller.getOwnedWebContentsId(spare.id) !== null, '无关页面被销毁');
  const result = {
    kind,
    passed: true,
    before,
    after: {
      preview,
      drain,
      destroyed,
      pendingSnapshots: controller.getPendingSnapshotCount(),
      pendingConversations: service.getPendingOperationCounts(),
      native: originals
        .filter((item) => item.name.startsWith(kind + ':native'))
        .map((item) => ({ ...item })),
      promptCount,
      finished,
      closed,
    },
  };
  reports.push(result);
  record('case-passed', result);
  controller.dispose();
  win.destroy();
}
app.on('window-all-closed', () => undefined);
app.on('will-quit', () => record('will-quit'));
app.on('quit', (_event, code) => record('quit', { code }));
void app
  .whenReady()
  .then(async () => {
    check(process.versions.electron === '43.7.7', 'Electron版本不符');
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('夹具地址缺失');
    origin = `http://127.0.0.1:${address.port}`;
    await researchCapture();
    for (const kind of cases) await runCase(kind);
    writeFileSync(
      join(root, 'completed.json'),
      JSON.stringify(
        {
          completed: true,
          cases: reports,
          originals,
          interpretation:
            '产品生命周期类与真实Electron聚焦验收；原生Promise如仍pending不称已结算；不替代完整index/guardian生产退出验收',
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    releaseFinalQuit();
  })
  .catch((error: unknown) => {
    record('failed', { message: error instanceof Error ? error.message : '未知失败' });
    writeFileSync(
      join(root, 'failed.json'),
      JSON.stringify({ completed: false, reports, originals }),
      { flag: 'wx' },
    );
    process.exitCode = 1;
    // The external bounded Job closes failures; this path never masquerades as normal quit.
  });
