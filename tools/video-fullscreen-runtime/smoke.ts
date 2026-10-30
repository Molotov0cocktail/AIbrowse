import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeInput } from './input';
import {
  app,
  BaseWindow,
  WebContentsView,
  webContents,
  screen,
  session,
  type WebContents,
} from 'electron';
import { BrowserControllerImpl } from '../../src/main/browser/browser-controller';
import { AppSessionManager, PERSIST_PARTITION } from '../../src/main/browser/session-manager';
import { initLogger } from '../../src/main/logger';

const root = __dirname;
mkdirSync(join(root, 'profile'), { recursive: true });
app.setPath('userData', join(root, 'profile'));
initLogger(root);
const results: Array<{ name: string; passed: boolean; detail: unknown }> = [];
const decisions: Array<{
  wcId: number;
  permission: string;
  allowed: boolean;
  requestingUrl: string;
  isMainFrame: boolean;
}> = [];
function observePolicy(): void {
  const target = session.fromPartition(PERSIST_PARTITION);
  const install = target.setPermissionRequestHandler.bind(target);
  target.setPermissionRequestHandler = (handler) =>
    install(
      handler === null
        ? null
        : (wc, permission, callback, details) => {
            handler(
              wc,
              permission,
              (allowed) => {
                decisions.push({
                  wcId: wc.id,
                  permission,
                  allowed,
                  requestingUrl: details.requestingUrl,
                  isMainFrame: details.isMainFrame,
                });
                callback(allowed);
              },
              details,
            );
          },
    );
}
const normalBounds = { x: 0, y: 80, width: 900, height: 540 };
function trace(event: string): void {
  if (process.argv.includes('--trace-close'))
    appendFileSync(
      join(root, 'trace.jsonl'),
      JSON.stringify({ event, at: performance.now() }) + '\n',
    );
}
let controller: BrowserControllerImpl | undefined;
let owner: BaseWindow | undefined;
let requests = 0;
let base = '';
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const server = createServer((request, response) => {
  requests += 1;
  writeFileSync(
    join(root, 'requests.json'),
    JSON.stringify({ requests, providerCalls: 0 }, null, 2),
  );
  if (requests > 40) {
    response.writeHead(429).end();
    throw new Error('本机请求预算超限');
  }
  const mode =
    new URL(request.url ?? '/', 'http://localhost').searchParams.get('mode') ?? 'container';
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(
    `<!doctype html><title>全屏验收</title><style>body{margin:0}button{width:240px;height:80px}iframe{border:0;width:800px;height:400px}video{width:300px;height:180px}</style>${
      mode.startsWith('iframe')
        ? `<iframe ${mode === 'iframe' ? 'allowfullscreen' : ''} src="${base.replace('127.0.0.1', 'localhost')}/?mode=container"></iframe>`
        : `<button id="enter" aria-expanded="false">进入全屏</button><section id="player"><video id="video" muted autoplay playsinline></video><button id="exit">退出全屏</button></section><script>
  const canvas=document.createElement('canvas'); canvas.width=300;canvas.height=180;
  canvas.getContext('2d').fillRect(0,0,300,180);video.srcObject=canvas.captureStream(1);
  window.attempted=0;window.denied=0;
  function enter(){window.attempted++;document.querySelector('${mode === 'video' ? '#video' : '#player'}').requestFullscreen().catch(()=>window.denied++);}
  document.querySelector('#enter').onclick=()=>enter();
  document.querySelector('#exit').onclick=()=>document.exitFullscreen();
  document.addEventListener('keydown',e=>{if(e.key.toLowerCase()==='f')enter()});
  ${mode === 'escape-block' ? "document.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation()}})" : ''}
  document.addEventListener('click',e=>{window.lastClick=e.target.tagName;window.clickAt=[e.clientX,e.clientY]},true);
  ${mode === 'automatic' ? 'setTimeout(enter,100);' : ''}
  </script>`
    }`,
  );
});
async function until(test: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = performance.now() + 6000;
  while (performance.now() < end) {
    if (await bounded(Promise.resolve().then(test), label, Math.max(1, end - performance.now())))
      return;
    await pause(30);
  }
  throw new Error(`等待超时：${label}`);
}
async function bounded<T>(value: Promise<T>, label: string, budget = 6000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`探针超时：${label}`)), budget);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function contents(id: string): WebContents {
  const wc = webContents.fromId(controller!.getOwnedWebContentsId(id)!);
  assert(wc);
  return wc;
}
function view(wc: WebContents): WebContentsView {
  const value = owner!.contentView.children.find(
    (child) => child instanceof WebContentsView && child.webContents.id === wc.id,
  );
  assert(value instanceof WebContentsView);
  return value;
}
async function read(wc: WebContents): Promise<unknown> {
  return bounded(
    wc.executeJavaScript(
      '({fullscreen:!!document.fullscreenElement,enabled:document.fullscreenEnabled,tag:document.fullscreenElement?.tagName,attempted:window.attempted,denied:window.denied,lastClick:window.lastClick,clickAt:window.clickAt,button:document.querySelector("#enter")?.getBoundingClientRect().toJSON(),at:document.elementFromPoint(100,40)?.tagName})',
    ),
    '页面诊断',
  ).catch((error: unknown) => ({
    probeError: error instanceof Error ? error.message : String(error),
  }));
}
async function click(wc: WebContents, x = 100, y = 40): Promise<void> {
  if (process.argv.includes('--offset')) {
    const bounds = view(wc).getBounds();
    x += bounds.x;
    y += bounds.y;
  }
  owner!.focus();
  wc.focus();
  await pause(120);
  if (process.argv.includes('--native')) {
    const bounds = owner!.getContentBounds();
    const childBounds = view(wc).getBounds();
    const at = screen.dipToScreenPoint({
      x: bounds.x + childBounds.x + x,
      y: bounds.y + childBounds.y + y,
    });
    await nativeInput(owner!, 'Click', at.x, at.y);
    return;
  }
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
  await pause(30);
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
}
async function key(wc: WebContents, keyCode: string): Promise<void> {
  owner!.focus();
  wc.focus();
  await pause(120);
  if (process.argv.includes('--native')) {
    assert(keyCode === 'F' || keyCode === 'Escape');
    await nativeInput(owner!, keyCode);
    return;
  }
  wc.sendInputEvent({ type: 'keyDown', keyCode });
  wc.sendInputEvent({ type: 'keyUp', keyCode });
}
async function loaded(wc: WebContents): Promise<void> {
  await until(() => wc.getTitle() === '全屏验收' && !wc.isLoading(), '夹具载入');
  await pause(150);
}
async function entered(wc: WebContents): Promise<void> {
  await until(
    async () =>
      Boolean(await wc.executeJavaScript('!!document.fullscreenElement')) && owner!.isFullScreen(),
    'DOM与窗口同时进入全屏',
  );
  await until(() => {
    const [width, height] = owner!.getContentSize();
    const b = view(wc).getBounds();
    return b.x === 0 && b.y === 0 && b.width === width && b.height === height;
  }, '视图覆盖窗口完整内容区');
}
async function exited(wc?: WebContents): Promise<void> {
  await until(
    async () =>
      !owner!.isFullScreen() &&
      (!wc || wc.isDestroyed() || !(await wc.executeJavaScript('!!document.fullscreenElement'))),
    'DOM与窗口退出全屏',
  );
}
async function scenario(name: string): Promise<void> {
  controller = new BrowserControllerImpl({
    ownerWindow: owner!,
    sessionManager: new AppSessionManager(),
    getFallbackBounds: () => normalBounds,
  });
  controller.setContentBounds(normalBounds);
  let detail: unknown;
  let observed: WebContents | undefined;
  const timeline: unknown[] = [];
  const capture = (event: string): void => {
    if (timeline.length < 50)
      timeline.push({
        event,
        at: performance.now(),
        window: owner!.getContentBounds(),
        size: owner!.getContentSize(),
        contentView: owner!.contentView.getBounds(),
        view: observed && !observed.isDestroyed() ? view(observed).getBounds() : null,
      });
  };
  const resize = (): void => capture('resize');
  const windowEnter = (): void => capture('enter-full-screen');
  owner!.on('resize', resize);
  owner!.on('enter-full-screen', windowEnter);
  try {
    const mode =
      name === 'iframe-noallow' || name === 'escape-block'
        ? name
        : name === 'video'
          ? 'video'
          : name === 'iframe'
            ? 'iframe'
            : name === 'automatic'
              ? 'automatic'
              : 'container';
    const tab =
      name === 'task'
        ? await controller.createTaskTab(`${base}/?mode=${mode}`)
        : await controller.createTab(`${base}/?mode=${mode}`);
    const wc = contents(tab.id);
    if (process.argv.includes('--trace-close')) {
      const close = wc.close.bind(wc);
      wc.close = (...args: Parameters<WebContents['close']>) => {
        trace('wc.close:before');
        close(...args);
        trace('wc.close:after');
      };
      wc.on('destroyed', () => trace('wc.destroyed'));
      wc.on('leave-html-full-screen', () => trace('wc.leave-html-full-screen'));
    }
    let enterEvents = 0;
    wc.on('enter-html-full-screen', () => {
      enterEvents += 1;
      capture('enter-html-full-screen');
    });
    wc.on('before-mouse-event', (_event, input) => process.stdout.write(`mouse:${input.type}\n`));
    wc.on('before-input-event', (_event, input) => process.stdout.write(`key:${input.key}\n`));
    observed = wc;
    await loaded(wc);
    process.stdout.write(
      `initial:${JSON.stringify({ page: await read(wc), bounds: view(wc).getBounds(), visible: view(wc).getVisible(), focused: owner!.isFocused() })}\n`,
    );
    if (name === 'background') {
      const other = await controller.createTab(`${base}/?mode=container`);
      await loaded(contents(other.id));
      await wc.executeJavaScript('enter()', true);
    } else if (name === 'ai') {
      const snapshot = await controller.getPageSnapshot(tab.id);
      assert(snapshot);
      const button = snapshot.buttons.find((element) => element.text === '进入全屏');
      assert(button);
      const action = await controller.clickElement(
        tab.id,
        button.id,
        'expand',
        snapshot.meta.documentId,
      );
      assert.equal(action.ok, true, 'AI点击本身必须执行，拒绝发生在全屏请求');
      detail = action;
    } else if (name === 'task') {
      // Adversarial activation is only used for rejection; task tabs have no user surface.
      await wc.executeJavaScript('enter()', true);
    } else if (name === 'keyboard') await key(wc, 'F');
    else if (name !== 'automatic') await click(wc);
    if (['automatic', 'background', 'task', 'ai', 'iframe-noallow'].includes(name)) {
      const frame = name === 'iframe-noallow' ? wc.mainFrame.frames[0] : wc.mainFrame;
      assert(frame);
      await until(
        async () =>
          Boolean(await frame.executeJavaScript('window.attempted>0')) &&
          (decisions.some(
            (decision) =>
              decision.wcId === wc.id && decision.permission === 'fullscreen' && !decision.allowed,
          ) ||
            Boolean(await frame.executeJavaScript('window.denied===window.attempted'))),
        '实际请求经产品callback拒绝或内核拒绝',
      );
      await exited(wc);
      assert.equal(enterEvents, 0);
      assert(!decisions.some((decision) => decision.wcId === wc.id && decision.allowed));
      assert.deepEqual(view(wc).getBounds(), normalBounds);
      const count = decisions.filter((decision) => decision.wcId === wc.id).length;
      if (name === 'background') {
        await controller.activateTab(tab.id);
        await pause(350);
        await exited(wc);
        assert.equal(enterEvents, 0);
        assert.equal(decisions.filter((decision) => decision.wcId === wc.id).length, count);
      }
      detail = {
        action: detail,
        page: await read(wc),
        enterEvents,
        decisions: decisions.filter((decision) => decision.wcId === wc.id),
      };
    } else {
      await entered(wc);
      assert(
        decisions.some(
          (decision) =>
            decision.wcId === wc.id && decision.permission === 'fullscreen' && decision.allowed,
        ),
      );
      detail = { entered: await read(wc), bounds: view(wc).getBounds(), timeline };
      if (name === 'switch') {
        const other = await controller.createTab(`${base}/?mode=container`);
        await loaded(contents(other.id));
        await exited(wc);
        await controller.activateTab(tab.id);
      } else if (name === 'navigate') {
        await controller.navigate(tab.id, `${base}/?mode=video`);
        await loaded(wc);
      } else if (name === 'close') {
        trace('controller.closeTab:before');
        await bounded(controller.closeTab(tab.id), '关闭标签');
        trace('controller.closeTab:after');
        observed = undefined;
        await exited();
        await until(() => wc.isDestroyed(), '精确旧WC销毁');
      } else if (name === 'page-close' || name === 'destroyed' || name === 'dispose') {
        if (name === 'page-close') void wc.executeJavaScript('window.close()').catch(() => {});
        else if (name === 'destroyed') wc.close({ waitForBeforeUnload: false });
        else controller.dispose();
        observed = undefined;
        await exited();
        await until(() => wc.isDestroyed(), '特殊终止路径精确旧WC销毁');
      } else if (name === 'owner-hide' || name === 'minimize') {
        if (name === 'owner-hide') owner!.hide();
        else owner!.minimize();
        await exited(wc);
        await pause(350);
        if (name === 'owner-hide')
          assert.equal(owner!.isVisible(), false, '全屏退出不得重新显示隐藏窗口');
        else assert.equal(owner!.isMinimized(), true, '全屏退出不得恢复已最小化窗口');
        if (name === 'owner-hide') owner!.show();
        else owner!.restore();
        await until(() => owner!.isVisible() && !owner!.isMinimized(), '恢复可见窗口');
        assert.deepEqual(view(wc).getBounds(), normalBounds, '恢复可见后保持普通布局');
        await click(wc);
        await entered(wc);
        assert.equal(
          decisions.filter(
            (decision) =>
              decision.wcId === wc.id && decision.permission === 'fullscreen' && decision.allowed,
          ).length,
          2,
          '恢复后新的实体手势再次获得权限',
        );
        await key(wc, 'Escape');
      } else if (name === 'hide') {
        controller.setContentVisible(false);
        await exited(wc);
        controller.setContentVisible(true);
      } else if (name === 'page-exit') await wc.executeJavaScript('document.exitFullscreen()');
      else await key(wc, 'Escape');
      if (!['close', 'page-close', 'destroyed', 'dispose'].includes(name)) await exited(wc);
      if (!wc.isDestroyed())
        assert.deepEqual(view(wc).getBounds(), normalBounds, '退出恢复普通布局');
    }
    results.push({ name, passed: true, detail });
  } catch (error) {
    results.push({
      name,
      passed: false,
      detail: {
        detail,
        page: observed && !observed.isDestroyed() ? await read(observed) : null,
        error: error instanceof Error ? error.message : String(error),
        windowFullscreen: owner!.isFullScreen(),
        geometry:
          observed && !observed.isDestroyed()
            ? {
                view: view(observed).getBounds(),
                contentSize: owner!.getContentSize(),
                contentBounds: owner!.getContentBounds(),
              }
            : null,
        decisions: decisions.filter((decision) => decision.wcId === observed?.id),
        timeline,
      },
    });
  } finally {
    capture('complete');
    owner!.removeListener('resize', resize);
    owner!.removeListener('enter-full-screen', windowEnter);
    writeFileSync(join(root, 'partial.json'), JSON.stringify({ requests, results }, null, 2));
    controller.dispose();
    controller = undefined;
    owner!.setFullScreen(false);
    await pause(150);
  }
}
function finish(code: number, error?: unknown): void {
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify(
      {
        passed: code === 0,
        requests,
        providerCalls: 0,
        results,
        error: error instanceof Error ? error.message : error,
      },
      null,
      2,
    ),
  );
  controller?.dispose();
  server.close();
  app.exit(code);
}
const budgetMs = Number(
  process.argv.find((argument) => argument.startsWith('--budget-ms='))?.slice(12) ?? 180000,
);
setTimeout(() => finish(2, '超过内部运行预算'), budgetMs - 1000);
void app
  .whenReady()
  .then(async () => {
    observePolicy();
    owner = new BaseWindow({ width: 900, height: 700, show: true, title: 'AIbrowse 视频全屏验收' });
    if (process.argv.includes('--trace-close')) {
      const set = owner.setFullScreen.bind(owner);
      owner.setFullScreen = (value: boolean) => {
        trace(`owner.setFullScreen(${value}):before`);
        set(value);
        trace(`owner.setFullScreen(${value}):after`);
      };
      const remove = owner.contentView.removeChildView.bind(owner.contentView);
      owner.contentView.removeChildView = (child) => {
        trace('removeChildView:before');
        remove(child);
        trace('removeChildView:after');
      };
      owner.on('leave-full-screen', () => trace('owner.leave-full-screen'));
      setInterval(() => trace('heartbeat'), 500).unref();
    }
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
    const only = process.argv.find((argument) => argument.startsWith('--case='))?.slice(7);
    const cases = process.argv.includes('--negative')
      ? ['automatic', 'background', 'task', 'ai']
      : only
        ? [only]
        : process.argv.includes('--red')
          ? ['video']
          : [
              'video',
              'container',
              'keyboard',
              'iframe',
              'iframe-noallow',
              'escape-block',
              'page-exit',
              'switch',
              'navigate',
              'close',
              'hide',
              'automatic',
              'background',
              'task',
              'ai',
            ];
    for (const name of cases) await scenario(name);
    finish(results.every((result) => result.passed) ? 0 : 1);
  })
  .catch((error: unknown) => finish(1, error));
