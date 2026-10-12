'use strict';
// Diagnostic bootstrap: synthetic pages and public preload operations only.
const { app, webContents, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const scope = path.resolve(process.argv.at(-1));
if (!/^resource-run-[a-f0-9]{32}$/.test(path.basename(scope))) throw new Error('诊断目录无效');
const control = JSON.parse(fs.readFileSync(path.join(scope, 'plan.json'), 'utf8'));
app.setPath('userData', path.join(scope, 'profile'));
app.setPath('sessionData', path.join(scope, 'profile'));
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith('AIBROWSE_') ||
    ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(key)
  )
    delete process.env[key];
}
const events = path.join(scope, 'events.jsonl');
const started = performance.now();
let phase = 'starting';
let window = null;
let stopping = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (kind, values = {}) =>
  fs.appendFileSync(
    events,
    JSON.stringify({
      kind,
      phase,
      elapsedMs: performance.now() - started,
      epochMs: Date.now(),
      ...values,
    }) + '\n',
  );
const need = (value, message) => {
  if (!value) throw new Error(message);
};
dialog.showErrorBox = (title) => {
  record('startup-error-dialog', { title: String(title).slice(0, 100) });
  app.exit(1);
};
function writeState() {
  if (fs.existsSync(path.join(scope, 'stop.request'))) {
    fail(new Error('原生资源采集失败'));
    return;
  }
  const state = {
    phase,
    epochMs: Date.now(),
    pids: app.getAppMetrics().map((p) => ({ pid: p.pid, role: p.type })),
    contents: webContents
      .getAllWebContents()
      .filter((p) => !p.isDestroyed())
      .map((p) => ({ id: p.id, pid: p.getOSProcessId() })),
    js: process.memoryUsage(),
  };
  const temporary = path.join(scope, 'state.tmp');
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, path.join(scope, 'state.json'));
}
async function evaluate(source) {
  let timer;
  try {
    return await Promise.race([
      window.webContents.executeJavaScript(source),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('诊断动作超时')), 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waitReady(id) {
  for (let count = 0; count < 160; count++) {
    const ready = await evaluate(
      `window.aibrowse.tabs.list().then(v=>v.some(t=>t.id===${JSON.stringify(id)}&&t.state==='ready'))`,
    );
    if (ready) return;
    await sleep(50);
  }
  throw new Error('诊断 Tab 未就绪');
}
function bind(id, url) {
  const matches = webContents
    .getAllWebContents()
    .filter((p) => !p.isDestroyed() && p.getURL() === url);
  need(matches.length === 1, '诊断页面归属不唯一');
  const content = matches[0];
  return { id, url, pid: content.getOSProcessId(), webContentsId: content.id };
}
async function fixedPhase(name, durationMs, work) {
  phase = name;
  record('phase-start');
  writeState();
  const until = performance.now() + durationMs;
  let count = 0;
  while (performance.now() < until) {
    if (work) await work(count++);
    await sleep(Math.min(1000, Math.max(1, until - performance.now())));
  }
  record('phase-end', { operations: count });
}
const server = http.createServer((request, response) => {
  if (!/^\/page\/\d+\?g=\d+$/.test(request.url || '')) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(
    '<!doctype html><title>资源诊断合成页面</title><h1>RESOURCE_DIAGNOSTIC</h1><p>' +
      'synthetic '.repeat(600) +
      '</p>',
  );
});
async function run() {
  const base = `http://127.0.0.1:${server.address().port}`;
  let initial = [];
  const initialDeadline = performance.now() + 8000;
  while (performance.now() < initialDeadline) {
    initial = await evaluate('window.aibrowse.tabs.list()');
    if (initial.length === 1 && initial[0].state === 'ready') break;
    await sleep(50);
  }
  need(initial.length === 1 && initial[0].state === 'ready', '初始 Tab 未在期限内就绪');
  const tabs = [];
  for (let slot = 0; slot < 10; slot++) {
    const url = `${base}/page/${slot}?g=0`;
    let id;
    if (slot === 0) {
      id = initial[0].id;
      need(
        await evaluate(
          `window.aibrowse.nav.navigate(${JSON.stringify(id)},${JSON.stringify(url)})`,
        ),
        '导航失败',
      );
    } else {
      const created = await evaluate(`window.aibrowse.tabs.create(${JSON.stringify(url)})`);
      id = created.id;
    }
    await waitReady(id);
    tabs.push(bind(id, url));
  }
  record('tabs-ready', { tabs });
  writeState();
  if (control.startupOnly) {
    await sleep(3000);
    record('startup-complete');
    await new Promise((resolve) => server.close(resolve));
    window.close();
    return;
  }
  const sampler = setInterval(writeState, 1000);
  try {
    await fixedPhase('warm', 90000);
    await fixedPhase('idle-before', 120000);
    await fixedPhase('snapshot-load', 120000, async (index) => {
      const tab = tabs[index % tabs.length];
      need(await evaluate(`window.aibrowse.tabs.activate(${JSON.stringify(tab.id)})`), '激活失败');
      const snapshot = await evaluate(`window.aibrowse.page.snapshot(${JSON.stringify(tab.id)})`);
      need(
        snapshot &&
          snapshot.url === tab.url &&
          snapshot.visibleText.includes('RESOURCE_DIAGNOSTIC'),
        '快照归属错误',
      );
    });
    await fixedPhase('idle-after-snapshot', 120000);
    phase = 'turnover';
    record('phase-start');
    for (let index = 0; index < 20; index++) {
      const slot = index % 10;
      const old = tabs[slot];
      record('close-start', { index, slot, old });
      need(await evaluate(`window.aibrowse.tabs.close(${JSON.stringify(old.id)})`), '关闭失败');
      record('close-return', { index, oldPid: old.pid });
      const url = `${base}/page/${slot}?g=${Math.floor(index / 10) + 1}`;
      record('create-start', { index, oldPid: old.pid });
      const created = await evaluate(`window.aibrowse.tabs.create(${JSON.stringify(url)})`);
      await waitReady(created.id);
      const next = bind(created.id, url);
      tabs[slot] = next;
      record('create-return', { index, oldPid: old.pid, next });
      writeState();
      await sleep(3000);
    }
    record('phase-end', { operations: 20 });
    await fixedPhase('idle-after-turnover', 120000);
    phase = 'closing';
    record('work-complete');
  } finally {
    clearInterval(sampler);
    await new Promise((resolve) => server.close(resolve));
    window.close();
  }
}
function fail(error) {
  if (stopping) return;
  stopping = true;
  record('failure', {
    name: error instanceof Error ? error.name : 'unknown',
    code: typeof error?.code === 'string' ? error.code.slice(0, 60) : null,
    message: error instanceof Error ? error.message.slice(0, 100) : 'unknown',
  });
  server.close();
  if (window && !window.isDestroyed()) window.close();
  else app.quit();
}
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (error) => {
    // Do not persist exception messages, URL text, or arbitrary stack strings.
    record('fatal-observed', {
      event,
      name: error instanceof Error ? error.name : 'unknown',
      code: typeof error?.code === 'string' ? error.code.slice(0, 60) : null,
      projectFrames:
        error instanceof Error
          ? [...(error.stack || '').matchAll(/[\\/]([^\\/\s()]+\.(?:js|cjs|mjs|ts)):(\d+):(\d+)/g)]
              .slice(0, 12)
              .map((match) => ({
                file: match[1],
                line: Number(match[2]),
                column: Number(match[3]),
              }))
          : [],
    });
  });
}
app.on('browser-window-created', (_event, candidate) => {
  need(window === null, '多余主窗口');
  window = candidate;
  candidate.webContents.once('did-finish-load', () => {
    void run().catch(fail);
  });
});
app.on('will-quit', () => {
  record('will-quit');
});
setTimeout(
  () => fail(new Error('固定诊断预算已用尽')),
  control.startupOnly ? 25000 : 750000,
).unref();
server.listen(0, '127.0.0.1', () => {
  record('bootstrap-ready', {
    developmentRootMatches: app.getAppPath() === path.join(scope, 'app'),
  });
  try {
    require(path.join(app.getAppPath(), 'out/main/index.js'));
  } catch (error) {
    fail(error);
  }
});
