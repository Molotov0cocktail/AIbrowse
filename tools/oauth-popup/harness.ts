import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BaseWindow,
  session,
  webContents,
  WebContentsView,
  type Session,
  type WebContents,
} from 'electron';
import { assessGeneralPopupCases, assessOAuthPopup, type OAuthPopupFacts } from './oracle';

interface TabInfo {
  readonly id: string;
  readonly url: string;
  readonly active: boolean;
}

interface ProbeController {
  createTab(url?: string): Promise<TabInfo>;
  closeTab(tabId: string): Promise<boolean>;
  navigate(tabId: string, url: string): Promise<boolean>;
  getTabs(): Promise<TabInfo[]>;
  getActiveTab(): Promise<TabInfo | null>;
  getOwnedWebContentsId(tabId: string): number | null;
  dispose(): void;
}

interface ControllerOptions {
  ownerWindow: BaseWindow;
  sessionManager: { getSession(): Session };
  getFallbackBounds(): Electron.Rectangle;
}

type ControllerConstructor = new (options: ControllerOptions) => ProbeController;

const root = process.env.AIBROWSE_OAUTH_PROBE_ROOT;
const productBundle = process.env.AIBROWSE_OAUTH_PRODUCT_BUNDLE;
const baselineBundle = process.env.AIBROWSE_OAUTH_BASELINE_BUNDLE;
const expected = process.env.AIBROWSE_OAUTH_EXPECTED;
const scope = process.env.AIBROWSE_OAUTH_SCOPE ?? 'full';
if (
  !root ||
  !productBundle ||
  !['legacy', 'fixed'].includes(expected ?? '') ||
  !['full', 'sandbox', 'close', 'close-switch'].includes(scope)
)
  throw new Error('OAuth 探针启动参数无效');

app.setPath('userData', join(root, 'profile'));
if (expected === 'fixed')
  app.commandLine.appendSwitch('blink-settings', 'allowScriptsToCloseWindows=false');
const requestBudget = 30;
const protocolUrls: string[] = [];
const protocolRequestDetails: Array<{
  readonly url: string;
  readonly referrer: string;
  readonly refererHeader: string | null;
}> = [];
const unexpectedExternalRequests: string[] = [];
const consoleErrors: string[] = [];
const stages: string[] = [];
let controller: ProbeController | undefined;
let owner: BaseWindow | undefined;
let localServer: Server | undefined;
let completed = false;

interface LocalRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: string;
}

const localRequests: LocalRequest[] = [];
const viewConstructions: Array<{ readonly withWebContents: boolean }> = [];

const sourceHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>X OAuth 合成夹具</title><link rel="icon" href="data:,"></head>
<body><button id="login" style="display:block;width:240px;height:80px">使用 Google 登录</button>
<script>
(() => {
  const root = document.documentElement;
  let popup = null;
  addEventListener('message', (event) => {
    if (event.origin !== 'https://accounts.google.com' || !event.data || event.data.fixture !== 'oauth-popup') return;
    if (event.data.phase === 'ready') {
      root.dataset.ready = 'true';
      root.dataset.targetOpener = String(event.data.opener === true);
      root.dataset.childRequire = String(event.data.requireKind);
      root.dataset.childProcess = String(event.data.processKind);
      root.dataset.childElectron = String(event.data.electronKind);
      event.source?.postMessage({fixture:'oauth-popup', phase:'x-ack'}, 'https://accounts.google.com');
    }
    if (event.data.phase === 'complete') {
      root.dataset.complete = 'true';
      root.dataset.ack = String(event.data.ack === true);
    }
  });
  document.querySelector('#login').addEventListener('click', (event) => {
    root.dataset.clickTrusted = String(event.isTrusted);
    popup = window.open(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-fixture&redirect_uri=https%3A%2F%2Fx.com%2Ffixture',
      'google-oauth-fixture',
      'popup,width=500,height=600'
    );
    root.dataset.popupReturn = popup === null ? 'null' : 'object';
    const timer = setInterval(() => {
      if (popup && popup.closed) {
        root.dataset.childClosed = 'true';
        clearInterval(timer);
      }
    }, 20);
  });
})();
</script></body></html>`;

const targetHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Google OAuth 合成夹具</title><link rel="icon" href="data:,"></head>
<body>固定合成登录页<script>
(() => {
  const root = document.documentElement;
  const openerPresent = window.opener !== null;
  root.dataset.opener = String(openerPresent);
  root.dataset.requireKind = typeof require;
  root.dataset.processKind = typeof process;
  root.dataset.electronKind = typeof window.electron;
  addEventListener('message', (event) => {
    if (event.origin !== 'https://x.com' || !event.data || event.data.fixture !== 'oauth-popup' || event.data.phase !== 'x-ack') return;
    root.dataset.ack = 'true';
    window.opener?.postMessage({fixture:'oauth-popup', phase:'complete', ack:true}, 'https://x.com');
    setTimeout(() => window.close(), 50);
  });
  window.opener?.postMessage({
    fixture:'oauth-popup', phase:'ready', opener:openerPresent,
    requireKind:typeof require, processKind:typeof process, electronKind:typeof window.electron
  }, 'https://x.com');
})();
</script></body></html>`;

const secondSourceHtml = sourceHtml.replaceAll(
  'https://accounts.google.com',
  'https://login.example.test',
);
const secondTargetHtml = targetHtml.replaceAll('https://x.com', 'https://portal.example.test');
const blankTargetUrl =
  'https://blank-target.example.test/o/oauth2/v2/auth?client_id=synthetic-fixture';
const blankSourceHtml = sourceHtml
  .replaceAll('https://accounts.google.com', 'https://blank-target.example.test')
  .replace(
    'https://blank-target.example.test/o/oauth2/v2/auth?client_id=synthetic-fixture&redirect_uri=https%3A%2F%2Fx.com%2Ffixture',
    'about:blank',
  )
  .replace(
    "root.dataset.popupReturn = popup === null ? 'null' : 'object';",
    `root.dataset.popupReturn = popup === null ? 'null' : 'object';\n    if (popup) popup.location.href = '${blankTargetUrl}';`,
  );
const blankTargetHtml = targetHtml.replaceAll('https://x.com', 'https://blank-source.example.test');
const noopenerSourceHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Noopener 源夹具</title><link rel="icon" href="data:,"></head>
<body><a id="login" target="_blank" rel="noopener" href="https://article.example.test/opened" style="display:block;width:240px;height:80px">普通新标签</a>
<script>document.querySelector('#login').addEventListener('click',event=>document.documentElement.dataset.clickTrusted=String(event.isTrusted));</script></body></html>`;
const noopenerTargetHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Noopener 目标夹具</title><link rel="icon" href="data:,"></head>
<body><script>document.documentElement.dataset.opener=String(window.opener!==null);document.documentElement.dataset.requireKind=typeof require;document.documentElement.dataset.processKind=typeof process;document.documentElement.dataset.electronKind=typeof window.electron;</script>普通目标页</body></html>`;
const afterNavigationHtml =
  '<!doctype html><html><head><meta charset="utf-8"><title>源页已导航</title><link rel="icon" href="data:,"></head><body>源页新文档</body></html>';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(test: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await test()) return;
    await pause(20);
  }
  throw new Error('限定等待未满足');
}

function ownedContents(tabId: string): WebContents | null {
  const id = controller?.getOwnedWebContentsId(tabId);
  return id === null || id === undefined ? null : (webContents.fromId(id) ?? null);
}

async function readData(contents: WebContents): Promise<Record<string, string>> {
  return contents.executeJavaScript(
    `Object.fromEntries(Object.entries(document.documentElement.dataset))`,
    true,
  ) as Promise<Record<string, string>>;
}

async function readTransientData(contents: WebContents): Promise<Record<string, string> | null> {
  return Promise.race([readData(contents), pause(500).then(() => null)]);
}

async function click(contents: WebContents, button: 'left' | 'middle' = 'left'): Promise<void> {
  owner?.focus();
  contents.focus();
  await pause(250);
  const point = (await contents.executeJavaScript(
    `(() => { const r=document.querySelector('#login').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`,
    true,
  )) as { x: number; y: number };
  await clickAt(contents, point, button);
}

async function clickAt(
  contents: WebContents,
  point: { x: number; y: number },
  button: 'left' | 'middle' = 'left',
): Promise<void> {
  contents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  await pause(20);
  contents.sendInputEvent({
    type: 'mouseDown',
    button,
    clickCount: 1,
    x: point.x,
    y: point.y,
  });
  await pause(20);
  contents.sendInputEvent({
    type: 'mouseUp',
    button,
    clickCount: 1,
    x: point.x,
    y: point.y,
  });
}

async function runSemanticCase(
  sourceUrl: string,
  targetHost: string,
): Promise<{
  facts: OAuthPopupFacts;
  peakTabCount: number;
  parentAvailableForProtocol: boolean;
}> {
  stages.push(`semantic:${sourceUrl}:start`);
  const sourceTab = await controller!.createTab(sourceUrl);
  const sourceContents = ownedContents(sourceTab.id);
  assert(sourceContents);
  sourceContents.on('console-message', (details) => {
    if (details.level === 'error') consoleErrors.push(details.message.slice(0, 500));
  });
  await until(() => sourceContents.getTitle() === 'X OAuth 合成夹具', 5000);
  stages.push(`semantic:${sourceUrl}:loaded`);
  await click(sourceContents);
  await until(async () => {
    const data = await readData(sourceContents);
    return data.popupReturn === 'null' || data.popupReturn === 'object';
  }, 3000);
  let peakTabCount = (await controller!.getTabs()).length;
  let targetLoaded = false;
  let directTargetData: Record<string, string> = {};
  const observeUntil = performance.now() + 3500;
  while (performance.now() < observeUntil) {
    const tabs = await controller!.getTabs();
    peakTabCount = Math.max(peakTabCount, tabs.length);
    const targetTab = tabs.find((tab) => {
      try {
        return new URL(tab.url).hostname === targetHost;
      } catch {
        return false;
      }
    });
    const targetContents = targetTab ? ownedContents(targetTab.id) : null;
    if (targetContents && !targetContents.isDestroyed()) {
      try {
        if (targetContents.getTitle() === 'Google OAuth 合成夹具') {
          targetLoaded = true;
          directTargetData = (await readTransientData(targetContents)) ?? directTargetData;
        }
      } catch {
        // The native child may close between ownership lookup and inspection.
      }
    }
    const sourceData = await readData(sourceContents);
    if (sourceData.childClosed === 'true' && sourceData.complete === 'true') break;
    await pause(25);
  }
  const sourceData = await readData(sourceContents);
  stages.push(`semantic:${sourceUrl}:observed`);
  targetLoaded =
    targetLoaded ||
    sourceData.ready === 'true' ||
    protocolUrls.some((value) => new URL(value).hostname === targetHost);
  const booleanOrNull = (value: string | undefined): boolean | null =>
    value === 'true' ? true : value === 'false' ? false : null;
  return {
    peakTabCount,
    parentAvailableForProtocol:
      !sourceContents.isDestroyed() &&
      sourceData.ready === 'true' &&
      sourceData.complete === 'true',
    facts: {
      sourceClickTrusted: sourceData.clickTrusted === 'true',
      popupReturnKind:
        sourceData.popupReturn === 'null' || sourceData.popupReturn === 'object'
          ? sourceData.popupReturn
          : 'unknown',
      targetLoaded,
      targetOpenerPresent: booleanOrNull(sourceData.targetOpener ?? directTargetData.opener),
      sourceReceivedReady: sourceData.ready === 'true',
      targetReceivedAck: sourceData.ack === 'true' || directTargetData.ack === 'true',
      sourceReceivedComplete: sourceData.complete === 'true',
      childClosed: sourceData.childClosed === 'true',
      childRequireKind: sourceData.childRequire ?? directTargetData.requireKind ?? null,
      childProcessKind: sourceData.childProcess ?? directTargetData.processKind ?? null,
      childElectronKind: sourceData.childElectron ?? directTargetData.electronKind ?? null,
    },
  };
}

async function runNoopenerCase(): Promise<Record<string, unknown>> {
  stages.push('noopener:start');
  const sourceTab = await controller!.createTab('https://news.example.test/fixture-noopener');
  const sourceContents = ownedContents(sourceTab.id);
  assert(sourceContents);
  await until(() => sourceContents.getTitle() === 'Noopener 源夹具', 5000);
  stages.push('noopener:loaded');
  await click(sourceContents);
  let targetTab: TabInfo | undefined;
  await until(async () => {
    targetTab = (await controller!.getTabs()).find((tab) => {
      try {
        return new URL(tab.url).hostname === 'article.example.test';
      } catch {
        return false;
      }
    });
    return targetTab !== undefined;
  }, 4000);
  assert(targetTab);
  const targetContents = ownedContents(targetTab.id);
  assert(targetContents);
  await until(() => targetContents.getTitle() === 'Noopener 目标夹具', 5000);
  const beforeNavigation = await readData(targetContents);
  const sourceData = await readData(sourceContents);
  const navigated = await controller!.navigate(
    sourceTab.id,
    'https://news.example.test/after-navigation',
  );
  await until(() => sourceContents.getTitle() === '源页已导航', 5000);
  stages.push('noopener:navigated');
  const tabsAfterNavigation = await controller!.getTabs();
  const targetAfterNavigation = tabsAfterNavigation.find((tab) => tab.id === targetTab!.id);
  const childStillAlive =
    targetAfterNavigation !== undefined &&
    ownedContents(targetTab.id) !== null &&
    ownedContents(targetTab.id)?.isDestroyed() === false;
  const sourceClosed = await controller!.closeTab(sourceTab.id);
  stages.push('noopener:source-closed');
  const childAliveAfterSourceClose =
    (await controller!.getTabs()).some((tab) => tab.id === targetTab!.id) &&
    ownedContents(targetTab.id)?.isDestroyed() === false;
  return {
    passed:
      sourceData.clickTrusted === 'true' &&
      beforeNavigation.opener === 'false' &&
      beforeNavigation.requireKind === 'undefined' &&
      beforeNavigation.processKind === 'undefined' &&
      beforeNavigation.electronKind === 'undefined' &&
      navigated &&
      childStillAlive &&
      sourceClosed &&
      childAliveAfterSourceClose,
    sourceClickTrusted: sourceData.clickTrusted === 'true',
    openerPresent: beforeNavigation.opener === 'true',
    navigated,
    childStillAlive,
    sourceClosed,
    childAliveAfterSourceClose,
    targetTabId: targetTab.id,
  };
}

async function runPostCase(localOrigin: string): Promise<Record<string, unknown>> {
  stages.push('post:start');
  const sourceUrl = `${localOrigin}/post-source`;
  const sourceTab = await controller!.createTab(sourceUrl);
  const sourceContents = ownedContents(sourceTab.id);
  assert(sourceContents);
  await until(() => sourceContents.getTitle() === 'POST 源夹具', 5000);
  await click(sourceContents);
  await until(() => localRequests.some((request) => request.path === '/post-target'), 5000);
  const request = localRequests.find((candidate) => candidate.path === '/post-target');
  assert(request);
  let targetTab: TabInfo | undefined;
  await until(async () => {
    targetTab = (await controller!.getTabs()).find((tab) => {
      try {
        return new URL(tab.url).pathname === '/post-target';
      } catch {
        return false;
      }
    });
    return targetTab !== undefined;
  }, 5000);
  assert(targetTab);
  const targetContents = ownedContents(targetTab.id);
  assert(targetContents);
  await until(() => targetContents.getTitle() === 'POST 目标夹具', 5000);
  const data = await readData(targetContents);
  const referer = request.headers.referer;
  const origin = request.headers.origin;
  const contentType = request.headers['content-type'];
  return {
    passed:
      request.method === 'POST' &&
      request.body === 'fixture=fixed-message' &&
      origin === localOrigin &&
      referer === sourceUrl &&
      typeof contentType === 'string' &&
      contentType.startsWith('application/x-www-form-urlencoded') &&
      data.requireKind === 'undefined' &&
      data.processKind === 'undefined' &&
      data.electronKind === 'undefined',
    request,
    targetLoaded: true,
  };
}

async function runNoreferrerCase(localOrigin: string): Promise<Record<string, unknown>> {
  stages.push('noreferrer:start');
  const sourceTab = await controller!.createTab(`${localOrigin}/noreferrer-source`);
  const sourceContents = ownedContents(sourceTab.id);
  assert(sourceContents);
  await until(() => sourceContents.getTitle() === 'Noreferrer 源夹具', 5000);
  await click(sourceContents);
  await until(() => localRequests.some((request) => request.path === '/noreferrer-target'), 5000);
  const request = localRequests.find((candidate) => candidate.path === '/noreferrer-target');
  assert(request);
  const targetTab = (await controller!.getTabs()).find((tab) => {
    try {
      return new URL(tab.url).pathname === '/noreferrer-target';
    } catch {
      return false;
    }
  });
  assert(targetTab);
  const targetContents = ownedContents(targetTab.id);
  assert(targetContents);
  await until(() => targetContents.getTitle() === 'Noreferrer 目标夹具', 5000);
  const data = await readData(targetContents);
  return {
    passed:
      request.method === 'GET' && request.headers.referer === undefined && data.opener === 'false',
    request,
    openerPresent: data.opener === 'true',
  };
}

async function runSandboxCase(localOrigin: string): Promise<Record<string, unknown>> {
  stages.push('sandbox:start');
  const controlTab = await controller!.createTab(`${localOrigin}/sandbox-control-target`);
  const controlContents = ownedContents(controlTab.id);
  assert(controlContents);
  await until(() => controlContents.getTitle() === 'Sandbox 正控目标夹具', 5000);
  await until(
    () => localRequests.some((request) => request.path === '/sandbox-control-script-ran'),
    5000,
  );
  const positiveControlRan = true;
  await controller!.closeTab(controlTab.id);
  const sourceTab = await controller!.createTab(`${localOrigin}/sandbox-source`);
  const sourceContents = ownedContents(sourceTab.id);
  assert(sourceContents);
  await until(() => sourceContents.getTitle() === 'Sandbox 源夹具', 5000);
  owner?.focus();
  sourceContents.focus();
  await pause(250);
  // WebContents.sendInputEvent does not route a synthetic coordinate into a
  // child frame on this Electron build. Grant the real main-frame input token,
  // then activate the no-script frame's fixed anchor from the harness.
  await clickAt(sourceContents, { x: 500, y: 300 });
  await sourceContents.executeJavaScript(
    `document.querySelector('#sandbox-frame').contentDocument.querySelector('a').click()`,
    true,
  );
  await until(() => localRequests.some((request) => request.path === '/sandbox-target'), 5000);
  const targetTab = (await controller!.getTabs()).find((tab) => {
    try {
      return new URL(tab.url).pathname === '/sandbox-target';
    } catch {
      return false;
    }
  });
  assert(targetTab);
  const targetContents = ownedContents(targetTab.id);
  assert(targetContents);
  await until(() => targetContents.getTitle() === 'Sandbox 目标夹具', 5000);
  await pause(500);
  const scriptRan = localRequests.some((request) => request.path === '/sandbox-script-ran');
  return {
    passed: positiveControlRan && !scriptRan,
    positiveControlRan,
    inheritedScriptRestriction: !scriptRan,
    inputMode: 'trusted-main-frame-input-plus-controlled-frame-anchor',
  };
}

async function captureCase(
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    return await run();
  } catch (error) {
    return { passed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runCloseContrast(
  currentConstructor: ControllerConstructor,
  baselineConstructor: ControllerConstructor | null,
  isolated: Session,
  localOrigin: string,
  switchOnly: boolean,
): Promise<Record<string, unknown>> {
  const create = (Constructor: ControllerConstructor): ProbeController =>
    new Constructor({
      ownerWindow: owner!,
      sessionManager: { getSession: () => isolated },
      getFallbackBounds: () => ({ x: 0, y: 0, width: 900, height: 700 }),
    });
  const selfClose = async (
    Constructor: ControllerConstructor,
    label: string,
  ): Promise<Record<string, unknown>> => {
    controller = create(Constructor);
    const tab = await controller.createTab(`${localOrigin}/self-close?case=${label}`);
    const contents = ownedContents(tab.id);
    assert(contents);
    await until(() => contents.getTitle() === 'Self close 夹具', 5000);
    const historyLength = contents.navigationHistory.getAllEntries().length;
    await click(contents);
    await pause(500);
    const webContentsDestroyed = contents.isDestroyed();
    const tabPresent = (await controller.getTabs()).some((candidate) => candidate.id === tab.id);
    await until(async () => (await controller!.getTabs()).length > 0, 3000);
    const replacementTabs = await controller.getTabs();
    const activeTab = await controller.getActiveTab();
    const replacementTab = replacementTabs.length === 1 ? replacementTabs[0] : undefined;
    controller.dispose();
    controller = undefined;
    return {
      label,
      historyLength,
      webContentsDestroyed,
      tabPresent,
      replacementCount: replacementTabs.length,
      replacementUrl: replacementTab?.url,
      replacementActive: replacementTab?.active,
      activeTabMatchesReplacement: activeTab?.id === replacementTab?.id,
    };
  };
  const openerClose = async (withHistory: boolean): Promise<Record<string, unknown>> => {
    controller = create(currentConstructor);
    const initialPath = withHistory ? '/history-a' : '/single-source';
    const tab = await controller.createTab(`${localOrigin}${initialPath}`);
    const contents = ownedContents(tab.id);
    assert(contents);
    await until(
      () => contents.getTitle() === (withHistory ? 'History A 夹具' : 'Opener close 源夹具'),
      5000,
    );
    if (withHistory) {
      await controller.navigate(tab.id, `${localOrigin}/history-b`);
      await until(() => contents.getTitle() === 'History B 夹具', 5000);
    }
    const historyLength = contents.navigationHistory.getAllEntries().length;
    const childRequestsBefore = localRequests.filter(
      (request) => request.path === '/close-child',
    ).length;
    await click(contents);
    await until(
      () =>
        localRequests.filter((request) => request.path === '/close-child').length >
        childRequestsBefore,
      5000,
    );
    await pause(500);
    const webContentsDestroyed = contents.isDestroyed();
    const tabs = await controller.getTabs();
    const tabPresent = tabs.some((candidate) => candidate.id === tab.id);
    const childTabPresent = tabs.some((candidate) => {
      try {
        return new URL(candidate.url).pathname === '/close-child';
      } catch {
        return false;
      }
    });
    controller.dispose();
    controller = undefined;
    return {
      withHistory,
      historyLength,
      webContentsDestroyed,
      tabPresent,
      childSelfClosed: !childTabPresent,
    };
  };
  const openedChildClose = async (
    kind: 'middle' | 'anchor' | 'form',
  ): Promise<Record<string, unknown>> => {
    controller = create(currentConstructor);
    const sourcePath =
      kind === 'middle'
        ? '/background-source'
        : kind === 'anchor'
          ? '/anchor-close-source'
          : '/form-close-source';
    const childAPath =
      kind === 'middle'
        ? '/background-child-a'
        : kind === 'anchor'
          ? '/anchor-close-child-a'
          : '/form-close-child-a';
    const childBPath =
      kind === 'middle'
        ? '/background-child-b'
        : kind === 'anchor'
          ? '/anchor-close-child-b'
          : '/form-close-child-b';
    const source = await controller.createTab(`${localOrigin}${sourcePath}`);
    const sourceContents = ownedContents(source.id);
    assert(sourceContents);
    await until(() => sourceContents.getTitle() === `${kind} close source 夹具`, 5000);
    const constructionOffset = viewConstructions.length;
    await click(sourceContents, kind === 'middle' ? 'middle' : 'left');
    await until(() => localRequests.some((request) => request.path === childAPath), 5000);
    const child = (await controller.getTabs()).find((candidate) => candidate.id !== source.id);
    assert(child);
    const childContents = ownedContents(child.id);
    assert(childContents);
    await until(() => childContents.getTitle() === `${kind} close child A 夹具`, 3000);
    assert.equal(await controller.navigate(child.id, `${localOrigin}${childBPath}`), true);
    await until(() => localRequests.some((request) => request.path === childBPath), 5000);
    await until(() => childContents.getTitle() === `${kind} close child B 夹具`, 3000);
    await until(() => childContents.navigationHistory.getAllEntries().length >= 2, 3000);
    const historyLength = childContents.navigationHistory.getAllEntries().length;
    void childContents.executeJavaScript(`window.close()`, true).catch(() => undefined);
    if (kind === 'middle') await pause(500);
    else
      await until(
        async () => !(await controller!.getTabs()).some((candidate) => candidate.id === child.id),
        3000,
      );
    const tabsAfterClose = await controller.getTabs();
    const activeTab = await controller.getActiveTab();
    const constructions = viewConstructions.slice(constructionOffset);
    const openingRequest = localRequests.find((request) => request.path === childAPath);
    controller.dispose();
    controller = undefined;
    return {
      kind,
      disposition: kind === 'middle' ? 'background-tab' : 'foreground-tab',
      historyLength,
      childSelfClosed: !tabsAfterClose.some((candidate) => candidate.id === child.id),
      sourceSurvived: tabsAfterClose.some((candidate) => candidate.id === source.id),
      activeSourcePreserved: activeTab?.id === source.id,
      viewConstructions: constructions,
      openingRequest,
    };
  };
  if (switchOnly) {
    const currentSelfClose = await selfClose(currentConstructor, 'current-switch');
    const currentMultiDocumentChildOpenerClose = await openerClose(true);
    const currentMiddleClickMultiDocumentChildClose = await openedChildClose('middle');
    const currentAnchorMultiDocumentChildClose = await openedChildClose('anchor');
    const currentFormMultiDocumentChildClose = await openedChildClose('form');
    assert.deepEqual(
      {
        destroyed: currentSelfClose.webContentsDestroyed,
        removed: currentSelfClose.tabPresent === false,
        replacementCount: currentSelfClose.replacementCount,
        replacementUrl: currentSelfClose.replacementUrl,
        replacementActive: currentSelfClose.replacementActive,
        activeMatches: currentSelfClose.activeTabMatchesReplacement,
      },
      {
        destroyed: true,
        removed: true,
        replacementCount: 1,
        replacementUrl: 'about:blank',
        replacementActive: true,
        activeMatches: true,
      },
    );
    assert.equal(currentMultiDocumentChildOpenerClose.webContentsDestroyed, false);
    assert.equal(currentMultiDocumentChildOpenerClose.tabPresent, true);
    assert.equal(currentMultiDocumentChildOpenerClose.childSelfClosed, true);
    assert.ok(Number(currentMiddleClickMultiDocumentChildClose.historyLength) >= 2);
    assert.equal(currentMiddleClickMultiDocumentChildClose.childSelfClosed, false);
    assert.equal(currentMiddleClickMultiDocumentChildClose.sourceSurvived, true);
    assert.equal(currentMiddleClickMultiDocumentChildClose.activeSourcePreserved, true);
    for (const candidate of [
      currentAnchorMultiDocumentChildClose,
      currentFormMultiDocumentChildClose,
    ]) {
      assert.ok(Number(candidate.historyLength) >= 2);
      assert.equal(candidate.childSelfClosed, true);
      assert.equal(candidate.sourceSurvived, true);
      assert.equal(candidate.activeSourcePreserved, true);
    }
    const formRequest = currentFormMultiDocumentChildClose.openingRequest as
      LocalRequest | undefined;
    assert.equal(formRequest?.method, 'POST');
    assert.equal(formRequest?.body, 'fixture=fixed-message');
    assert.equal(formRequest?.headers.origin, localOrigin);
    assert.equal(formRequest?.headers.referer, `${localOrigin}/form-close-source`);
    return {
      currentSelfClose,
      currentMultiDocumentChildOpenerClose,
      currentMiddleClickMultiDocumentChildClose,
      currentAnchorMultiDocumentChildClose,
      currentFormMultiDocumentChildClose,
    };
  }
  assert(baselineConstructor);
  return {
    baselineSelfClose: await selfClose(baselineConstructor, 'baseline-b8f782c'),
    currentSelfClose: await selfClose(currentConstructor, 'current'),
    currentSingleDocumentChildOpenerClose: await openerClose(false),
    currentMultiDocumentChildOpenerClose: await openerClose(true),
  };
}

async function runProbe(): Promise<Record<string, unknown>> {
  const requireProduct = createRequire(join(root!, 'product-loader.cjs'));
  const electronRuntime = requireProduct('electron') as {
    WebContentsView: typeof WebContentsView;
  };
  const NativeWebContentsView = electronRuntime.WebContentsView;
  const TracedWebContentsView = new Proxy(NativeWebContentsView, {
    construct(target, argumentsList, newTarget) {
      const options = argumentsList[0];
      viewConstructions.push({
        withWebContents:
          options !== null &&
          typeof options === 'object' &&
          'webContents' in options &&
          options.webContents !== undefined,
      });
      return Reflect.construct(target, argumentsList, newTarget);
    },
  });
  const tracedElectronRuntime = new Proxy(electronRuntime, {
    get(target, property, receiver) {
      return property === 'WebContentsView'
        ? TracedWebContentsView
        : Reflect.get(target, property, receiver);
    },
  });
  type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;
  const moduleRuntime = requireProduct('node:module') as unknown as { _load: ModuleLoad };
  const nativeModuleLoad = moduleRuntime._load;
  moduleRuntime._load = function (this: unknown, request, parent, isMain) {
    const loaded = nativeModuleLoad.call(this, request, parent, isMain);
    return request === 'electron' ? tracedElectronRuntime : loaded;
  };
  let product: { BrowserControllerImpl: ControllerConstructor };
  try {
    product = requireProduct(productBundle!) as {
      BrowserControllerImpl: ControllerConstructor;
    };
  } finally {
    moduleRuntime._load = nativeModuleLoad;
  }
  const isolated = session.fromPartition('oauth-popup-synthetic');
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.on('will-download', (event) => event.preventDefault());
  await isolated.setProxy({ mode: 'direct' });
  let localOrigin = '';
  localServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > 16_384) throw new Error('本地POST正文超过16KiB预算');
      chunks.push(value);
    }
    const path = new URL(request.url ?? '/', localOrigin).pathname;
    localRequests.push({
      method: request.method ?? '',
      path,
      headers: { ...request.headers },
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if (protocolUrls.length + localRequests.length > requestBudget)
      throw new Error('合成页面请求超过30次预算');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (path === '/post-source') {
      response.setHeader('content-security-policy', "default-src 'none'; form-action 'self'");
      response.end(
        `<!doctype html><title>POST 源夹具</title><form method="post" action="${localOrigin}/post-target" target="_blank"><input name="fixture" value="fixed-message"><button id="login" style="display:block;width:240px;height:80px">POST</button></form>`,
      );
      return;
    }
    if (path === '/post-target') {
      response.end(
        `<title>POST 目标夹具</title><script>document.documentElement.dataset.requireKind=typeof require;document.documentElement.dataset.processKind=typeof process;document.documentElement.dataset.electronKind=typeof window.electron;</script>`,
      );
      return;
    }
    if (path === '/noreferrer-source') {
      response.end(
        `<title>Noreferrer 源夹具</title><a id="login" href="${localOrigin}/noreferrer-target" target="_blank" rel="noreferrer" style="display:block;width:240px;height:80px">noreferrer</a>`,
      );
      return;
    }
    if (path === '/noreferrer-target') {
      response.end(
        `<title>Noreferrer 目标夹具</title><script>document.documentElement.dataset.opener=String(window.opener!==null);</script>`,
      );
      return;
    }
    if (path === '/sandbox-source') {
      response.end(
        `<title>Sandbox 源夹具</title><iframe id="sandbox-frame" sandbox="allow-popups allow-same-origin" style="width:300px;height:120px;border:0" srcdoc="<a target='_blank' href='${localOrigin}/sandbox-target' style='display:block;width:280px;height:100px'>sandbox child</a>"></iframe>`,
      );
      return;
    }
    if (path === '/sandbox-target') {
      response.end(
        `<title>Sandbox 目标夹具</title><script>fetch('${localOrigin}/sandbox-script-ran')</script>`,
      );
      return;
    }
    if (path === '/sandbox-control-target') {
      response.end(
        `<title>Sandbox 正控目标夹具</title><script>fetch('${localOrigin}/sandbox-control-script-ran')</script>`,
      );
      return;
    }
    if (path === '/sandbox-script-ran') {
      response.end('<title>脚本不应运行</title>');
      return;
    }
    if (path === '/sandbox-control-script-ran') {
      response.end('<title>正控脚本已运行</title>');
      return;
    }
    if (path === '/self-close') {
      response.end(
        `<title>Self close 夹具</title><button id="login" style="display:block;width:240px;height:80px" onclick="window.close()">close</button>`,
      );
      return;
    }
    if (path === '/single-source' || path === '/history-b') {
      response.end(
        `<title>${path === '/history-b' ? 'History B 夹具' : 'Opener close 源夹具'}</title><button id="login" style="display:block;width:240px;height:80px" onclick="window.open('${localOrigin}/close-child','close-child','popup,width=400,height=300')">child</button>`,
      );
      return;
    }
    if (path === '/history-a') {
      response.end('<title>History A 夹具</title>history-a');
      return;
    }
    if (path === '/close-child') {
      response.end(
        `<title>Close child 夹具</title><script>window.opener?.close();window.close()</script>child`,
      );
      return;
    }
    if (path === '/background-source') {
      response.end(
        `<title>middle close source 夹具</title><a id="login" target="_blank" href="${localOrigin}/background-child-a" style="display:block;width:240px;height:80px">background child</a>`,
      );
      return;
    }
    if (path === '/background-child-a') {
      response.end(`<title>middle close child A 夹具</title>`);
      return;
    }
    if (path === '/background-child-b') {
      response.end(`<title>middle close child B 夹具</title>`);
      return;
    }
    if (path === '/anchor-close-source') {
      response.end(
        `<title>anchor close source 夹具</title><a id="login" target="_blank" href="${localOrigin}/anchor-close-child-a" style="display:block;width:240px;height:80px">anchor child</a>`,
      );
      return;
    }
    if (path === '/anchor-close-child-a' || path === '/anchor-close-child-b') {
      response.end(`<title>anchor close child ${path.endsWith('-a') ? 'A' : 'B'} 夹具</title>`);
      return;
    }
    if (path === '/form-close-source') {
      response.end(
        `<title>form close source 夹具</title><form method="post" action="${localOrigin}/form-close-child-a" target="_blank"><input name="fixture" value="fixed-message"><button id="login" style="display:block;width:240px;height:80px">form child</button></form>`,
      );
      return;
    }
    if (path === '/form-close-child-a' || path === '/form-close-child-b') {
      response.end(`<title>form close child ${path.endsWith('-a') ? 'A' : 'B'} 夹具</title>`);
      return;
    }
    response.statusCode = 404;
    response.end('<title>未找到</title>');
  });
  await new Promise<void>((resolveListen) => localServer!.listen(0, '127.0.0.1', resolveListen));
  const address = localServer.address();
  assert(address && typeof address !== 'string');
  localOrigin = `http://127.0.0.1:${address.port}`;
  const allowedRequest = (urlText: string): boolean => {
    const url = new URL(urlText);
    const key = `${url.hostname}${url.pathname}`;
    return (
      (url.protocol === 'https:' &&
        [
          'x.com/fixture',
          'accounts.google.com/o/oauth2/v2/auth',
          'portal.example.test/fixture',
          'login.example.test/o/oauth2/v2/auth',
          'blank-source.example.test/fixture',
          'blank-target.example.test/o/oauth2/v2/auth',
          'news.example.test/fixture-noopener',
          'news.example.test/after-navigation',
          'article.example.test/opened',
        ].includes(key)) ||
      (url.origin === localOrigin &&
        [
          '/post-source',
          '/post-target',
          '/noreferrer-source',
          '/noreferrer-target',
          '/sandbox-source',
          '/sandbox-target',
          '/sandbox-script-ran',
          '/sandbox-control-target',
          '/sandbox-control-script-ran',
          '/self-close',
          '/single-source',
          '/history-a',
          '/history-b',
          '/close-child',
          '/background-source',
          '/background-child-a',
          '/background-child-b',
          '/anchor-close-source',
          '/anchor-close-child-a',
          '/anchor-close-child-b',
          '/form-close-source',
          '/form-close-child-a',
          '/form-close-child-b',
        ].includes(url.pathname))
    );
  };
  isolated.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
      if (!allowedRequest(details.url)) unexpectedExternalRequests.push(details.url.slice(0, 500));
      callback({ cancel: !allowedRequest(details.url) });
      return;
    }
    callback({ cancel: false });
  });
  isolated.protocol.handle('https', (request) => {
    protocolUrls.push(request.url);
    protocolRequestDetails.push({
      url: request.url,
      referrer: request.referrer,
      refererHeader: request.headers.get('referer'),
    });
    if (protocolUrls.length > requestBudget) throw new Error('本地协议请求超过30次预算');
    const url = new URL(request.url);
    const key = `${url.hostname}${url.pathname}`;
    const fixtures: Readonly<Record<string, string>> = {
      'x.com/fixture': sourceHtml,
      'accounts.google.com/o/oauth2/v2/auth': targetHtml,
      'portal.example.test/fixture': secondSourceHtml,
      'login.example.test/o/oauth2/v2/auth': secondTargetHtml,
      'blank-source.example.test/fixture': blankSourceHtml,
      'blank-target.example.test/o/oauth2/v2/auth': blankTargetHtml,
      'news.example.test/fixture-noopener': noopenerSourceHtml,
      'news.example.test/after-navigation': afterNavigationHtml,
      'article.example.test/opened': noopenerTargetHtml,
    };
    const body = fixtures[key] ?? '';
    if (body === '') unexpectedExternalRequests.push(request.url.slice(0, 500));
    return new Response(body, {
      status: body === '' ? 404 : 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });
  const cookiesBefore = (await isolated.cookies.get({})).length;
  owner = new BaseWindow({
    show: true,
    x: 40,
    y: 40,
    width: 900,
    height: 700,
    title: 'AIbrowse OAuth 合成探针',
  });
  if (scope === 'close' || scope === 'close-switch') {
    if (scope === 'close' && !baselineBundle) throw new Error('关闭语义对照缺少冻结基线包');
    const baselineProduct = baselineBundle
      ? (requireProduct(baselineBundle) as {
          BrowserControllerImpl: ControllerConstructor;
        })
      : null;
    const contrast = await runCloseContrast(
      product.BrowserControllerImpl,
      baselineProduct?.BrowserControllerImpl ?? null,
      isolated,
      localOrigin,
      scope === 'close-switch',
    );
    const cookiesAfter = (await isolated.cookies.get({})).length;
    return {
      completed: true,
      expected,
      scope,
      blinkSettings: app.commandLine.getSwitchValue('blink-settings'),
      expectationPassed: true,
      contrast,
      requestCount: localRequests.length,
      requestBudget,
      localRequests,
      cookiesBefore,
      cookiesAfter,
      providerCalls: 0,
      unexpectedExternalRequests,
    };
  }
  controller = new product.BrowserControllerImpl({
    ownerWindow: owner,
    sessionManager: { getSession: () => isolated },
    getFallbackBounds: () => ({ x: 0, y: 0, width: 900, height: 700 }),
  });
  if (scope === 'sandbox') {
    const sandbox = await captureCase(() => runSandboxCase(localOrigin));
    const cookiesAfter = (await isolated.cookies.get({})).length;
    const boundary = {
      protocolRequests: protocolUrls.length + localRequests.length,
      requestBudget,
      unexpectedExternalRequests,
      cookiesBefore,
      cookiesAfter,
      providerCalls: 0,
    };
    return {
      completed: true,
      expected,
      scope,
      expectationPassed:
        sandbox.passed === true &&
        boundary.protocolRequests <= requestBudget &&
        boundary.unexpectedExternalRequests.length === 0 &&
        boundary.cookiesBefore === 0 &&
        boundary.cookiesAfter === 0,
      sandbox,
      boundary,
      localRequests,
      stages,
    };
  }
  const primary = await runSemanticCase('https://x.com/fixture', 'accounts.google.com');
  const secondary =
    expected === 'fixed'
      ? await runSemanticCase('https://portal.example.test/fixture', 'login.example.test')
      : null;
  const blank =
    expected === 'fixed'
      ? await runSemanticCase(
          'https://blank-source.example.test/fixture',
          'blank-target.example.test',
        )
      : null;
  const noopener = expected === 'fixed' ? await runNoopenerCase() : null;
  const post = expected === 'fixed' ? await captureCase(() => runPostCase(localOrigin)) : null;
  const noreferrer =
    expected === 'fixed' ? await captureCase(() => runNoreferrerCase(localOrigin)) : null;
  const sandbox =
    expected === 'fixed' ? await captureCase(() => runSandboxCase(localOrigin)) : null;
  const cookiesAfter = (await isolated.cookies.get({})).length;
  const boundary = {
    protocolRequests: protocolUrls.length + localRequests.length,
    requestBudget,
    unexpectedExternalRequests,
    cookiesBefore,
    cookiesAfter,
    providerCalls: 0,
  };
  const assessment = assessOAuthPopup(primary.facts, boundary);
  const secondaryAssessment = secondary ? assessOAuthPopup(secondary.facts, boundary) : null;
  const blankAssessment = blank ? assessOAuthPopup(blank.facts, boundary) : null;
  const generalCasesPassed =
    expected === 'legacy' ||
    (secondaryAssessment !== null &&
      blankAssessment?.nativePopupSemanticsObserved === true &&
      noopener !== null &&
      post?.passed === true &&
      noreferrer?.passed === true &&
      sandbox?.passed === true &&
      assessGeneralPopupCases(assessment, secondaryAssessment, {
        sourceClickTrusted: noopener.sourceClickTrusted === true,
        openerPresent: noopener.openerPresent === true,
        navigated: noopener.navigated === true,
        childStillAlive: noopener.childStillAlive === true,
      }));
  const expectationPassed =
    assessment.boundaryPassed &&
    generalCasesPassed &&
    (expected === 'legacy'
      ? assessment.legacyFailureObserved
      : assessment.nativePopupSemanticsObserved);
  return {
    completed: true,
    expected,
    blinkSettings: app.commandLine.getSwitchValue('blink-settings'),
    expectationPassed,
    facts: primary.facts,
    parentProtocolAvailability: primary.parentAvailableForProtocol,
    boundary,
    assessment,
    secondaryFacts: secondary?.facts ?? null,
    secondaryAssessment,
    blankFacts: blank?.facts ?? null,
    blankAssessment,
    noopener,
    post,
    noreferrer,
    sandbox,
    generalCasesPassed,
    peakTabCount: Math.max(
      primary.peakTabCount,
      secondary?.peakTabCount ?? 0,
      blank?.peakTabCount ?? 0,
    ),
    finalTabs: await controller.getTabs(),
    protocolUrls,
    protocolRequestDetails,
    stages,
    localRequests,
    consoleErrors,
    fixture: {
      source: 'https://x.com/fixture',
      targetOrigin: 'https://accounts.google.com',
      targetPath: '/o/oauth2/v2/auth',
      secondarySource: 'https://portal.example.test/fixture',
      secondaryTargetOrigin: 'https://login.example.test',
      blankBootstrapSource: 'https://blank-source.example.test/fixture',
      blankBootstrapTargetOrigin: 'https://blank-target.example.test',
      noopenerSource: 'https://news.example.test/fixture-noopener',
      localHttpOrigin: localOrigin,
      content: '固定合成消息，无凭据、Token或真实Cookie',
    },
  };
}

function finish(result: Record<string, unknown>, exitCode: number): void {
  if (completed) return;
  completed = true;
  writeFileSync(join(root!, 'result.json'), JSON.stringify(result, null, 2));
  controller?.dispose();
  controller = undefined;
  if (owner && !owner.isDestroyed()) owner.destroy();
  localServer?.close();
  app.exit(exitCode);
}

const errorDetail = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

const deadline = setTimeout(
  () => finish({ completed: false, expected, error: '45秒探针预算耗尽', stages }, 2),
  45_000,
);

process.on('uncaughtException', (error) =>
  finish({ completed: false, error: errorDetail(error) }, 1),
);
process.on('unhandledRejection', (error) =>
  finish({ completed: false, error: errorDetail(error) }, 1),
);

void app
  .whenReady()
  .then(runProbe)
  .then((result) => {
    clearTimeout(deadline);
    finish(result, result.expectationPassed === true ? 0 : 1);
  })
  .catch((error: unknown) => {
    clearTimeout(deadline);
    finish(
      {
        completed: false,
        expected,
        error: errorDetail(error),
      },
      1,
    );
  });
