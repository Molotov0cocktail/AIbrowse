'use strict';

// Launch only through a suspended, identity-bound child in a dedicated Job.
// The external launcher owns root pins, process identity, EOF and the 120s watchdog.
// CJS path checks are defensive checks, not proof of pre-CJS isolation or Job membership.
// argv: electron.exe <this-file> --aibrowse-blank-feasibility --user-data-dir=<root>/user-data
// TEMP/TMP, APPDATA and LOCALAPPDATA must already point to the fresh six-root layout.
const process = require('node:process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout, clearTimeout } = require('node:timers');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BaseWindow, WebContentsView, session } = require('electron');

const started = process.hrtime.bigint();
let lines = 0;
let phase = '启动校验';
let owner = null;
let view = null;
let closing = false;
let failed = false;
let watchdog = null;
const eventCounts = { domReady: 0, finished: 0, started: 0, failed: 0, gone: 0, destroyed: 0 };
const observations = [];

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

function emit(kind, detail = {}) {
  if (++lines > 64) {
    app.exit(76);
    return;
  }
  process.stdout.write(
    `${canonical({
      version: 1,
      kind,
      phase,
      elapsedMs: Number((process.hrtime.bigint() - started) / 1000000n),
      ...detail,
    })}\n`,
  );
}

function requireCondition(value) {
  if (!value) throw new Error('空白页实验前置条件不满足');
}

function validateAndBindPaths() {
  requireCondition(process.platform === 'win32' && process.versions.electron === '43.4.0');
  requireCondition(process.type === 'browser' && !app.isReady());
  const temporary = process.env.TEMP;
  requireCondition(typeof temporary === 'string' && path.isAbsolute(temporary));
  const root = path.dirname(temporary);
  requireCondition(/^run-[A-Z2-7]{26}$/.test(path.basename(root)));
  const roots = {
    appData: path.join(root, 'appdata'),
    localAppData: path.join(root, 'localappdata'),
    processTemp: path.join(root, 'process-temp'),
    userData: path.join(root, 'user-data'),
    watchTemp: path.join(root, 'watch-temp'),
  };
  requireCondition(
    temporary === roots.processTemp &&
      process.env.TMP === roots.processTemp &&
      process.env.APPDATA === roots.appData &&
      process.env.LOCALAPPDATA === roots.localAppData,
  );
  requireCondition(
    process.argv.length === 4 &&
      ['--aibrowse-blank-feasibility', '--aibrowse-browser-smoke'].includes(process.argv[2]) &&
      process.argv[3] === `--user-data-dir=${roots.userData}` &&
      app.commandLine.getSwitchValue('user-data-dir') === roots.userData,
  );
  for (const directory of [root, ...Object.values(roots)]) {
    const stat = fs.lstatSync(directory);
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink());
  }
  requireCondition(
    app.getPath('userData') === roots.userData && app.getPath('sessionData') === roots.userData,
  );
  for (const [name, directory] of Object.entries({
    appData: roots.appData,
    cache: roots.appData,
    userData: roots.userData,
    sessionData: roots.userData,
    userCache: roots.localAppData,
    logs: roots.localAppData,
    crashDumps: roots.processTemp,
    temp: roots.processTemp,
  })) {
    app.setPath(name, directory);
  }
  requireCondition(!app.isReady());
  emit('启动校验完成', { mainPid: process.pid, earlyPathsMatch: true, defaultGpu: true });
}

function observe(point) {
  requireCondition(view !== null && !view.webContents.isDestroyed());
  const rendererPid = view.webContents.getOSProcessId();
  requireCondition(Number.isSafeInteger(rendererPid) && rendererPid >= 0);
  const metrics = app.getAppMetrics();
  requireCondition(metrics.length <= 32);
  const appMetrics = metrics
    .map(({ pid, type }) => {
      requireCondition(
        Number.isSafeInteger(pid) && pid > 0 && /^[A-Za-z][A-Za-z -]{0,31}$/.test(type),
      );
      return { pid, type };
    })
    .sort((left, right) => left.pid - right.pid);
  const observation = {
    point,
    webContentsId: view.webContents.id,
    rendererPid,
    isLoading: view.webContents.isLoading(),
    events: { ...eventCounts },
    appMetrics,
  };
  observations.push(observation);
  emit('观察', observation);
}

async function bounded(operation, milliseconds) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('空白页实验操作超时')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function run() {
  await app.whenReady();
  const isolatedSession = session.fromPartition('persist:aibrowse');
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  isolatedSession.setPermissionCheckHandler(() => false);
  owner = new BaseWindow({ width: 720, height: 480, show: false, title: '空白页加载可行性实验' });
  owner.on('closed', () => {
    if (!closing) fail();
  });
  phase = '仅构造';
  view = new WebContentsView({
    webPreferences: {
      session: isolatedSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  const contents = view.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const [event, counter] of [
    ['dom-ready', 'domReady'],
    ['did-finish-load', 'finished'],
    ['did-start-loading', 'started'],
    ['did-fail-load', 'failed'],
    ['render-process-gone', 'gone'],
    ['destroyed', 'destroyed'],
  ]) {
    contents.on(event, () => {
      eventCounts[counter] += 1;
      emit('页面事件', { event: counter, count: eventCounts[counter] });
    });
  }
  observe('构造后立即');
  await delay(3000);
  observe('构造后三秒');

  phase = '挂载并显示聚焦';
  owner.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 720, height: 480 });
  view.setVisible(true);
  owner.show();
  contents.focus();
  observe('显示聚焦后立即');
  await delay(5000);
  observe('显示聚焦后五秒');
  const beforeExplicitLoad = observations.map((entry) => entry.rendererPid);

  phase = '显式加载空白页';
  // Do not execute JavaScript or access mainFrame before explicit loadURL:
  // those operations could create the renderer being investigated.
  await bounded(contents.loadURL('about:blank'), 10000);
  observe('显式加载完成');
  const dom = await bounded(
    contents.executeJavaScript(
      '({ readyState: document.readyState, hasDocumentElement: !!document.documentElement, hasBody: !!document.body })',
      false,
    ),
    3000,
  );
  requireCondition(
    dom !== null &&
      dom.readyState === 'complete' &&
      dom.hasDocumentElement === true &&
      dom.hasBody === true &&
      contents.getOSProcessId() > 0 &&
      eventCounts.domReady > 0 &&
      eventCounts.finished > 0 &&
      eventCounts.failed === 0 &&
      eventCounts.gone === 0,
  );
  emit('固定DOM状态', {
    readyState: 'complete',
    hasDocumentElement: true,
    hasBody: true,
  });
  await delay(3000);
  observe('显式加载后三秒');
  emit('实验结果', {
    constructedRendererObserved: beforeExplicitLoad.slice(0, 2).some((pid) => pid > 0),
    visibleFocusedRendererObserved: beforeExplicitLoad.slice(2).some((pid) => pid > 0),
    deferredRendererCandidate: beforeExplicitLoad.every((pid) => pid === 0),
    formalResourceVerdict: '不适用；仅用于机制可行性诊断',
    coverage: '单个真实WCV；没有完整AIbrowse UI或四个Session任务负载',
  });

  phase = '关闭';
  closing = true;
  const destroyed = new Promise((resolve) => contents.once('destroyed', resolve));
  owner.contentView.removeChildView(view);
  contents.close({ waitForBeforeUnload: false });
  await bounded(destroyed, 3000);
  owner.close();
  requireCondition(contents.isDestroyed() && owner.isDestroyed());
  clearTimeout(watchdog);
  emit('实验正常完成', { webContentsDestroyed: true, windowDestroyed: true });
  app.quit();
}

function fail() {
  if (failed) return;
  failed = true;
  clearTimeout(watchdog);
  emit('实验失败', { reason: '前置条件、生命周期或有界操作未通过' });
  app.exit(75);
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
process.stdout.on('error', () => app.exit(75));
app.on('window-all-closed', () => {});
try {
  validateAndBindPaths();
  const productSmoke = process.argv[2] === '--aibrowse-browser-smoke';
  watchdog = setTimeout(fail, productSmoke ? 50000 : 28000);
  if (productSmoke) {
    // The native launcher pins this locally compiled product-class bundle.
    const product = require('../../log/watch-qualification-build/browser-smoke.cjs');
    void app
      .whenReady()
      .then(() => product.run(emit))
      .then(
        () => {
          clearTimeout(watchdog);
          app.quit();
        },
        (error) => {
          // These are controlled smoke assertions; do not emit arbitrary exception bodies.
          emit('浏览器冒烟失败', {
            classification:
              error instanceof Error &&
              /^(浏览器|默认空白|显示聚焦|首次导航|并发首次|替代导航|显式空白|关闭|意外销毁|销毁浏览器)/.test(
                error.message,
              )
                ? error.message
                : '未分类异常',
          });
          fail();
        },
      );
  } else {
    void run().catch(fail);
  }
} catch {
  fail();
}
