import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  utilityProcess,
  type IpcMainInvokeEvent,
} from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  OperationGate,
  QUALIFICATION,
  UI_ENTRY,
  UI_SCHEME,
  resolveUiAsset,
  type Mode,
} from './protocol';

const monotonic = () => Number(process.hrtime.bigint()) / 1e6;
const root = resolve(dirname(process.execPath), '../..');
if (
  !app.isPackaged ||
  process.platform !== 'win32' ||
  process.arch !== 'x64' ||
  basename(process.execPath) !== QUALIFICATION.executable ||
  !/^utility-[a-f0-9]{32}$/.test(basename(root)) ||
  basename(dirname(root)) !== 'stage7-e2' ||
  process.argv.length !== 2 ||
  process.argv[1] !== '--qualification-run'
)
  app.exit(2);
const runtime = join(root, 'runtime');
if (existsSync(runtime)) app.exit(3);
mkdirSync(runtime);
for (const key of ['appData', 'userData', 'sessionData', 'temp', 'crashDumps', 'logs'] as const) {
  const directory = join(runtime, key);
  mkdirSync(directory);
  app.setPath(key, directory);
}
app.setName(QUALIFICATION.appName);
protocol.registerSchemesAsPrivileged([
  {
    scheme: UI_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      bypassCSP: false,
      allowServiceWorkers: false,
      supportFetchAPI: false,
      allowExtensions: false,
    },
  },
]);
const sentinel = join(runtime, 'active-fixture.txt');
writeFileSync(sentinel, 'E2合成原数据：禁止失败操作切换', { flag: 'wx' });
const sentinelHash = () => createHash('sha256').update(readFileSync(sentinel)).digest('hex');
const before = sentinelHash();
const started = monotonic();
const samples: { at: number; sequence: number; roundTripMs: number; mode: string }[] = [];
const cases: Record<string, unknown>[] = [];
const diagnostics: { phase: string; kind: string; detail: string }[] = [];
let phase = '等待应用ready';
function diagnostic(kind: string, detail: unknown): void {
  if (diagnostics.length >= 10) return;
  diagnostics.push({ phase, kind, detail: String(detail).slice(0, 512) });
}
let activeMode = 'startup';
let environment: unknown = null;
let window: BrowserWindow | null = null;
let finished = false;
const uiUrl = UI_ENTRY;
const ownedChildren = new Set<Electron.UtilityProcess>();
const applicationDeadline = setTimeout(
  () => finish(false, '应用总时限'),
  QUALIFICATION.applicationMs,
);

function finish(ok: boolean, classification: string): void {
  if (finished) return;
  finished = true;
  clearTimeout(applicationDeadline);
  for (const child of ownedChildren) child.kill();
  const after = sentinelHash();
  writeFileSync(
    join(runtime, 'report.json'),
    JSON.stringify(
      {
        version: 1,
        scope: '独立资格小应用；不是产品包验收或E2 PASS',
        ok: ok && before === after && ownedChildren.size === 0,
        classification,
        phase,
        diagnostics,
        versions: {
          electron: process.versions.electron,
          node: process.versions.node,
          sqlite: process.versions.sqlite,
        },
        executable: process.execPath,
        asar: app.getAppPath(),
        userData: app.getPath('userData'),
        durationMs: monotonic() - started,
        budget: QUALIFICATION,
        environment,
        fixture: { before, after, switches: 0, unchanged: before === after },
        outstandingChildren: ownedChildren.size,
        cases,
        samples,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  app.exit(ok && before === after && ownedChildren.size === 0 ? 0 : 1);
}

function assertSender(event: IpcMainInvokeEvent): void {
  if (
    window === null ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== uiUrl
  ) {
    throw new Error('资格IPC发送者不合法');
  }
}

function installUi(): void {
  let lastPing = 0;
  let lastSample = 0;
  ipcMain.handle('qualification:environment', (event, value: unknown) => {
    assertSender(event);
    if (environment !== null || typeof value !== 'object' || value === null)
      throw new Error('资格UI环境无效');
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'contextIsolated,nodeVisible,sandboxed' ||
      record.nodeVisible !== false ||
      record.sandboxed !== true ||
      record.contextIsolated !== true
    )
      throw new Error('资格UI隔离无效');
    environment = record;
  });
  ipcMain.handle('qualification:ping', (event, sequence: unknown) => {
    assertSender(event);
    if (sequence !== lastPing + 1 || lastPing >= 5000) throw new Error('资格UI序号越界');
    lastPing++;
    return sequence;
  });
  ipcMain.handle('qualification:sample', (event, sequence: unknown, ms: unknown) => {
    assertSender(event);
    if (
      sequence !== lastSample + 1 ||
      sequence !== lastPing ||
      typeof ms !== 'number' ||
      !Number.isFinite(ms) ||
      ms < 0 ||
      ms > QUALIFICATION.applicationMs
    )
      throw new Error('资格UI样本越界');
    lastSample++;
    samples.push({ at: monotonic(), sequence: lastSample, roundTripMs: ms, mode: activeMode });
  });
}

const pause = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

async function runCase(mode: Mode, id: number): Promise<void> {
  activeMode = `${mode}-${id}`;
  const caseStart = monotonic();
  const gate = new OperationGate(id);
  const child = utilityProcess.fork(join(__dirname, 'worker.js'), [mode, String(id)], {
    stdio: 'ignore',
    env: {},
    execArgv: [],
    cwd: runtime,
    serviceName: 'E2固定SQLite资格进程',
    partition: 'e2-utility-qualification',
    respondToAuthRequestsFromMainProcess: false,
  });
  ownedChildren.add(child);
  let pid: number | undefined;
  let enteredAt: number | null = null;
  let killAt: number | null = null;
  let exitAt: number | null = null;
  let exitCode: number | null = null;
  let killReturned: boolean | null = null;
  let heartbeatAfterEntry = 0;
  let validated = false;
  let ready = false;
  let fatalError = false;
  let timer: NodeJS.Timeout | null = null;
  let terminationTimer: NodeJS.Timeout | null = null;
  let caseTimer: NodeJS.Timeout | null = null;
  let rejectExit: (error: Error) => void = () => {};
  const kill = () => {
    if (killAt !== null || exitAt !== null) return;
    killAt = monotonic();
    killReturned = child.kill();
    terminationTimer = setTimeout(
      () => rejectExit(new Error('资格进程退出未确认')),
      QUALIFICATION.exitConfirmationMs,
    );
  };
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveExit = resolvePromise;
    rejectExit = rejectPromise;
    caseTimer = setTimeout(() => {
      gate.fail('deadline');
      kill();
    }, QUALIFICATION.caseMs);
  });
  child.on('spawn', () => {
    pid = child.pid;
  });
  child.on('error', () => {
    fatalError = true;
    gate.fail('exit');
    kill();
  });
  child.on('exit', (code) => {
    exitAt = monotonic();
    exitCode = code;
    gate.confirmExit(code);
    ownedChildren.delete(child);
    resolveExit();
  });
  child.on('message', (raw: unknown) => {
    const message = gate.receive(raw);
    if (message === null) {
      if (mode !== 'late') kill();
      return;
    }
    if (message.kind === 'ready') {
      if (ready) {
        gate.fail('protocol');
        kill();
        return;
      }
      ready = true;
      child.postMessage('start');
    }
    if (message.kind === 'entered') {
      enteredAt = monotonic();
      if (mode === 'late') {
        gate.fail('deadline');
        timer = setTimeout(kill, 200);
      } else if (mode === 'native') {
        const deadline = enteredAt + QUALIFICATION.nativeObservationMs;
        const expire = () => {
          const remaining = deadline - monotonic();
          if (remaining > 0) {
            timer = setTimeout(expire, Math.ceil(remaining));
            return;
          }
          gate.fail('deadline');
          kill();
        };
        timer = setTimeout(expire, QUALIFICATION.nativeObservationMs);
      }
    }
    if (message.kind === 'heartbeat' && enteredAt !== null) heartbeatAfterEntry++;
    if (message.kind === 'validated') validated = true;
  });
  let caseError = false;
  try {
    await exited;
  } catch {
    caseError = true;
  }
  if (timer !== null) clearTimeout(timer);
  if (terminationTimer !== null) clearTimeout(terminationTimer);
  if (caseTimer !== null) clearTimeout(caseTimer);
  const entry = enteredAt as number | null;
  const killed = killAt as number | null;
  const ended = exitAt as number | null;
  const ui = samples.filter(
    (sample) =>
      sample.mode === activeMode &&
      (entry === null || sample.at >= entry) &&
      (killed === null || sample.at <= killed),
  );
  const uiMaxMs = ui.length ? Math.max(...ui.map((sample) => sample.roundTripMs)) : null;
  const gaps = ui.slice(1).map((sample, index) => sample.at - ui[index].at);
  if (entry !== null && killed !== null && ui.length)
    gaps.push(ui[0].at - entry, killed - ui[ui.length - 1].at);
  const uiMaxGapMs = gaps.length ? Math.max(...gaps) : null;
  const terminationMs = killed !== null && ended !== null ? ended - killed : null;
  const nativeOk =
    mode !== 'native' ||
    (entry !== null &&
      killed !== null &&
      killed - entry >= QUALIFICATION.nativeObservationMs &&
      heartbeatAfterEntry === 0 &&
      !validated &&
      ui.length >= QUALIFICATION.minimumNativeUiSamples &&
      uiMaxMs !== null &&
      uiMaxMs <= QUALIFICATION.uiRoundTripMs &&
      uiMaxGapMs !== null &&
      uiMaxGapMs <= QUALIFICATION.uiGapMs);
  const expected =
    mode === 'control'
      ? gate.canSwitch() && validated
      : !gate.canSwitch() && gate.phase === 'failed';
  const negativeOk =
    (mode !== 'late' || gate.late > 0) &&
    (mode !== 'flood' || gate.failure === 'flood') &&
    (mode !== 'malformed' || gate.failure === 'protocol');
  const terminationOk =
    mode === 'control' ||
    (killReturned === true &&
      terminationMs !== null &&
      terminationMs <= QUALIFICATION.exitConfirmationMs);
  const ok =
    !caseError &&
    !fatalError &&
    ready &&
    pid !== undefined &&
    gate.exited &&
    expected &&
    nativeOk &&
    negativeOk &&
    terminationOk &&
    sentinelHash() === before;
  cases.push({
    mode,
    id,
    ok,
    pid,
    durationMs: monotonic() - caseStart,
    enteredAt: entry,
    killAt: killed,
    exitAt: ended,
    exitCode,
    killReturned,
    terminationMs,
    heartbeatAfterEntry,
    validated,
    gate,
    nativeUiSamples: ui.length,
    uiMaxMs,
    uiMaxGapMs,
    fixtureUnchanged: sentinelHash() === before,
  });
  if (!ok) throw new Error('资格场景未满足预设观测门');
}

void app
  .whenReady()
  .then(async () => {
    phase = '注册IPC';
    installUi();
    phase = '创建窗口';
    window = new BrowserWindow({
      width: 600,
      height: 260,
      show: true,
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        partition: 'e2-qualification-ui',
      },
    });
    window.setMenu(null);
    window.webContents.on('preload-error', (_event, _path, error) =>
      diagnostic('preload失败', error.message),
    );
    window.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame) diagnostic('UI加载失败', `${code}:${description}`);
    });
    window.webContents.on('render-process-gone', (_event, details) =>
      diagnostic('renderer退出', `${details.reason}:${details.exitCode}`),
    );
    phase = '安装窗口安全策略';
    window.webContents.session.protocol.handle(UI_SCHEME, (request) => {
      const asset = resolveUiAsset(request.url, request.method);
      if (asset === null) return new Response(null, { status: 404 });
      try {
        return new Response(new Uint8Array(readFileSync(join(__dirname, asset))), {
          headers: {
            'Content-Type':
              asset === 'ui.html' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
            'Content-Security-Policy':
              "default-src 'none'; script-src 'self'; style-src 'none'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch {
        diagnostic('固定UI资产读取失败', asset);
        return new Response(null, { status: 404 });
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== uiUrl) event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );
    phase = '加载固定UI';
    await window.loadURL(uiUrl);
    phase = '等待UI往返';
    const uiDeadline = monotonic() + 5000;
    while ((environment === null || samples.length < 3) && monotonic() < uiDeadline)
      await pause(50);
    if (environment === null || samples.length < 3) throw new Error('资格UI没有真实往返');
    const modes: Mode[] = ['control', 'native', 'native', 'native', 'late', 'flood', 'malformed'];
    for (let index = 0; index < modes.length; index++) {
      phase = `场景${index + 1}:${modes[index]}`;
      await runCase(modes[index], index + 1);
    }
    finish(true, '资格测量通过');
  })
  .catch((error: unknown) => {
    diagnostic('受信启动/场景错误', error instanceof Error ? error.message : '未知错误');
    finish(false, '资格测量失败');
  });
