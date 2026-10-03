import {
  app,
  BaseWindow,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
  WebContentsView,
  type WebContents,
} from 'electron';
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import {
  APP_ASSET_CSP,
  APP_ENTRY_URL,
  installAppAssetProtocol,
  registerAppAssetScheme,
  type AppAssetManifest,
} from '../../src/main/security/asset-protocol';
import { installSessionSecurity } from '../../src/main/security/session-security';
import { installUiDocumentSecurity } from '../../src/main/security/ui-document-security';
import { resolveUiNavigationAllowed } from '../../src/main/ui-navigation-policy';

interface ScenarioResult {
  readonly name: string;
  readonly status: 'PASS' | 'FAIL';
  readonly durationMs: number;
}

const SCENARIO_TIMEOUT_MS = 30_000;
const OVERALL_TIMEOUT_MS = 110_000;
const rootArgument = process.argv.find((argument) => argument.startsWith('--qualification-root='));
if (rootArgument === undefined) throw new Error('缺少资格输出根');
const qualificationRoot = resolve(rootArgument.slice('--qualification-root='.length));
const profileRoot = join(qualificationRoot, 'profile');
const assetRoot = join(qualificationRoot, 'assets');
const downloadsRoot = join(qualificationRoot, 'downloads');
const canaryPath = join(qualificationRoot, 'synthetic-secret.txt');
const reportPath = join(qualificationRoot, 'report.json');
const preloadPath = join(qualificationRoot, 'qualification-preload.cjs');
const canary = 'S7RT02-SYNTHETIC-CANARY';

for (const directory of [qualificationRoot, profileRoot, assetRoot, downloadsRoot]) {
  mkdirSync(directory, { recursive: true });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('资格目录类型无效');
}
app.setPath('userData', profileRoot);
app.setPath('sessionData', profileRoot);

writeFileSync(canaryPath, canary, { encoding: 'utf8', flag: 'wx' });
writeFileSync(
  join(assetRoot, 'index.html'),
  [
    '<!doctype html>',
    '<html><head>',
    '<meta charset="UTF-8">',
    '<title>AIbrowse E1 qualification</title>',
    '<link rel="stylesheet" href="/main.css">',
    '</head><body>',
    '<main id="external-style" class="qualified">安全资格</main>',
    '<div id="inline-style" style="background-color: rgb(4, 5, 6)">inline</div>',
    '<script>globalThis.__inlineScriptExecuted = true</script>',
    '<script src="/main.js"></script>',
    '</body></html>',
  ].join(''),
  { encoding: 'utf8', flag: 'wx' },
);
writeFileSync(join(assetRoot, 'main.css'), '.qualified{color:rgb(1,2,3)}', {
  encoding: 'utf8',
  flag: 'wx',
});
writeFileSync(join(assetRoot, 'main.js'), 'globalThis.__externalScriptExecuted = true;', {
  encoding: 'utf8',
  flag: 'wx',
});
writeFileSync(join(assetRoot, 'payload.bin'), 'synthetic-download', {
  encoding: 'utf8',
  flag: 'wx',
});
writeFileSync(
  preloadPath,
  [
    "const { contextBridge, ipcRenderer } = require('electron');",
    "contextBridge.exposeInMainWorld('__qualification', {",
    "  open: () => ipcRenderer.invoke('e1-security:document-open'),",
    "  probe: (token) => ipcRenderer.invoke('e1-security:trusted-document-probe', token)",
    '});',
    "if (location.protocol === 'about:' && location.hash.length > 1) {",
    "  void ipcRenderer.invoke('e1-security:trusted-document-probe', decodeURIComponent(location.hash.slice(1)));",
    '}',
  ].join('\n'),
  { encoding: 'utf8', flag: 'wx' },
);

const manifest: AppAssetManifest = {
  version: 1,
  assets: {
    '/index.html': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
    '/main.css': { file: 'main.css', contentType: 'text/css; charset=utf-8' },
    '/main.js': { file: 'main.js', contentType: 'text/javascript; charset=utf-8' },
    '/payload.bin': { file: 'payload.bin', contentType: 'application/octet-stream' },
  },
};

registerAppAssetScheme(protocol);

const results: ScenarioResult[] = [];
const navigationObservations: Array<{
  readonly targetClass: string;
  readonly finalEntry: boolean;
  readonly willNavigateDelta: number;
  readonly willFrameNavigateDelta: number;
  readonly didStartDelta: number;
}> = [];
const ipcObservation: { trustedWrites: number; denied: number; automaticRecoveries: number } = {
  trustedWrites: 0,
  denied: 0,
  automaticRecoveries: 0,
};
const popupObservation = { denied: 0, created: 0 };
let uiWindow: BrowserWindow | null = null;
let tabOwner: BaseWindow | null = null;
let tabView: WebContentsView | null = null;
let failed = false;

const overallWatchdog = setTimeout(() => {
  failed = true;
  writeReport();
  app.exit(74);
}, OVERALL_TIMEOUT_MS);

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function bounded<T>(promise: Promise<T>, timeoutMs = SCENARIO_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('场景超时')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runScenario(name: string, operation: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  try {
    await bounded(operation());
    results.push({ name, status: 'PASS', durationMs: Date.now() - startedAt });
  } catch {
    failed = true;
    results.push({ name, status: 'FAIL', durationMs: Date.now() - startedAt });
  }
}

function writeReport(): void {
  const report = {
    version: 1,
    electron: process.versions.electron ?? 'unknown',
    chromium: process.versions.chrome ?? 'unknown',
    syntheticOnly: true,
    scenarioTimeoutMs: SCENARIO_TIMEOUT_MS,
    overallTimeoutMs: OVERALL_TIMEOUT_MS,
    results,
    navigationObservations,
    ipcObservation,
    popupObservation,
    status: failed || results.some((result) => result.status === 'FAIL') ? 'FAIL' : 'PASS',
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

async function inspectUiAssets(contents: WebContents): Promise<void> {
  const state = (await contents.executeJavaScript(
    `({
      title: document.title,
      externalScript: globalThis.__externalScriptExecuted === true,
      inlineScript: globalThis.__inlineScriptExecuted === true,
      externalColor: getComputedStyle(document.getElementById('external-style')).color,
      inlineBackground: getComputedStyle(document.getElementById('inline-style')).backgroundColor
    })`,
    false,
  )) as {
    title: string;
    externalScript: boolean;
    inlineScript: boolean;
    externalColor: string;
    inlineBackground: string;
  };
  assertCondition(state.title === 'AIbrowse E1 qualification', '固定协议入口未加载');
  assertCondition(state.externalScript, '清单外部脚本未运行');
  assertCondition(!state.inlineScript, 'CSP 未阻断 inline script');
  assertCondition(state.externalColor === 'rgb(1, 2, 3)', 'self CSS 未生效');
  assertCondition(state.inlineBackground !== 'rgb(4, 5, 6)', 'CSP 未阻断 inline style');
}

async function main(): Promise<void> {
  assertCondition(process.versions.electron === '43.7.7', 'Electron 版本不匹配');
  await app.whenReady();

  await runScenario('safeStorage 最大合法合成 Key 密文预算', async () => {
    assertCondition(safeStorage.isEncryptionAvailable(), 'safeStorage 不可用，密文资格未完成');
    const observations = ['A'.repeat(16384), '汉'.repeat(16384), '😀'.repeat(8192)].map((input) => {
      const encrypted = safeStorage.encryptString(input);
      const base64Bytes = Buffer.byteLength(encrypted.toString('base64'));
      const roundtrip = safeStorage.decryptString(encrypted) === input;
      assertCondition(base64Bytes <= 128 * 1024 && roundtrip, '合法 Key 超预算或往返失败');
      return {
        units: input.length,
        inputBytes: Buffer.byteLength(input),
        cipherBytes: encrypted.length,
        base64Bytes,
        roundtrip,
      };
    });
    writeFileSync(join(qualificationRoot, 'credential-size.json'), JSON.stringify(observations), {
      flag: 'wx',
    });
  });

  const uiSession = session.defaultSession;
  installSessionSecurity(uiSession);
  installAppAssetProtocol(uiSession.protocol, assetRoot, manifest);
  uiSession.setDownloadPath(downloadsRoot);

  const identityFor = (event: Electron.IpcMainInvokeEvent) => {
    const currentWindow = uiWindow;
    if (
      currentWindow === null ||
      currentWindow.isDestroyed() ||
      event.senderFrame === null ||
      event.sender !== currentWindow.webContents ||
      event.senderFrame !== currentWindow.webContents.mainFrame
    ) {
      return null;
    }
    return { owner: event.sender, frame: event.senderFrame, url: event.senderFrame.url };
  };
  ipcMain.handle('e1-security:document-open', (event) => {
    const identity = identityFor(event);
    return identity === null ? null : guard.token(identity);
  });
  ipcMain.handle('e1-security:trusted-document-probe', (event, token: unknown) => {
    const identity = identityFor(event);
    if (identity === null || !guard.accepts(identity, token)) {
      ipcObservation.denied += 1;
      return { ok: false };
    }
    ipcObservation.trustedWrites += 1;
    return { ok: true };
  });

  uiWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: preloadPath,
    },
  });
  const contents = uiWindow.webContents;
  let deniedNavigations = 0;
  let deniedFrameNavigations = 0;
  let didStartNavigations = 0;
  let unauthorizedCommits = 0;
  let deniedWindows = 0;
  const policy = { selfOrigin: null, selfFileUrl: null, selfAppUrl: APP_ENTRY_URL };
  const guard = installUiDocumentSecurity(contents, {
    entry: APP_ENTRY_URL,
    policy,
    onDenied: (kind) => {
      if (kind === 'window') {
        deniedWindows += 1;
        popupObservation.denied += 1;
      } else if (kind === 'frame') deniedFrameNavigations += 1;
      else deniedNavigations += 1;
    },
    onRecovery: () => {
      ipcObservation.automaticRecoveries += 1;
    },
    onRecoveryFailed: () => {
      throw new Error('受信入口恢复失败');
    },
  });
  contents.on('did-start-navigation', () => {
    didStartNavigations += 1;
  });
  contents.on('did-frame-navigate', (_event, url, _code, _status, isMainFrame) => {
    if (isMainFrame && !resolveUiNavigationAllowed(url, policy)) unauthorizedCommits += 1;
  });
  contents.on('did-create-window', () => {
    popupObservation.created += 1;
  });

  await runScenario('固定协议 UI 与 CSP 响应', async () => {
    await contents.loadURL(APP_ENTRY_URL);
    assertCondition(contents.getURL() === APP_ENTRY_URL, 'UI 最终 URL 不匹配');
    await inspectUiAssets(contents);
    const trustedToken = (await contents.executeJavaScript(
      `globalThis.__qualification.open()`,
      false,
    )) as string | null;
    assertCondition(typeof trustedToken === 'string', '受信入口未获得主进程令牌');
    const trustedProbe = (await contents.executeJavaScript(
      `globalThis.__qualification.probe(${JSON.stringify(trustedToken)})`,
      false,
    )) as { ok: boolean };
    assertCondition(trustedProbe.ok, '受信入口 IPC 未通过');
    if (ipcObservation.trustedWrites !== 1) throw new Error('受信入口写计数不一致');
    const response = await net.fetch(APP_ENTRY_URL);
    assertCondition(response.status === 200, '协议主资源响应失败');
    assertCondition(
      response.headers.get('content-security-policy') === APP_ASSET_CSP,
      '协议 CSP 响应漂移',
    );
    assertCondition(response.headers.get('x-content-type-options') === 'nosniff', '缺少 nosniff');
  });

  await runScenario('编码穿越与外部 file 零读取', async () => {
    const traversal = await net.fetch('aibrowse://app/assets/%2e%2e/%2e%2e/synthetic-secret.txt');
    assertCondition(traversal.status === 404, '编码穿越未拒绝');
    assertCondition((await traversal.text()) === '', '拒绝响应回显正文');

    const tabSession = session.fromPartition('persist:e1-security-qualification');
    installSessionSecurity(tabSession);
    tabOwner = new BaseWindow({ show: false, width: 320, height: 240 });
    tabView = new WebContentsView({
      webPreferences: {
        session: tabSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    tabOwner.contentView.addChildView(tabView);
    let rejected = false;
    try {
      await tabView.webContents.loadURL(pathToFileURL(canaryPath).href);
    } catch {
      rejected = true;
    }
    assertCondition(rejected, '外部 file 导航未拒绝');
    const body = (await tabView.webContents.executeJavaScript(
      'document.body?.innerText ?? ""',
      false,
    )) as string;
    assertCondition(!body.includes(canary), '外部 file 正文已进入 renderer');
  });

  await runScenario('Session 权限与下载默认拒绝', async () => {
    const permissionState = (await contents.executeJavaScript(
      `(async () => ({
        notification: await Notification.requestPermission(),
        geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state
      }))()`,
      false,
    )) as { notification: string; geolocation: string };
    assertCondition(permissionState.notification === 'denied', '通知权限未拒绝');
    assertCondition(permissionState.geolocation === 'denied', '定位权限未拒绝');

    const downloadObserved = new Promise<void>((resolveDownload) => {
      uiSession.once('will-download', () => resolveDownload());
    });
    await contents.executeJavaScript(
      `(() => {
        const link = document.createElement('a');
        link.href = 'aibrowse://app/payload.bin';
        link.download = 'synthetic.bin';
        document.body.append(link);
        link.click();
      })()`,
      false,
    );
    await bounded(downloadObserved, 5_000);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    assertCondition(readdirSync(downloadsRoot).length === 0, '下载产生了磁盘文件');

    assertCondition(tabView !== null, 'Tab view 未创建');
    const tabContents = tabView.webContents;
    const tabSession = tabContents.session;
    tabSession.setDownloadPath(downloadsRoot);
    const server = createServer((request, response) => {
      if (request.url === '/download') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="synthetic.exe"',
        });
        response.end('S7-SYNTHETIC-DOWNLOAD');
      } else {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>synthetic session</title>');
      }
    });
    try {
      await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
      const address = server.address();
      assertCondition(address !== null && typeof address !== 'string', '受控网络地址不可用');
      await tabContents.loadURL(`http://127.0.0.1:${address.port}/`);
      const denied = (await tabContents.executeJavaScript(
        `(async () => ({ notification: await Notification.requestPermission(), geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state }))()`,
      )) as { notification: string; geolocation: string };
      assertCondition(
        denied.notification === 'denied' && denied.geolocation === 'denied',
        'Tab Session 权限未拒绝',
      );
      const observed = new Promise<void>((resolveDownload) =>
        tabSession.once('will-download', () => resolveDownload()),
      );
      tabContents.downloadURL(`http://127.0.0.1:${address.port}/download`);
      await bounded(observed, 5_000);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      assertCondition(readdirSync(downloadsRoot).length === 0, 'Tab下载产生磁盘文件');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  await runScenario('WebContentsView 无 preload 与 Node 能力', async () => {
    assertCondition(tabView !== null, 'Tab view 未创建');
    await tabView.webContents.loadURL('about:blank');
    const exposure = (await tabView.webContents.executeJavaScript(
      `({
        processType: typeof globalThis.process,
        requireType: typeof globalThis.require,
        bridgeType: typeof globalThis.aibrowse
      })`,
      false,
    )) as { processType: string; requireType: string; bridgeType: string };
    assertCondition(exposure.processType === 'undefined', 'Tab 暴露 process');
    assertCondition(exposure.requireType === 'undefined', 'Tab 暴露 require');
    assertCondition(exposure.bridgeType === 'undefined', 'Tab 暴露应用 bridge');
  });

  await runScenario('恶意 scheme、window.open 与 about IPC 隔离', async () => {
    for (const [targetClass, target] of [
      ['data', 'data:text/html,blocked'],
      ['file', 'file:///C:/Windows/win.ini'],
      ['javascript', 'javascript:document.title="compromised"'],
    ] as const) {
      const beforeWillNavigate = deniedNavigations;
      const beforeWillFrameNavigate = deniedFrameNavigations;
      const beforeDidStart = didStartNavigations;
      await contents.executeJavaScript(
        `(() => {
          const link = document.createElement('a');
          link.href = ${JSON.stringify(target)};
          document.body.append(link);
          link.click();
        })()`,
        false,
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      navigationObservations.push({
        targetClass,
        finalEntry: contents.getURL() === APP_ENTRY_URL,
        willNavigateDelta: deniedNavigations - beforeWillNavigate,
        willFrameNavigateDelta: deniedFrameNavigations - beforeWillFrameNavigate,
        didStartDelta: didStartNavigations - beforeDidStart,
      });
      assertCondition(contents.getURL() === APP_ENTRY_URL, 'UI 被导航到恶意 scheme');
      assertCondition(contents.getTitle() === 'AIbrowse E1 qualification', 'javascript URL 已执行');
    }
    await contents.executeJavaScript(`window.open('https://example.invalid/')`, false);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    assertCondition(unauthorizedCommits === 0, '恶意 scheme 已提交导航');
    assertCondition(deniedWindows === 1, 'window.open handler 未拒绝');
    assertCondition(popupObservation.created === 0, 'window.open 创建了新窗口');

    const beforeDidStart = didStartNavigations;
    const beforeWillNavigate = deniedNavigations;
    const beforeWillFrameNavigate = deniedFrameNavigations;
    const firstToken = (await contents.executeJavaScript(
      `globalThis.__qualification.open()`,
      false,
    )) as string;
    await contents.executeJavaScript(
      `(() => {
        const link = document.createElement('a');
        link.href = ${JSON.stringify(`about:blank#${firstToken}`)};
        document.body.append(link);
        link.click();
      })()`,
      false,
    );
    await bounded(
      new Promise<void>((resolveRecovery) => {
        const check = (): void => {
          if (contents.getURL() === APP_ENTRY_URL && ipcObservation.automaticRecoveries === 1) {
            resolveRecovery();
          } else {
            setTimeout(check, 10);
          }
        };
        check();
      }),
      5_000,
    );
    navigationObservations.push({
      targetClass: 'about',
      finalEntry: contents.getURL() === APP_ENTRY_URL,
      willNavigateDelta: deniedNavigations - beforeWillNavigate,
      willFrameNavigateDelta: deniedFrameNavigations - beforeWillFrameNavigate,
      didStartDelta: didStartNavigations - beforeDidStart,
    });
    assertCondition(contents.getURL() === APP_ENTRY_URL, '非入口提交后未恢复固定入口');
    if (Number(unauthorizedCommits) !== 1) throw new Error('about commit 计数不一致');
    if (Number(ipcObservation.denied) !== 1) throw new Error('非入口 preload 旧令牌未拒绝');
    if (Number(ipcObservation.trustedWrites) !== 1) throw new Error('恢复前产生业务写');

    const secondToken = (await contents.executeJavaScript(
      `globalThis.__qualification.open()`,
      false,
    )) as string;
    assertCondition(secondToken !== firstToken, '恢复后沿用旧文档令牌');
    const oldProbe = (await contents.executeJavaScript(
      `globalThis.__qualification.probe(${JSON.stringify(firstToken)})`,
      false,
    )) as { ok: boolean };
    assertCondition(!oldProbe.ok, '恢复后旧令牌仍有效');
    const recoveredProbe = (await contents.executeJavaScript(
      `globalThis.__qualification.probe(${JSON.stringify(secondToken)})`,
      false,
    )) as { ok: boolean };
    assertCondition(recoveredProbe.ok, '恢复入口不能调用 IPC');
    if (Number(ipcObservation.trustedWrites) !== 2) throw new Error('恢复入口写计数不一致');

    await contents.executeJavaScript(
      `(() => {
        const link = document.createElement('a');
        link.href = ${JSON.stringify(`about:blank#${secondToken}`)};
        document.body.append(link);
        link.click();
      })()`,
      false,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    assertCondition(contents.getURL().startsWith('about:blank#'), '第二次非入口提交未发生');
    assertCondition(ipcObservation.automaticRecoveries === 1, '恢复发生无界循环');
    if (ipcObservation.trustedWrites !== 2) throw new Error('第二次非入口产生业务写');
  });

  clearTimeout(overallWatchdog);
  writeReport();
  app.exit(failed ? 1 : 0);
}

function closeOwnedContents(): void {
  if (tabView !== null && !tabView.webContents.isDestroyed()) {
    tabOwner?.contentView.removeChildView(tabView);
    tabView.webContents.close({ waitForBeforeUnload: false });
  }
  if (tabOwner !== null && !tabOwner.isDestroyed()) tabOwner.close();
  if (uiWindow !== null && !uiWindow.isDestroyed()) uiWindow.destroy();
}

process.on('uncaughtException', () => {
  failed = true;
  closeOwnedContents();
  if (!existsSync(reportPath)) writeReport();
  app.exit(73);
});
process.on('unhandledRejection', () => {
  failed = true;
  closeOwnedContents();
  if (!existsSync(reportPath)) writeReport();
  app.exit(73);
});
app.on('window-all-closed', () => {});
void main().catch(() => {
  failed = true;
  closeOwnedContents();
  clearTimeout(overallWatchdog);
  if (!existsSync(reportPath)) writeReport();
  app.exit(1);
});
