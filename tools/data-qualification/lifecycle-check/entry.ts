import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
} from 'electron';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PageSnapshot, TabInfo } from '../../../src/shared/types/browser';
import { IPC } from '../../../src/shared/types/ipc';

const scope = dirname(__dirname);
const phase = process.argv[2];
if (
  !/^lifecycle-check-[a-f0-9]{32}$/u.test(scope.split(/[\\/]/u).at(-1) ?? '') ||
  !['exercise', 'main-fault', 'cold'].includes(phase ?? '')
)
  throw new Error('固定故障入口无效');
const control = JSON.parse(readFileSync(join(scope, `${phase}-control.json`), 'utf8')) as {
  deadline: number;
};
const deadline = performance.now() + (control.deadline - Date.now());
const started = performance.now();
const uiUrl = pathToFileURL(join(__dirname, 'out/renderer/index.html')).href;
const profile = join(scope, 'profile');
let window: BrowserWindow | null = null;
let loadCount = 0;
const events: Array<{ action: string; elapsedMs: number }> = [];
const canary = 'S7-网页正文-密码-cookie-路径-CANARY-秘密';
let diagnosticSaveCalls = 0;
let lastCommitFrame: import('electron').WebFrameMain | null = null;
const observations: Array<Record<string, string | number | boolean | null>> = [];
function observe(
  kind: string,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  check();
  need(observations.length < 128, '窄握手观察上限');
  observations.push({ kind, elapsedMs: Math.round(performance.now() - started), ...fields });
}
const registerHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener): void => {
  if (channel !== IPC.UiDocumentOpen) return registerHandle(channel, listener);
  registerHandle(channel, (event, ...args: unknown[]) => {
    const result: unknown = listener(event, ...args);
    const nativeFields: Record<string, boolean> = { fieldReadFailed: false };
    try {
      nativeFields.frameDetached = event.senderFrame?.detached ?? true;
      nativeFields.frameUrlIsEntry = event.senderFrame?.url === uiUrl;
      nativeFields.senderIsMain = event.sender === window?.webContents;
      nativeFields.contentsUrlIsEntry = window?.webContents.getURL() === uiUrl;
    } catch {
      nativeFields.fieldReadFailed = true;
    }
    observe('document-open', {
      sameCurrentFrame: event.senderFrame === window?.webContents.mainFrame,
      sameCommitFrame: event.senderFrame === lastCommitFrame,
      returnedToken: typeof result === 'string',
      returnedNull: result === null,
      ...nativeFields,
    });
    return result;
  });
};
dialog.showSaveDialog = async (
  first: BrowserWindow | SaveDialogOptions,
  options?: SaveDialogOptions,
): Promise<SaveDialogReturnValue> => {
  need(phase === 'exercise' && first === owner() && options?.title === '导出诊断信息');
  need(options.defaultPath === 'aibrowse-diagnostic.json' && diagnosticSaveCalls < 2);
  diagnosticSaveCalls += 1;
  return { canceled: diagnosticSaveCalls === 1, filePath: join(scope, 'diagnostic-export.json') };
};
const server = createServer((request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(
    `<!doctype html><title>固定${request.url === '/a' ? 'A' : 'B'}页</title><h1>${request.url === '/a' ? 'A' : 'B'}-生命周期</h1><button>固定动作</button><input value="${canary}"><p>${canary}</p>`,
  );
});
function need(value: unknown, message = '真实生命周期条件不成立'): asserts value {
  if (!value) throw new Error(message);
}
function check(): void {
  need(performance.now() < deadline, '固定故障场期限已过');
}
function event(action: string): void {
  check();
  need(events.length < 64);
  events.push({ action, elapsedMs: Math.round(performance.now() - started) });
}
function writeNew(name: string, value: unknown): void {
  writeFileSync(join(scope, name), JSON.stringify(value), { flag: 'wx' });
}
function owner(): BrowserWindow {
  check();
  need(window !== null && !window.isDestroyed() && !window.webContents.isDestroyed());
  need(window.webContents.getURL() === uiUrl, '唯一可信主文档不匹配');
  return window;
}
async function evaluate(source: string): Promise<unknown> {
  const win = owner();
  const result: unknown = await win.webContents.executeJavaScript(source);
  need(owner() === win);
  return result;
}
async function wait(work: () => Promise<boolean>, message: string): Promise<void> {
  const end = Math.min(deadline, performance.now() + 30_000);
  while (performance.now() < end) {
    if (await work()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
function ledger(): { session: string; main: { pid: number } | null; utility: unknown } {
  const value = JSON.parse(
    readFileSync(join(profile, 'lifecycle-guardian/writers.json'), 'utf8'),
  ) as { session: string; main: { pid: number } | null; utility: unknown };
  need(value.main?.pid === process.pid && /^[a-f0-9]{32}$/u.test(value.session));
  return value;
}
async function tabs(): Promise<TabInfo[]> {
  return (await evaluate('window.aibrowse.tabs.list()')) as TabInfo[];
}
async function snapshot(id: string): Promise<PageSnapshot> {
  const value = (await evaluate(
    `window.aibrowse.page.snapshot(${JSON.stringify(id)})`,
  )) as PageSnapshot | null;
  need(value !== null);
  return value;
}
async function complete(): Promise<void> {
  const value = ledger();
  writeNew(`${phase}-complete.json`, {
    phase,
    pid: process.pid,
    session: value.session,
    events,
    loadCount,
    observations,
  });
  server.close();
  owner().close();
}
async function run(): Promise<void> {
  await wait(async () => {
    const value = (await evaluate('window.aibrowse.getConversationStorageStatus()')) as {
      state: string;
    };
    if (value.state !== 'ready' || (await tabs()).length === 0) return false;
    const state = (await evaluate('window.aibrowse.dataTransfer.getStatus()')) as {
      availableActions: string[];
    };
    return state.availableActions.includes('backup');
  }, '普通服务图未开放');
  ledger();
  event('ordinary-graph-ready');
  const list = await evaluate('window.aibrowse.sources.list({page:0,pageSize:20})');
  need(JSON.stringify(list).includes('恢复夹具A'), '固定持久数据未读回');
  if (phase === 'main-fault') {
    writeNew('fault-injected.json', {
      phase,
      pid: process.pid,
      at: Date.now(),
      elapsedMs: performance.now() - started,
      session: ledger().session,
    });
    server.close();
    process.emit('uncaughtException', new Error('固定合成main故障'));
    return;
  }
  if (phase === 'cold') {
    event('cold-persistent-read');
    await complete();
    return;
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  need(address !== null && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const a = (await evaluate(
    `window.aibrowse.tabs.create(${JSON.stringify(`${base}/a`)})`,
  )) as TabInfo | null;
  const b = (await evaluate(
    `window.aibrowse.tabs.create(${JSON.stringify(`${base}/b`)})`,
  )) as TabInfo | null;
  need(a && b && a.id !== b.id);
  await wait(async () => {
    const selected = (await tabs()).filter((tab) => [a.id, b.id].includes(tab.id));
    return selected.length === 2 && selected.every((tab) => tab.state === 'ready');
  }, '固定页面未ready');
  const beforeA = await snapshot(a.id),
    beforeB = await snapshot(b.id);
  need(beforeA.visibleText?.includes('A-生命周期') && beforeB.visibleText?.includes('B-生命周期'));
  const view = owner().contentView.children.find(
    (child) =>
      'webContents' in child &&
      (child as import('electron').WebContentsView).webContents.getURL() === `${base}/a`,
  ) as import('electron').WebContentsView | undefined;
  need(view);
  view.webContents.forcefullyCrashRenderer();
  event('web-renderer-crashed');
  await wait(
    async () => (await tabs()).find((tab) => tab.id === a.id)?.failure === 'renderer-gone',
    '网页崩溃未投影',
  );
  const afterB = await snapshot(b.id);
  need(
    afterB.meta.documentId === beforeB.meta.documentId &&
      afterB.visibleText?.includes('B-生命周期'),
    '另一Tab世代或内容误用',
  );
  need((await snapshot(a.id)).meta.documentId !== beforeA.meta.documentId, '旧崩溃文档仍被采信');
  need(await evaluate(`window.aibrowse.nav.reload(${JSON.stringify(a.id)})`));
  await wait(
    async () => (await tabs()).find((tab) => tab.id === a.id)?.state === 'ready',
    '崩溃Tab重载未恢复',
  );
  const reloadedA = await snapshot(a.id);
  need(
    reloadedA.meta.documentId > beforeA.meta.documentId &&
      reloadedA.visibleText?.includes('A-生命周期'),
  );
  event('web-only-reload-complete');
  const ids = (await tabs()).map((tab) => tab.id).sort();
  const oldPreview = (await evaluate('window.aibrowse.diagnostics.preview()')) as {
    ok: boolean;
    preview?: { sequence: number; digest: string };
  };
  need(oldPreview.ok && oldPreview.preview);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const win = owner();
    const oldProcess = win.webContents.getOSProcessId();
    const priorLoads = loadCount;
    win.webContents.forcefullyCrashRenderer();
    event(`main-ui-crashed-${attempt}`);
    await wait(async () => {
      if (
        loadCount <= priorLoads ||
        win.webContents.isDestroyed() ||
        win.webContents.getURL() !== uiUrl
      )
        return false;
      try {
        return (
          (await tabs())
            .map((tab) => tab.id)
            .sort()
            .join('|') === ids.join('|')
        );
      } catch {
        if (!observations.some((item) => item.kind === `bridge-read-${attempt}`)) {
          const status = await evaluate(
            `(() => ({bridge:typeof window.aibrowse,ready:document.readyState}))()`,
          );
          need(status !== null && typeof status === 'object');
          const value = status as { bridge?: unknown; ready?: unknown };
          observe(`bridge-read-${attempt}`, {
            bridge: typeof value.bridge === 'string' ? value.bridge : 'unknown',
            ready: typeof value.ready === 'string' ? value.ready : 'unknown',
          });
        }
        return false;
      }
    }, '主UI未恢复同一服务图');
    need(
      owner() === win && win.webContents.getOSProcessId() !== oldProcess,
      '主UI未换新renderer进程',
    );
    need(
      (await snapshot(a.id)).visibleText?.includes('A-生命周期') &&
        (await snapshot(b.id)).visibleText?.includes('B-生命周期'),
    );
    event(`main-ui-recovered-${attempt}`);
  }
  const oldExport = (await evaluate(
    `window.aibrowse.diagnostics.export(${JSON.stringify({
      sequence: oldPreview.preview.sequence,
      digest: oldPreview.preview.digest,
    })})`,
  )) as { ok: boolean; errorCode?: string };
  need(!oldExport.ok && oldExport.errorCode === 'stale' && diagnosticSaveCalls === 0);
  event('diagnostic-old-document-capability-rejected');
  const preview = (await evaluate('window.aibrowse.diagnostics.preview()')) as {
    ok: boolean;
    preview?: { json: string; byteLength: number; sequence: number; digest: string };
  };
  need(preview.ok && preview.preview && preview.preview.byteLength <= 65536);
  for (const forbidden of [canary, base, '恢复夹具A', profile, 'conversations/index.json'])
    need(!preview.preview.json.includes(forbidden), '诊断输出泄漏合成私有字段');
  event('diagnostic-real-ipc-private-projection');
  const payload = { sequence: preview.preview.sequence, digest: preview.preview.digest };
  const cancelled = (await evaluate(
    `window.aibrowse.diagnostics.export(${JSON.stringify(payload)})`,
  )) as {
    ok: boolean;
    errorCode?: string;
  };
  need(
    !cancelled.ok &&
      cancelled.errorCode === 'cancelled' &&
      !existsSync(join(scope, 'diagnostic-export.json')),
  );
  const exported = (await evaluate(
    `window.aibrowse.diagnostics.export(${JSON.stringify(payload)})`,
  )) as {
    ok: boolean;
    digest?: string;
    byteLength?: number;
  };
  const file = readFileSync(join(scope, 'diagnostic-export.json'));
  need(
    exported.ok &&
      exported.digest === preview.preview.digest &&
      exported.byteLength === preview.preview.byteLength,
  );
  need(
    file.equals(Buffer.from(preview.preview.json)) &&
      createHash('sha256').update(file).digest('hex') === preview.preview.digest &&
      Number(diagnosticSaveCalls) === 2,
  );
  writeNew('diagnostic-proof.json', {
    nativeChoice: 'NOT RUN',
    diagnosticSaveCalls,
    preview: preview.preview,
    cancelled,
    exported,
  });
  event('diagnostic-cancel-and-exact-preview-export');
  await complete();
}
for (const key of Object.keys(process.env))
  if (
    key.startsWith('AIBROWSE_') ||
    ['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)
  )
    delete process.env[key];
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.on('browser-window-created', (_event, candidate) => {
  need(window === null, '只能存在一个主窗口');
  window = candidate;
  candidate.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) observe('main-navigation-start');
  });
  candidate.webContents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) => {
    if (isMainFrame) {
      lastCommitFrame = candidate.webContents.mainFrame;
      observe('main-frame-commit');
    }
  });
  candidate.webContents.on('preload-error', (_event, _path, error) => {
    observe('preload-error', {
      category: /module|require/iu.test(error.message) ? 'module' : 'other',
    });
  });
  candidate.webContents.on('render-process-gone', () => observe('main-renderer-gone'));
  candidate.webContents.on('did-finish-load', () => {
    loadCount += 1;
    observe('main-load-finished');
  });
  candidate.webContents.once('did-finish-load', () => {
    void run().catch((error: unknown) => {
      writeNew(`${phase}-failure.json`, {
        phase,
        events,
        error: error instanceof Error ? error.message.slice(0, 500) : '检查失败',
        observations,
      });
      app.exit(2);
    });
  });
});
createRequire(__filename)('./out/main/index.js');
