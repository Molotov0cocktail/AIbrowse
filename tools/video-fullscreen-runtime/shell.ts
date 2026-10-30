import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { app, BrowserWindow, WebContentsView, screen } from 'electron';
import { nativeInput } from './input';

const root = __dirname;
const profile = join(root, 'profile');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const appWithPath = app as typeof app & { setAppPath(path: string): void };
appWithPath.setAppPath(process.cwd());
process.env.AIBROWSE_USER_DATA_DIR = profile;
let requests = 0;
let win: BrowserWindow | undefined;
const report: {
  passed: boolean;
  requests: number;
  providerCalls: number;
  checks: string[];
  error?: string;
} = { passed: false, requests: 0, providerCalls: 0, checks: [] };
const server = createServer((_request, response) => {
  requests += 1;
  writeFileSync(
    join(root, 'requests.json'),
    JSON.stringify({ requests, providerCalls: 0 }, null, 2),
  );
  if (requests > 40) {
    response.writeHead(429).end();
    finish(new Error('本机请求超预算'));
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(
    '<!doctype html><title>真实壳全屏夹具</title><style>body{margin:0}button{width:240px;height:80px}</style><button onclick="document.querySelector(\'section\').requestFullscreen()">全屏</button><section style="background:navy;color:white">视频容器</section>',
  );
});
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = performance.now() + 10000;
  while (performance.now() < end) {
    if (await test()) return;
    await pause(50);
  }
  throw new Error(`等待超时：${label}`);
}
function finish(error?: unknown): void {
  report.passed = !error;
  report.requests = requests;
  if (error) report.error = error instanceof Error ? error.message : String(error);
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
  server.close();
  app.quit();
}
setTimeout(() => finish(new Error('超过180秒预算')), 175000);
app.on('browser-window-created', (_event, value) => {
  win ??= value;
});
void new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  .then(async () => {
    const address = server.address();
    assert(address && typeof address !== 'string');
    createRequire(join(process.cwd(), 'package.json'))(join(process.cwd(), 'out/main/index.js'));
    await until(
      async () =>
        Boolean(
          win &&
          !win.webContents.isLoading() &&
          (await win.webContents.executeJavaScript('!!window.aibrowse')),
        ),
      '应用bridge',
    );
    const owner = win!;
    const js = (script: string): Promise<unknown> => owner.webContents.executeJavaScript(script);
    await until(
      async () => Boolean(await js('window.aibrowse.tabs.getState().then(s=>s.tabs.length>0)')),
      '应用初始化首标签',
    );
    await pause(500);
    await js(`window.aibrowse.tabs.create(${JSON.stringify(`http://127.0.0.1:${address.port}/`)})`);
    let remote: WebContentsView | undefined;
    await until(() => {
      remote = owner.contentView.children.find(
        (child): child is WebContentsView =>
          child instanceof WebContentsView &&
          child.webContents.getURL().startsWith(`http://127.0.0.1:${address.port}`),
      );
      return Boolean(remote && !remote.webContents.isLoading());
    }, '本机视频页');
    await js("document.querySelector('.ai-toggle').click()");
    await pause(500);
    const before = remote!.getBounds();
    const wc = remote!.webContents;
    owner.show();
    owner.focus();
    wc.focus();
    await pause(200);
    if (process.argv.includes('--native')) {
      const bounds = owner.getContentBounds();
      const at = screen.dipToScreenPoint({
        x: bounds.x + before.x + 100,
        y: bounds.y + before.y + 40,
      });
      await nativeInput(owner, 'Click', at.x, at.y);
    } else {
      wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: 100, y: 40 });
      wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 100, y: 40 });
    }
    await until(
      async () =>
        owner.isFullScreen() && Boolean(await wc.executeJavaScript('!!document.fullscreenElement')),
      '真实壳进入全屏',
    );
    await pause(750);
    const [width, height] = owner.getContentSize();
    assert.deepEqual(remote!.getBounds(), { x: 0, y: 0, width, height });
    report.checks.push('侧栏打开时全屏覆盖完整窗口且ResizeObserver不缩回正文区');
    if (process.argv.includes('--native')) await nativeInput(owner, 'Escape');
    else {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    }
    await until(
      async () =>
        !owner.isFullScreen() && !(await wc.executeJavaScript('!!document.fullscreenElement')),
      '真实壳Escape退出',
    );
    await pause(750);
    assert.deepEqual(remote!.getBounds(), before);
    assert.equal(await js("!!document.querySelector('.ai-panel')"), true);
    report.checks.push('退出恢复侧栏和原内容布局');
    finish();
  })
  .catch((error: unknown) => finish(error));
