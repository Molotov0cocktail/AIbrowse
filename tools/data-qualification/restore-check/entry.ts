import { app, BrowserWindow, dialog } from 'electron';
import type { MessageBoxOptions, OpenDialogOptions, SaveDialogOptions } from 'electron';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { need, readControl, scopeAt, writeNew, type Phase } from './contract';

const scope = scopeAt(dirname(__dirname));
const controlPath = join(scope, 'control.json');
const control = readControl(controlPath);
const initialPhase = control.phase;
const profile = join(scope, 'profile');
const deadline = performance.now() + Math.max(0, control.deadline - Date.now());
const uiUrl = pathToFileURL(join(__dirname, 'out/renderer/index.html')).href;
const events: Array<{ action: string; elapsedMs: number }> = [];
const started = performance.now();
let failure = false;
let window: BrowserWindow | null = null;
let nextChoice:
  | 'save'
  | 'open-cancel'
  | 'confirm-cancel'
  | 'confirm-accept'
  | 'partial-cancel'
  | 'partial-accept'
  | null = null;
let openCalls = 0;
let confirmationCalls = 0;
let saves = 0;
function check(): void {
  need(!failure && performance.now() < deadline, '固定场景期限已过');
}
function event(action: string): void {
  check();
  need(events.length < 96, '固定动作记录超限');
  events.push({ action, elapsedMs: Math.round(performance.now() - started) });
}
function fail(error: unknown): void {
  if (failure) return;
  failure = true;
  try {
    writeNew(join(scope, `${initialPhase}-failure.json`), {
      phase: initialPhase,
      pid: process.pid,
      error: error instanceof Error ? error.message.slice(0, 1000) : '恢复检查失败',
      events,
    });
  } finally {
    app.exit(1);
  }
}
function ledger(): { session: string; main: { pid: number } | null; utility: unknown } {
  const value = JSON.parse(
    readFileSync(join(profile, 'lifecycle-guardian/writers.json'), 'utf8'),
  ) as {
    session: string;
    main: { pid: number } | null;
    utility: unknown;
  };
  need(typeof value.session === 'string' && /^[a-f0-9]{32}$/u.test(value.session));
  need(value.main?.pid === process.pid, '当前main不属于同根guardian账本');
  return value;
}
function transition(phase: Phase): void {
  const previous = ledger();
  const next = { ...control, phase, previousPid: process.pid, previousSession: previous.session };
  const temporary = join(scope, `control-${initialPhase}.tmp`);
  writeFileSync(temporary, JSON.stringify(next), { flag: 'wx' });
  renameSync(temporary, controlPath);
  writeNew(join(scope, `${initialPhase}-handoff.json`), {
    ...next,
    events,
    openCalls,
    confirmationCalls,
  });
}
function owner(candidate: BrowserWindow): void {
  check();
  need(window !== null && candidate === window && !candidate.isDestroyed());
  need(candidate.webContents.getURL() === uiUrl, '动作必须来自本构建的主文档');
}

// These fixed responses exist only in this tools entry. The product selector,
// IPC, admission, maintenance, workers and guardian remain unchanged.
Object.defineProperty(dialog, 'showSaveDialog', {
  value: async (candidate: BrowserWindow, options: SaveDialogOptions) => {
    owner(candidate);
    need(initialPhase === 'backup' && nextChoice === 'save' && saves++ === 0);
    need(options.title === '保存本地数据备份' && options.defaultPath === 'AIbrowse-backup.aibak');
    need(
      JSON.stringify(options.filters) ===
        JSON.stringify([{ name: 'AIbrowse 备份', extensions: ['aibak'] }]),
    );
    const target = join(scope, 'product-A.aibak');
    need(!existsSync(target));
    nextChoice = null;
    event('save-selected');
    return { canceled: false, filePath: target };
  },
});
Object.defineProperty(dialog, 'showOpenDialog', {
  value: async (candidate: BrowserWindow, options: OpenDialogOptions) => {
    owner(candidate);
    need(initialPhase === 'restore' || initialPhase === 'gate');
    need(
      options.title === '选择要恢复的 AIbrowse 备份' &&
        JSON.stringify(options.properties) === '["openFile"]',
    );
    need(
      JSON.stringify(options.filters) ===
        JSON.stringify([{ name: 'AIbrowse 备份', extensions: ['aibak'] }]),
    );
    need(++openCalls <= 3);
    if (nextChoice === 'open-cancel') {
      nextChoice = null;
      event('open-cancelled');
      return { canceled: true, filePaths: [] };
    }
    need(nextChoice === 'confirm-cancel' || nextChoice === 'confirm-accept');
    event('open-selected');
    return {
      canceled: false,
      filePaths: [join(scope, control.scene === 'R' ? 'product-A.aibak' : 'synthetic-H.aibak')],
    };
  },
});
Object.defineProperty(dialog, 'showMessageBox', {
  value: async (candidate: BrowserWindow, options: MessageBoxOptions) => {
    owner(candidate);
    const partial = initialPhase === 'partial';
    need(partial || initialPhase === 'restore' || initialPhase === 'gate');
    need(
      options.title === '确认恢复本地数据' &&
        options.type === 'warning' &&
        options.defaultId === 1 &&
        options.cancelId === 1 &&
        options.noLink === true,
    );
    need(JSON.stringify(options.buttons) === '["恢复并重新启动","取消"]');
    need(
      options.message ===
        (partial
          ? '本地数据服务未完整启动。是否关闭当前标签页并重新启动到恢复界面？重新启动后需要再次选择备份并确认恢复；原件和失败现场将保留。'
          : '恢复将替换当前信源、研究、监控数据和已保存会话，并关闭当前标签页后重新启动。是否继续？'),
    );
    need(++confirmationCalls <= 2);
    const accepted = nextChoice === (partial ? 'partial-accept' : 'confirm-accept');
    need(accepted || nextChoice === (partial ? 'partial-cancel' : 'confirm-cancel'));
    nextChoice = null;
    event(accepted ? 'confirmation-accepted' : 'confirmation-cancelled');
    if (accepted) transition(partial ? 'gate' : 'successor');
    return { response: accepted ? 0 : 1, checkboxChecked: false };
  },
});

// Remove inherited development selectors before the ordinary main module loads.
for (const key of Object.keys(process.env))
  if (
    key.startsWith('AIBROWSE_') ||
    ['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)
  )
    delete process.env[key];
app.setPath('userData', profile);
app.setPath('sessionData', profile);

async function evaluate(source: string): Promise<unknown> {
  need(window);
  owner(window);
  const value: unknown = await window.webContents.executeJavaScript(source);
  owner(window);
  return value;
}
async function wait(predicate: () => Promise<boolean>, name: string): Promise<void> {
  const stop = Math.min(deadline, performance.now() + 30_000);
  while (performance.now() < stop) {
    check();
    if (await predicate()) return;
    await new Promise<void>((done) => setTimeout(done, 100));
  }
  throw new Error(`固定UI未满足：${name}`);
}
async function text(value: string): Promise<void> {
  await wait(
    async () =>
      (await evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`)) === true,
    value,
  );
}
async function button(label: string): Promise<void> {
  const script = `(() => { const label=${JSON.stringify(label)}; const nodes=[...document.querySelectorAll('button')].filter(n => !n.disabled && n.getClientRects().length && ((n.getAttribute('aria-label') || n.getAttribute('title') || n.textContent.trim()) === label)); if(nodes.length!==1)return false; nodes[0].click(); return true; })()`;
  await wait(async () => (await evaluate(script)) === true, `按钮${label}`);
  event(`button:${label}`);
}
async function readDomains(variant: 'A' | 'H'): Promise<void> {
  const marker = `恢复夹具${variant}`;
  await button('信源面板');
  await text(marker);
  await text(`https://example.invalid/restore-${variant}/`);
  await button('研究面板');
  await wait(
    async () =>
      (await evaluate(
        `(() => {const n=[...document.querySelectorAll('.research-panel button')].filter(n=>n.getClientRects().length && [...n.querySelectorAll('*')].some(c=>c.textContent.trim()===${JSON.stringify(marker)}));if(n.length!==1)return false;n[0].click();return true;})()`,
      )) === true,
    '研究任务选择',
  );
  await button('打开结果');
  await text(`${marker}研究结论`);
  await button('监控工作区');
  await button('规则');
  await text(marker);
  await text('状态：paused / user / 未静音');
  await button('← 返回浏览');
  await button('AI 侧栏');
  await button(marker);
  await text(`${marker}问题`);
  await text(`${marker}回答`);
  event('four-domains-read');
}
async function finished(): Promise<void> {
  check();
  need(window);
  const identity = ledger();
  writeNew(join(scope, `${initialPhase}-complete.json`), {
    phase: initialPhase,
    scene: control.scene,
    pid: process.pid,
    parentPid: process.ppid,
    previousPid: control.previousPid,
    previousSession: control.previousSession,
    session: identity.session,
    events,
    saves,
    openCalls,
    confirmationCalls,
  });
  window.close();
}
async function run(): Promise<void> {
  await wait(
    async () =>
      (await evaluate(
        `(() => {const n=document.querySelector('section.local-data details'); if(!n)return false;if(!n.open)n.querySelector('summary').click();return n.open;})()`,
      )) === true,
    '本地数据面板',
  );
  const identity = ledger();
  if (initialPhase === 'successor' || initialPhase === 'gate') {
    need(
      control.previousPid !== null &&
        control.previousPid !== process.pid &&
        control.previousSession !== identity.session,
      '未发生真实guardian继任',
    );
  }
  if (initialPhase === 'boot') {
    await text('尚未开始数据维护');
    await finished();
    return;
  }
  if (initialPhase === 'backup') {
    await text('尚未开始数据维护');
    nextChoice = 'save';
    await button('备份本地数据');
    await text('备份已完整保存，原数据业务已恢复');
    need(saves === 1 && nextChoice === null);
    await finished();
    return;
  }
  if (initialPhase === 'successor' || initialPhase === 'cold') {
    await text('尚未开始数据维护');
    await readDomains(control.scene === 'R' ? 'A' : 'H');
    await finished();
    return;
  }
  if (initialPhase === 'partial') {
    await text('本地数据服务未完整启动。恢复需要先关闭标签页并重新启动，再选择备份。');
    nextChoice = 'partial-cancel';
    await button('选择备份恢复');
    await text('已取消重新启动，原数据业务保持关闭');
    nextChoice = 'partial-accept';
    await button('选择备份恢复');
    return;
  }
  if (initialPhase === 'gate') {
    await text('本地数据需要恢复。请选择备份；原件和失败现场将保留。');
    need(
      readFileSync(join(profile, 'data-transfer/recovery-gate'), 'utf8') ===
        'AIbrowse recovery barrier\n',
    );
    need(
      readFileSync(join(profile, 'conversations/index.json'), 'utf8') ===
        '{"version":1,"sessions":',
    );
    event('gate-and-bad-index-preserved');
  } else await text('尚未开始数据维护');
  nextChoice = 'open-cancel';
  await button('选择备份恢复');
  await wait(async () => openCalls === 1 && nextChoice === null, 'Open取消响应');
  await text('操作已取消');
  nextChoice = 'confirm-cancel';
  await button('选择备份恢复');
  await wait(
    async () => openCalls === 2 && confirmationCalls === 1 && nextChoice === null,
    '确认取消响应',
  );
  await text('操作已取消');
  need(openCalls === 2 && confirmationCalls === 1 && nextChoice === null);
  nextChoice = 'confirm-accept';
  await button('选择备份恢复');
}
app.on('browser-window-created', (_event, candidate) => {
  if (window !== null) {
    fail(new Error('固定检查只接受一个BrowserWindow'));
    return;
  }
  window = candidate;
  candidate.webContents.once('did-finish-load', () => {
    void run().catch(fail);
  });
});
setTimeout(
  () => fail(new Error('固定场景总期限耗尽')),
  Math.max(1, deadline - performance.now()),
).unref();
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
createRequire(__filename)('./out/main/index.js');
