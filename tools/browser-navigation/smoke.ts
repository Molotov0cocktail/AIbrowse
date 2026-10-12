import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { app, BaseWindow, screen, session, webContents, type WebContents } from 'electron';
import { BrowserControllerImpl } from '../../src/main/browser/browser-controller';
import type { SessionManager } from '../../src/main/browser/session-manager';
import { initLogger } from '../../src/main/logger';

const root = __dirname;
mkdirSync(join(root, 'profile'), { recursive: true });
app.setPath('userData', join(root, 'profile'));
initLogger(root);
const results: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
let controller: BrowserControllerImpl | undefined;
let owner: BaseWindow | undefined;
let nativeWindows = 0;
const inputEvents: string[] = [];
const server = createServer((request, response) => {
  const mode = new URL(request.url ?? '/', 'http://localhost').searchParams.get('mode') ?? 'normal';
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url?.startsWith('/target')) {
    response.end('<title>已到目标页</title>安全目标');
    return;
  }
  const link = `<a id="link" style="display:block;width:200px;height:50px" href="/target" ${mode === 'normal' || mode === 'ctrl' ? '' : 'target="_blank"'}>安全目标链接</a>`;
  const html =
    mode === 'iframe'
      ? '<iframe src="/?mode=blank" style="width:400px;height:150px;border:0"></iframe>'
      : mode === 'script'
        ? `${link}<script>setTimeout(()=>{document.documentElement.dataset.attempted='1';window.open('/target')},50)</script>`
        : mode === 'dangerous'
          ? '<button style="width:200px;height:50px" onclick="window.open(\'file:///C:/private\')">危险目标</button>'
          : mode === 'post'
            ? '<form method="post" action="/target" target="_blank"><button style="width:200px;height:50px">提交</button></form>'
            : link;
  response.end(
    `<!doctype html><title>导航夹具</title>${html}<script>document.addEventListener('click',()=>document.documentElement.dataset.clicked='1',true)</script>`,
  );
});
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (await test()) return;
    await pause(25);
  }
  throw new Error('限定等待未满足');
}
function contents(id: string): WebContents {
  const value = webContents.fromId(controller!.getOwnedWebContentsId(id)!);
  assert(value);
  return value;
}
function createController(): BrowserControllerImpl {
  const sharedSession = session.fromPartition('browser-navigation-smoke');
  sharedSession.setPermissionCheckHandler(() => false);
  sharedSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  sharedSession.on('will-download', (event) => event.preventDefault());
  return new BrowserControllerImpl({
    ownerWindow: owner!,
    sessionManager: { getSession: () => sharedSession } as SessionManager,
    getFallbackBounds: () => ({ x: 0, y: 0, width: 1000, height: 740 }),
  });
}
async function click(
  wc: WebContents,
  modifiers: Electron.InputEvent['modifiers'] = [],
  x = 30,
  y = 30,
): Promise<void> {
  owner!.focus();
  wc.focus();
  await pause(100);
  wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
  await pause(50);
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y, modifiers });
  await pause(30);
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y, modifiers });
}
async function localCase(mode: string, base: string): Promise<void> {
  controller = createController();
  try {
    const tab =
      mode === 'task'
        ? await controller.createTaskTab(`${base}/?mode=blank`)
        : await controller.createTab(`${base}/?mode=${mode}`);
    const wc = contents(tab.id);
    wc.on('console-message', (details) => {
      process.stdout.write(`fixture-console:${details.message}\n`);
    });
    wc.on('before-mouse-event', (_event, mouse) => inputEvents.push(mouse.type));
    await until(() => wc.getTitle() === '导航夹具' && !wc.isLoading());
    if (mode === 'ai') {
      const snapshot = await controller.getPageSnapshot(tab.id);
      assert(snapshot?.links[0]);
      const result = await controller.clickElement(
        tab.id,
        snapshot.links[0].id,
        'nav',
        snapshot.meta.documentId,
      );
      assert.equal(result.ok, true);
    } else if (mode !== 'script') {
      const point: unknown = await wc.executeJavaScript(
        `(() => {const frame=document.querySelector('iframe'); const a=(frame?frame.contentDocument:document).querySelector('a,button');const r=a.getBoundingClientRect();const f=frame?frame.getBoundingClientRect():{x:0,y:0};return {x:Math.round(f.x+r.x+r.width/2),y:Math.round(f.y+r.y+r.height/2)};})()`,
      );
      assert(
        point &&
          typeof point === 'object' &&
          'x' in point &&
          typeof point.x === 'number' &&
          'y' in point &&
          typeof point.y === 'number',
      );
      if (mode === 'iframe') {
        owner!.focus();
        wc.focus();
        const bounds = owner!.getContentBounds();
        const absolute = screen.dipToScreenPoint({ x: bounds.x + point.x, y: bounds.y + point.y });
        const native = spawn(
          'pwsh.exe',
          [
            '-NoProfile',
            '-File',
            join(process.cwd(), 'tools/browser-navigation/native-click.ps1'),
            '-TargetWindow',
            owner!.getNativeWindowHandle().readBigUInt64LE().toString(),
            '-TargetProcess',
            String(process.pid),
            '-ScreenX',
            String(absolute.x),
            '-ScreenY',
            String(absolute.y),
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let nativeError = '';
        native.stderr.on('data', (chunk: Buffer) => {
          nativeError = (nativeError + chunk.toString()).slice(0, 1200);
        });
        const nativeExit = await new Promise<number | null>((resolveExit, reject) => {
          const stop = setTimeout(() => {
            native.kill();
            reject(new Error('原生输入超过五秒预算'));
          }, 5000);
          native.once('error', (error) => {
            clearTimeout(stop);
            reject(error);
          });
          native.once('exit', (code) => {
            clearTimeout(stop);
            resolveExit(code);
          });
        });
        assert.equal(nativeExit, 0, nativeError);
      } else await click(wc, mode === 'ctrl' ? ['control'] : [], point.x, point.y);
      if (process.argv.some((argument) => argument.startsWith('--diagnostic'))) {
        await pause(300);
        writeFileSync(join(root, 'fixture.png'), (await wc.capturePage()).toPNG());
        writeFileSync(
          join(root, 'fixture.json'),
          JSON.stringify(
            {
              point,
              page: await wc.executeJavaScript(
                '({url:location.href,html:document.documentElement.outerHTML,frame:document.querySelector("iframe")?.contentDocument.documentElement.outerHTML,focus:document.hasFocus()})',
              ),
            },
            null,
            2,
          ),
        );
      }
    }
    if (['blank', 'ctrl', 'iframe'].includes(mode)) {
      await until(async () => (await controller!.getTabs()).length === 2);
      const tabs = await controller.getTabs();
      await until(() => contents(tabs[1]!.id).getURL().endsWith('/target'));
      assert.equal((await controller.getActiveTab())?.id, mode === 'ctrl' ? tab.id : tabs[1]!.id);
      assert.equal(await contents(tabs[1]!.id).executeJavaScript('window.opener === null'), true);
      assert.equal(
        await contents(tabs[1]!.id).executeJavaScript(
          "typeof require === 'undefined' && typeof process === 'undefined' && typeof window.electron === 'undefined'",
        ),
        true,
      );
    } else if (mode === 'normal') await until(() => wc.getURL().endsWith('/target'));
    else {
      await until(
        async () =>
          (await wc.executeJavaScript(
            mode === 'script'
              ? "document.documentElement.dataset.attempted === '1'"
              : "document.documentElement.dataset.clicked === '1'",
          )) === true,
      );
      assert.equal((await controller.getTabs()).length, 1);
      assert.equal(
        await wc.executeJavaScript(
          mode === 'script'
            ? "document.documentElement.dataset.attempted === '1'"
            : "document.documentElement.dataset.clicked === '1'",
        ),
        true,
      );
    }
    assert.equal(nativeWindows, 0);
    results.push({ name: mode, passed: true });
  } catch (error) {
    results.push({
      name: mode,
      passed: false,
      detail: error instanceof Error ? error.message : '未知错误',
    });
  } finally {
    controller.dispose();
    controller = undefined;
  }
}
async function realBing(): Promise<void> {
  controller = createController();
  const detail: Record<string, unknown> = { queries: 1, resultClicks: 0, providerCalls: 0 };
  try {
    const tab = await controller.createTab('https://www.bing.com/search?q=bilibili');
    const wc = contents(tab.id);
    await until(() => !wc.isLoadingMainFrame() && wc.getURL().startsWith('https://'), 20000);
    const found: unknown = await wc.executeJavaScript(
      `(() => { const a = [...document.querySelectorAll('li.b_algo h2 a')].find(a => /bilibili|哔哩哔哩/i.test(a.textContent)); if (!a) return null; a.scrollIntoView({block:'center'}); const r=a.getBoundingClientRect(); return {x:Math.round(r.x+Math.min(r.width/2,80)),y:Math.round(r.y+r.height/2),target:a.target,href:a.href}; })()`,
    );
    assert(
      found &&
        typeof found === 'object' &&
        'x' in found &&
        typeof found.x === 'number' &&
        'y' in found &&
        typeof found.y === 'number' &&
        'target' in found &&
        'href' in found &&
        typeof found.href === 'string',
    );
    detail.target = found.target;
    detail.resultHost = new URL(found.href).hostname;
    detail.resultClicks = 1;
    await click(wc, [], found.x, found.y);
    await until(
      async () =>
        (await controller!.getTabs()).some((candidate) =>
          /(^|\.)bilibili\.com$/u.test(new URL(candidate.url).hostname),
        ),
      25000,
    );
    const tabs = await controller.getTabs();
    const destination = tabs.find((candidate) =>
      /(^|\.)bilibili\.com$/u.test(new URL(candidate.url).hostname),
    );
    assert(destination);
    detail.destinationHost = new URL(destination.url).hostname;
    detail.newTab = destination.id !== tab.id;
    detail.tabCount = tabs.length;
    assert.equal(nativeWindows, 0);
    results.push({ name: '真实Bing到bilibili', passed: true, detail });
  } catch (error) {
    results.push({
      name: '真实Bing到bilibili',
      passed: false,
      detail: { ...detail, error: error instanceof Error ? error.message : '未知错误' },
    });
  } finally {
    controller.dispose();
    controller = undefined;
  }
}
const deadline = setTimeout(() => {
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify({ passed: false, deadlineExceeded: true, results, inputEvents }, null, 2),
  );
  app.exit(2);
}, 90000);
void app
  .whenReady()
  .then(async () => {
    owner = new BaseWindow({ width: 1000, height: 800, title: 'AIbrowse 导航验证', show: true });
    app.on('browser-window-created', () => {
      nativeWindows += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    for (const mode of process.argv.includes('--real-only')
      ? []
      : process.argv.includes('--diagnostic-iframe')
        ? ['iframe']
        : process.argv.includes('--diagnostic')
          ? ['blank']
          : ['normal', 'blank', 'ctrl', 'iframe', 'script', 'dangerous', 'post', 'task', 'ai'])
      await localCase(mode, `http://127.0.0.1:${address.port}`);
    if (process.argv.includes('--real-bing')) await realBing();
    const passed = results.every((result) => result.passed);
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify({ passed, results, nativeWindows, inputEvents }, null, 2),
    );
    clearTimeout(deadline);
    server.close();
    owner.close();
    app.exit(passed ? 0 : 1);
  })
  .catch((error: unknown) => {
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify(
        { passed: false, error: error instanceof Error ? error.message : '未知错误', results },
        null,
        2,
      ),
    );
    controller?.dispose();
    clearTimeout(deadline);
    server.close();
    app.exit(1);
  });
