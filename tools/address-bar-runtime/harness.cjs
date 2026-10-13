/* global __dirname, clearTimeout, process, require, setTimeout, URL */
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { app, webContents } = require('electron');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, realpathSync, lstatSync } = require('node:fs');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');

const repository = realpathSync(resolve(__dirname, '../..'));
const root = resolve(process.argv[2] ?? '');
const part = relative(join(repository, 'log/address-bar-runtime-20261014'), root);
assert(part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
assert.equal(realpathSync(root), root);
assert(!lstatSync(root).isSymbolicLink());
const input = JSON.parse(readFileSync(join(root, 'input.json'), 'utf8'));
const launch = JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8'));
assert.equal(input.repository, repository);
assert.equal(input.deadlineMs, 90000);
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
for (const [path, expected] of Object.entries(input.binding)) {
  const full = resolve(repository, path);
  const rel = relative(repository, full);
  assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  assert.equal(digest(full), expected);
}
const profile = join(root, 'profile');
const session = join(root, 'session');
for (const path of [profile, session]) {
  assert.equal(realpathSync(path), path);
  assert(!lstatSync(path).isSymbolicLink());
}
app.setPath('userData', profile);
app.setPath('sessionData', session);
app.setAppPath(repository);
process.env.AIBROWSE_USER_DATA_DIR = profile;

const report = {
  expectation: input.expectation,
  completed: false,
  willQuit: false,
  error: null,
  checks: {},
  observations: {},
  inputEvents: [],
  navigations: [],
  externalNetwork: 0,
  providerCalls: 0,
};
const persist = () => writeFileSync(join(root, 'runtime.json'), JSON.stringify(report, null, 2));
const allowedOrigin = new URL(launch.base).origin;
app.on('session-created', (sessionObject) => {
  sessionObject.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      let allowed;
      try {
        allowed = new URL(details.url).origin === allowedOrigin;
      } catch {
        allowed = false;
      }
      if (!allowed) {
        report.externalNetwork += 1;
        persist();
      }
      callback({ cancel: !allowed });
    },
  );
});
app.on('web-contents-created', (_event, contents) => {
  contents.on('did-start-navigation', (_navigationEvent, url) => {
    report.navigations.push(url);
    try {
      const parsed = new URL(url);
      if (
        !['file:', 'about:', 'data:', 'devtools:'].includes(parsed.protocol) &&
        parsed.origin !== allowedOrigin
      ) {
        report.externalNetwork += 1;
      }
    } catch {
      report.externalNetwork += 1;
    }
    persist();
  });
});
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  report.providerCalls += 1;
  persist();
  throw new Error(`验收禁止主进程fetch：${String(args[0]).slice(0, 80)}`);
};
for (const protocol of ['node:http', 'node:https']) {
  const module = require(protocol);
  module.request = function () {
    report.externalNetwork += 1;
    persist();
    throw new Error('验收禁止产品Node网络请求');
  };
  module.get = module.request;
}

let win;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(description, probe, budget = 12000) {
  const deadline = Math.min(launch.deadline, Date.now() + budget);
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await delay(60);
  }
  throw new Error(`${description}超时${lastError ? `：${lastError.message}` : ''}`);
}
const js = (source) => win.webContents.executeJavaScript(source, true);
const invoke = (space, method, ...args) =>
  js(
    `window.aibrowse[${JSON.stringify(space)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`,
  );
async function state() {
  return invoke('tabs', 'getState');
}
async function address() {
  const value = await js(
    `(() => { const e=document.querySelector('.address-bar'); return e && {value:e.value,start:e.selectionStart,end:e.selectionEnd,focused:document.activeElement===e,documentFocused:document.hasFocus(),visibility:document.visibilityState}; })()`,
  );
  return value === null
    ? null
    : {
        ...value,
        nativeWebContentsFocused: win.webContents.isFocused(),
        nativeWindowFocused: win.isFocused(),
      };
}
async function point(ratio = 0.65) {
  return js(`(() => {
    const input=document.querySelector('.address-bar');
    const r=input.getBoundingClientRect(), style=getComputedStyle(input);
    const canvas=document.createElement('canvas'), context=canvas.getContext('2d');
    context.font=style.font;
    const prefix=input.value.slice(0,Math.max(1,Math.floor(input.value.length*${ratio})));
    const textX=r.x+parseFloat(style.paddingLeft)+context.measureText(prefix).width;
    return {x:Math.round(Math.min(r.right-8,textX)),y:Math.round(r.y+r.height/2)};
  })()`);
}
async function focusRenderer() {
  win.show();
  win.focus();
  win.webContents.focus();
  await until(
    '产品UI取得原生焦点',
    async () => win.isFocused() && win.webContents.isFocused() && (await js(`document.hasFocus()`)),
  );
}
async function mouse(button, clickCount, ratio = 0.65) {
  await focusRenderer();
  const at = await point(ratio);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...at });
  win.webContents.sendInputEvent({ type: 'mouseDown', button, ...at, clickCount });
  await delay(35);
  win.webContents.sendInputEvent({ type: 'mouseUp', button, ...at, clickCount });
  await delay(80);
  return address();
}
async function drag(fromRatio, toRatio) {
  await focusRenderer();
  const from = await point(fromRatio);
  const to = await point(toRatio);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...from });
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...from, clickCount: 1 });
  for (const ratio of [0.4, 0.55, 0.7]) {
    const current = await point(ratio);
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      button: 'left',
      modifiers: ['leftbuttondown'],
      ...current,
    });
  }
  win.webContents.sendInputEvent({
    type: 'mouseMove',
    button: 'left',
    modifiers: ['leftbuttondown'],
    ...to,
  });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...to, clickCount: 1 });
  await delay(100);
  return address();
}
async function focusAndType(value) {
  await focusRenderer();
  await js(
    `document.querySelector('.address-bar').focus(); document.querySelector('.address-bar').select()`,
  );
  await until('地址栏取得真实焦点', async () => {
    const current = await address();
    return current?.focused && current.documentFocused && current.nativeWebContentsFocused;
  });
  await win.webContents.insertText(value);
  await until('地址栏输入', async () => (await address())?.value === value);
}
async function physicalBlur() {
  await focusRenderer();
  const at = await js(
    `(() => { const r=document.querySelector('.ai-toggle').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`,
  );
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...at, clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...at, clickCount: 1 });
  await until('地址栏失焦', async () => !(await address())?.focused);
}
async function physicalClick(selector) {
  await focusRenderer();
  const at = await js(
    `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`,
  );
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...at, clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...at, clickCount: 1 });
}
async function ready() {
  await until('真实产品bridge与地址栏', async () => {
    const tabs = await state();
    return tabs.tabs.length > 0 && (await address()) !== null;
  });
  await focusRenderer();
  await js(`(() => {
    const input=document.querySelector('.address-bar');
    window.__addressBarRuntimeEvents=[];
    const sample=(event,phase) => {
      window.__addressBarRuntimeEvents.push({
        type:event.type, phase, detail:event.detail ?? null, button:event.button ?? null,
        buttons:event.buttons ?? null, clientX:event.clientX ?? null, clientY:event.clientY ?? null,
        start:input.selectionStart, end:input.selectionEnd, focused:document.activeElement===input,
        documentFocused:document.hasFocus(), visibility:document.visibilityState
      });
      if (phase==='bubble') queueMicrotask(() => window.__addressBarRuntimeEvents.push({
        type:event.type, phase:'after-dispatch', detail:event.detail ?? null, button:event.button ?? null,
        buttons:event.buttons ?? null, clientX:event.clientX ?? null, clientY:event.clientY ?? null,
        start:input.selectionStart, end:input.selectionEnd, focused:document.activeElement===input,
        documentFocused:document.hasFocus(), visibility:document.visibilityState
      }));
    };
    for (const type of ['focus','blur','focusin','focusout','mousedown','mousemove','mouseup','click','dblclick']) {
      input.addEventListener(type,event=>sample(event,'capture'),true);
      input.addEventListener(type,event=>sample(event,'bubble'));
    }
  })()`);
}
async function run() {
  await ready();
  const urlA = `${launch.base}/alpha-path-long`;
  const urlB = `${launch.base}/beta-path-current`;
  const urlEnter = `${launch.base}/enter-navigation`;
  let tabs = await state();
  const initialId = tabs.activeTabId;
  assert(initialId);
  assert(await invoke('nav', 'navigate', initialId, urlA));
  await until(
    '首个本地页',
    async () => (await state()).tabs.find((tab) => tab.id === initialId)?.url === urlA,
  );
  await until('地址栏同步首个URL', async () => (await address())?.value === urlA);

  await physicalBlur();
  const firstClick = await mouse('left', 1, 0.72);
  report.observations.firstClick = firstClick;
  report.checks.singleClickSelectsAll =
    firstClick.start === 0 && firstClick.end === firstClick.value.length;
  await delay(650);
  const repeated = await mouse('left', 1, 0.32);
  report.observations.repeatedSingleClick = repeated;
  report.checks.repeatedSingleClickSelectsAll =
    repeated.start === 0 && repeated.end === repeated.value.length;

  await physicalBlur();
  const dragged = await drag(0.25, 0.75);
  report.observations.dragSelection = dragged;
  report.checks.dragSelectionPreserved =
    dragged.start < dragged.end && dragged.start > 0 && dragged.end < dragged.value.length;

  await physicalBlur();
  const doubleFirst = await mouse('left', 1, 0.68);
  const doubleSecond = await mouse('left', 2, 0.68);
  report.observations.doubleClick = { first: doubleFirst, second: doubleSecond };
  report.checks.doubleClickRestoresCaret =
    doubleFirst.start === 0 &&
    doubleFirst.end === doubleFirst.value.length &&
    doubleSecond.start === doubleSecond.end &&
    doubleSecond.start > 0 &&
    doubleSecond.start < doubleSecond.value.length;

  await js(`document.querySelector('.address-bar').select()`);
  const beforeRight = await address();
  const afterRight = await mouse('right', 1, 0.5);
  report.observations.rightClick = { before: beforeRight, after: afterRight };
  report.checks.rightClickPreservesSelection =
    beforeRight.start === 0 &&
    beforeRight.end === beforeRight.value.length &&
    afterRight.start === beforeRight.start &&
    afterRight.end === beforeRight.end;

  await physicalBlur();
  await focusAndType('旧草稿必须被新标签清空');
  const beforeNewTab = await state();
  await physicalClick('.new-tab-button');
  const afterNewTab = await until('空白新标签激活', async () => {
    const value = await state();
    return value.tabs.length === beforeNewTab.tabs.length + 1 &&
      value.activeTabId !== beforeNewTab.activeTabId
      ? value
      : false;
  });
  const blank = afterNewTab.tabs.find((tab) => tab.id === afterNewTab.activeTabId);
  assert(blank);
  const blankAddress = await address();
  report.observations.newTab = blankAddress;
  report.checks.newTabClearsFocusedAddress = blankAddress.value === '' && blankAddress.focused;

  await invoke('tabs', 'activate', initialId);
  await until('返回原标签', async () => (await state()).activeTabId === initialId);
  const returnedOldDraft = await address();
  report.observations.returnedOldDraft = returnedOldDraft;
  await physicalBlur();
  await until('返回原标签后失焦恢复', async () => (await address()).value === urlA);
  await focusAndType('同URL切换不得保留此草稿');
  const contentsBeforeSameUrl = new Set(
    webContents.getAllWebContents().map((contents) => contents.id),
  );
  const sameUrl = await invoke('tabs', 'create', urlA);
  assert(sameUrl);
  await until('同URL新标签激活', async () => (await state()).activeTabId === sameUrl.id);
  const sameUrlPage = await until('同URL新标签WebContents唯一归属', () => {
    const matches = webContents
      .getAllWebContents()
      .filter(
        (contents) =>
          contents !== win.webContents &&
          !contentsBeforeSameUrl.has(contents.id) &&
          contents.getURL() === urlA,
      );
    return matches.length === 1 ? matches[0] : false;
  });
  const sameUrlAddress = await address();
  report.observations.sameUrlTab = sameUrlAddress;
  report.checks.sameUrlTabSyncsDraft = sameUrlAddress.value === urlA;

  await physicalBlur();
  await focusAndType('同标签编辑中的草稿');
  const beforeSameTabUrlChange = await address();
  assert(beforeSameTabUrlChange.documentFocused && beforeSameTabUrlChange.nativeWebContentsFocused);
  await sameUrlPage.executeJavaScript(
    `history.pushState({}, '', ${JSON.stringify(new URL(urlB).pathname)})`,
    true,
  );
  await until(
    '同标签URL更新',
    async () => (await state()).tabs.find((tab) => tab.id === sameUrl.id)?.url === urlB,
  );
  const whileFocused = await address();
  report.observations.sameTabDraft = whileFocused;
  report.checks.sameTabDraftPreserved =
    whileFocused.value === '同标签编辑中的草稿' &&
    whileFocused.focused &&
    whileFocused.documentFocused &&
    whileFocused.nativeWebContentsFocused;
  await physicalBlur();
  const afterBlur = await address();
  report.observations.afterBlur = afterBlur;
  report.checks.blurRestoresCurrentUrl = afterBlur.value === urlB && !afterBlur.focused;

  await focusAndType(urlEnter);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await until(
    'Enter导航',
    async () => (await state()).tabs.find((tab) => tab.id === sameUrl.id)?.url === urlEnter,
  );
  report.checks.enterNavigationWorks = true;
  report.inputEvents = await js(`window.__addressBarRuntimeEvents`);
  report.completed = true;
  persist();
  app.quit();
}
const timer = setTimeout(
  () => {
    report.error = 'Electron验收超过内部86秒预算';
    persist();
    app.exit(1);
  },
  Math.max(1, launch.deadline - Date.now()),
);
app.on('browser-window-created', (_event, value) => {
  if (win) return;
  win = value;
  void run().catch(async (error) => {
    report.error = error?.stack ?? String(error);
    try {
      report.inputEvents = await js(`window.__addressBarRuntimeEvents ?? []`);
    } catch {
      report.inputEvents = [];
    }
    persist();
    app.quit();
  });
});
app.on('will-quit', () => {
  report.willQuit = true;
  clearTimeout(timer);
  persist();
  globalThis.fetch = originalFetch;
});
process.on('exit', persist);
persist();
require(join(repository, 'out/main/index.js'));
