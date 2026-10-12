/* global __dirname, require, process, setTimeout, clearTimeout */
// Electron loads this bootstrap before the unmodified ordinary product entry.
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const electron = require('electron');
const { app, ipcMain, BrowserWindow, webContents } = electron;
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, writeFileSync, realpathSync, lstatSync } = require('node:fs');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');
const { fileURLToPath } = require('node:url');

const repository = realpathSync(resolve(__dirname, '../..'));
const root = resolve(process.argv[2] ?? '');
const phase = process.argv[3];
const rel = relative(join(repository, 'log/tray-runtime-20261012'), root);
assert(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
assert.equal(realpathSync(root), root);
assert(['write', 'reopen', 'disabled'].includes(phase));
const input = JSON.parse(readFileSync(join(root, 'input.json'), 'utf8'));
const launch = JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8'));
assert.equal(input.repository, repository);
assert.equal(input.deadlineMs, 180000);
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
process.env.AIBROWSE_USER_DATA_DIR = profile;

const report = {
  phase,
  passed: false,
  willQuit: false,
  error: null,
  facts: {},
  details: {},
  captures: [],
  ipc: {},
};
const persist = () => writeFileSync(join(root, `${phase}.json`), JSON.stringify(report, null, 2));
const fact = (name, details) => {
  report.facts[name] = true;
  if (details !== undefined) report.details[name] = details;
  persist();
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) =>
  originalHandle(channel, (event, ...args) => {
    report.ipc[channel] = (report.ipc[channel] ?? 0) + 1;
    return listener(event, ...args);
  });
let win;
let started = false;
let observedRuntime;
let tray;
let trayMenu;
let runtimeBefore;
async function until(description, probe, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
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
const invoke = (namespace, name, payload) =>
  js(
    `window.aibrowse[${JSON.stringify(namespace)}][${JSON.stringify(name)}](${payload === undefined ? '' : JSON.stringify(payload)})`,
  );
const watch = (name, payload) => invoke('watch', name, payload);
const rules = async () => {
  const value = await watch('listRules', {
    page: 1,
    pageSize: 50,
    filter: { state: null, sourceId: null },
  });
  assert(value.ok, JSON.stringify(value));
  return value.value.items;
};
function readDb(file, work) {
  const db = new DatabaseSync(join(profile, file), { readOnly: true });
  try {
    return work(db);
  } finally {
    db.close();
  }
}
function watchRows(ruleId) {
  return readDb('watch/watch.db', (db) => ({
    rule: db
      .prepare(
        'SELECT id, binding_kind, source_id, baseline_version, target_json FROM watch_rules WHERE id = ?',
      )
      .get(ruleId),
    baseline: db
      .prepare(
        'SELECT version, content_hash, projection_json FROM watch_baselines WHERE rule_id = ?',
      )
      .get(ruleId),
    runs: db
      .prepare(
        'SELECT id, trigger, status, outcome_json FROM watch_runs WHERE rule_id = ? ORDER BY rowid',
      )
      .all(ruleId),
    events: db
      .prepare('SELECT id, event_kind, item_count FROM watch_events WHERE rule_id = ? ORDER BY id')
      .all(ruleId),
    evidence: db
      .prepare(
        'SELECT before_value_json, after_value_json FROM watch_event_items WHERE event_id IN (SELECT id FROM watch_events WHERE rule_id = ?) ORDER BY id',
      )
      .all(ruleId),
  }));
}
async function click(selector) {
  assert(
    await js(
      `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if (!(e instanceof HTMLElement) || e.disabled) return false; e.click(); return true; })()`,
    ),
    `无法点击${selector}`,
  );
  await delay(80);
}
async function button(container, text) {
  assert(
    await js(
      `(() => { const root=document.querySelector(${JSON.stringify(container)}); const e=root && [...root.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)}); if (!e || e.disabled) return false; e.click(); return true; })()`,
    ),
    `无法点击${text}`,
  );
  await delay(80);
}
async function inputValue(selector, value, select = false) {
  assert(
    await js(
      `(() => { const e=document.querySelector(${JSON.stringify(selector)}); const proto=${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype; if (!e || e.disabled) return false; Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return e.value===${JSON.stringify(value)}; })()`,
    ),
  );
  await delay(80);
}
async function capture(name) {
  await delay(200);
  const png = (await win.capturePage()).toPNG();
  const path = join(root, 'captures', `${name}.png`);
  writeFileSync(path, png, { flag: 'wx' });
  const layout = await js(
    `({theme:document.documentElement.dataset.theme, viewport:[innerWidth,innerHeight], overflow:document.documentElement.scrollWidth>innerWidth+2, urlInput:document.querySelector('.watch-wizard input')?.value??null, noticeCount:document.querySelectorAll('.ai-citation-notices').length})`,
  );
  assert.equal(layout.overflow, false);
  report.captures.push({ path, sha256: hash(png), layout });
  persist();
}

// Observe the real native instance when production sets its real context menu.
const originalSetContextMenu = electron.Tray.prototype.setContextMenu;
function observeTray(value, menu) {
  tray = value;
  trayMenu = menu;
}
electron.Tray.prototype.setContextMenu = function (menu) {
  observeTray(this, menu);
  return originalSetContextMenu.call(this, menu);
};
function menu(label) {
  const item = trayMenu?.items.find((entry) => entry.label === label);
  assert(item && item.enabled && typeof item.click === 'function', `缺少托盘菜单${label}`);
  item.click(undefined, win, {});
}
async function preferences() {
  return invoke('appPreferences', 'get');
}
async function openPreferences() {
  await click('.settings-open');
  await until('设置界面', () => js(`Boolean(document.querySelector('.settings-page'))`));
  await button('.settings-nav', '常规');
  await until('托盘设置', () =>
    js(`Boolean(document.querySelector('input[aria-label="关闭窗口后在系统托盘运行"]'))`),
  );
}
async function togglePreference(value) {
  const selector = 'input[aria-label="关闭窗口后在系统托盘运行"]';
  const checked = await js(`document.querySelector(${JSON.stringify(selector)}).checked`);
  if (checked !== value) await click(selector);
  await until('托盘设置保存', async () => (await preferences()).runInTray === value);
  assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).checked`), value);
}
function alive() {
  const now = observedRuntime();
  assert.equal(now.browserController, runtimeBefore.browserController);
  assert.equal(now.watchScheduler, runtimeBefore.watchScheduler);
  assert.equal(now.watchRepo, runtimeBefore.watchRepo);
  assert.equal(now.watchRunCoordinator, runtimeBefore.watchRunCoordinator);
  assert.equal(now.runtimeShutdown, null);
  assert.equal(BrowserWindow.fromId(win.id), win);
  assert(!win.isDestroyed());
}
async function hide() {
  win.close();
  await until('主窗口隐藏', () => !win.isVisible());
  alive();
}
function syntheticDue(ruleId) {
  const runtime = observedRuntime();
  assert.equal(app.getPath('userData'), profile);
  assert.equal(
    realpathSync(runtime.watchRepo.dbHandle.path),
    realpathSync(join(profile, 'watch/watch.db')),
  );
  const due = new Date(Date.now() + 400).toISOString();
  const result = runtime.watchRepo.dbHandle
    .prepare('UPDATE watch_rules SET next_due_at = ? WHERE id = ? AND state = ?')
    .run(due, ruleId, 'enabled');
  assert.equal(Number(result.changes), 1);
  runtime.watchScheduler.upsert({ ruleId, effectiveDueAt: Date.parse(due) });
  report.details.syntheticDue = {
    ruleId,
    due,
    scope: '隔离合成规则；真实系统时钟、HostGate与生产调度不替换',
  };
  persist();
}
async function eventWhileHidden(ruleId, count, from, to) {
  const rows = await until(
    '隐藏期间自动周期完成',
    () => {
      alive();
      assert.equal(win.isVisible(), false);
      const value = watchRows(ruleId);
      return value.events.length === count &&
        value.runs.filter(
          (run) =>
            run.trigger === 'scheduled' &&
            run.status === 'finished' &&
            JSON.parse(run.outcome_json).kind === 'event-created',
        ).length === count
        ? value
        : null;
    },
    35000,
  );
  assert(
    rows.evidence.some((item) => {
      const a = JSON.parse(item.before_value_json);
      const b = JSON.parse(item.after_value_json);
      return (
        a.kind === 'present' &&
        b.kind === 'present' &&
        a.excerpt.includes(`版本${from}`) &&
        b.excerpt.includes(`版本${to}`)
      );
    }),
  );
  return { runs: rows.runs, eventCount: rows.events.length, visible: win.isVisible() };
}
async function runWrite() {
  assert.deepEqual(await preferences(), { runInTray: false, available: true, error: null });
  fact('defaultDisabled');
  const tab = await invoke('tabs', 'create', `${launch.base}/page`);
  assert(tab);
  await until('合成用户页面', async () =>
    (await invoke('tabs', 'list')).some((item) => item.id === tab.id && item.state === 'ready'),
  );
  const remote = webContents
    .getAllWebContents()
    .find((contents) => contents.getURL() === `${launch.base}/page`);
  assert(remote);
  const remoteId = remote.id;
  const rendererId = win.webContents.id;
  await openPreferences();
  await capture('tray-setting-disabled');
  await togglePreference(true);
  fact('settingEnabledThroughUi');
  assert(tray && !tray.isDestroyed());
  fact('nativeTrayCreated');
  await capture('tray-setting-enabled');
  await click('.workspace-page-back');
  await click('[aria-label="监控工作区"]');
  await button('.watch-overview-guide', '创建监控');
  await inputValue('.watch-wizard input', `${launch.base}/page`);
  await button('.watch-wizard', '下一步');
  await inputValue('.watch-wizard select', 'session', true);
  for (let i = 0; i < 4; i++) await button('.watch-wizard', '下一步');
  await click('.watch-wizard input[type="checkbox"]');
  await button('.watch-wizard', '采集 Baseline 预览');
  await until('Baseline预览完成', () =>
    js(
      `Boolean([...document.querySelectorAll('.watch-wizard button')].find(e=>e.textContent.trim()==='确认创建'&&!e.disabled))`,
    ),
  );
  // Hide before confirming, so even the first scheduled acquisition starts hidden.
  await hide();
  fact('hiddenWindowPreserved', { windowId: win.id, rendererId, remoteId });
  writeFileSync(join(root, 'fixture-state.json'), JSON.stringify({ revision: 'B' }));
  await button('.watch-wizard', '确认创建');
  const rule = await until('合成规则创建', async () => (await rules())[0]);
  fact('scheduledEventWhileHidden', await eventWhileHidden(rule.id, 1, 'A', 'B'));
  writeFileSync(join(root, 'fixture-state.json'), JSON.stringify({ revision: 'C' }));
  syntheticDue(rule.id);
  fact('laterScheduledEventWhileHidden', await eventWhileHidden(rule.id, 2, 'B', 'C'));
  menu('打开 AIbrowse');
  await until('原主窗口显示', () => win.isVisible());
  alive();
  assert.equal(win.webContents.id, rendererId);
  assert.equal(webContents.fromId(remoteId), remote);
  assert((await invoke('tabs', 'list')).some((item) => item.id === tab.id));
  fact('sameWindowAndTabRestored', { windowId: win.id, rendererId, remoteId });
  report.passed = true;
  fact('menuQuitRequested');
  menu('退出 AIbrowse');
}
async function runReopen() {
  assert.deepEqual(await preferences(), { runInTray: true, available: true, error: null });
  assert(tray && !tray.isDestroyed());
  fact('enabledPreferencePersisted');
  await hide();
  fact('hiddenAfterRestart');
  menu('打开 AIbrowse');
  await until('重启后窗口恢复', () => win.isVisible());
  await openPreferences();
  await togglePreference(false);
  fact('disabledThroughUi');
  report.passed = true;
  fact('disabledCloseRequested');
  win.close();
}
async function runDisabled() {
  assert.deepEqual(await preferences(), { runInTray: false, available: true, error: null });
  fact('disabledPreferencePersisted');
  report.passed = true;
  fact('defaultCloseRequested');
  win.close();
}
async function run() {
  await until('应用IPC就绪', async () => (await watch('getStatus'))?.value?.mode === 'available');
  report.details.initialVisibility = {
    visible: win.isVisible(),
    windowsHide: true,
    startupVisibility: 'NOTRUN；启动器显式建立可见夹具，首场不可见历史原因unknown',
  };
  win.show();
  await until('可见夹具就绪', () => win.isVisible());
  assert.equal(app.getPath('userData'), profile);
  assert.equal(app.getPath('sessionData'), session);
  fact('isolatedProfile', { profile, session });
  runtimeBefore = observedRuntime();
  assert(
    runtimeBefore.browserController &&
      runtimeBefore.watchScheduler &&
      runtimeBefore.watchRepo &&
      runtimeBefore.watchRunCoordinator,
  );
  win.setSize(1280, 900);
  if (phase === 'write') await runWrite();
  else if (phase === 'reopen') await runReopen();
  else await runDisabled();
}
const timer = setTimeout(() => {
  report.passed = false;
  report.error = '有界运行超过180秒';
  persist();
  app.exit(1);
}, input.deadlineMs);
app.on('browser-window-created', (_event, value) => {
  if (started) return;
  started = true;
  win = value;
  void run().catch((error) => {
    report.passed = false;
    report.error = error.stack ?? String(error);
    persist();
    app.quit();
  });
});
app.on('will-quit', () => {
  report.willQuit = true;
  clearTimeout(timer);
  persist();
});
process.on('exit', () => {
  if (tray?.isDestroyed()) fact('nativeTrayDestroyed');
  if (observedRuntime?.().runtimeShutdown?.getPhase() === 'closed') fact('orderlyShutdown');
  persist();
});
persist();
// Append observation accessors only in memory; the original bundle remains byte-identical.
const entry = join(repository, 'out/main/index.js');
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function (source, filename) {
  if (filename !== entry) return originalCompile.call(this, source, filename);
  Module.prototype._compile = originalCompile;
  const appended =
    source +
    '\n;module.exports.__trayRuntimeObserve = () => ({browserController, watchScheduler, watchRepo, watchRunCoordinator, runtimeShutdown});\n';
  return originalCompile.call(this, appended, filename);
};
observedRuntime = require(entry).__trayRuntimeObserve;
