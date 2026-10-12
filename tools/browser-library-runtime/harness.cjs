/* global process, require, setTimeout, clearTimeout */
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { app, screen } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join, resolve, relative } = require('node:path');
const { spawn } = require('node:child_process');
const root = resolve(process.argv[2]);
const phase = process.argv[3];
const input = JSON.parse(readFileSync(join(root, 'input.json'), 'utf8'));
assert(['write', 'reopen'].includes(phase));
assert(
  !relative(resolve(input.repository, 'log/browser-settings-20261012'), root).startsWith('..'),
);
app.setPath('userData', join(root, 'profile'));
app.setPath('sessionData', join(root, 'session'));
app.setAppPath(input.repository);
process.env.AIBROWSE_USER_DATA_DIR = join(root, 'profile');
const report = { phase, passed: false, willQuit: false, checks: [], error: null };
const persist = () => writeFileSync(join(root, `${phase}.json`), JSON.stringify(report, null, 2));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(work) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try {
      const x = await work();
      if (x) return x;
    } catch {
      /* Startup can precede the authorized document. */
    }
    await delay(100);
  }
  throw new Error('有界等待未满足');
}
let win;
let started = false;
const timer = setTimeout(() => {
  report.error = '运行超过90秒';
  persist();
  app.exit(1);
}, 90000);
async function nativeInput(x, y, end) {
  const bounds = win.getContentBounds();
  const point = screen.dipToScreenPoint({
    x: bounds.x + Math.round(x),
    y: bounds.y + Math.round(y),
  });
  const args = [
    '-NoProfile',
    '-File',
    join(input.repository, 'tools/browser-library-runtime/native-input.ps1'),
    '-TargetWindow',
    String(win.getNativeWindowHandle().readBigUInt64LE()),
    '-TargetProcess',
    String(process.pid),
    '-X',
    String(point.x),
    '-Y',
    String(point.y),
  ];
  if (end) {
    const target = screen.dipToScreenPoint({ x: bounds.x + end.x, y: bounds.y + end.y });
    args.push('-EndX', String(target.x), '-EndY', String(target.y));
  }
  win.focus();
  await delay(200);
  const child = spawn('pwsh.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stdout.on('data', (chunk) => {
    diagnostic = (diagnostic + chunk.toString()).slice(0, 4096);
  });
  child.stderr.on('data', (chunk) => {
    diagnostic = (diagnostic + chunk.toString()).slice(0, 4096);
  });
  child.once('close', () => {
    report.nativeInput = diagnostic;
    persist();
  });
  assert.equal(
    await new Promise((r, reject) => {
      child.once('error', reject);
      child.once('close', r);
    }),
    0,
  );
}
async function run() {
  const js = (source) => win.webContents.executeJavaScript(source, true);
  const list = () =>
    js(`window.aibrowse.browserLibrary.listHistory({query:'',cursor:null,limit:100})`);
  await until(
    async () => (await js(`window.aibrowse.browserLibrary.getStatus()`)).state === 'available',
  );
  const first = `${input.base}/one?private=synthetic#section`;
  if (phase === 'write') {
    const tab = await js(`window.aibrowse.tabs.create(${JSON.stringify(first)})`);
    await until(async () => {
      const h = await list();
      return (
        h.ok && h.value.items.some((item) => item.url === first && item.title === '重启浏览夹具一')
      );
    });
    assert.equal((await js('window.aibrowse.browserLibrary.addCurrentBookmark()')).ok, true);
    await js(
      `window.aibrowse.nav.navigate(${JSON.stringify(tab.id)},${JSON.stringify(input.base + '/two')})`,
    );
    await until(async () => {
      const h = await list();
      return h.ok && h.value.items.length === 2;
    });
    await js(`window.aibrowse.nav.back(${JSON.stringify(tab.id)})`);
    await until(async () => {
      const h = await list();
      return (
        h.ok &&
        h.value.items.length === 3 &&
        h.value.items[0].url === first &&
        h.value.items[0].title === '重启浏览夹具一'
      );
    });
    report.checks.push('真实主框架访问/标题/后退历史', '收藏当前真实网页');
    const bounds = win.getBounds();
    report.physicalInput = input.physicalInput
      ? 'RUNNING'
      : 'NOTRUN: Windows前台资格校验拒绝，原件保留';
    if (input.physicalInput) await nativeInput(420, 18, { x: 484, y: 50 });
    else win.setPosition(bounds.x + 64, bounds.y + 32);
    const moved = win.getBounds();
    report.drag = { before: bounds, after: moved };
    persist();
    assert(Math.abs(moved.x - bounds.x) >= 40 && Math.abs(moved.y - bounds.y) >= 20);
    report.checks.push(
      input.physicalInput ? '顶栏空白区原生拖动' : '原生窗口API移动（不代表鼠标拖动）',
    );
    const overlay = await js(
      `(() => { const r=navigator.windowControlsOverlay.getTitlebarAreaRect(); return {x:r.x,width:r.width,height:r.height,visible:navigator.windowControlsOverlay.visible}; })()`,
    );
    assert(overlay.visible && overlay.height >= 30);
    const [width] = win.getContentSize();
    const left = overlay.x + overlay.width;
    const buttonWidth = (width - left) / 3;
    if (input.physicalInput) await nativeInput(left + buttonWidth / 2, 18);
    else win.minimize();
    await until(() => win.isMinimized());
    win.restore();
    await until(() => !win.isMinimized());
    if (input.physicalInput) await nativeInput(left + buttonWidth * 1.5, 18);
    else win.maximize();
    await until(() => win.isMaximized());
    win.unmaximize();
    await until(() => !win.isMaximized());
    const restored = win.getBounds();
    assert(Math.abs(restored.x - moved.x) <= 2 && Math.abs(restored.y - moved.y) <= 2);
    assert(
      Math.abs(restored.width - moved.width) <= 2 && Math.abs(restored.height - moved.height) <= 2,
    );
    report.checks.push(
      input.physicalInput ? '原生最小化与最大化按钮' : '原生窗口API最小化/恢复/最大化/还原',
    );
    report.passed = true;
    persist();
    if (input.physicalInput) {
      report.physicalInput = 'PASS';
      persist();
      await nativeInput(left + buttonWidth * 2.5, 18);
    } else win.close();
  } else {
    const history = await list();
    const bookmarks = await js(
      `window.aibrowse.browserLibrary.listBookmarks({query:'',cursor:null,limit:100})`,
    );
    assert(
      history.ok &&
        history.value.items.length === 3 &&
        history.value.items.some((item) => item.url === first),
    );
    assert(
      bookmarks.ok && bookmarks.value.items.length === 1 && bookmarks.value.items[0].url === first,
    );
    assert(
      history.value.items.every(
        (item) => item.title === (item.url === first ? '重启浏览夹具一' : '重启浏览夹具二'),
      ),
    );
    assert.equal(bookmarks.value.items[0].title, '重启浏览夹具一');
    report.checks.push('完整退出后复启历史/标题/书签保持');
    assert.equal((await js('window.aibrowse.browserLibrary.clearHistory()')).ok, true);
    assert.equal((await list()).value.items.length, 0);
    assert.equal(
      (await js(`window.aibrowse.browserLibrary.listBookmarks({query:'',cursor:null,limit:100})`))
        .value.items.length,
      1,
    );
    report.checks.push('清空历史不影响书签');
    report.passed = true;
    persist();
    win.close();
  }
}
app.on('browser-window-created', (_event, value) => {
  if (started) return;
  started = true;
  win = value;
  void run().catch((error) => {
    report.error = error.stack;
    persist();
    app.quit();
  });
});
app.on('will-quit', () => {
  report.willQuit = true;
  clearTimeout(timer);
  persist();
});
process.on('exit', () => persist());
persist();
require(join(input.repository, 'out/main/index.js'));
