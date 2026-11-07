import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.AIBROWSE_LOCAL_CLIENT_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('缺少隔离目录');
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'session'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
app.commandLine.appendSwitch('disable-background-networking');
const result = {
  scope: '仅本人本机已安装客户端的离线原UI实验，不是生产集成',
  versions: process.versions,
  completed: false,
  willQuit: false,
  error: null as string | null,
  deniedRequests: 0,
  rejectionSentinel: null as { rejected: boolean; intercepted: number } | null,
  stage: 'initializing',
  pages: {} as Record<string, unknown>,
  consoleErrors: [] as string[],
  settingsProbe: null as { selected: boolean; afterReload: boolean } | null,
};
const windows: BrowserWindow[] = [];
let sentinelHits = 0;
const persist = (): void =>
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
let finishing = false;
function finish(error?: unknown): void {
  if (finishing) return;
  finishing = true;
  result.error = error ? String(error) : null;
  result.completed = !error;
  persist();
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  app.quit();
}
const timer = setTimeout(() => finish(new Error('原UI实验175秒预算耗尽')), 175000);
app.on('will-quit', () => {
  clearTimeout(timer);
  result.willQuit = true;
  persist();
});
app.on('window-all-closed', () => {
  /* Explicit lifecycle ownership. */
});
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
async function bounded<T>(promise: Promise<T>, stage: string): Promise<T> {
  result.stage = stage;
  persist();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(`步骤超时：${stage}`)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
void app
  .whenReady()
  .then(async () => {
    if (process.versions.electron !== '43.8.4') throw new Error('Electron版本不符');
    const isolated = session.fromPartition('persist:local-client-probe');
    await isolated.setProxy({ mode: 'direct' });
    isolated.setPermissionRequestHandler((_wc, _permission, reply) => reply(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (details, reply) => {
        result.deniedRequests++;
        if (details.url === 'https://aibrowse-probe.invalid/sentinel') sentinelHits++;
        persist();
        reply({ cancel: true });
        if (result.deniedRequests > 100) finish(new Error('原UI外网拒绝尝试超过100次预算'));
      },
    );
    const extension = await bounded(
      isolated.extensions.loadExtension(path.join(root!, 'client'), { allowFileAccess: false }),
      'load-original-client',
    );
    for (const page of ['popup', 'options', 'side-panel']) {
      const win = new BrowserWindow({
        show: false,
        width: page === 'popup' ? 460 : 1100,
        height: 820,
        webPreferences: {
          session: isolated,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          backgroundThrottling: false,
          offscreen: true,
        },
      });
      windows.push(win);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(`chrome-extension://${extension.id}/`)) event.preventDefault();
      });
      win.webContents.on('console-message', (details) => {
        if (details.level === 'error' && result.consoleErrors.length < 30) {
          result.consoleErrors.push(`${page}: ${details.message.slice(0, 400)}`);
          persist();
        }
      });
      await bounded(win.loadURL(`chrome-extension://${extension.id}/${page}.html`), `load-${page}`);
      // Wait for actual DOM activity, bounded independently of renderer timers.
      const observed = await bounded(
        win.webContents.executeJavaScript(`new Promise(resolve=>{
      const name=${JSON.stringify(page)};
      const read=()=>({title:document.title,text:document.body.innerText.slice(0,5000),
        buttons:[...document.querySelectorAll('button')].map(b=>b.innerText.trim()).slice(0,35),
        inputs:[...document.querySelectorAll('input')].map(i=>({type:i.type,name:i.name})).slice(0,30),
        require:typeof require,appBridge:typeof window.electron});
      const ready=()=>{const p=read();return name==='popup'?p.text.includes('翻译服务')&&p.buttons.some(b=>b.startsWith('翻译')):
        name==='options'?p.text.includes('基本设置')&&p.inputs.length>1&&!p.text.includes('加载中...'):
        p.text.includes('翻译文本')&&p.buttons.includes('翻译');};
      const done=()=>{observer.disconnect();clearTimeout(timeout);resolve(read());};
      const observer=new MutationObserver(()=>{if(ready())done();});
      const timeout=setTimeout(done,6000);observer.observe(document.body,{childList:true,subtree:true});
      if(ready())done();
    })`),
        `observe-${page}`,
      );
      result.pages[page] = observed;
      persist();
      // DOM readiness precedes paint; use one fixed settling interval, never pick a green frame.
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      const capture = await bounded(
        new Promise<Electron.NativeImage>((resolve) => {
          win.webContents.once('paint', (_event, _dirty, image) => resolve(image));
          win.webContents.invalidate();
        }),
        `capture-${page}`,
      );
      fs.writeFileSync(path.join(root!, `${page}.png`), capture.toPNG());
      if (page === 'options' && process.env.AIBROWSE_LOCAL_CLIENT_MODE === 'local-sync') {
        const selected = (await bounded(
          win.webContents.executeJavaScript(`(async()=>{
          const wait=check=>new Promise(resolve=>{const deadline=Date.now()+2500;
            const poll=()=>{if(check())resolve(true);else if(Date.now()>=deadline)resolve(false);else setTimeout(poll,30);};poll();});
          const initial=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='双语对照');
          if(!initial)return false;initial.click();
          const find=()=>[...document.querySelectorAll('body *')].find(el=>el.children.length===0&&el.textContent.trim()==='仅译文'&&el.getClientRects().length>0);
          if(!await wait(()=>!!find()))return false;find().click();
          return wait(()=>[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='仅译文'));
        })()`),
          'original-settings-select',
        )) as boolean;
        await bounded(
          win.loadURL(`chrome-extension://${extension.id}/options.html`),
          'original-settings-reload',
        );
        const afterReload = (await bounded(
          win.webContents.executeJavaScript(`new Promise(resolve=>{
          const deadline=Date.now()+5000;const poll=()=>{if([...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='仅译文'))resolve(true);
            else if(Date.now()>=deadline)resolve(false);else setTimeout(poll,50);};poll();})`),
          'original-settings-readback',
        )) as boolean;
        result.settingsProbe = { selected, afterReload };
        persist();
      }
    }
    const before = sentinelHits;
    const rejected = (await bounded(
      windows[0].webContents.executeJavaScript(
        "fetch('https://aibrowse-probe.invalid/sentinel').then(()=>false,()=>true)",
      ),
      'network-rejection-sentinel',
    )) as boolean;
    result.rejectionSentinel = { rejected, intercepted: sentinelHits - before };
    finish();
  })
  .catch(finish);
