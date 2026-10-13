import { app, BrowserWindow, ipcMain, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { QualifiedScriptStore } from '../../src/main/userscripts-qualified/store';
import { QualifiedScriptRuntime } from '../../src/main/userscripts-qualified/runtime';
import { QUALIFIED_SCRIPT_CATALOG } from '../../src/main/userscripts-qualified/catalog';
import { readQualifiedPackage } from '../../src/main/userscripts-qualified/package';
import { createQualifiedScriptFeature } from '../../src/main/userscripts-qualified/feature';

// Original bytes execute only against offline representative DOM, never live sites.
const root = process.env.AIBROWSE_QUALIFIED_PROBE_ROOT;
const preload = process.env.AIBROWSE_QUALIFIED_PRELOAD;
if (!root || !preload || !path.isAbsolute(root) || !path.isAbsolute(preload))
  throw new Error('资格探针路径无效');
app.setPath('userData', path.join(root, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
const hash = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex').toUpperCase();
const result = {
  completed: false,
  passed: false,
  scope: '原版脚本与真实运行层；离线代表性 DOM，不能证明实时网站全兼容',
  budget: { milliseconds: 180000, fixtureRequests: 30, externalRequests: 0, providerCalls: 0 },
  assets: [] as { url: string; file: string; sha256: string; bytes: number }[],
  toolHashes: {} as Record<string, string>,
  fixtures: [] as string[],
  denied: [] as string[],
  network: [] as { url: string; method: string }[],
  prepares: [] as { contentsId: number; ids: string[] }[],
  operations: [] as { contentsId: number; op: unknown; key: unknown }[],
  console: [] as { url: string; level: string; message: string }[],
  checks: {} as Record<string, unknown>,
  failures: [] as string[],
  error: null as string | null,
};
let runtime: QualifiedScriptRuntime | undefined;
let store: QualifiedScriptStore | undefined;
let startupFeature: ReturnType<typeof createQualifiedScriptFeature> | undefined;
const windows: BrowserWindow[] = [];
let activeId = -1;
let closing = false;
function finish(error?: unknown): void {
  if (closing) return;
  closing = true;
  if (error) result.error = String(error);
  result.completed = true;
  result.passed = !result.error && result.failures.length === 0;
  fs.writeFileSync(path.join(root!, 'result.json'), JSON.stringify(result, null, 2));
  runtime?.dispose();
  store?.dispose();
  startupFeature?.dispose();
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  app.exit(result.passed ? 0 : 1);
}
setTimeout(() => finish('180 秒总预算耗尽'), 180000).unref();
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
function check(name: string, value: unknown, passed: boolean): void {
  result.checks[name] = value;
  if (!passed) result.failures.push(name);
  fs.writeFileSync(path.join(root!, 'checkpoint.json'), JSON.stringify(result, null, 2));
}
async function waitFor(
  window: BrowserWindow,
  expression: string,
  milliseconds = 10000,
): Promise<boolean> {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
const settingsHosts = ['ac-baidu.90dao.com', 'ac-baidu.tujidu.com', 'ibaidu.tujidu.com'];
const githubHtml = `<!doctype html><html><head><meta name="analytics-location" content="/&lt;user-name&gt;/&lt;repo-name&gt;"><title>GitHub</title></head><body><h1>离线 GitHub 代表页面</h1><nav><a id="code">Code</a><a id="signin">Sign in</a><a id="issues">Issues</a></nav><p class="f4 my-3">Representative repository description.</p></body></html>`;
const baiduHtml = `<!doctype html><html><head><title>离线百度代表页面</title></head><body><h1>离线搜索结果</h1><div class="s_form"></div><div id="container"><div id="content_left"><div class="c-container result" srcid="1599" id="1"><h3 class="t"><a id="search-result" href="https://www.baidu.com/link?url=fixture">Representative final URL result</a></h3><div>Representative search result description.</div></div><div class="c-container result" srcid="1599" id="2"><h3 class="t"><a id="html-result" href="https://www.baidu.com/link?url=fixture-html">Representative HTML result</a></h3></div></div></div></body></html>`;
const settingsHtml =
  '<!doctype html><html><head><title>离线 AC 设置页</title></head><body><h1>离线设置桥资格页面</h1></body></html>';
const gistHtml =
  '<!doctype html><html><head><title>Offline Gist fixture</title></head><body><a>Sign in</a><div class="gist-content"><p itemprop="about">Representative gist description.</p></div></body></html>';
const pageSafety = `({require:typeof require,process:typeof process,GM:typeof GM,host:typeof __qualifiedHost,electron:typeof electron,api:typeof window.api,interfaceKeys:typeof AC_GM_Interface==='undefined'?[]:Object.keys(AC_GM_Interface)})`;
void app
  .whenReady()
  .then(async () => {
    const packageFiles = {
      'ac-baidu': path.join(root, 'resources', 'qualified-userscripts', 'ac-baidu.json'),
      'github-zh': path.join(root, 'resources', 'qualified-userscripts', 'github-zh.json'),
    } as const;
    const builtInTexts = new Map<string, ReadonlyMap<string, string>>();
    for (const entry of Object.values(QUALIFIED_SCRIPT_CATALOG)) {
      const texts = readQualifiedPackage(packageFiles[entry.id], entry);
      builtInTexts.set(entry.id, texts);
      for (const asset of entry.assets) {
        const text = texts.get(asset.key);
        if (text === undefined) throw new Error(`固定内置资产缺失：${asset.key}`);
        result.assets.push({
          url: asset.url,
          file: `${packageFiles[entry.id]}#${asset.key}`,
          sha256: asset.sha256,
          bytes: Buffer.byteLength(text),
        });
      }
    }
    for (const file of [
      'tools/qualified-userscripts-runtime/actual-probe.ts',
      'tools/qualified-userscripts-runtime/run-probe.mjs',
      'src/preload/qualified-userscripts.ts',
      'src/main/userscripts-qualified/catalog.ts',
      'src/main/userscripts-qualified/store.ts',
      'src/main/userscripts-qualified/runtime.ts',
      preload,
      path.join(root, 'probe.cjs'),
    ])
      result.toolHashes[path.resolve(file)] = hash(fs.readFileSync(file));
    const storeOptions = {
      directory: path.join(root, 'qualified-store'),
      fetchText: async (): Promise<string> => {
        throw new Error('内置初始化禁止安装网络');
      },
    };
    store = new QualifiedScriptStore(storeOptions);
    for (const id of ['ac-baidu', 'github-zh'] as const) {
      const installed = await store.install(id, () => true, builtInTexts.get(id));
      if (!installed.ok) throw new Error(installed.message);
    }
    // This is an explicit test setting input, not a source modification.
    const seeded = store.setValue(
      'ac-baidu',
      'ACConfig',
      JSON.stringify({
        common: {
          isRedirectEnable: true,
          isFaviconEnable: false,
          isAutopage: false,
          isBlockEnable: false,
          isCounterEnable: true,
        },
      }),
    );
    if (!seeded.ok) throw new Error(seeded.message);
    runtime = new QualifiedScriptRuntime({
      store,
      network: {
        request: async (input) => {
          result.network.push({ url: input.url, method: input.method });
          if (result.network.length + result.fixtures.length > 30)
            throw new Error('替身网络预算耗尽');
          const url = new URL(input.url);
          if (!(
            (url.hostname === 'www.baidu.com' &&
              url.pathname === '/link' &&
              input.method === 'GET') ||
            (settingsHosts.includes(url.hostname) && input.method === 'HEAD')
          ))
            throw new Error('替身网络拒绝非预定请求');
          return {
            status: 200,
            statusText: 'OK',
            finalUrl: input.method === 'GET' ? 'https://example.org/qualified-result' : input.url,
            responseText:
              input.method === 'GET' && url.searchParams.get('url') === 'fixture-html'
                ? "<html><script>location.replace(URL='https://example.org/qualified-result')</script></html>"
                : '',
            responseHeaders: 'content-type: text/html\r\n',
          };
        },
      },
      isOpen: () => true,
      isActiveUserTab: (id) => id === activeId,
      openUserTab: (url) => {
        result.checks.openedSettingsUrl = url;
      },
      notify: (text) => {
        result.checks.notification = text;
      },
    });
    ipcMain.on('qualified-scripts:prepare', (event, payload: unknown) => {
      const prepared = runtime!.prepare(event, payload);
      result.prepares.push({ contentsId: event.sender.id, ids: prepared.map((item) => item.id) });
      event.returnValue = prepared;
    });
    ipcMain.on('qualified-scripts:sync', (event, payload: unknown) => {
      const data = payload as Record<string, unknown>;
      result.operations.push({ contentsId: event.sender.id, op: data?.op, key: data?.key });
      event.returnValue = runtime!.sync(event, payload);
    });
    ipcMain.handle('qualified-scripts:request', (event, payload: unknown) =>
      runtime!.request(event, payload),
    );
    ipcMain.on('qualified-scripts:cancel', (event, payload: unknown) =>
      runtime!.cancel(event, payload),
    );
    const isolated = session.fromPartition('persist:qualified-actual');
    const allowedHosts = new Set([
      'github.com',
      'gist.github.com',
      'www.baidu.com',
      ...settingsHosts,
    ]);
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const allowed = url.protocol === 'https:' && allowedHosts.has(url.hostname);
      if (!allowed) result.denied.push(details.url);
      callback({ cancel: !allowed });
    });
    isolated.protocol.handle('https', (request) => {
      result.fixtures.push(request.url);
      if (result.fixtures.length + result.network.length > 30)
        throw new Error('内存页面请求预算耗尽');
      const url = new URL(request.url);
      let html: string | undefined;
      if (url.hostname === 'github.com' && url.pathname === '/fixture/repository')
        html = githubHtml;
      if (url.hostname === 'gist.github.com' && url.pathname === '/fixture/id') html = gistHtml;
      if (url.hostname === 'www.baidu.com' && url.pathname === '/s') html = baiduHtml;
      if (settingsHosts.includes(url.hostname) && url.pathname.startsWith('/pages/custom/'))
        html = settingsHtml;
      if (settingsHosts.includes(url.hostname) && url.pathname === '/other') html = settingsHtml;
      return new Response(html ?? '', {
        status: html ? 200 : 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    const makeWindow = (user: boolean): BrowserWindow => {
      const window = new BrowserWindow({
        show: false,
        width: 1000,
        height: 760,
        webPreferences: {
          session: isolated,
          ...(user ? { preload } : {}),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      windows.push(window);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('console-message', (event) => {
        if (result.console.length < 200)
          result.console.push({
            url: window.webContents.getURL(),
            level: event.level,
            message: event.message,
          });
      });
      window.webContents.on('preload-error', (_event, _path, error) =>
        result.failures.push(String(error)),
      );
      if (user) {
        runtime!.attach(window.webContents);
        activeId = window.webContents.id;
      }
      return window;
    };
    const github = makeWindow(true);
    await github.loadURL('https://github.com/fixture/repository');
    const translated = await waitFor(
      github,
      "document.querySelector('#code')?.textContent==='代码'",
    );
    // The original description button is deliberately delayed by 100 ms.
    await new Promise((resolve) => setTimeout(resolve, 350));
    check(
      'githubTranslation',
      await github.webContents.executeJavaScript(
        "({code:document.querySelector('#code').textContent,signin:document.querySelector('#signin').textContent,issues:document.querySelector('#issues').textContent,lang:document.documentElement.lang})",
      ),
      translated,
    );
    check(
      'githubNoIflyrecButton',
      await github.webContents.executeJavaScript("document.querySelector('#translate-me')===null"),
      await github.webContents.executeJavaScript("document.querySelector('#translate-me')===null"),
    );
    const safety = (await github.webContents.executeJavaScript(pageSafety)) as Record<
      string,
      unknown
    >;
    check(
      'githubPageSafety',
      safety,
      ['require', 'process', 'GM', 'host', 'electron', 'api'].every(
        (key) => safety[key] === 'undefined',
      ),
    );
    fs.writeFileSync(
      path.join(root, 'github.png'),
      (await github.webContents.capturePage()).toPNG(),
    );
    const menu = runtime.menus(github.webContents.id).find((item) => item.label.includes('正则'));
    check('githubMenu', runtime.menus(github.webContents.id), !!menu);
    if (menu) {
      runtime.invokeMenu(menu);
      await waitFor(github, 'true', 100);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = runtime
        .menus(github.webContents.id)
        .find((item) => item.label.includes('正则'));
      if (second) runtime.invokeMenu(second);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await waitFor(github, "document.querySelector('#code')?.textContent==='代码'");
      const reopened = new QualifiedScriptStore(storeOptions);
      check(
        'githubWriteReloadReopen',
        {
          values: reopened.getValues('github-zh'),
          prepares: result.prepares.filter((item) => item.contentsId === github.webContents.id)
            .length,
        },
        reopened.getValues('github-zh').enable_RegExp === true &&
          result.prepares.filter((item) => item.contentsId === github.webContents.id).length >= 2,
      );
      reopened.dispose();
    }
    const gist = makeWindow(true);
    await gist.loadURL('https://gist.github.com/fixture/id');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const gistState = (await gist.webContents.executeJavaScript(
      "({button:!!document.querySelector('#translate-me'),text:document.querySelector('a').textContent})",
    )) as { button: boolean; text: string };
    check('gistNoIflyrecButton', gistState, !gistState.button && gistState.text === '登录');
    fs.writeFileSync(path.join(root, 'gist.png'), (await gist.webContents.capturePage()).toPNG());
    const task = makeWindow(false);
    await task.loadURL('https://github.com/fixture/repository');
    const taskState = (await task.webContents.executeJavaScript(
      `({text:document.querySelector('#code').textContent,safety:${pageSafety}})`,
    )) as { text: string };
    check(
      'sameSessionTaskIsolation',
      taskState,
      taskState.text === 'Code' &&
        !result.prepares.some((item) => item.contentsId === task.webContents.id),
    );
    await task.loadURL('https://www.baidu.com/s?wd=fixture');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const taskAc = (await task.webContents.executeJavaScript(
      "({href:document.querySelector('#search-result').href,counters:document.querySelectorAll('.AC-CounterT').length})",
    )) as { href: string; counters: number };
    check(
      'sameSessionAcTaskIsolation',
      taskAc,
      taskAc.href === 'https://www.baidu.com/link?url=fixture' &&
        taskAc.counters === 0 &&
        !result.prepares.some((item) => item.contentsId === task.webContents.id),
    );
    const baidu = makeWindow(true);
    await baidu.loadURL('https://www.baidu.com/s?wd=fixture');
    const redirected = await waitFor(
      baidu,
      "document.querySelector('#search-result')?.href==='https://example.org/qualified-result'",
    );
    check(
      'acActualRedirect',
      await baidu.webContents.executeJavaScript(
        "({href:document.querySelector('#search-result').href,status:document.querySelector('#search-result').getAttribute('ac_redirectStatus'),counters:document.querySelectorAll('.AC-CounterT').length,styles:document.querySelectorAll('style').length})",
      ),
      redirected,
    );
    check(
      'acActualHtmlRedirect',
      await baidu.webContents.executeJavaScript("document.querySelector('#html-result').href"),
      await baidu.webContents.executeJavaScript(
        "document.querySelector('#html-result').href==='https://example.org/qualified-result'",
      ),
    );
    const acMenu = runtime
      .menus(baidu.webContents.id)
      .find((item) => item.label.includes('脚本设置'));
    check('acActualMenus', runtime.menus(baidu.webContents.id), !!acMenu);
    if (acMenu) {
      runtime.invokeMenu(acMenu);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    fs.writeFileSync(path.join(root, 'baidu.png'), (await baidu.webContents.capturePage()).toPNG());
    for (const host of settingsHosts) {
      const settings = makeWindow(true);
      await settings.loadURL(`https://${host}/pages/custom/#/common`);
      const ready = await waitFor(settings, "typeof AC_GM_Interface!=='undefined'", 3000);
      check(
        `settingsInterface:${host}`,
        await settings.webContents.executeJavaScript(pageSafety),
        ready,
      );
      if (ready) {
        const reply = (await settings.webContents.executeJavaScript(
          "(async()=>{ const before=await AC_GM_Interface.get('op_common','{}'); await AC_GM_Interface.save('ACBlockRules',[{fixture:'bounded'}]); const after=await AC_GM_Interface.get('ACBlockRules','[]'); let rejected=false; try{await AC_GM_Interface.get('apiKey','{}')}catch{rejected=true} return {before,after,rejected,keys:Object.keys(AC_GM_Interface)} })()",
        )) as { after: unknown; rejected: boolean; keys: string[] };
        check(
          `settingsRoundTrip:${host}`,
          reply,
          reply.rejected &&
            JSON.stringify(reply.after) === '[{"fixture":"bounded"}]' &&
            reply.keys.join(',') === 'get,save,change',
        );
        if (host === settingsHosts[0]) {
          const forged = await settings.webContents.executeJavaScript(`(async()=>{
            let channel;
            const observe=e=>{if(e.data?.kind==='ac-call')channel=e.data.channel};
            window.addEventListener('message',observe);
            await AC_GM_Interface.get('ACBlockRules','[]');
            window.removeEventListener('message',observe);
            const frame=document.createElement('iframe'); document.body.appendChild(frame);
            const data={channel,kind:'ac-call',requestId:'forged',method:'save',key:'ACBlockRules',value:[{forged:true}]};
            window.dispatchEvent(new MessageEvent('message',{data,origin:location.origin,source:frame.contentWindow}));
            window.dispatchEvent(new MessageEvent('message',{data,origin:'https://evil.invalid',source:window}));
            await new Promise(resolve=>setTimeout(resolve,100));
            frame.remove(); return await AC_GM_Interface.get('ACBlockRules','[]');
          })()`);
          check(
            'settingsRejectForeignSourceAndOrigin',
            forged,
            JSON.stringify(forged) === '[{"fixture":"bounded"}]',
          );
          fs.writeFileSync(
            path.join(root, 'settings.png'),
            (await settings.webContents.capturePage()).toPNG(),
          );
        }
      }
      settings.destroy();
    }
    const wrongPath = makeWindow(true);
    await wrongPath.loadURL('https://ac-baidu.90dao.com/other');
    check(
      'settingsWrongPathNoFacade',
      await wrongPath.webContents.executeJavaScript('typeof AC_GM_Interface'),
      await wrongPath.webContents.executeJavaScript("typeof AC_GM_Interface==='undefined'"),
    );
    const reopened = new QualifiedScriptStore(storeOptions);
    check(
      'acReopenPersistence',
      reopened.getValues('ac-baidu').ACBlockRules,
      reopened.getValues('ac-baidu').ACBlockRules === '[{"fixture":"bounded"}]',
    );
    reopened.dispose();
    check(
      'noIflyrecRequests',
      result.network,
      !result.network.some((item) => item.url.includes('iflyrec')),
    );
    runtime.dispose();
    runtime = undefined;
    ipcMain.removeAllListeners('qualified-scripts:prepare');
    ipcMain.removeAllListeners('qualified-scripts:sync');
    ipcMain.removeAllListeners('qualified-scripts:cancel');
    ipcMain.removeHandler('qualified-scripts:request');
    const startupWindow = new BrowserWindow({ show: false });
    windows.push(startupWindow);
    startupFeature = createQualifiedScriptFeature({
      win: startupWindow,
      dataRoot: path.join(root, 'startup-data'),
      isOpen: () => false,
      canInitialize: () => true,
      getActiveUserContentsId: () => null,
      openUserTab: () => undefined,
    });
    await startupFeature.ready;
    const startupState = startupFeature.store.list();
    check(
      'builtInFeatureStartup',
      startupState,
      startupState.length === 2 &&
        startupState.every((item) => item.installed && item.enabled && item.issue === null),
    );
    check(
      'runtimeRemainsAdmissionClosed',
      startupFeature.runtime.prepare({ sender: { id: -1 } } as never, {}),
      startupFeature.runtime.prepare({ sender: { id: -1 } } as never, {}).length === 0,
    );
    startupFeature.dispose();
    startupFeature = undefined;
    startupWindow.destroy();
    finish();
  })
  .catch(finish);
