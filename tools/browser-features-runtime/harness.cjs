/* global __dirname, require, process, setTimeout, clearTimeout, queueMicrotask, URL */
// Electron requires a synchronous CommonJS bootstrap before the product entry.
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { app, dialog, webContents } = require('electron');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, realpathSync, lstatSync } = require('node:fs');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');
const { fileURLToPath } = require('node:url');

const repository = realpathSync(resolve(__dirname, '../..'));
const root = resolve(process.argv[2] ?? '');
const phase = process.argv[3];
const rel = relative(join(repository, 'log/browser-groups-userscripts-20261013'), root);
assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
assert.equal(realpathSync(root), root);
assert(['write', 'reopen'].includes(phase));
const launch = JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8'));
const input = JSON.parse(readFileSync(join(root, 'input.json'), 'utf8'));
assert.equal(input.repository, repository);
assert.equal(input.deadlineMs, 180000);
assert.equal(input.requestBudget, 20);
for (const [path, digest] of Object.entries(input.binding)) {
  const full = resolve(repository, path);
  const part = relative(repository, full);
  assert(part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
  assert.equal(createHash('sha256').update(readFileSync(full)).digest('hex'), digest);
}
const profile = join(root, 'profile');
const session = join(root, 'session');
for (const path of [profile, session]) {
  assert.equal(realpathSync(path), path);
  assert(!lstatSync(path).isSymbolicLink());
}
assert(!app.isPackaged);
app.setPath('userData', profile);
app.setPath('sessionData', session);
app.setAppPath(repository);
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
);
process.env.AIBROWSE_USER_DATA_DIR = profile;

const report = {
  phase,
  passed: false,
  willQuit: false,
  error: null,
  facts: {},
  details: {},
  captures: [],
  dialogs: [],
  network: { electronLocal: 0, unexpected: 0, node: 0, fetch: 0 },
  childLaunches: 0,
  downloadBoundary: {
    harnessHeaderObservers: 0,
    productHeaderListeners: [],
    cookieReads: 0,
    debuggerAttachments: 0,
    cookieCommands: 0,
    nativeEvents: [],
    trustedClick: false,
  },
  nativeHelpers: [],
  lifecycle: [],
};
const persist = () => writeFileSync(join(root, `${phase}.json`), JSON.stringify(report, null, 2));
const lifecycle = (event) => {
  report.lifecycle.push({ event, at: Date.now(), ready: app.isReady() });
  persist();
};
app.on('will-finish-launching', () => lifecycle('will-finish-launching'));
app.on('ready', () => lifecycle('ready'));
const fact = (name, detail) => {
  report.facts[name] = true;
  if (detail !== undefined) report.details[name] = detail;
  persist();
};
const local = (url) => {
  try {
    return new URL(url).origin === launch.base;
  } catch {
    return false;
  }
};
// Observe native completion ordering without changing product callbacks or results.
report.details.scriptRuntime = [];
const observeScriptRuntime = (value) => {
  if (report.details.scriptRuntime.length >= 100) return;
  report.details.scriptRuntime.push(value);
  persist();
};
app.on('web-contents-created', (_event, contents) => {
  const attach = contents.debugger.attach;
  contents.debugger.attach = function (...args) {
    report.downloadBoundary.debuggerAttachments += 1;
    persist();
    return Reflect.apply(attach, this, args);
  };
  const command = contents.debugger.sendCommand;
  contents.debugger.sendCommand = function (...args) {
    if (['Network.getCookies', 'Network.getAllCookies', 'Storage.getCookies'].includes(args[0])) {
      report.downloadBoundary.cookieCommands += 1;
      persist();
    }
    return Reflect.apply(command, this, args);
  };
  for (const name of ['did-finish-load', 'did-stop-loading']) {
    contents.on(name, () => {
      if (!contents.isDestroyed() && local(contents.getURL()))
        observeScriptRuntime({ name, loadingMainFrame: contents.isLoadingMainFrame() });
    });
  }
  const execute = contents.executeJavaScriptInIsolatedWorld;
  contents.executeJavaScriptInIsolatedWorld = function (...args) {
    const result = Reflect.apply(execute, this, args);
    if (local(this.getURL()) && args[0] >= 2000 && args[0] < 2050) {
      observeScriptRuntime({ name: 'isolated-call', world: args[0] });
      void result.then(
        (value) =>
          observeScriptRuntime({
            name: 'isolated-result',
            value: [true, false, 'executed', 'failed', 'stale'].includes(value) ? value : 'other',
          }),
        () => observeScriptRuntime({ name: 'isolated-rejection' }),
      );
    }
    return result;
  };
});
const fail = (error) => {
  report.passed = false;
  report.error = error.stack ?? String(error);
  persist();
  app.quit();
};
app.on('session-created', (value) => {
  // Install our counter first; registrations observed below belong to the product.
  value.webRequest.onSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    if (local(details.url)) report.network.electronLocal += 1;
    else {
      report.network.unexpected += 1;
      fail(new Error('拒绝验收计划外网络请求'));
    }
  });
  report.downloadBoundary.harnessHeaderObservers += 1;
  for (const method of ['onBeforeSendHeaders', 'onSendHeaders']) {
    const original = value.webRequest[method];
    value.webRequest[method] = function (...args) {
      report.downloadBoundary.productHeaderListeners.push(method);
      persist();
      return Reflect.apply(original, this, args);
    };
  }
  const getCookies = value.cookies.get;
  value.cookies.get = function (...args) {
    report.downloadBoundary.cookieReads += 1;
    persist();
    return Reflect.apply(getCookies, this, args);
  };
  value.on('will-download', (event, item) => {
    const native = {
      filename: item.getFilename(),
      hasUserGesture: item.hasUserGesture(),
      prevented: false,
    };
    report.downloadBoundary.nativeEvents.push(native);
    // Inspect the same event after product listeners run; this harness never cancels it.
    queueMicrotask(() => {
      native.prevented = event.defaultPrevented;
      persist();
    });
  });
});
for (const protocol of ['node:http', 'node:https']) {
  const module = require(protocol);
  module.request = function () {
    report.network.node += 1;
    throw new Error('本轮不允许Node网络调用');
  };
  module.get = function () {
    report.network.node += 1;
    throw new Error('本轮不允许Node网络调用');
  };
}
globalThis.fetch = function () {
  report.network.fetch += 1;
  return Promise.reject(new Error('本轮不允许Provider或fetch网络调用'));
};
// Preserve production startup helpers while denying every IDM launch.
for (const method of ['spawn', 'exec', 'execFile', 'spawnSync', 'execSync', 'execFileSync']) {
  const original = require('node:child_process')[method];
  require('node:child_process')[method] = function (...args) {
    const executable = String(args[0] ?? '');
    report.nativeHelpers.push({ method, executable });
    if (!/idman(?:\.exe)?|idm-handoff(?:\.exe)?/i.test(executable)) {
      persist();
      return Reflect.apply(original, this, args);
    }
    report.childLaunches += 1;
    persist();
    throw new Error('本轮不允许启动 IDM');
  };
}

let pendingFile = null;
let confirming = false;
dialog.showOpenDialog = async (...args) => {
  assert(pendingFile, '未计划的文件选择');
  const options = args.at(-1);
  report.dialogs.push({ kind: 'open', title: options.title ?? null });
  return { canceled: false, filePaths: [pendingFile] };
};
dialog.showMessageBox = async (...args) => {
  assert(confirming, '未计划的确认对话框');
  const options = args.at(-1);
  const response = options.buttons.findIndex(
    (label) => /安装|导入|确认|允许|移除|删除/.test(label) && !/取消|不/.test(label),
  );
  assert(response >= 0, '未知确认按钮');
  report.dialogs.push({
    kind: 'confirm',
    title: options.title ?? null,
    response,
    buttons: options.buttons,
  });
  return { response, checkboxChecked: false };
};

let win;
let started = false;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(description, probe, budget = 12000) {
  const deadline = Math.min(launch.deadline, Date.now() + budget);
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(75);
  }
  throw new Error(`${description}超时${lastError ? `：${lastError.message}` : ''}`);
}
async function js(source) {
  assert.equal(
    resolve(fileURLToPath(win.webContents.getURL())),
    join(repository, 'out/renderer/index.html'),
  );
  return win.webContents.executeJavaScript(source, true);
}
const invoke = (space, method, ...args) =>
  js(
    `window.aibrowse[${JSON.stringify(space)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`,
  );
async function capture(name) {
  const image = await win.capturePage();
  const data = image.toPNG();
  assert(data.length > 1000);
  const path = join(root, 'captures', `${phase}-${name}.png`);
  writeFileSync(path, data, { flag: 'wx' });
  report.captures.push({ name, path, sha256: createHash('sha256').update(data).digest('hex') });
  persist();
}
async function click(selector) {
  await until(`控件${selector}`, () =>
    js(
      `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if (!(e instanceof HTMLElement) || e.disabled) return false; e.click(); return true; })()`,
    ),
  );
}
async function clickText(scope, text) {
  await until(`按钮${text}`, () =>
    js(
      `(() => { const e=[...document.querySelectorAll(${JSON.stringify(scope)})].find(e => e.textContent.trim()===${JSON.stringify(text)}); if (!(e instanceof HTMLElement) || e.disabled) return false; e.click(); return true; })()`,
    ),
  );
}
async function ready() {
  await until('真实bridge就绪', async () => (await invoke('tabs', 'getState')).tabs.length > 0);
  await until('会话存储就绪', () =>
    js(`window.aibrowse.getConversationStorageStatus().then(status => status.state === 'ready')`),
  );
  await until('启动状态提示更新', () =>
    js(`!document.body.textContent.includes('会话保存失败，不能确认已保存')`),
  );
}

async function groups() {
  const first = await invoke('tabs', 'create');
  const second = await invoke('tabs', 'create');
  assert(first && second);
  await invoke('tabs', 'activate', first.id);
  await click('[aria-label="标签分组"]');
  await until('分组编辑器', () => js(`Boolean(document.querySelector('.tab-group-editor'))`));
  await js(`(() => {
    const input = document.querySelector('.tab-group-name-field input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '研究资料');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await clickText('.tab-group-editor-actions button', '创建新分组');
  await until(
    '编辑器创建分组',
    async () => (await invoke('tabs', 'getState')).groups[0]?.name === '研究资料',
  );
  await capture('group-editor-controls');
  await click('[aria-label="关闭标签分组编辑器"]');
  fact('groupEditorControls');
  const initial = await invoke('tabs', 'getState');
  const groupId = initial.groups[0].id;
  assert(await invoke('tabs', 'setGroup', { tabId: second.id, groupId }));
  await invoke('tabs', 'activate', second.id);
  assert(
    await invoke('tabs', 'updateGroup', {
      groupId,
      name: '已重命名资料',
      color: 'purple',
      collapsed: true,
    }),
  );
  const state = await invoke('tabs', 'getState');
  assert.equal(state.activeTabId, second.id);
  assert.deepEqual(state.groups[0], {
    id: groupId,
    name: '已重命名资料',
    color: 'purple',
    collapsed: true,
    tabIds: [first.id, second.id],
  });
  await until('折叠活动标签可见', () =>
    js(
      `(() => { const active=document.querySelector('.tab.active'); return active && active.getBoundingClientRect().width>0 && [...document.querySelectorAll('.tab')].length===2 && document.body.textContent.includes('已重命名资料'); })()`,
    ),
  );
  await capture('groups-collapsed-active');
  fact('groups', { groupId, activeTabId: second.id });
  const reloaded = new Promise((done) => win.webContents.once('did-finish-load', done));
  win.webContents.reload();
  await reloaded;
  await ready();
  assert.deepEqual((await invoke('tabs', 'getState')).groups, state.groups);
  await until('UI重载组可见', () =>
    js(
      `document.body.textContent.includes('已重命名资料') && document.querySelector('.tab.active')!==null`,
    ),
  );
  fact('uiReloadGroups');
  assert(await invoke('tabs', 'setGroup', { tabId: first.id, groupId: null }));
  assert.deepEqual((await invoke('tabs', 'getState')).groups[0].tabIds, [second.id]);
  assert(await invoke('tabs', 'ungroup', groupId));
  const after = await invoke('tabs', 'getState');
  assert.equal(after.groups.length, 0);
  assert(
    after.tabs.some((tab) => tab.id === first.id) && after.tabs.some((tab) => tab.id === second.id),
  );
  report.details.groups.ungroupPreservedTabs = true;
}

async function appearance() {
  await click('[aria-label="设置"]');
  await clickText('.settings-nav button', '外观');
  const colors = {};
  for (const choice of ['light', 'dark', 'system']) {
    await click(`.theme-choice input[value="${choice}"]`);
    await until(`外观${choice}`, () =>
      js(
        `document.documentElement.dataset.theme===${JSON.stringify(choice)} && document.querySelector('.theme-choice input[value="${choice}"]').checked`,
      ),
    );
    await js(
      `Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)))`,
    );
    const measured = await js(`(() => {
      const rows=[...document.querySelectorAll('.theme-choice')].map(e=>{
        const label=e.querySelector('strong'); const copy=e.querySelector('.theme-choice-copy > span');
        const style=getComputedStyle(e); const rect=e.getBoundingClientRect();
        return {text:label.textContent, color:getComputedStyle(label).color, secondary:getComputedStyle(copy).color, background:style.backgroundColor, width:rect.width,height:rect.height};
      }); return {rows, rootBackground:getComputedStyle(document.body).backgroundColor, checked:[...document.querySelectorAll('.theme-choice input')].filter(e=>e.checked).length};
    })()`);
    report.details.appearanceSamples ??= {};
    report.details.appearanceSamples[choice] = measured;
    persist();
    assert.equal(measured.rows.length, 3);
    assert.equal(measured.checked, 1);
    for (const row of measured.rows) {
      assert(row.width > 80 && row.height > 35);
      row.primaryContrast = contrast(row.color, row.background);
      row.secondaryContrast = contrast(row.secondary, row.background);
      persist();
      assert(row.primaryContrast >= 4.5, `${choice}主文字对比不足`);
      assert(row.secondaryContrast >= 4.5, `${choice}说明对比不足`);
    }
    colors[choice] = measured;
    await capture(`appearance-${choice}`);
  }
  assert.notDeepEqual(
    colors.light.rows.map((row) => row.background),
    colors.dark.rows.map((row) => row.background),
  );
  fact('appearance', colors);
  await clickText('.settings-nav button', '下载与脚本');
  await until('脚本入口', () => js(`document.body.textContent.includes('导入脚本')`));
  await capture('scripts-settings');
  await clickText('.workspace-page-back', '返回浏览');
}
async function themeState(mode, color) {
  await until(`配色${mode}/${color}`, () =>
    js(`(() => {
    const root=document.documentElement;
    return root.dataset.theme===${JSON.stringify(mode)} && root.dataset.themeColor===${JSON.stringify(color)} && localStorage.getItem('aibrowse.appearance')===${JSON.stringify(mode)} && localStorage.getItem('aibrowse.themeColor')===${JSON.stringify(color)};
  })()`),
  );
}
async function inputValue(selector, value) {
  await js(`(() => {
    const input=document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
}
function cssHex(value) {
  const numbers = value.match(/[\d.]+/g)?.map(Number);
  assert(numbers && numbers.length === 3, `颜色必须为不透明RGB：${value}`);
  return '#' + numbers.map((number) => Math.round(number).toString(16).padStart(2, '0')).join('');
}
async function themeSample(name) {
  const animations = await js(`(async () => {
    const all=document.getAnimations();
    const infinite=all.filter(animation=>animation.effect?.getTiming().iterations===Infinity);
    const ignoredInfinite=infinite.map(animation=>{
      const target=animation.effect?.target;
      const properties=[...new Set(animation.effect.getKeyframes().flatMap(frame=>Object.keys(frame)))];
      if (!(target instanceof Element) || !target.matches('.spinner') || target.matches('.tab-strip-row,.toolbar,.tab.active,.ai-toggle') || animation.animationName!=='spin' || properties.some(property=>!['offset','computedOffset','easing','composite','transform'].includes(property)))
        throw new Error('存在影响颜色观测或未识别的无限动画，停止主题验收');
      return {type:target.tagName,className:target.className,animation:animation.animationName,properties};
    });
    const samples=[...document.querySelectorAll('.tab-strip-row,.toolbar,.tab.active,.ai-toggle')];
    const relevant=all.filter(animation=>{
      const target=animation.effect?.target;
      return Number.isFinite(animation.effect?.getTiming().iterations) && target instanceof Element && samples.some(sample=>sample===target || sample.contains(target));
    });
    await Promise.all(relevant.map(animation=>animation.finished.catch(()=>undefined)));
    return {finiteSampleAnimations:relevant.length,ignoredInfiniteCount:ignoredInfinite.length,ignoredInfinite};
  })()`);
  report.details.themeAnimations ??= {};
  report.details.themeAnimations[name] = animations;
  persist();
  win.focus();
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 10, y: 110 });
  await delay(60);
  await js(
    `(() => { const button=document.querySelector('.ai-toggle'); if (button.getAttribute('aria-pressed')==='true') button.click(); })()`,
  );
  const sample = await js(`(() => {
    const root=document.documentElement;
    const chrome=getComputedStyle(document.querySelector('.tab-strip-row'));
    const toolbar=getComputedStyle(document.querySelector('.toolbar'));
    const tab=getComputedStyle(document.querySelector('.tab.active'));
    const button=document.querySelector('.ai-toggle');
    const ai=getComputedStyle(button), rect=button.getBoundingClientRect();
    return {mode:root.dataset.theme,color:root.dataset.themeColor,systemDark:matchMedia('(prefers-color-scheme: dark)').matches,chrome:chrome.backgroundColor,text:chrome.color,toolbar:toolbar.backgroundColor,activeTab:tab.backgroundColor,tabText:tab.color,normal:{color:ai.color,background:ai.backgroundColor,filter:ai.filter,hover:button.matches(':hover')},point:{x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}};
  })()`);
  assert.equal(sample.normal.hover, false);
  assert.equal(sample.normal.filter, 'none');
  sample.normalContrast = contrast(sample.normal.color, sample.normal.background);
  sample.chromeContrast = contrast(sample.text, sample.chrome);
  sample.tabContrast = contrast(sample.tabText, sample.activeTab);
  await until('标题栏原生参数同步', () => {
    const native = report.details.nativeOverlays.at(-1);
    if (native?.color !== cssHex(sample.chrome) || native?.symbolColor !== cssHex(sample.text))
      return false;
    sample.native = { ...native };
    return true;
  });
  win.webContents.sendInputEvent({ type: 'mouseMove', ...sample.point });
  await until('AI按钮真实悬停', () => js(`document.querySelector('.ai-toggle').matches(':hover')`));
  sample.hover = await js(
    `(() => { const style=getComputedStyle(document.querySelector('.ai-toggle'));return {color:style.color,background:style.backgroundColor,filter:style.filter}; })()`,
  );
  assert.equal(sample.hover.filter, 'none');
  sample.hoverContrast = contrast(sample.hover.color, sample.hover.background);
  report.details.themeSamples ??= {};
  report.details.themeSamples[name] = sample;
  persist();
  assert(sample.normalContrast >= 4.5 && sample.hoverContrast >= 4.5, `${name}按钮文字对比不足`);
  assert(sample.chromeContrast >= 4.5 && sample.tabContrast >= 4.5, `${name}标签文字对比不足`);
  assert.equal(sample.native.height, 36);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 10, y: 110 });
  return sample;
}
async function themeColors() {
  await click('[aria-label="设置"]');
  await clickText('.settings-nav button', '外观');
  await until('主题色16预设', () =>
    js(`document.querySelectorAll('.theme-color-choice input').length===16`),
  );
  await click('.theme-color-choice input[value="default"]');
  win.focus();
  win.webContents.focus();
  await js(`document.querySelector('.theme-color-choice input[value="default"]').focus()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
  await themeState('system', '#1a73e8');
  const keyboard = await js(`(() => {
    const input=document.activeElement;
    const choice=input.closest('.theme-color-choice');
    const style=getComputedStyle(choice);
    return {value:input.value,checked:input.checked,focusVisible:input.matches(':focus-visible'),outline:parseFloat(style.outlineWidth),name:input.getAttribute('aria-label')};
  })()`);
  assert.equal(keyboard.value, 'blue');
  assert.equal(keyboard.checked, true);
  assert.equal(keyboard.focusVisible, true);
  assert(keyboard.outline >= 2 && keyboard.name.length > 0);
  fact('themeColorKeyboard', keyboard);
  const samples = {};
  const narrow = {};
  for (const mode of ['light', 'dark']) {
    await click(`.theme-choice input[value="${mode}"]`);
    await click('.theme-color-choice input[value="purple"]');
    await themeState(mode, '#7e57c2');
    samples[mode] = await themeSample(`purple-${mode}`);
    await js(`document.querySelector('.settings-page').scrollTop=0`);
    await capture(`theme-purple-${mode}`);
    win.setSize(600, 900);
    await delay(200);
    await js(`document.querySelector('.theme-color-picker').scrollIntoView({block:'nearest'})`);
    const geometry = await js(`(() => {
      const root=document.querySelector('.settings-content'), picker=document.querySelector('.theme-color-picker');
      const rect=picker.getBoundingClientRect();
      const boxes=[...picker.querySelectorAll('.theme-color-choice,.theme-color-custom input,.theme-color-custom button')].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,right:r.right,width:r.width,height:r.height};});
      return {viewport:innerWidth,width:root.clientWidth,scrollWidth:root.scrollWidth,pickerWidth:picker.clientWidth,pickerScrollWidth:picker.scrollWidth,left:rect.left,right:rect.right,boxes};
    })()`);
    assert(geometry.viewport >= 560 && geometry.viewport <= 600);
    assert(geometry.scrollWidth <= geometry.width + 1);
    assert(geometry.pickerScrollWidth <= geometry.pickerWidth + 1);
    assert(geometry.boxes.length === 19);
    assert(
      geometry.boxes.every(
        (box) =>
          box.width >= 35 &&
          box.height >= 35 &&
          box.x >= geometry.left - 1 &&
          box.right <= geometry.right + 1,
      ),
    );
    narrow[mode] = geometry;
    await capture(`theme-purple-${mode}-600px`);
    win.setSize(1280, 900);
    await delay(100);
  }
  assert.notEqual(samples.light.chrome, samples.dark.chrome);
  fact('themeColorNarrow', narrow);
  await inputValue('.theme-color-hex input', '#GGGGGG');
  await click('.theme-color-custom button[type="submit"]');
  await until('拒绝非法HEX', () =>
    js(
      `document.querySelector('.theme-color-hex input').getAttribute('aria-invalid')==='true' && document.querySelector('.theme-color-error')?.textContent.includes('HEX')`,
    ),
  );
  await themeState('dark', '#7e57c2');
  await inputValue('.theme-color-hex input', '#FFCC00');
  await click('.theme-color-custom button[type="submit"]');
  await themeState('dark', '#ffcc00');
  await themeSample('custom-hex-dark');
  await inputValue('.theme-color-native input', '#00ff00');
  await themeState('dark', '#00ff00');
  await themeSample('custom-picker-dark');
  await click('.theme-choice input[value="light"]');
  await themeState('light', '#00ff00');
  fact('themeColorInputs', {
    invalidRejected: true,
    hex: '#ffcc00',
    nativeInput: '#00ff00',
    modeIndependent: true,
  });
  await clickText('.theme-color-heading button', '恢复默认');
  await themeState('light', 'default');
  assert(await js(`document.querySelector('.theme-color-choice input[value="default"]').checked`));
  fact('themeColorReset', { mode: 'light', color: 'default' });
  await click('.theme-choice input[value="system"]');
  await click('.theme-color-choice input[value="purple"]');
  await themeState('system', '#7e57c2');
  const system = await themeSample('purple-system');
  assert.equal(system.chrome, samples[system.systemDark ? 'dark' : 'light'].chrome);
  fact('themeColors', { purple: '#7e57c2', systemDark: system.systemDark });
  fact('themeNativeSync', { samples: Object.keys(report.details.themeSamples) });
  await clickText('.workspace-page-back', '返回浏览');
}
async function prepareThemePersistence() {
  await clickText('.settings-nav button', '外观');
  await click('.theme-choice input[value="dark"]');
  await inputValue('.theme-color-hex input', '#245F94');
  await click('.theme-color-custom button[type="submit"]');
  await themeState('dark', '#245f94');
  await themeSample('persisted-dark');
  writeFileSync(
    join(root, 'expected-theme.json'),
    JSON.stringify({ mode: 'dark', color: '#245f94' }),
    { flag: 'wx' },
  );
  fact('themeColorPersistencePrepared');
}
async function reopenTheme() {
  const expected = JSON.parse(readFileSync(join(root, 'expected-theme.json'), 'utf8'));
  assert.deepEqual(expected, { mode: 'dark', color: '#245f94' });
  await themeState(expected.mode, expected.color);
  await click('[aria-label="设置"]');
  await clickText('.settings-nav button', '外观');
  await until('重启颜色控件还原', () =>
    js(
      `document.querySelector('.theme-choice input[value="dark"]').checked && document.querySelector('.theme-color-hex input').value==='#245f94'`,
    ),
  );
  await themeSample('reopened-dark');
  await capture('theme-reopened');
  fact('themeColorPersisted', expected);
  await clickText('.workspace-page-back', '返回浏览');
}
async function downloadAndScriptsUi() {
  await click('[aria-label="下载与脚本"]');
  await until('工具直达下载与脚本', () =>
    js(
      `document.querySelector('.settings-nav [aria-current="page"]')?.textContent==='下载与脚本' && document.querySelectorAll('[aria-label="指定油猴脚本"] .userscript-card').length===2`,
    ),
  );
  for (const label of ['IDM 下载工具', '指定油猴脚本', '用户脚本管理']) {
    assert(await js(`Boolean(document.querySelector('[aria-label=${JSON.stringify(label)}]'))`));
  }
  const status = await invoke('downloads', 'getStatus');
  assert.equal(typeof status.available, 'boolean');
  const qualified = await invoke('qualifiedScripts', 'list');
  assert.deepEqual(qualified.map((script) => script.id).sort(), ['ac-baidu', 'github-zh']);
  assert(qualified.every((script) => script.installed && script.enabled && script.issue === null));
  const rejected = [];
  for (const url of [
    'file:///C:/fixture.zip',
    'javascript:alert(1)',
    'https://example.com/file\r\ninvalid',
  ]) {
    const answer = await invoke('downloads', 'sendToIdm', url);
    assert.equal(answer.ok, false);
    assert.equal(answer.code, 'invalid-url');
    rejected.push({ url, answer });
  }
  assert.equal(report.childLaunches, 0);
  fact('downloadToolEntry', { status, qualified, rejected });
  const samples = {};
  for (const theme of ['light', 'dark']) {
    await clickText('.settings-nav button', '外观');
    await click(`.theme-choice input[value="${theme}"]`);
    await until('主题切换', () =>
      js(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`),
    );
    await clickText('.settings-nav button', '下载与脚本');
    await until('指定脚本完成渲染', () =>
      js(`document.querySelectorAll('[aria-label="指定油猴脚本"] .userscript-card').length===2`),
    );
    await js(
      `Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)))`,
    );
    await js(`document.querySelector('.settings-page').scrollTop=0`);
    await capture(`download-scripts-${theme}`);
    await js(
      `document.querySelector('[aria-label="指定油猴脚本"]').scrollIntoView({block:'start'})`,
    );
    await capture(`qualified-scripts-${theme}`);
    await js(
      `document.querySelector('[aria-label="用户脚本管理"]').scrollIntoView({block:'start'})`,
    );
    await capture(`other-scripts-${theme}`);
    await js(`document.querySelector('.settings-page').scrollTop=0`);
    win.setSize(600, 900);
    await delay(250);
    const geometry = await js(`(() => {
      const root=document.querySelector('.settings-content');
      const panels=[...root.querySelectorAll(':scope > section')].map(e=>({label:e.getAttribute('aria-label'),width:e.getBoundingClientRect().width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}));
      const input=document.querySelector('#idm-download-url').getBoundingClientRect();
      return {viewport:innerWidth,rootWidth:root.clientWidth,rootScrollWidth:root.scrollWidth,inputWidth:input.width,panels};
    })()`);
    samples[theme] = geometry;
    report.details.downloadNarrowSamples = samples;
    persist();
    assert(geometry.viewport <= 600 && geometry.viewport >= 560);
    assert(geometry.rootScrollWidth <= geometry.rootWidth + 1, '窄窗口工具页横向溢出');
    assert(geometry.inputWidth >= 150);
    assert(
      geometry.panels.length === 3 &&
        geometry.panels.every(
          (panel) => panel.width > 250 && panel.scrollWidth <= panel.clientWidth + 1,
        ),
    );
    await capture(`download-scripts-${theme}-600px`);
    await js(
      `document.querySelector('[aria-label="指定油猴脚本"]').scrollIntoView({block:'start'})`,
    );
    await capture(`qualified-scripts-${theme}-600px`);
    await js(
      `document.querySelector('[aria-label="用户脚本管理"]').scrollIntoView({block:'start'})`,
    );
    await capture(`other-scripts-${theme}-600px`);
    win.setSize(1280, 900);
    await delay(150);
  }
  fact('downloadToolAppearance', samples);
  await clickText('.workspace-page-back', '返回浏览');
}
async function browserDownloadBlocked() {
  const { contents } = await page(`${launch.base}/download-click`);
  win.show();
  win.focus();
  contents.focus();
  await delay(100);
  assert(win.isFocused() && contents.isFocused(), '下载正控制未取得前台焦点');
  const point = await contents.executeJavaScript(`(() => {
    const rect=document.querySelector('#blocked-download').getBoundingClientRect();
    return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};
  })()`);
  contents.sendInputEvent({ type: 'mouseMove', ...point });
  await delay(50);
  contents.sendInputEvent({ type: 'mouseDown', button: 'left', ...point, clickCount: 1 });
  await delay(80);
  contents.sendInputEvent({ type: 'mouseUp', button: 'left', ...point, clickCount: 1 });
  await until('浏览器原生下载事件', () => report.downloadBoundary.nativeEvents.length > 0);
  report.downloadBoundary.trustedClick = await contents.executeJavaScript(
    'window.__downloadClickTrusted===true',
  );
  assert.equal(report.downloadBoundary.trustedClick, true);
  assert.deepEqual(report.downloadBoundary.nativeEvents, [
    { filename: 'blocked-download.bin', hasUserGesture: true, prevented: true },
  ]);
  assert.equal(report.childLaunches, 0);
  fact('browserDownloadBlocked');
}
function contrast(first, second) {
  const luminance = (value) => {
    const numbers = value.match(/[\d.]+/g)?.map(Number);
    assert(
      numbers && numbers.length >= 3 && (numbers.length === 3 || numbers[3] === 1),
      `未知透明颜色：${value}`,
    );
    const converted = numbers.slice(0, 3).map((part) => {
      const v = part / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return converted[0] * 0.2126 + converted[1] * 0.7152 + converted[2] * 0.0722;
  };
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function fixture(name, marker, grant = 'none') {
  const path = join(root, 'fixtures', `${name}.user.js`);
  const code = `// ==UserScript==\n// @name ${name}\n// @namespace synthetic.runtime\n// @version 1.0.0\n// @description 受控本地脚本夹具\n// @match http://127.0.0.1/*\n// @exclude http://127.0.0.1/unmatched*\n// @grant ${grant}\n// @run-at document-idle\n// ==/UserScript==\ndocument.documentElement.setAttribute('data-${marker}', 'yes');\nwindow.__fixtureScriptSecret = 'isolated-world';\ndocument.documentElement.setAttribute('data-script-isolation', JSON.stringify({pageGlobalAbsent: typeof window.__fixturePageSecret === 'undefined', requireAbsent: typeof require === 'undefined', processAbsent: typeof process === 'undefined', bridgeAbsent: typeof window.aibrowse === 'undefined'}));\n`;
  writeFileSync(path, code, { flag: 'wx' });
  return path;
}
async function importScript(path) {
  pendingFile = path;
  confirming = true;
  try {
    return await invoke('userscripts', 'importScript');
  } finally {
    pendingFile = null;
    confirming = false;
  }
}
async function summaries() {
  const value = await invoke('userscripts', 'list');
  assert(value.ok, JSON.stringify(value));
  for (const item of value.value)
    assert(
      !Object.hasOwn(item, 'code') &&
        !Object.hasOwn(item, 'source') &&
        !Object.hasOwn(item, 'path'),
    );
  return value.value;
}
async function page(url) {
  const tab = await invoke('tabs', 'create', url);
  assert(tab);
  const contents = await until('合成页面完成', () =>
    webContents
      .getAllWebContents()
      .find((wc) => wc !== win.webContents && wc.getURL() === url && !wc.isLoadingMainFrame()),
  );
  return { tab, contents };
}
async function marker(contents, name, expected) {
  if (expected)
    await until(`脚本标记${name}`, () =>
      contents.executeJavaScript(
        `document.documentElement.getAttribute(${JSON.stringify(`data-${name}`)})==='yes'`,
      ),
    );
  else {
    await delay(250);
    assert.equal(
      await contents.executeJavaScript(
        `document.documentElement.getAttribute(${JSON.stringify(`data-${name}`)})`,
      ),
      null,
    );
  }
}
async function reloadPage(current) {
  const loaded = new Promise((done) => current.contents.once('did-finish-load', done));
  assert(await invoke('nav', 'reload', current.tab.id));
  await loaded;
}
async function writeScripts() {
  assert.deepEqual(await summaries(), []);
  const path = fixture('运行时脚本验证', 'script-probe');
  const result = await importScript(path);
  assert(result.ok, JSON.stringify(result));
  const installed = (await summaries())[0];
  assert(installed && installed.enabled);
  const matched = await page(`${launch.base}/matched`);
  await marker(matched.contents, 'script-probe', true);
  const isolation = await matched.contents.executeJavaScript(`({
    facts: JSON.parse(document.documentElement.getAttribute('data-script-isolation')),
    pageGlobal: window.__fixturePageSecret,
    scriptGlobalAbsent: typeof window.__fixtureScriptSecret === 'undefined'
  })`);
  assert.deepEqual(isolation.facts, {
    pageGlobalAbsent: true,
    requireAbsent: true,
    processAbsent: true,
    bridgeAbsent: true,
  });
  assert.equal(isolation.pageGlobal, 'page-world');
  assert.equal(isolation.scriptGlobalAbsent, true);
  const preferences = matched.contents.getLastWebPreferences();
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.webSecurity, true);
  assert(!preferences.preload);
  fact('scriptIsolation', isolation);
  const unmatched = await page(`${launch.base}/unmatched`);
  await marker(unmatched.contents, 'script-probe', false);
  assert((await invoke('userscripts', 'setEnabled', installed.id, false)).ok);
  await reloadPage(matched);
  await marker(matched.contents, 'script-probe', false);
  assert((await invoke('userscripts', 'setEnabled', installed.id, true)).ok);
  await reloadPage(matched);
  await marker(matched.contents, 'script-probe', true);
  confirming = true;
  try {
    assert((await invoke('userscripts', 'remove', installed.id)).ok);
  } finally {
    confirming = false;
  }
  await reloadPage(matched);
  await marker(matched.contents, 'script-probe', false);
  assert.deepEqual(await summaries(), []);
  fact('scriptLifecycle');
  const invalid = await importScript(
    fixture('不支持权限验证', 'forbidden-probe', 'GM_xmlhttpRequest'),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'unsupported');
  assert.deepEqual(await summaries(), []);
  fact('unsupportedRejected');
  assert((await importScript(fixture('重启启用验证', 'enabled-probe'))).ok);
  assert((await importScript(fixture('重启禁用验证', 'disabled-probe'))).ok);
  const list = await summaries();
  const disabled = list.find((script) => script.name === '重启禁用验证');
  assert(disabled);
  assert((await invoke('userscripts', 'setEnabled', disabled.id, false)).ok);
  const saved = await summaries();
  writeFileSync(join(root, 'expected-scripts.json'), JSON.stringify(saved, null, 2), {
    flag: 'wx',
  });
  await reloadPage(matched);
  await marker(matched.contents, 'enabled-probe', true);
  await marker(matched.contents, 'disabled-probe', false);
  await invoke('tabs', 'activate', matched.tab.id);
  await capture('script-matched');
  fact('persistencePrepared', { ids: saved.map((script) => script.id) });
  await click('[aria-label="设置"]');
  await clickText('.settings-nav button', '下载与脚本');
  await until('脚本列表反映已保存状态', () =>
    js(`(() => {
      const rows = [...document.querySelectorAll('[aria-label="用户脚本管理"] .userscript-card')];
      return rows.length === 2 && rows.some(row => row.textContent.includes('重启启用验证') && row.querySelector('input').checked) && rows.some(row => row.textContent.includes('重启禁用验证') && !row.querySelector('input').checked);
    })()`),
  );
  await capture('scripts-installed');
}
async function reopenScripts() {
  const expected = JSON.parse(readFileSync(join(root, 'expected-scripts.json'), 'utf8'));
  assert.deepEqual(await summaries(), expected);
  fact('scriptsPersisted');
  const matched = await page(`${launch.base}/reopened`);
  await marker(matched.contents, 'enabled-probe', true);
  await marker(matched.contents, 'disabled-probe', false);
  fact('persistedExecution');
  await capture('script-reopened');
}

async function run() {
  await ready();
  assert.equal(app.getPath('userData'), profile);
  assert.equal(app.getPath('sessionData'), session);
  fact('isolation', { profile, session });
  win.setSize(1280, 900);
  win.show();
  if (phase === 'write') {
    await groups();
    await appearance();
    await themeColors();
    await downloadAndScriptsUi();
    await browserDownloadBlocked();
    await writeScripts();
    await prepareThemePersistence();
  } else {
    await reopenTheme();
    await reopenScripts();
  }
  assert.equal(report.network.unexpected, 0);
  assert.equal(report.network.node, 0);
  assert.equal(report.network.fetch, 0);
  assert.equal(report.childLaunches, 0);
  assert(report.downloadBoundary.harnessHeaderObservers > 0);
  assert.deepEqual(report.downloadBoundary.productHeaderListeners, []);
  assert.equal(report.downloadBoundary.cookieReads, 0);
  assert.equal(report.downloadBoundary.debuggerAttachments, 0);
  assert.equal(report.downloadBoundary.cookieCommands, 0);
  report.passed = true;
  persist();
  app.quit();
}
const timer = setTimeout(
  () => {
    report.passed = false;
    report.error = '总运行预算180秒耗尽';
    persist();
    app.exit(1);
  },
  Math.max(1, launch.deadline - Date.now()),
);
app.on('browser-window-created', (_event, value) => {
  if (started) return;
  started = true;
  win = value;
  report.details.nativeOverlays = [];
  const setOverlay = win.setTitleBarOverlay;
  win.setTitleBarOverlay = function (...args) {
    const result = Reflect.apply(setOverlay, this, args);
    // Record only successful calls to the real native implementation.
    report.details.nativeOverlays.push({ ...args[0] });
    persist();
    return result;
  };
  void run().catch(fail);
});
app.on('will-quit', () => {
  report.willQuit = true;
  clearTimeout(timer);
  persist();
});
process.on('exit', persist);
persist();
lifecycle('before-product-require');
require(join(repository, 'out/main/index.js'));
lifecycle('after-product-require');
setTimeout(() => lifecycle('first-event-loop-turn'), 0);
