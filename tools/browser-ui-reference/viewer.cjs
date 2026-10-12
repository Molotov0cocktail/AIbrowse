/* global __dirname, clearTimeout, require, setTimeout */
// This isolated viewer creates visible reference screenshots, not product acceptance evidence.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, BrowserWindow, session } = require('electron');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { mkdirSync, writeFileSync } = require('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { join, resolve } = require('node:path');

const targets = [
  [
    'chrome',
    'https://www.google.com/chrome/',
    'https://www.google.com/chrome/static/images/homepage/lpo-chrome_desktop.png',
  ],
  [
    'edge',
    'https://www.microsoft.com/en-us/edge/features/vertical-tabs',
    'https://edgestatic.azureedge.net/shared/cms/lrs1c69a1j/section-images/b3a4b9c39ba04f329671b073b6515c61.png',
  ],
  [
    'firefox',
    'https://support.mozilla.org/en-US/kb/get-started-firefox-overview-main-features',
    'https://assets-prod.sumo.prod.webservices.mozgcp.net/media/uploads/gallery/images/2024-09-25-05-51-36-3464b8.png',
  ],
  [
    'safari',
    'https://www.apple.com/safari/',
    'https://www.apple.com/v/safari/u/images/overview/customization_tab_groups__fpvff7a89d26_large_2x.png',
  ],
  [
    'opera',
    'https://www.opera.com/features/opera-ai',
    'https://media-production-opera-website.operacdn.com/media/images/hero-top-image-mobile.width-320.format-png.png',
  ],
  [
    'brave',
    'https://support.brave.app/hc/en-us/articles/5181998802061-How-do-I-use-Brave-Sidebar',
    'https://support.brave.app/hc/article_attachments/5182240420493',
  ],
  [
    'vivaldi',
    'https://help.vivaldi.com/desktop-sr/panels-sr/panels/',
    'https://help.vivaldi.com/wp-content/uploads/2016/01/8.0_desktop_panel_editor.png',
  ],
  [
    'arc',
    'https://www.appsntips.com/home/arc-browser-review-top-features/',
    'https://storage.ghost.io/c/79/45/794539e9-2a02-4255-8c35-d208fe7cbac5/content/images/2023/03/arc-brower-profiles-and-spaces.jpg',
  ],
  [
    'zen',
    'https://docs.zen-browser.app/user-manual/compact-mode',
    'https://docs.zen-browser.app/_next/static/media/enable-compact-mode.796558c0.png',
  ],
  [
    'floorp',
    'https://docs.floorp.app/docs/features/panel-sidebar/',
    'https://docs.floorp.app/assets/images/split-2fd6abc7dd3933108b01436e2440795e.webp',
  ],
];

const root = resolve(__dirname, '../..');
const runRoot = join(root, 'log/browser-ux-20261012', `references-${Date.now()}`);
mkdirSync(runRoot, { recursive: true });
app.setPath('userData', join(runRoot, 'profile'));
app.setPath('sessionData', join(runRoot, 'session'));
app.commandLine.appendSwitch('disable-http-cache');
// Keep the bounded runner alive while one completed target window is replaced by the next.
app.on('window-all-closed', () => {});
const report = {
  purpose: '十款浏览器参考图的可见画面调研，不是产品验证',
  startedAt: new Date().toISOString(),
  runRoot,
  providerCalls: 0,
  targetBudget: 10,
  timeoutPerTargetMs: 20_000,
  priorAttempts: [
    'references-1791796399181: 十图加载后均无可捕获显示表面；保留失败原件',
    'references-1791796445474: 窗口截图均为空图；原状态是待视觉检查，不是通过',
    'references-1791796506004: Chrome成功；替换窗口时默认退出导致Edge加载中断',
  ],
  captureMethod: '隔离离屏 Chromium 窗口真实渲染截图；首张为空即停止',
  screenshots: [],
  requests: [],
};
const save = () => writeFileSync(join(runRoot, 'index.json'), JSON.stringify(report, null, 2));
let window;
const watchdog = setTimeout(() => {
  report.error = '总运行预算超时';
  save();
  app.exit(2);
}, 240_000);

app
  .whenReady()
  .then(async () => {
    const isolated = session.fromPartition(`references-${Date.now()}`, { cache: false });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', (event) => event.preventDefault());
    let activeImage = '';
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url === activeImage && details.resourceType === 'mainFrame';
      report.requests.push({ url: details.url, allowed });
      callback({ cancel: !allowed });
    });
    for (const [name, source, imageUrl] of targets) {
      activeImage = imageUrl;
      window = new BrowserWindow({
        width: 1440,
        height: 1000,
        show: false,
        webPreferences: {
          session: isolated,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          javascript: false,
          offscreen: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const entry = { name, source, imageUrl, startedAt: new Date().toISOString() };
      let timeout;
      try {
        await Promise.race([
          window.webContents.loadURL(imageUrl),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('目标加载超过20秒')), 20_000);
          }),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const shot = await window.webContents.capturePage(
          { x: 0, y: 0, width: 1440, height: 1000 },
          { stayHidden: true, stayAwake: true },
        );
        if (shot.isEmpty()) throw new Error('渲染截图为空，停止本轮后续目标');
        const capturePath = join(runRoot, `${name}.png`);
        writeFileSync(capturePath, shot.toPNG());
        entry.capturePath = capturePath;
        entry.status = 'captured-needs-visual-inspection';
        entry.loadedUrl = window.webContents.getURL();
      } catch (error) {
        entry.status = 'failed';
        entry.error = String(error);
      } finally {
        clearTimeout(timeout);
        window.destroy();
      }
      report.screenshots.push(entry);
      save();
      if (entry.status === 'failed') break;
    }
    report.finishedAt = new Date().toISOString();
    save();
    clearTimeout(watchdog);
    app.exit(report.screenshots.some((entry) => entry.status === 'failed') ? 1 : 0);
  })
  .catch((error) => {
    report.error = String(error);
    save();
    clearTimeout(watchdog);
    app.exit(2);
  });
