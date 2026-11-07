import { app, BaseWindow, WebContentsView, session, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

// Only generated fixture code runs. This is not a third-party compatibility test.
const root = process.env.AIBROWSE_TRANSLATION_PROBE_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('缺少隔离证据目录');
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'session'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.commandLine.appendSwitch('disable-background-networking');
const result = {
  scope: '自有合成夹具；不证明原客户端兼容、完整P1或产品安全通过',
  versions: process.versions,
  completed: false,
  willQuit: false,
  timedOut: false,
  error: null as string | null,
  requests: 0,
  deniedNetwork: 0,
  stage: 'initializing',
  native: {} as Record<string, unknown>,
  controlled: {} as Record<string, unknown>,
};
const persist = (): void =>
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
function stage(value: string): void {
  result.stage = value;
  persist();
}
async function bounded<T>(operation: Promise<T>, name: string): Promise<T> {
  stage(name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`步骤超时：${name}`)), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let server: http.Server | undefined;
let deniedServer: http.Server | undefined;
let owner: BaseWindow | undefined;
const views: WebContentsView[] = [];
const contents: Electron.WebContents[] = [];
let finishing = false;
function finish(error?: unknown): void {
  if (finishing) return;
  finishing = true;
  if (error) result.error = error instanceof Error ? error.message : String(error);
  result.completed = !error;
  persist();
  for (const wc of contents) if (!wc.isDestroyed()) wc.close();
  if (owner && !owner.isDestroyed()) owner.destroy();
  server?.close();
  deniedServer?.close();
  persist();
  process.exitCode = error ? 1 : 0;
  app.quit();
}
const deadline = setTimeout(() => {
  result.timedOut = true;
  finish(new Error('180秒预算耗尽'));
}, 175000);
app.on('will-quit', () => {
  result.willQuit = true;
  clearTimeout(deadline);
  persist();
});
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
app.on('window-all-closed', () => {
  /* Explicit ownership controls shutdown. */
});

const apiPaths = [
  'tabs.query',
  'tabs.create',
  'tabs.sendMessage',
  'windows.create',
  'windows.getCurrent',
  'contextMenus.create',
  'sidePanel.open',
  'storage.local.get',
  'storage.sync.get',
  'scripting.executeScript',
  'scripting.registerContentScripts',
  'webRequest.onBeforeRequest.addListener',
  'declarativeNetRequest.updateDynamicRules',
  'downloads.download',
  'runtime.sendMessage',
];
const snapshot = `Object.fromEntries(${JSON.stringify(apiPaths)}.map(p => [p, typeof p.split('.').reduce((v,k) => v?.[k], chrome)]))`;
const inspect = `(() => ({marker:document.documentElement.dataset.translationProbe || null,
  bridge:typeof window.translationHost, require:typeof require, cookie:document.cookie,
  frames:Array.from(document.querySelectorAll('iframe')).map(f => ({
    url:f.contentWindow.location.href, marker:f.contentDocument.documentElement.dataset.translationProbe || null,
    bridge:typeof f.contentWindow.translationHost}))}))()`;

void app
  .whenReady()
  .then(async () => {
    if (process.versions.electron !== '43.8.4') throw new Error('必须使用固定Electron 43.8.4');
    const fixture = path.join(root!, 'fixture');
    fs.mkdirSync(fixture);
    fs.writeFileSync(
      path.join(fixture, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: '翻译宿主合成探针',
        version: '1.0.0',
        permissions: ['storage', 'tabs', 'scripting', 'webRequest', 'contextMenus'],
        host_permissions: ['<all_urls>'],
        background: { service_worker: 'background.js' },
        content_scripts: [
          {
            matches: ['<all_urls>'],
            js: ['content.js'],
            all_frames: true,
            match_about_blank: true,
            run_at: 'document_start',
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(fixture, 'content.js'),
      `(() => {
    const mark=()=>{if(document.documentElement)document.documentElement.dataset.translationProbe='native';};
    mark();document.addEventListener('DOMContentLoaded',mark,{once:true});
    chrome.runtime.sendMessage({kind:'fixture-document',url:location.href,top:window===top});
  })();`,
    );
    fs.writeFileSync(
      path.join(fixture, 'background.js'),
      `
    const reports=[];
    chrome.runtime.onMessage.addListener((m,s,reply)=>{
      if(m?.kind==='fixture-document'){reports.push({tabId:s.tab?.id,frameId:s.frameId,url:m.url,top:m.top});reply({ok:true});}
      if(m?.kind==='fixture-read')reply({reports,apis:${snapshot}});
    });`,
    );
    fs.writeFileSync(
      path.join(fixture, 'probe.html'),
      '<!doctype html><title>合成扩展容器</title>',
    );
    const local = http.createServer((request, response) => {
      result.requests++;
      persist();
      if (result.requests > 60) {
        response.destroy();
        finish(new Error('本机请求预算超过60'));
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(
        request.url === '/frame'
          ? '<!doctype html><p>子帧原文</p>'
          : '<!doctype html><html><body><p id="source">Original fixture text</p><iframe src="/frame"></iframe><iframe src="about:blank"></iframe></body></html>',
      );
    });
    server = local;
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
    const address = local.address();
    if (!address || typeof address === 'string') throw new Error('本机监听失败');
    const origin = `http://127.0.0.1:${address.port}`;
    let deniedOriginHits = 0;
    const deniedLocal = http.createServer((_request, response) => {
      deniedOriginHits++;
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.end('此端口应被拒绝');
    });
    deniedServer = deniedLocal;
    await new Promise<void>((resolve) => deniedLocal.listen(0, '127.0.0.1', resolve));
    const deniedAddress = deniedLocal.address();
    if (!deniedAddress || typeof deniedAddress === 'string') throw new Error('拒绝哨兵监听失败');
    const deniedURL = `http://127.0.0.1:${deniedAddress.port}/sentinel`;
    const isolated = session.fromPartition(`persist:translation-probe-${randomUUID()}`);
    await isolated.setProxy({ mode: 'direct' });
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (details, callback) => {
        const allowed = details.url.startsWith(`${origin}/`);
        if (!allowed) result.deniedNetwork++;
        callback({ cancel: !allowed });
      },
    );
    owner = new BaseWindow({ show: false });
    function create(preload?: string): WebContentsView {
      const view = new WebContentsView({
        webPreferences: {
          session: isolated,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          webSecurity: true,
          ...(preload ? { preload } : {}),
        },
      });
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      owner!.contentView.addChildView(view);
      views.push(view);
      contents.push(view.webContents);
      return view;
    }
    const extension = await isolated.extensions.loadExtension(fixture, { allowFileAccess: false });
    const control = create();
    await bounded(
      control.webContents.loadURL(`chrome-extension://${extension.id}/probe.html`),
      'native-control-load',
    );
    const roles = ['user', 'research', 'watch'];
    const nativePages: Record<string, unknown> = {};
    for (const role of roles) {
      const page = create();
      await bounded(page.webContents.loadURL(`${origin}/same`), `native-load-${role}`);
      nativePages[role] = {
        id: page.webContents.id,
        url: page.webContents.getURL(),
        sameSession: page.webContents.session === isolated,
        observed: await bounded(
          page.webContents.executeJavaScript(inspect),
          `native-inspect-${role}`,
        ),
      };
    }
    result.native = {
      pages: nativePages,
      apis: await bounded(control.webContents.executeJavaScript(snapshot), 'native-api-snapshot'),
      background: await bounded(
        control.webContents.executeJavaScript(`chrome.runtime.sendMessage({kind:'fixture-read'})`),
        'native-background-message',
      ),
      query: await bounded(
        control.webContents.executeJavaScript(`new Promise(resolve => {
      if(typeof chrome.tabs?.query!=='function'){resolve({unsupported:true});return;}
      chrome.tabs.query({}, tabs=>resolve({error:chrome.runtime.lastError?.message || null,
        tabs:tabs?.map(t=>({id:t.id,url:t.url,active:t.active}))}));})`),
        'native-tab-query',
      ),
    };
    stage('native-complete');
    isolated.extensions.removeExtension(extension.id);
    for (const wc of contents) if (!wc.isDestroyed()) wc.close();

    // No native extension exists in the controlled phase; only this fixed fixture runs.
    const preload = path.join(root!, 'preload.cjs');
    const channel = `translation-fixture-${randomUUID()}`;
    fs.writeFileSync(
      preload,
      `const {ipcRenderer,webFrame}=require('electron');
    if(process.isMainFrame) {
      const start=()=>ipcRenderer.invoke(${JSON.stringify(channel)}, {kind:'hello'}).then(value=>{
        if(value?.allowed)return webFrame.executeJavaScriptInIsolatedWorld(2417,[{code:
          "document.documentElement.dataset.translationProbe='controlled';"}]);
      }).catch(error=>console.error('合成preload失败：'+String(error)));
      if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
      else start();
    }`,
    );
    const allowedIds = new Map<number, { frame: Electron.WebFrameMain; epoch: number }>();
    const audit: Array<{
      id: number;
      allowed: boolean;
      registered: boolean;
      currentFrame: boolean;
      currentURL: boolean;
    }> = [];
    result.controlled = { audit };
    ipcMain.handle(channel, (event, payload: unknown) => {
      const entry = allowedIds.get(event.sender.id);
      const allowed =
        !!entry &&
        !event.sender.isDestroyed() &&
        event.senderFrame === entry.frame &&
        event.senderFrame === event.sender.mainFrame &&
        event.sender.getURL() === `${origin}/same` &&
        typeof payload === 'object' &&
        payload !== null &&
        Object.keys(payload).length === 1 &&
        'kind' in payload &&
        payload.kind === 'hello';
      audit.push({
        id: event.sender.id,
        allowed,
        registered: !!entry,
        currentFrame:
          !!entry &&
          event.senderFrame === entry.frame &&
          event.senderFrame === event.sender.mainFrame,
        currentURL: event.sender.getURL() === `${origin}/same`,
      });
      persist();
      return { allowed };
    });
    const controlledPages: Record<string, unknown> = {};
    let user: WebContentsView | undefined;
    for (const role of roles) {
      const page = create(role === 'user' ? preload : undefined);
      if (role === 'user') {
        user = page;
        const pageId = page.webContents.id;
        page.webContents.on('did-frame-navigate', (_event, url, _code, _text, isMain) => {
          if (isMain && url === `${origin}/same`)
            allowedIds.set(page.webContents.id, { frame: page.webContents.mainFrame, epoch: 1 });
        });
        page.webContents.on('did-start-navigation', (details) => {
          if (details.isMainFrame && !details.isSameDocument)
            allowedIds.delete(page.webContents.id);
        });
        page.webContents.once('destroyed', () => allowedIds.delete(pageId));
      }
      await bounded(page.webContents.loadURL(`${origin}/same`), `controlled-load-${role}`);
      if (role === 'user') {
        await bounded(
          page.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
        if(document.documentElement.dataset.translationProbe==='controlled'){resolve(true);return;}
        const timer=setTimeout(()=>{observer.disconnect();reject(new Error('用户页正控未运行'));},3000);
        const observer=new MutationObserver(()=>{if(document.documentElement.dataset.translationProbe==='controlled'){
          clearTimeout(timer);observer.disconnect();resolve(true);}});
        observer.observe(document.documentElement,{attributes:true});})`),
          'controlled-user-marker',
        );
        await isolated.cookies.set({
          url: origin,
          name: 'translation_fixture',
          value: 'shared',
          sameSite: 'lax',
        });
      }
      controlledPages[role] = {
        id: page.webContents.id,
        url: page.webContents.getURL(),
        sameSession: page.webContents.session === isolated,
        observed: await bounded(
          page.webContents.executeJavaScript(inspect),
          `controlled-inspect-${role}`,
        ),
      };
      result.controlled = { pages: controlledPages, audit };
      persist();
    }
    const deniedBefore = result.deniedNetwork;
    const fetchRejected = await bounded(
      user!.webContents.executeJavaScript(
        `fetch(${JSON.stringify(deniedURL)}).then(()=>false,()=>true)`,
      ),
      'controlled-network-negative',
    );
    const networkSentinel = {
      fetchRejected,
      deniedOriginHits,
      deniedByGate: result.deniedNetwork - deniedBefore,
    };
    const userId = user!.webContents.id;
    await bounded(user!.webContents.loadURL('about:blank'), 'controlled-revoke');
    const revokedOnNavigation = !allowedIds.has(userId);
    await bounded(user!.webContents.loadURL(`${origin}/same`), 'controlled-readmit-for-close');
    const closingWC = user!.webContents;
    const admittedBeforeClose = allowedIds.has(userId);
    const destroyed = new Promise<void>((resolve) => closingWC.once('destroyed', () => resolve()));
    closingWC.close();
    await bounded(destroyed, 'controlled-direct-close');
    const revokedOnClose = !allowedIds.has(userId);
    result.controlled = {
      pages: controlledPages,
      audit,
      revokedOnNavigation,
      revokedOnClose,
      admittedBeforeClose,
      networkSentinel,
      nativeExtensions: isolated.extensions.getAllExtensions().length,
      limitations: [
        '未执行原客户端/后台适配',
        '未验证原UI/凭据/可信采集排除',
        '未验证恶意旧文档IPC重放/并发竞态',
      ],
    };
    ipcMain.removeHandler(channel);
    finish();
  })
  .catch(finish);
