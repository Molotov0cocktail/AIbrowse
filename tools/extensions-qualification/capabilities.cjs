/* global __dirname, __filename, require, process, setTimeout, clearTimeout */
// Read-only platform qualification with a generated, network-free extension.
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, session } = require('electron');
const { createHash, randomUUID } = require('node:crypto');
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const repository = resolve(__dirname, '../..');
const root = join(repository, 'log/extensions-three-20261013', `capabilities-${randomUUID()}`);
const profile = join(root, 'profile');
const partitionRoot = join(root, 'session');
const extensionRoot = join(root, 'fixture');
for (const path of [profile, partitionRoot, extensionRoot]) mkdirSync(path, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', partitionRoot);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');

const apiPaths = [
  'runtime.connectNative',
  'runtime.sendNativeMessage',
  'runtime.onUserScriptMessage',
  'userScripts.register',
  'userScripts.getScripts',
  'userScripts.configureWorld',
  'action.setPopup',
  'action.openPopup',
  'contextMenus.create',
  'tabs.create',
  'tabs.get',
  'tabs.query',
  'windows.create',
  'windows.getCurrent',
  'storage.local.get',
  'storage.sync.get',
  'storage.session.get',
  'downloads.download',
  'permissions.contains',
  'permissions.request',
  'declarativeNetRequest.updateDynamicRules',
  'webRequest.onBeforeRequest',
  'scripting.registerContentScripts',
  'scripting.executeScript',
  'offscreen.createDocument',
  'cookies.getAll',
  'alarms.create',
  'webNavigation.onCommitted',
  'proxy.settings.get',
];
const snapshot = `(() => Object.fromEntries(${JSON.stringify(apiPaths)}.map(path => {
  try { return [path, typeof path.split('.').reduce((value, key) => value?.[key], chrome)]; }
  catch { return [path, 'access-error']; }
})))()`;
const manifest = {
  manifest_version: 3,
  name: 'AIbrowse 扩展接口资格探针',
  version: '1.0.0',
  permissions: [
    'storage',
    'tabs',
    'scripting',
    'userScripts',
    'nativeMessaging',
    'downloads',
    'contextMenus',
    'webRequest',
    'declarativeNetRequest',
    'offscreen',
    'cookies',
    'alarms',
    'webNavigation',
    'proxy',
  ],
  host_permissions: ['http://127.0.0.1/*'],
  background: { service_worker: 'background.js' },
  action: { default_popup: 'probe.html' },
};
writeFileSync(join(extensionRoot, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
writeFileSync(
  join(extensionRoot, 'background.js'),
  `chrome.storage.local.set({ platformProbe: ${snapshot} });`,
  { flag: 'wx' },
);
writeFileSync(join(extensionRoot, 'probe.html'), '<!doctype html><title>扩展接口资格探针</title>', {
  flag: 'wx',
});
const report = {
  scope: '仅观察当前Electron隔离扩展上下文API；不代表第三方插件安装或兼容通过',
  versions: process.versions,
  fixture: manifest,
  toolSha256: createHash('sha256').update(readFileSync(__filename)).digest('hex'),
  root,
  completed: false,
  willQuit: false,
  timedOut: false,
  deniedNetworkRequests: 0,
  extensionPage: null,
  serviceWorker: null,
  error: null,
};
const persist = () => writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
const timer = setTimeout(() => {
  report.timedOut = true;
  persist();
  app.exit(1);
}, 30000);
app.on('will-quit', () => {
  report.willQuit = true;
  clearTimeout(timer);
  persist();
});
app.whenReady().then(async () => {
  let win;
  try {
    const isolated = session.fromPartition('persist:extension-capabilities');
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_details, callback) => {
        report.deniedNetworkRequests += 1;
        callback({ cancel: true });
      },
    );
    const extension = await isolated.extensions.loadExtension(extensionRoot, {
      allowFileAccess: false,
    });
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: isolated,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadURL(`chrome-extension://${extension.id}/probe.html`);
    report.extensionPage = await win.webContents.executeJavaScript(snapshot);
    report.serviceWorker = await win.webContents.executeJavaScript(
      `chrome.storage.local.get('platformProbe').then(value => value.platformProbe ?? null)`,
    );
    report.completed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : '探针执行失败';
    process.exitCode = 1;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    persist();
    process.stdout.write(`${root}\n`);
    app.quit();
  }
});
