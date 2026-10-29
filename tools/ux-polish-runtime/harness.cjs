/* global __dirname, clearTimeout, process, require, setTimeout, URL */
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { app } = require('electron');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, realpathSync, lstatSync } = require('node:fs');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');

const repository = realpathSync(resolve(__dirname, '../..'));
const root = resolve(process.argv[2] ?? '');
const part = relative(join(repository, 'log/ux-polish-20261029'), root);
assert(part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
assert.equal(realpathSync(root), root);
assert(!lstatSync(root).isSymbolicLink());
const input = JSON.parse(readFileSync(join(root, 'input.json'), 'utf8'));
const launch = JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8'));
assert.equal(input.repository, repository);
assert.equal(input.deadlineMs, 180000);
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
for (const [path, expected] of Object.entries(input.binding)) {
  const full = resolve(repository, path);
  const rel = relative(repository, full);
  assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  assert.equal(digest(full), expected);
}
const profile = resolve(root, '../profile');
const session = resolve(root, '../session');
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
  visualBoundary:
    '深浅色通过设置根节点data-theme验证CSS；非设置持久化测试。键盘为真实sendInputEvent，聚焦初始控件由harness完成。',
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
async function until(description, probe, budget = 15000) {
  const deadline = Math.min(launch.deadline, Date.now() + budget);
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(70);
  }
  throw new Error(`${description}超时${lastError ? `：${lastError.message}` : ''}`);
}
const js = (source) => win.webContents.executeJavaScript(source, true);
const invoke = (space, method, ...args) =>
  js(
    `window.aibrowse[${JSON.stringify(space)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`,
  );
const state = () => invoke('tabs', 'getState');
const exists = (selector) => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
async function click(selector) {
  await until(selector, () => exists(selector));
  win.show();
  win.focus();
  win.webContents.focus();
  const at = await js(
    `(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`,
  );
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at });
  await delay(120);
}
async function type(selector, text) {
  await click(selector);
  await js(`document.querySelector(${JSON.stringify(selector)}).select()`);
  await win.webContents.insertText(text);
}
const key = (keyCode) => {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
};
async function capture(name) {
  await delay(200);
  writeFileSync(
    join(root, 'captures', `${name}.png`),
    (await win.webContents.capturePage()).toPNG(),
  );
}
function check(name, value) {
  report.checks[name] = Boolean(value);
  persist();
  assert(value, name);
}
async function sidebars() {
  for (const theme of ['light', 'dark']) {
    await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    for (const width of [1280, 600]) {
      win.setMinimumSize(400, 400);
      win.setContentSize(width, 800);
      await delay(250);
      for (const panel of ['ai', 'sources', 'research']) {
        await click(`.${panel}-toggle`);
        await until(`${panel}侧栏`, () => exists(`.${panel}-panel`));
        const geometry = await js(
          `(() => { const e=document.querySelector('.${panel}-panel'), r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,client:e.clientWidth,scroll:e.scrollWidth,viewport:innerWidth,height:innerHeight,doc:document.documentElement.scrollWidth}; })()`,
        );
        report.observations[`${theme}-${width}-${panel}`] = geometry;
        check(
          `${theme}-${width}-${panel}-geometry`,
          geometry.left >= -1 &&
            geometry.right <= geometry.viewport + 1 &&
            geometry.bottom <= geometry.height + 1 &&
            geometry.scroll <= geometry.client + 1 &&
            geometry.doc <= geometry.viewport + 1,
        );
        await js(`document.querySelector('.${panel}-panel button:not(:disabled)').focus()`);
        key('Tab');
        await delay(100);
        check(
          `${theme}-${width}-${panel}-keyboard`,
          await js(
            `document.activeElement.matches('button,input,textarea,select,[tabindex]') && document.activeElement !== document.body`,
          ),
        );
        await capture(`${theme}-${width}-${panel}`);
        await click(`.${panel}-toggle`);
      }
      await capture(`${theme}-${width}-start`);
    }
  }
  win.setContentSize(1280, 800);
}
async function run() {
  await until(
    '产品就绪',
    async () => (await state()).tabs.length > 0 && (await exists('.start-page')),
  );
  check('start-visible', await exists('.start-search input'));
  check('watch-status-visible', await until('监视状态', () => exists('.start-watch-stats')));
  const pageViews = () =>
    win.contentView.children.filter(
      (view) => view.webContents && view.webContents !== win.webContents,
    );
  check(
    'start-native-views-hidden',
    await until('起始页原生网页隐藏', () => pageViews().every((view) => !view.getVisible())),
  );
  await capture('start-initial');
  if (launch.phase === 'write' || launch.phase === 'keyboard') {
    const initial = await state();
    const urlA = `${launch.base}/alpha`;
    const urlB = `${launch.base}/beta`;
    await type('.start-search input', urlA);
    await until('起始页输入提交就绪', () =>
      js(
        `document.querySelector('.start-search input').value === ${JSON.stringify(urlA)} && !document.querySelector('.start-search button').disabled`,
      ),
    );
    await delay(100);
    await js(
      `window.__uxInputEvents=[]; for(const type of ['keydown','keypress','keyup','submit']) document.addEventListener(type,event=>window.__uxInputEvents.push({type,key:event.key ?? null,code:event.code ?? null,defaultPrevented:event.defaultPrevented}),true)`,
    );
    if (launch.phase === 'keyboard') {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    } else key('Return');
    await delay(200);
    report.inputEvents = await js('window.__uxInputEvents');
    report.observations.returnProbe = await state();
    persist();
    if (launch.phase === 'keyboard')
      check(
        'return-submits',
        report.inputEvents.some((event) => event.type === 'submit'),
      );
    else if (await exists('.start-search button')) await click('.start-search button');
    await until(
      '起始页当前标签导航',
      async () => (await state()).tabs.find((t) => t.id === initial.activeTabId)?.url === urlA,
    );
    check('search-current-tab', (await state()).tabs.length === initial.tabs.length);
    check('start-hidden-on-web', !(await exists('.start-page')));
    check(
      'web-native-view-visible',
      await until('网页原生视图可见', () =>
        pageViews().some((view) => view.webContents.getURL() === urlA && view.getVisible()),
      ),
    );
    if (launch.phase === 'keyboard') {
      report.completed = true;
      persist();
      app.quit();
      return;
    }
    await invoke('tabs', 'create', urlB);
    await until('两个页面历史', async () => {
      const h = await invoke('browserLibrary', 'listHistory', {
        query: '',
        cursor: null,
        limit: 6,
      });
      return (
        h.ok &&
        h.value.items.some((i) => i.url === urlA) &&
        h.value.items.some((i) => i.url === urlB)
      );
    });
    await saveBookmarks();
    await click('.new-tab-button');
    await until('新标签起始页', () => exists('.start-page'));
    await until('最近历史显示', () => exists('.start-recent-list li'));
    check(
      'recent-history-bounded',
      await js(
        `document.querySelectorAll('.start-recent-list li').length > 0 && document.querySelectorAll('.start-recent-list li').length <= 6`,
      ),
    );
    await capture('start-history-populated');
    const beforeHistory = await state();
    await click('.start-recent-list button');
    await until('最近历史当前标签打开', async () =>
      (await state()).tabs
        .find((t) => t.id === beforeHistory.activeTabId)
        ?.url.startsWith(launch.base),
    );
    check('history-click-current-tab', (await state()).tabs.length === beforeHistory.tabs.length);
    await click('.new-tab-button');
    await until('历史后返回起始页', () => exists('.start-page'));
    await sidebars();
    await capture('start-final');
  } else {
    await verifyBookmarks();
    check(
      'history-reopened',
      (await invoke('browserLibrary', 'listHistory', { query: '', cursor: null, limit: 6 })).value
        .items.length >= 2,
    );
  }
  report.completed = true;
  persist();
  app.quit();
}
const timer = setTimeout(
  () => {
    report.error = 'Electron验收超过172秒内部预算';
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
      await capture('failure');
    } catch {
      /* Preserve the original failure if capture is unavailable. */
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
async function saveBookmarks() {
  const tabs = (await state()).tabs;
  assert.equal(tabs.length, 2);
  check(
    'group-created',
    await invoke('tabs', 'createGroup', { tabId: tabs[0].id, name: '验收阅读组', color: 'blue' }),
  );
  const group = (await state()).groups.find((g) => g.name === '验收阅读组');
  assert(group);
  check(
    'second-tab-grouped',
    await invoke('tabs', 'setGroup', { tabId: tabs[1].id, groupId: group.id }),
  );
  await click('.tab-group-edit');
  await click('.bookmark-group-save button');
  await until('保存书签组完成', () =>
    js(
      `document.querySelector('.tab-group-editor [role=status]')?.textContent.includes('已保存到书签')`,
    ),
  );
  await click('[aria-label="关闭标签分组编辑器"]');
  await verifyBookmarks();
}
async function verifyBookmarks() {
  const result = await invoke('browserLibrary', 'listBookmarkGroups');
  assert(result.ok);
  const group = result.value.find((g) => g.name === '验收阅读组');
  check('bookmark-group-name-persisted', Boolean(group));
  const bookmarks = await invoke('browserLibrary', 'listBookmarks', {
    query: '',
    cursor: null,
    limit: 100,
  });
  assert(bookmarks.ok);
  const members = bookmarks.value.items.filter((item) => item.groupId === group.id);
  check(
    'bookmark-group-two-members',
    members.length === 2 &&
      members.some((i) => i.url === `${launch.base}/alpha`) &&
      members.some((i) => i.url === `${launch.base}/beta`),
  );
  await click('.bookmarks-open');
  await until('书签组显示', () => exists('.bookmark-group details'));
  check(
    'bookmark-group-default-collapsed',
    await js(`!document.querySelector('.bookmark-group details').open`),
  );
  await capture('bookmarks-collapsed');
  const before = await state();
  await click('.bookmark-group summary');
  check(
    'bookmark-group-expanded',
    await js(`document.querySelector('.bookmark-group details').open`),
  );
  check('expand-opens-no-tabs', (await state()).tabs.length === before.tabs.length);
  await capture('bookmarks-expanded');
  const url = await js(
    `document.querySelector('.bookmark-group-members .library-item-url').textContent`,
  );
  await click('.bookmark-group-members .library-item-main');
  await until('单书签打开', async () => {
    const s = await state();
    return s.tabs.find((t) => t.id === s.activeTabId)?.url === url;
  });
  check('single-bookmark-opens-one-tab', (await state()).tabs.length === before.tabs.length + 1);
}
