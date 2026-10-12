/* global __dirname, require, process, setTimeout, clearTimeout */
// Electron loads this bootstrap before the unmodified ordinary product entry.
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { app, ipcMain } = require('electron');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { readFileSync, writeFileSync, realpathSync, lstatSync } = require('node:fs');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');
const { fileURLToPath } = require('node:url');

const repository = realpathSync(resolve(__dirname, '../..'));
const root = resolve(process.argv[2] ?? '');
const phase = process.argv[3];
const rel = relative(join(repository, 'log/watch-repair-20261012'), root);
assert(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
assert.equal(realpathSync(root), root);
assert(['write', 'reopen'].includes(phase));
const input = JSON.parse(readFileSync(join(root, 'input.json'), 'utf8'));
const launch = JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8'));
assert.equal(input.repository, repository);
assert.equal(input.deadlineMs, 150000);
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
function sourceFacts() {
  return readDb('sources/sources.db', (db) => {
    const data = {
      sources: db.prepare('SELECT * FROM sources ORDER BY id').all(),
      usage: db.prepare('SELECT * FROM usage_events ORDER BY source_id').all(),
      journal: db.prepare('SELECT * FROM change_journal ORDER BY idempotency_key').all(),
      ftsData: db.prepare('SELECT * FROM sources_fts_data ORDER BY id').all(),
      ftsIndex: db.prepare('SELECT * FROM sources_fts_idx ORDER BY segid, term').all(),
      ftsDocsize: db.prepare('SELECT * FROM sources_fts_docsize ORDER BY id').all(),
      ftsConfig: db.prepare('SELECT * FROM sources_fts_config ORDER BY k').all(),
    };
    return {
      count: data.sources.length,
      usageCount: data.usage.length,
      digest: hash(JSON.stringify(data)),
    };
  });
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
async function theme(value) {
  await click('.settings-open');
  await until('设置页面', () => js(`Boolean(document.querySelector('.settings-page'))`));
  await button('.settings-nav', '外观');
  await inputValue('select[aria-label="界面外观"]', value, true);
  await until('主题更新', () =>
    js(`document.documentElement.dataset.theme===${JSON.stringify(value)}`),
  );
  await click('.workspace-page-back');
}
async function currentPageEntry() {
  await click('.settings-open');
  await button('.settings-nav', '高级');
  await button('.settings-content', '监控当前页');
  await until('创建监控向导', () => js(`Boolean(document.querySelector('.watch-wizard'))`));
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
async function navigate(tabId, url) {
  assert(await js(`window.aibrowse.nav.navigate(${JSON.stringify(tabId)},${JSON.stringify(url)})`));
  await until('本地页面就绪', async () =>
    (await invoke('tabs', 'list')).some(
      (tab) => tab.id === tabId && tab.url === url && tab.state === 'ready',
    ),
  );
}

async function runWrite() {
  const pageUrl = `${launch.base}/page`;
  const seeded = await invoke('sources', 'add', {
    scope: 'page',
    url: `${launch.base}/sentinel`,
    name: '隔离信源哨兵',
    userNote: '源库保持不变',
    shareMode: 'full',
  });
  assert(seeded.ok, JSON.stringify(seeded));
  const searched = await invoke('sources', 'search', { query: '隔离信源', limit: 10 });
  assert(
    searched.ok && searched.results.some((item) => item.id === seeded.source.id),
    JSON.stringify(searched),
  );
  fact('sourceSentinelSearchable');
  const before = sourceFacts();
  assert.equal(before.count, 1);
  const tab = await invoke('tabs', 'create', pageUrl);
  assert(tab !== null);
  await until('iframe 页面就绪', async () =>
    (await invoke('tabs', 'list')).some((item) => item.id === tab.id && item.state === 'ready'),
  );
  const snap = await invoke('page', 'snapshot', tab.id);
  assert.equal(snap.meta.degraded, 'partial');
  assert.equal(snap.meta.mainDocument, 'complete');
  assert(snap.visibleText.includes('版本A'));
  assert(!snap.visibleText.includes('框架内容不进入主文档基线'));
  fact('mainDocumentFrameCoverage', {
    degraded: snap.meta.degraded,
    mainDocument: snap.meta.mainDocument,
    warningCount: snap.meta.warnings.length,
  });

  // A missing provider still persists the synthetic user citation before failing closed.
  const chat = await invoke('conversation', 'create');
  assert(chat !== null);
  await js(`window.aibrowse.conversation.ask(${JSON.stringify(chat.id)},'合成采集提示验收')`);
  await until('合成引用记录', async () =>
    (await invoke('conversation', 'getHistory', chat.id))?.some(
      (message) => message.contextSource?.degraded === false,
    ),
  );
  win.webContents.reload();
  await until('界面重新挂载', () => js(`Boolean(document.querySelector('.workspace-nav'))`));

  for (const appearance of ['dark', 'light']) {
    await theme(appearance);
    await click('[aria-label="AI 侧栏"]');
    await until('引用提示', () => js(`Boolean(document.querySelector('.ai-citation-notices'))`));
    await until('实时上下文徽标', () =>
      js(`document.querySelector('.ai-context-label')?.textContent==='当前网页'`),
    );
    assert.equal(await js(`Boolean(document.querySelector('.ai-context-hint'))`), false);
    assert.equal(
      await js(`document.querySelector('.ai-citation')?.textContent.includes('采集降级')`),
      false,
    );
    await capture(`${appearance}-capture-notice`);
    await currentPageEntry();
    assert.equal(await js(`document.querySelector('.watch-wizard input').value`), pageUrl);
    assert.equal(report.ipc['sources:quick-add'] ?? 0, 0);
    assert.deepEqual(sourceFacts(), before);
    await capture(`${appearance}-standalone-url`);
    await button('.watch-wizard', '取消');
    await button('.watch-header', '← 返回浏览');
  }
  fact('livePreviewRespectsCoverage');
  fact('twoThemeScreenshots', { count: report.captures.length });
  fact('currentPageEntryDidNotQuickAdd', { quickAddCalls: report.ipc['sources:quick-add'] ?? 0 });

  await click('[aria-label="监控工作区"]');
  await button('.watch-overview-guide', '创建监控');
  assert.equal(await js(`document.querySelector('.watch-wizard input').value`), '');
  await inputValue('.watch-wizard input', pageUrl);
  fact('standaloneUrlEditable');
  await button('.watch-wizard', '下一步');
  await inputValue('.watch-wizard select', 'session', true);
  for (let step = 0; step < 4; step++) await button('.watch-wizard', '下一步');
  assert.equal(
    await js(
      `([...document.querySelectorAll('.watch-wizard button')].find(e=>e.textContent.trim()==='采集 Baseline 预览')).disabled`,
    ),
    true,
  );
  assert.equal((await rules()).length, 0);
  await click('.watch-wizard input[type="checkbox"]');
  await button('.watch-wizard', '采集 Baseline 预览');
  await until('Session 预览成功', () =>
    js(
      `Boolean([...document.querySelectorAll('.watch-wizard button')].find(e=>e.textContent.trim()==='确认创建' && !e.disabled))`,
    ),
  );
  assert.equal((await rules()).length, 0);
  fact('sessionConsentRequired', {
    previewCalls: report.ipc['watch:previewPageRegions'] ?? 0,
    grantCalls: report.ipc['watch:issueSessionGrant'] ?? 0,
  });

  writeFileSync(join(root, 'fixture-state.json'), JSON.stringify({ revision: 'B' }));
  await button('.watch-wizard', '确认创建');
  const created = await until('独立规则创建', async () => {
    const list = await rules();
    return list.length === 1 ? list[0] : null;
  });
  assert.equal(created.bindingKind, 'watch-target');
  const changed = await until(
    '确认后的自动调度事件',
    () => {
      const rows = watchRows(created.id);
      return rows.runs.some(
        (run) =>
          run.trigger === 'scheduled' &&
          run.status === 'finished' &&
          JSON.parse(run.outcome_json).kind === 'event-created',
      ) && rows.events.length === 1
        ? rows
        : null;
    },
    35000,
  );
  fact('scheduledChangeProducedEvent', { runs: changed.runs, eventCount: changed.events.length });
  const typed = changed.evidence.some((item) => {
    const beforeValue = JSON.parse(item.before_value_json);
    const afterValue = JSON.parse(item.after_value_json);
    return (
      beforeValue.kind === 'present' &&
      afterValue.kind === 'present' &&
      beforeValue.excerpt.includes('版本A') &&
      afterValue.excerpt.includes('版本B')
    );
  });
  assert(typed);
  fact('eventHasTypedOldAndNew');
  const immediate = await watch('runNow', { ruleId: created.id });
  assert(immediate.ok, JSON.stringify(immediate));
  const unchanged = await until(
    '未变化运行完成',
    () => {
      const rows = watchRows(created.id);
      return rows.runs.some(
        (run) =>
          run.id === immediate.value.runId &&
          run.status === 'finished' &&
          JSON.parse(run.outcome_json).kind === 'unchanged',
      )
        ? rows
        : null;
    },
    35000,
  );
  assert.equal(unchanged.events.length, 1);
  fact('unchangedRunProducedNoEvent', {
    runs: unchanged.runs,
    eventCount: unchanged.events.length,
  });

  await navigate(tab.id, `${launch.base}/login`);
  const blocked = await watch('previewPageRegions', {
    mode: 'standalone',
    url: `${launch.base}/login`,
    accessMode: 'session',
    regions: [{ kind: 'main-text', label: '正文' }],
  });
  assert(!blocked.ok);
  assert.equal(blocked.errorCode, 'security-rejected');
  assert.equal((await rules()).length, 1);
  fact('loginPreviewRejected', { errorCode: blocked.errorCode });
  await navigate(tab.id, pageUrl);
  assert((await invoke('tabs', 'list')).some((item) => item.id === tab.id && item.url === pageUrl));
  fact('userTabPreserved');
  assert.deepEqual(sourceFacts(), before);
  assert.equal(report.ipc['sources:quick-add'] ?? 0, 0);
  fact('sourcesAndIndexUnchanged', before);
  const after = watchRows(created.id);
  writeFileSync(
    join(root, 'expected.json'),
    JSON.stringify(
      {
        ruleId: created.id,
        targetId: created.sourceId,
        sourceFacts: before,
        eventId: after.events[0].id,
        contentHash: after.baseline.content_hash,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
}
async function runReopen() {
  const expected = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8'));
  const list = await rules();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, expected.ruleId);
  assert.equal(list[0].bindingKind, 'watch-target');
  assert.equal(list[0].sourceId, expected.targetId);
  const saved = watchRows(expected.ruleId);
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0].id, expected.eventId);
  assert.equal(saved.baseline.content_hash, expected.contentHash);
  assert.equal(saved.rule.binding_kind, 'watch-target');
  assert.equal(JSON.parse(saved.rule.target_json).sessionConsent.origin, launch.base);
  fact('restartKeptRuleAndEvent');
  assert.deepEqual(sourceFacts(), expected.sourceFacts);
  fact('sourcesAndIndexUnchanged', expected.sourceFacts);
}
async function run() {
  await until(
    '真实应用 IPC 就绪',
    async () => (await watch('getStatus'))?.value?.mode === 'available',
  );
  assert.equal(app.getPath('userData'), profile);
  assert.equal(app.getPath('sessionData'), session);
  fact('isolatedProfile', { profile, session });
  win.setSize(1280, 900);
  if (phase === 'write') await runWrite();
  else await runReopen();
  report.passed = true;
  persist();
  win.close();
}
const timer = setTimeout(() => {
  report.passed = false;
  report.error = '有界运行超过150秒';
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
process.on('exit', () => persist());
persist();
require(join(repository, 'out/main/index.js'));
