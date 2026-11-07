import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const pairs = [
  ['The red fox walks through the quiet forest.', '红狐狸穿过安静的森林。'],
  ['Our science museum opens every morning at nine.', '我们的科学博物馆每天早上九点开放。'],
  ['Please keep the blue notebook beside the window.', '请把蓝色笔记本放在窗边。'],
];
const root = process.env.AIBROWSE_LOCAL_CLIENT_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('缺少隔离目录');
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'session'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.commandLine.appendSwitch('disable-background-networking');
const result = {
  completed: false,
  willQuit: false,
  error: null as string | null,
  stage: 'init',
  requests: [] as unknown[],
  localRequests: 0,
  deniedRequests: 0,
  consoleErrors: [] as string[],
  configuration: null as unknown,
  translated: null as unknown,
  restored: null as unknown,
  sentinel: null as unknown,
  tabId: 0,
  messages: [] as unknown[],
  diagnostics: [] as unknown[],
};
const windows: BrowserWindow[] = [];
let finishing = false;
let sentinelHits = 0;
const persist = () =>
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
const server = http.createServer((req, res) => {
  if (++result.localRequests > 60) {
    res.writeHead(429).end();
    finish(new Error('本机请求预算耗尽'));
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'GET' && req.url === '/fixture') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>合成翻译夹具</title></head><body><article>' +
        pairs.map((p, i) => `<p id="p${i}">${p[0]}</p>`).join('') +
        '</article></body></html>',
    );
    return;
  }
  if (req.url === '/translate' && req.method === 'OPTIONS') {
    res.end();
    return;
  }
  if (req.url !== '/translate' || req.method !== 'POST') {
    res.writeHead(403).end();
    return;
  }
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
    if (body.length > 4096) req.destroy();
  });
  req.on('end', () => {
    try {
      const data = JSON.parse(body) as {
        text_list: unknown;
        source_lang: unknown;
        target_lang: unknown;
      };
      result.requests.push(data);
      persist();
      if (result.requests.length > 12) throw new Error('翻译请求预算耗尽');
      if (
        !Array.isArray(data.text_list) ||
        data.text_list.length !== 1 ||
        data.target_lang !== 'zh-CN'
      )
        throw new Error('原请求schema不匹配');
      const sourceText = data.text_list[0];
      const pair = pairs.find((p) => p[0] === sourceText);
      if (!pair) throw new Error('原文不在确定性真值表');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ translations: [{ text: pair[1] }] }));
    } catch (error) {
      res.writeHead(422).end();
      finish(error);
    }
  });
});
function finish(error?: unknown) {
  if (finishing) return;
  finishing = true;
  result.error = error ? String(error) : null;
  result.completed = !error;
  persist();
  server.close();
  for (const w of windows) if (!w.isDestroyed()) w.destroy();
  app.quit();
}
const timer = setTimeout(() => finish(new Error('175秒预算耗尽')), 175000);
app.on('will-quit', () => {
  clearTimeout(timer);
  result.willQuit = true;
  persist();
});
app.on('window-all-closed', () => {});
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
async function bounded<T>(p: Promise<T>, stage: string): Promise<T> {
  result.stage = stage;
  persist();
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new Error('步骤超时：' + stage)), 20000);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}
void app
  .whenReady()
  .then(async () => {
    if (process.versions.electron !== '43.8.4') throw new Error('Electron版本不符');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无端口');
    const origin = `http://127.0.0.1:${address.port}`;
    const isolated = session.fromPartition('persist:content-probe');
    await isolated.setProxy({ mode: 'direct' });
    isolated.setPermissionRequestHandler((_wc, _p, reply) => reply(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (d, reply) => {
        const allowed =
          (d.url === origin + '/fixture' && d.method === 'GET') ||
          (d.url === origin + '/translate' && ['POST', 'OPTIONS'].includes(d.method));
        if (!allowed) {
          result.deniedRequests++;
          if (d.url === 'https://aibrowse-probe.invalid/sentinel') sentinelHits++;
          persist();
        }
        reply({ cancel: !allowed });
        if (result.deniedRequests > 100) finish(new Error('外网拒绝预算耗尽'));
      },
    );
    const extension = await bounded(
      isolated.extensions.loadExtension(path.join(root, 'client'), { allowFileAccess: false }),
      'load-extension',
    );
    const create = () => {
      const w = new BrowserWindow({
        show: false,
        width: 1000,
        height: 800,
        webPreferences: {
          session: isolated,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          backgroundThrottling: false,
        },
      });
      windows.push(w);
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      w.webContents.on('console-message', (d) => {
        if (d.level === 'error' && result.consoleErrors.length < 40) {
          result.consoleErrors.push(d.message.slice(0, 500));
          persist();
        }
      });
      w.webContents.on('will-navigate', (e, url) => {
        if (url !== origin + '/fixture' && !url.startsWith(`chrome-extension://${extension.id}/`))
          e.preventDefault();
      });
      return w;
    };
    const popup = create();
    await bounded(popup.loadURL(`chrome-extension://${extension.id}/popup.html`), 'popup');
    const bg = (method: string, data: unknown) =>
      popup.webContents.executeJavaScript(
        `chrome.runtime.sendMessage({from:'popup:main_sync',to:'background:main',payload:{method:${JSON.stringify(method)},data:${JSON.stringify(data)}}})`,
      );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const config = {
      translationService: 'custom1',
      targetLanguage: 'zh-CN',
      sourceLanguage: 'en',
      translationMode: 'dual',
      translationServices: {
        custom1: {
          type: 'custom',
          group: 'custom',
          name: '合成真值',
          url: origin + '/translate',
          langs: 'en,zh-CN',
          maxTextGroupLengthPerRequest: 1,
        },
      },
      sensitiveConfig: { telemetry: false },
      isEnableGuideTips: false,
    };
    result.messages.push(await bounded(bg('setUserConfig', config), 'set-config'));
    result.configuration = await bounded(bg('getUserConfig', {}), 'read-config');
    persist();
    const page = create();
    result.tabId = page.webContents.id;
    await bounded(page.loadURL(origin + '/fixture'), 'fixture');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const content = (method: string) =>
      popup.webContents.executeJavaScript(
        `chrome.tabs.sendMessage(${result.tabId},{from:'popup:main_sync',to:'content:main',payload:{method:${JSON.stringify(method)},data:{}}},{frameId:0})`,
      );
    result.diagnostics.push(await popup.webContents.executeJavaScript('chrome.tabs.query({})'));
    result.messages.push(await bounded(content('getPageStatus'), 'content-status'));
    persist();
    result.messages.push(await bounded(content('translatePage'), 'translate-message'));
    persist();
    const snapshot = `(()=>{const selector='.immersive-translate-target-inner';return {nodes:[...document.querySelectorAll(selector)].map(n=>n.textContent),paragraphs:[0,1,2].map(i=>{const p=document.getElementById('p'+i);const c=p.cloneNode(true);c.querySelectorAll('font.immersive-translate-target-wrapper,.immersive-translate-target-wrapper').forEach(n=>n.remove());return {original:c.textContent.trim(),text:p.textContent.trim(),translations:[...p.querySelectorAll(selector)].map(n=>n.textContent.trim())};}),html:document.querySelector('article').innerHTML};})()`;
    await new Promise((resolve) => setTimeout(resolve, 6000));
    result.translated = await bounded(
      page.webContents.executeJavaScript(snapshot),
      'translated-dom',
    );
    persist();
    result.messages.push(await bounded(content('restorePage'), 'restore-message'));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    result.restored = await bounded(page.webContents.executeJavaScript(snapshot), 'restored-dom');
    persist();
    const before = sentinelHits;
    const rejected = await bounded(
      popup.webContents.executeJavaScript(
        "fetch('https://aibrowse-probe.invalid/sentinel').then(()=>false,()=>true)",
      ),
      'sentinel',
    );
    result.sentinel = { rejected, hits: sentinelHits - before };
    finish();
  })
  .catch(finish);
