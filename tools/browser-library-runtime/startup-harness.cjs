/* global __dirname, console, process, require, setInterval, clearInterval, setTimeout, clearTimeout, URL */
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const electron = require('electron');
const { app, ipcMain } = electron;
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, realpathSync, lstatSync } = require('node:fs');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');

const repository = realpathSync(resolve(__dirname, '../..'));
const root = resolve(process.argv[2] ?? '');
const phase = process.argv[3];
assert(['first', 'reopen'].includes(phase));
const rel = relative(join(repository, 'log/browser-startup-20261014'), root);
assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
assert.equal(realpathSync(root), root);
assert(!lstatSync(root).isSymbolicLink());
const input = JSON.parse(readFileSync(join(root, 'input.json'), 'utf8'));
assert.equal(input.repository, repository);
assert.equal(input.electronDeadlineMs, 82000);
assert.equal(input.outerDeadlineMs, 90000);
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
for (const [path, expected] of Object.entries(input.binding)) {
  const full = resolve(repository, path);
  const part = relative(repository, full);
  assert(part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
  assert.equal(digest(full), expected);
}
const profile = join(root, 'profile');
const sessionData = join(root, 'session');
for (const path of [profile, sessionData]) {
  assert.equal(realpathSync(path), path);
  assert(!lstatSync(path).isSymbolicLink());
}
assert(!app.isPackaged);
app.setPath('userData', profile);
app.setPath('sessionData', sessionData);
app.setAppPath(repository);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
process.env.AIBROWSE_USER_DATA_DIR = profile;

const startedAt = Date.now();
const report = {
  phase,
  expectation: input.expectation,
  startedAt,
  passedHarness: false,
  willQuit: false,
  error: null,
  timeline: [],
  ipcStatuses: [],
  ipcStatusEvents: [],
  domStates: [],
  rendererConsole: [],
  mainConsole: [],
  captures: [],
  alertObserved: false,
  visibleAlertObserved: false,
  visibleAlerts: [],
  network: { electron: [], node: 0, fetch: 0 },
  networkTotal: 0,
  providerCalls: 0,
};
const persist = () =>
  writeFileSync(join(root, `runtime-${phase}.json`), JSON.stringify(report, null, 2));
const now = () => Date.now() - startedAt;
const event = (name, detail) => {
  report.timeline.push({ atMs: now(), name, ...(detail === undefined ? {} : { detail }) });
  persist();
};
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    if (report.mainConsole.length < 300) {
      report.mainConsole.push({
        atMs: now(),
        level,
        message: args.map(String).join(' ').slice(0, 4096),
      });
      persist();
    }
    original(...args);
  };
}
app.on('will-finish-launching', () => event('app:will-finish-launching'));
app.on('ready', () => event('app:ready'));
app.on('before-quit', () => event('app:before-quit'));
app.on('will-quit', () => {
  report.willQuit = true;
  event('app:will-quit');
});
app.on('quit', (_event, code) => event('app:quit', { code }));

app.on('session-created', (session) => {
  event('session:created');
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      report.network.electron.push({ atMs: now(), url: new URL(details.url).origin });
      report.networkTotal += 1;
      persist();
      callback({ cancel: true });
    },
  );
});
for (const protocol of ['node:http', 'node:https']) {
  const module = require(protocol);
  module.request = function () {
    report.network.node += 1;
    report.networkTotal += 1;
    persist();
    throw new Error('启动验收禁止Node网络请求');
  };
  module.get = module.request;
}
globalThis.fetch = function () {
  report.network.fetch += 1;
  report.networkTotal += 1;
  report.providerCalls += 1;
  persist();
  return Promise.reject(new Error('启动验收禁止fetch/Provider请求'));
};

const originalHandle = ipcMain.handle.bind(ipcMain);
const startupStatusChannels = new Set([
  'browser-library:status',
  'conversation:storage-status',
  'data-transfer:status',
]);
ipcMain.handle = (channel, listener) =>
  originalHandle(channel, (ipcEvent, ...args) => {
    const invokedAt = now();
    const value = listener(ipcEvent, ...args);
    if (!startupStatusChannels.has(channel)) return value;
    return Promise.resolve(value).then(
      (result) => {
        const observation = {
          channel,
          invokedAtMs: invokedAt,
          resolvedAtMs: now(),
          state: result?.state,
          code: result?.code,
          message: result?.message,
        };
        report.ipcStatusEvents.push(observation);
        if (channel === 'browser-library:status') report.ipcStatuses.push(observation);
        persist();
        return result;
      },
      (error) => {
        const observation = {
          channel,
          invokedAtMs: invokedAt,
          resolvedAtMs: now(),
          state: 'rejected',
          message: String(error).slice(0, 512),
        };
        report.ipcStatusEvents.push(observation);
        if (channel === 'browser-library:status') report.ipcStatuses.push(observation);
        persist();
        throw error;
      },
    );
  });

let win;
let poll;
let closeTimer;
let alertCaptureStarted = false;
let initializingCaptureStarted = false;
let readyCaptureStarted = false;
let closing = false;
let lastDom = '';
const targetAlert = '浏览数据暂不可用，请检查本地数据';
const fail = (error) => {
  report.error = error?.stack ?? String(error);
  persist();
  app.quit();
};
async function capture(name) {
  const bytes = (await win.capturePage()).toPNG();
  const path = join(root, 'captures', `${name}.png`);
  writeFileSync(path, bytes, { flag: 'wx' });
  report.captures.push({ name, path, sha256: createHash('sha256').update(bytes).digest('hex') });
  persist();
}
async function sampleDom() {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const state = await win.webContents.executeJavaScript(
    `(() => ({readyState:document.readyState, alerts:[...document.querySelectorAll('.data-global-alert')].map(x=>({text:(x.textContent??'').trim(),color:getComputedStyle(x).backgroundColor,visible:!!(x.getClientRects().length)})), bodyMounted:document.body.children.length>0}))()`,
    true,
  );
  const normalized = JSON.stringify(state);
  if (normalized !== lastDom) {
    lastDom = normalized;
    report.domStates.push({ atMs: now(), ...state });
    persist();
  }
  const visibleAlerts = state.alerts.filter((entry) => entry.visible);
  const hasVisibleAlert = visibleAlerts.length > 0;
  const hasAlert = visibleAlerts.some((entry) => entry.text === targetAlert);
  if (hasVisibleAlert) {
    report.visibleAlertObserved = true;
    for (const alert of visibleAlerts) {
      if (!report.visibleAlerts.some((entry) => entry.text === alert.text)) {
        report.visibleAlerts.push({ atMs: now(), ...alert });
      }
    }
    if (!alertCaptureStarted) {
      alertCaptureStarted = true;
      void capture(`${phase}-visible-alert`).catch(fail);
    }
  }
  if (hasAlert) {
    report.alertObserved = true;
  }
  const initializing = report.ipcStatuses.some((entry) => entry.state === 'initializing');
  if (initializing && !hasAlert && !initializingCaptureStarted) {
    initializingCaptureStarted = true;
    void capture(`${phase}-initializing-neutral`).catch(fail);
  }
  const hasStatus = (channel, state) =>
    report.ipcStatusEvents.some((entry) => entry.channel === channel && entry.state === state);
  const startupReady =
    hasStatus('browser-library:status', 'available') &&
    hasStatus('conversation:storage-status', 'ready') &&
    hasStatus('data-transfer:status', 'idle');
  if (startupReady && !hasVisibleAlert && !readyCaptureStarted) {
    readyCaptureStarted = true;
    void capture(`${phase}-available-clean`)
      .then(() => {
        closeTimer = setTimeout(() => {
          if (closing || win.isDestroyed()) return;
          closing = true;
          report.passedHarness = true;
          event('window:normal-close-request');
          win.close();
        }, 750);
      })
      .catch(fail);
  }
}
app.on('browser-window-created', (_event, value) => {
  if (win) return;
  win = value;
  event('window:created');
  value.webContents.on('console-message', (_consoleEvent, details) => {
    if (report.rendererConsole.length < 200) {
      report.rendererConsole.push({
        atMs: now(),
        level: details.level,
        message: details.message.slice(0, 2048),
      });
      persist();
    }
  });
  value.webContents.on('dom-ready', () => {
    event('renderer:dom-ready');
    if (!poll) poll = setInterval(() => void sampleDom().catch(fail), 25);
  });
  value.webContents.on('did-finish-load', () => event('renderer:did-finish-load'));
  value.once('ready-to-show', () => event('window:ready-to-show'));
  value.once('closed', () => {
    event('window:closed');
    if (poll) clearInterval(poll);
    if (closeTimer) clearTimeout(closeTimer);
  });
});

const deadline = setTimeout(
  () => fail(new Error('Electron启动验收超过内部82秒预算')),
  input.electronDeadlineMs - 1000,
);
app.on('will-quit', () => clearTimeout(deadline));
persist();
require(join(repository, 'out/main/index.js'));
