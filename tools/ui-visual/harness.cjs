/* global __dirname, clearTimeout, process, require, setTimeout, URL */
// CommonJS is required because Electron loads this file as the tool application's main entry.
process.stderr.write('UI_VISUAL_HARNESS_ENTER\n');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, nativeTheme } = require('electron');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isAbsolute, join, relative, resolve, sep } = require('node:path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fileURLToPath, pathToFileURL } = require('node:url');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHash, randomUUID } = require('node:crypto');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFileSync } = require('node:child_process');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createServer } = require('node:http');

const repositoryRoot = resolve(__dirname, '..', '..');
const evidenceParent = resolve(repositoryRoot, 'log', 'browser-settings-20261012');
const requestedRunRoot = process.env.AIBROWSE_UI_VISUAL_RUN_ROOT;
const runRoot = requestedRunRoot
  ? resolve(requestedRunRoot)
  : join(
      evidenceParent,
      `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID()}`,
    );
const profileRoot = join(runRoot, 'profile');
const sessionRoot = join(runRoot, 'session');
const capturesRoot = join(runRoot, 'captures');
const mainEntry = join(repositoryRoot, 'out', 'main', 'index.js');
const rendererEntry = join(repositoryRoot, 'out', 'renderer', 'index.html');
const preloadEntry = join(repositoryRoot, 'out', 'preload', 'index.js');
const resultPath = join(runRoot, 'result.json');
const startedAt = new Date().toISOString();
const topLevelTimeoutMs = 165_000;
const localDate = new Date();
const localDateStamp = [
  localDate.getFullYear(),
  String(localDate.getMonth() + 1).padStart(2, '0'),
  String(localDate.getDate()).padStart(2, '0'),
].join('-');
const appLogPath = join(repositoryRoot, 'log', `aibrowse-${localDateStamp}.log`);
const appLogOffsetBefore = existsSync(appLogPath) ? statSync(appLogPath).size : 0;

function assertInside(child, parent, label) {
  const relationship = relative(parent, child);
  if (
    relationship === '' ||
    relationship.startsWith(`..${sep}`) ||
    relationship === '..' ||
    isAbsolute(relationship)
  ) {
    throw new Error(`${label} 不在允许目录内`);
  }
}

assertInside(runRoot, evidenceParent, '运行目录');
for (const required of [mainEntry, rendererEntry, preloadEntry]) {
  if (!existsSync(required)) throw new Error(`缺少构建文件：${required}`);
}

mkdirSync(profileRoot, { recursive: true });
mkdirSync(sessionRoot, { recursive: true });
mkdirSync(capturesRoot, { recursive: true });

const disallowedEnvironment = Object.keys(process.env).filter(
  (key) =>
    key === 'AIBROWSE_SMOKE' ||
    (key.startsWith('AIBROWSE_') &&
      (key.includes('_SMOKE') || key.includes('_LIVE_') || key.includes('_H3A'))),
);
for (const key of disallowedEnvironment) delete process.env[key];
delete process.env.ELECTRON_RENDERER_URL;
process.env.AIBROWSE_USER_DATA_DIR = profileRoot;
app.setPath('userData', profileRoot);
app.setPath('sessionData', sessionRoot);
app.setAppPath(repositoryRoot);

const result = {
  schemaVersion: 1,
  purpose: 'AIbrowse 标题栏、统一设置、浏览资料与既有工作区的真实 Electron UI 有界验收',
  status: 'running',
  startedAt,
  finishedAt: null,
  repositoryRoot,
  runRoot,
  profileRoot,
  sessionRoot,
  inputs: {
    mainEntry,
    rendererEntry,
    preloadEntry,
    smokeMode: false,
    providerCalls: 0,
    clearedEnvironment: disallowedEnvironment,
    timeoutMs: topLevelTimeoutMs,
    appLogPath,
    appLogOffsetBefore,
    sourceHashes: Object.fromEntries(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'src'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      })
        .split('\0')
        .filter((path) => path !== '' && !path.endsWith('.test.ts'))
        .map((path) => [
          path,
          createHash('sha256')
            .update(readFileSync(join(repositoryRoot, path)))
            .digest('hex'),
        ]),
    ),
    artifactHashes: Object.fromEntries(
      [
        mainEntry,
        rendererEntry,
        preloadEntry,
        ...readdirSync(join(repositoryRoot, 'out/renderer/assets')).map((name) =>
          join(repositoryRoot, 'out/renderer/assets', name),
        ),
      ].map((path) => [
        relative(repositoryRoot, path).replaceAll('\\', '/'),
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ]),
    ),
  },
  renderer: null,
  persistence: null,
  nativeThemeContract: null,
  captures: [],
  console: [],
  failures: [],
  workspaceNavigation: null,
  browserLibraryFlow: null,
  shutdown: { requested: false, willQuit: false },
};

const syntheticServer = createServer((request, response) => {
  if (request.url !== '/library-test?case=ui#fragment' && request.url !== '/library-test?case=ui') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(
    '<!doctype html><html><head><title>合成浏览资料页</title></head><body><h1>合成浏览资料页</h1></body></html>',
  );
});
const syntheticServerReady = new Promise((resolveReady, rejectReady) => {
  syntheticServer.once('error', rejectReady);
  syntheticServer.listen(0, '127.0.0.1', () => {
    const address = syntheticServer.address();
    if (address === null || typeof address === 'string') {
      rejectReady(new Error('合成网页服务地址不可用'));
      return;
    }
    resolveReady(`http://127.0.0.1:${address.port}/library-test?case=ui#fragment`);
  });
});

function persistResult() {
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function preserveAppLogTail() {
  if (!existsSync(appLogPath)) return;
  const bytes = readFileSync(appLogPath);
  if (bytes.length < appLogOffsetBefore) return;
  writeFileSync(join(runRoot, 'app-log-tail.log'), bytes.subarray(appLogOffsetBefore));
}

function noteFailure(message, details) {
  result.failures.push({
    at: new Date().toISOString(),
    message,
    ...(details === undefined ? {} : { details }),
  });
  persistResult();
}

process.prependListener('uncaughtException', (error) => {
  noteFailure(
    '捕获主进程未处理异常',
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
});

process.prependListener('unhandledRejection', (reason) => {
  noteFailure(
    '捕获主进程未处理 Promise 拒绝',
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  );
});

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitFor(description, probe, timeoutMs = 20_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(
    `${description}超时${lastError instanceof Error ? `：${lastError.message}` : ''}`,
  );
}

function normalizeFilePath(value) {
  return resolve(value).toLocaleLowerCase('en-US');
}

function inspectRendererUrl(actualUrl) {
  try {
    const parsed = new URL(actualUrl);
    if (parsed.protocol !== 'file:' || parsed.username !== '' || parsed.password !== '') {
      return { trusted: false, actualUrl, reason: 'renderer 不是本地 file URL' };
    }
    const actualPath = fileURLToPath(parsed);
    const trusted = normalizeFilePath(actualPath) === normalizeFilePath(rendererEntry);
    return {
      trusted,
      actualUrl,
      actualPath,
      expectedUrl: pathToFileURL(rendererEntry).href,
      expectedPath: rendererEntry,
      reason: trusted ? null : 'renderer 文件不是当前 out/renderer/index.html',
    };
  } catch (error) {
    return {
      trusted: false,
      actualUrl,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function evaluate(webContents, source) {
  return webContents.executeJavaScript(source, true);
}

async function waitForSelector(webContents, selector, timeoutMs = 15_000) {
  const encoded = JSON.stringify(selector);
  return waitFor(
    `等待 ${selector} `,
    () => evaluate(webContents, `Boolean(document.querySelector(${encoded}))`),
    timeoutMs,
  );
}

async function clickSelector(webContents, selector) {
  const encoded = JSON.stringify(selector);
  const clicked = await evaluate(
    webContents,
    `(() => {
      const element = document.querySelector(${encoded});
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`无法点击 ${selector}`);
}

async function clickButtonText(webContents, containerSelector, text) {
  const container = JSON.stringify(containerSelector);
  const expected = JSON.stringify(text);
  const clicked = await evaluate(
    webContents,
    `(() => {
      const root = document.querySelector(${container});
      if (!(root instanceof HTMLElement)) return false;
      const element = [...root.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === ${expected},
      );
      if (!(element instanceof HTMLButtonElement)) return false;
      element.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`无法点击 ${containerSelector} 内的“${text}”`);
}

async function setInputValue(webContents, selector, value) {
  const encodedSelector = JSON.stringify(selector);
  const encodedValue = JSON.stringify(value);
  const changed = await evaluate(
    webContents,
    `(() => {
      const input = document.querySelector(${encodedSelector});
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter === undefined) return false;
      setter.call(input, ${encodedValue});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value === ${encodedValue};
    })()`,
  );
  if (!changed) throw new Error(`无法设置输入框 ${selector}`);
}

async function openSettingsSection(webContents, label) {
  if (!(await evaluate(webContents, `Boolean(document.querySelector('.settings-page'))`))) {
    await clickSelector(webContents, '.settings-open');
    await waitForSelector(webContents, '.settings-page');
  }
  await clickButtonText(webContents, '.settings-nav', label);
  await delay(100);
}

async function closeWorkspacePage(webContents) {
  if (await evaluate(webContents, `Boolean(document.querySelector('.workspace-page-back'))`)) {
    await clickSelector(webContents, '.workspace-page-back');
    await waitFor(
      '等待返回浏览器 ',
      () =>
        evaluate(
          webContents,
          `!document.querySelector('.settings-page') && !document.querySelector('.browser-library-page')`,
        ),
      5_000,
    );
  }
}

async function setTheme(webContents, theme) {
  await openSettingsSection(webContents, '外观');
  const encoded = JSON.stringify(theme);
  const state = await evaluate(
    webContents,
    `(() => {
      const select = document.querySelector('select[aria-label="界面外观"]');
      if (!(select instanceof HTMLSelectElement)) return { ok: false };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter === undefined) return { ok: false };
      setter.call(select, ${encoded});
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: true,
        value: select.value,
        options: [...select.options].map((option) => option.value),
      };
    })()`,
  );
  if (!state.ok) throw new Error('无法通过原生 select setter 切换主题');
  await waitFor(
    `等待 ${theme} 主题生效`,
    () =>
      evaluate(
        webContents,
        `document.documentElement.dataset.theme === ${encoded} && localStorage.getItem('aibrowse.appearance') === ${encoded}`,
      ),
    5_000,
  );
  await closeWorkspacePage(webContents);
  return state;
}

async function readComputedTheme(webContents) {
  return evaluate(
    webContents,
    `(() => {
      const style = getComputedStyle(document.body);
      return {
        select: document.querySelector('select[aria-label="界面外观"]')?.value ?? null,
        root: document.documentElement.dataset.theme ?? null,
        prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
        color: style.color,
        backgroundColor: style.backgroundColor,
      };
    })()`,
  );
}

async function verifyNativeThemeContract(webContents) {
  const originalThemeSource = nativeTheme.themeSource;
  const evidence = { originalThemeSource, restoredThemeSource: null, checks: {} };
  try {
    await setTheme(webContents, 'system');
    nativeTheme.themeSource = 'light';
    const systemLight = await waitFor(
      '等待 system 响应 nativeTheme light ',
      async () => {
        const state = await readComputedTheme(webContents);
        return state.root === 'system' && !state.prefersDark ? state : false;
      },
      5_000,
    );
    nativeTheme.themeSource = 'dark';
    const systemDark = await waitFor(
      '等待 system 响应 nativeTheme dark ',
      async () => {
        const state = await readComputedTheme(webContents);
        return state.root === 'system' && state.prefersDark ? state : false;
      },
      5_000,
    );

    await setTheme(webContents, 'light');
    nativeTheme.themeSource = 'dark';
    await delay(150);
    const explicitLightUnderNativeDark = await readComputedTheme(webContents);
    await setTheme(webContents, 'dark');
    nativeTheme.themeSource = 'light';
    await delay(150);
    const explicitDarkUnderNativeLight = await readComputedTheme(webContents);

    evidence.systemLight = systemLight;
    evidence.systemDark = systemDark;
    evidence.explicitLightUnderNativeDark = explicitLightUnderNativeDark;
    evidence.explicitDarkUnderNativeLight = explicitDarkUnderNativeLight;
    evidence.checks = {
      systemSelectRespondsToNativeThemeOk:
        systemLight.color !== systemDark.color &&
        systemLight.backgroundColor !== systemDark.backgroundColor,
      explicitLightIgnoresNativeDarkOk:
        explicitLightUnderNativeDark.root === 'light' &&
        explicitLightUnderNativeDark.color === systemLight.color &&
        explicitLightUnderNativeDark.backgroundColor === systemLight.backgroundColor,
      explicitDarkIgnoresNativeLightOk:
        explicitDarkUnderNativeLight.root === 'dark' &&
        explicitDarkUnderNativeLight.color === systemDark.color &&
        explicitDarkUnderNativeLight.backgroundColor === systemDark.backgroundColor,
    };
    return evidence;
  } finally {
    nativeTheme.themeSource = originalThemeSource;
    evidence.restoredThemeSource = nativeTheme.themeSource;
  }
}

async function setViewport(win, width, height) {
  win.setContentSize(width, height);
  await waitFor(
    `等待内容区尺寸 ${width}x${height} `,
    () => {
      const [actualWidth, actualHeight] = win.getContentSize();
      return actualWidth === width && actualHeight === height;
    },
    5_000,
  );
  await delay(250);
}

function rgbChannels(value) {
  const match = /^rgba?\((\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)/.exec(value);
  return match === null ? null : match.slice(1, 4).map(Number);
}

function contrastRatio(foreground, background) {
  const foregroundRgb = rgbChannels(foreground);
  const backgroundRgb = rgbChannels(background);
  if (foregroundRgb === null || backgroundRgb === null) return null;
  const luminance = (channels) => {
    const converted = channels.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * converted[0] + 0.7152 * converted[1] + 0.0722 * converted[2];
  };
  const first = luminance(foregroundRgb);
  const second = luminance(backgroundRgb);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function inspectWebContentsViews(win) {
  return win.contentView.children.map((view, index) => ({
    index,
    type: view.constructor.name,
    bounds: view.getBounds(),
    visible: view.getVisible(),
    url:
      'webContents' in view && view.webContents && !view.webContents.isDestroyed()
        ? view.webContents.getURL()
        : null,
  }));
}

async function inspectDom(webContents, panelSelector, expectedTheme) {
  const selector = JSON.stringify(panelSelector);
  const theme = JSON.stringify(expectedTheme);
  return evaluate(
    webContents,
    `(() => {
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const value = element.getBoundingClientRect();
        return {
          x: value.x,
          y: value.y,
          width: value.width,
          height: value.height,
          right: value.right,
          bottom: value.bottom,
        };
      };
      const html = document.documentElement;
      const body = document.body;
      const panel = ${selector} === null ? null : document.querySelector(${selector});
      const themeSelect = document.querySelector('select[aria-label="界面外观"]');
      const bodyStyle = getComputedStyle(body);
      const chrome = document.querySelector('.chrome');
      const chromeStyle = chrome instanceof HTMLElement ? getComputedStyle(chrome) : null;
      const tabStrip = document.querySelector('.tab-strip-row');
      const tabCluster = document.querySelector('.tab-cluster');
      const tabBar = document.querySelector('.tab-bar');
      const dragSpace = document.querySelector('.titlebar-drag-space');
      const activeTab = document.querySelector('.tab.active');
      const newTab = document.querySelector('.new-tab-button');
      const region = (element) => element instanceof HTMLElement
        ? getComputedStyle(element).getPropertyValue('-webkit-app-region')
        : null;
      const rawOverlayRect = navigator.windowControlsOverlay?.getTitlebarAreaRect?.() ?? null;
      const overlayRect = rawOverlayRect === null
        ? null
        : {
            x: rawOverlayRect.x,
            y: rawOverlayRect.y,
            width: rawOverlayRect.width,
            height: rawOverlayRect.height,
          };
      return {
        expectedTheme: ${theme},
        activeTheme: html.dataset.theme ?? null,
        storedTheme: localStorage.getItem('aibrowse.appearance'),
        themeSelect: themeSelect instanceof HTMLSelectElement
          ? {
              value: themeSelect.value,
              ariaLabel: themeSelect.getAttribute('aria-label'),
              options: [...themeSelect.options].map((option) => option.value),
            }
          : null,
        document: {
          clientWidth: html.clientWidth,
          clientHeight: html.clientHeight,
          scrollWidth: html.scrollWidth,
          scrollHeight: html.scrollHeight,
        },
        body: {
          clientWidth: body.clientWidth,
          clientHeight: body.clientHeight,
          scrollWidth: body.scrollWidth,
          scrollHeight: body.scrollHeight,
          color: bodyStyle.color,
          backgroundColor: bodyStyle.backgroundColor,
        },
        chrome: {
          rect: rect(chrome),
          color: chromeStyle?.color ?? null,
          backgroundColor: chromeStyle?.backgroundColor ?? null,
        },
        app: rect(document.querySelector('.app')),
        mainRow: rect(document.querySelector('.main-row')),
        contentArea: rect(document.querySelector('.content-area')),
        address: rect(document.querySelector('.address-field')),
        titlebar: {
          strip: rect(tabStrip),
          cluster: rect(tabCluster),
          tabBar: rect(tabBar),
          dragSpace: rect(dragSpace),
          activeTab: rect(activeTab),
          newTab: rect(newTab),
          stripRegion: region(tabStrip),
          dragSpaceRegion: region(dragSpace),
          activeTabRegion: region(activeTab),
          newTabRegion: region(newTab),
          overlayRect,
        },
        debugVisible: document.querySelector('.debug-panel') !== null,
        panel: rect(panel),
      };
    })()`,
  );
}

async function capture(win, captureName, context) {
  await delay(300);
  const dom = await inspectDom(win.webContents, context.panelSelector, context.theme);
  const views = inspectWebContentsViews(win);
  const [contentWidth, contentHeight] = win.getContentSize();
  const bodyContrast = contrastRatio(dom.body.color, dom.body.backgroundColor);
  const extraInspection =
    context.inspect === undefined ? null : await context.inspect(win.webContents);
  const panelWidthOk =
    context.panelSelector === null ||
    (dom.panel !== null && Math.abs(dom.panel.width - 380) <= 0.01);
  const contentViews = views.filter((view) => view.type === 'WebContentsView');
  const contentView = contentViews.find((view) => view.visible) ?? contentViews[0] ?? null;
  const expectedViewBounds =
    context.browserVisible && dom.contentArea !== null
      ? {
          x: Math.round(dom.contentArea.x),
          y: Math.round(dom.contentArea.y),
          width: Math.round(dom.contentArea.width),
          height: Math.round(dom.contentArea.height),
        }
      : null;
  const webContentsViewBoundsOk = context.browserVisible
    ? contentView !== null &&
      contentView.visible &&
      JSON.stringify(contentView.bounds) === JSON.stringify(expectedViewBounds)
    : contentViews.every((view) => !view.visible);
  const themeSelectContractOk =
    dom.themeSelect === null ||
    (dom.themeSelect.ariaLabel === '界面外观' &&
      JSON.stringify(dom.themeSelect.options) === JSON.stringify(['system', 'light', 'dark']));
  const checks = {
    requestedContentSize: context.viewport,
    actualContentSize: { width: contentWidth, height: contentHeight },
    contentSizeOk:
      contentWidth === context.viewport.width && contentHeight === context.viewport.height,
    themeOk:
      dom.activeTheme === context.theme &&
      dom.storedTheme === context.theme &&
      (dom.themeSelect === null || dom.themeSelect.value === context.theme),
    themeContractOk: themeSelectContractOk,
    documentHorizontalOverflowOk:
      dom.document.scrollWidth <= dom.document.clientWidth + 1 &&
      dom.body.scrollWidth <= dom.body.clientWidth + 1,
    documentVerticalOverflowOk:
      dom.document.scrollHeight <= dom.document.clientHeight + 1 &&
      dom.body.scrollHeight <= dom.body.clientHeight + 1,
    panelWidthOk,
    webContentsViewBoundsOk,
    bodyTextContrast: bodyContrast,
    bodyTextContrastOk: bodyContrast !== null && bodyContrast >= 4.5,
    ...(context.scene === '浏览器基线'
      ? {
          compactChromeOk: dom.chrome.rect.height <= 86,
          noDefaultDebugOk: !dom.debugVisible,
          noBottomChromeOk: Math.abs(dom.contentArea.bottom - contentHeight) <= 1,
          usableAddressOk: dom.address.width >= 180,
          nativeMenuHiddenOk: !win.isMenuBarVisible(),
          titlebarAtWindowTopOk: dom.titlebar.strip?.y === 0,
          nativeCaptionSafeAreaOk:
            dom.titlebar.overlayRect !== null &&
            dom.titlebar.cluster !== null &&
            dom.titlebar.cluster.right <=
              dom.titlebar.overlayRect.x + dom.titlebar.overlayRect.width + 1,
          titlebarDragSpaceOk:
            dom.titlebar.dragSpace !== null &&
            dom.titlebar.dragSpace.width >= 24 &&
            dom.titlebar.stripRegion === 'drag' &&
            dom.titlebar.dragSpaceRegion === 'drag',
          titlebarControlsNoDragOk:
            dom.titlebar.activeTabRegion === 'no-drag' && dom.titlebar.newTabRegion === 'no-drag',
          newTabAdjacentOk:
            dom.titlebar.tabBar !== null &&
            dom.titlebar.newTab !== null &&
            dom.titlebar.newTab.x - dom.titlebar.tabBar.right >= -1 &&
            dom.titlebar.newTab.x - dom.titlebar.tabBar.right <= 5,
        }
      : {}),
    ...(extraInspection?.checks ?? {}),
  };
  const failures = Object.entries(checks)
    .filter(([, value]) => value === false)
    .map(([name]) => name);
  const record = {
    name: captureName,
    theme: context.theme,
    viewport: context.viewport,
    scene: context.scene,
    panelSelector: context.panelSelector,
    browserVisible: context.browserVisible,
    png: `captures/${captureName}.png`,
    json: `captures/${captureName}.json`,
    checks,
    dom,
    webContentsViews: views,
    expectedViewBounds,
    extraInspection: extraInspection?.details ?? null,
    failures,
  };
  // Preserve measured geometry even if the host cannot capture its compositor.
  writeFileSync(
    join(capturesRoot, `${captureName}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
  const rawImage = await win.capturePage();
  const rawImageSize = rawImage.getSize();
  const image = rawImage.resize({ width: contentWidth, height: contentHeight, quality: 'best' });
  const imageSize = image.getSize();
  record.rawImageSize = rawImageSize;
  record.imageSize = imageSize;
  if (imageSize.width !== contentWidth || imageSize.height !== contentHeight) {
    record.failures.push('imageSizeOk');
  }
  writeFileSync(join(capturesRoot, `${captureName}.png`), image.toPNG());
  writeFileSync(
    join(capturesRoot, `${captureName}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
  result.captures.push(record);
  if (record.failures.length > 0) {
    noteFailure(`截图 ${captureName} 的检查失败`, record.failures);
  } else {
    persistResult();
  }
}

async function mountSyntheticConfirm(win) {
  for (const view of win.contentView.children) view.setVisible(false);
  const mounted = await evaluate(
    win.webContents,
    `(() => {
      if (document.querySelector('[data-ui-visual-synthetic="long-confirm"]')) return false;
      const repeated = (seed, length) => Array.from({ length }, (_, index) =>
        seed[index % seed.length],
      ).join('');
      const overlay = document.createElement('div');
      overlay.className = 'ai-confirm-overlay';
      overlay.dataset.uiVisualSynthetic = 'long-confirm';
      overlay.setAttribute('role', 'presentation');
      const dialog = document.createElement('div');
      dialog.className = 'ai-confirm-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', '合成长内容确认压力夹具');
      const title = document.createElement('h3');
      title.className = 'ai-confirm-title';
      title.textContent = '需要你的确认（合成压力夹具）';
      const body = document.createElement('div');
      body.className = 'ai-confirm-body';
      const addLine = (labelText, valueText, valueClass = '') => {
        const line = document.createElement('div');
        line.className = 'ai-confirm-line';
        const label = document.createElement('span');
        label.className = 'ai-confirm-label';
        label.textContent = labelText;
        const value = document.createElement('span');
        value.className = 'ai-confirm-value ' + valueClass;
        value.textContent = valueText;
        line.append(label, value);
        body.append(line);
      };
      addLine('工具', 'source_apply_changes');
      addLine('目标站点', 'https://example.invalid/' + repeated('路径参数', 280), 'ai-confirm-url');
      addLine('目标元素', repeated('页面提供的不可信元素文本', 200), 'ai-confirm-element-text');
      addLine('原因', repeated('变更详情第一行；变更详情第二行；', 2000), 'ai-confirm-detail');
      const actions = document.createElement('div');
      actions.className = 'ai-confirm-actions';
      const deny = document.createElement('button');
      deny.type = 'button';
      deny.className = 'ai-confirm-deny';
      deny.textContent = '拒绝';
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'ai-confirm-approve';
      approve.textContent = '批准';
      actions.append(deny, approve);
      dialog.append(title, body, actions);
      overlay.append(dialog);
      document.body.append(overlay);
      deny.focus();
      return true;
    })()`,
  );
  if (!mounted) throw new Error('无法挂载合成长确认压力夹具');
}

async function inspectSyntheticConfirm(webContents) {
  const details = await evaluate(
    webContents,
    `(() => {
      const overlay = document.querySelector('[data-ui-visual-synthetic="long-confirm"]');
      const dialog = overlay?.querySelector('.ai-confirm-dialog');
      const body = overlay?.querySelector('.ai-confirm-body');
      const actions = overlay?.querySelector('.ai-confirm-actions');
      const deny = overlay?.querySelector('.ai-confirm-deny');
      const approve = overlay?.querySelector('.ai-confirm-approve');
      const inspect = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
          height: bounds.height,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          overflowY: style.overflowY,
          maxHeight: style.maxHeight,
        };
      };
      return {
        synthetic: overlay instanceof HTMLElement && overlay.dataset.uiVisualSynthetic === 'long-confirm',
        viewport: { width: innerWidth, height: innerHeight },
        dialog: inspect(dialog),
        body: inspect(body),
        actions: inspect(actions),
        deny: inspect(deny),
        approve: inspect(approve),
        activeClass: document.activeElement?.className ?? null,
      };
    })()`,
  );
  const scrollTargets = [details.dialog, details.body].filter((value) => value !== null);
  const scrollAvailable = scrollTargets.some(
    (value) =>
      value.scrollHeight > value.clientHeight + 1 &&
      (value.overflowY === 'auto' || value.overflowY === 'scroll'),
  );
  const insideViewport = (value) =>
    value !== null &&
    value.top >= 0 &&
    value.left >= 0 &&
    value.bottom <= details.viewport.height &&
    value.right <= details.viewport.width;
  return {
    details,
    checks: {
      syntheticFixtureMarkedOk: details.synthetic,
      syntheticDefaultFocusOk: details.activeClass === 'ai-confirm-deny',
      syntheticDialogWithinViewportOk: insideViewport(details.dialog),
      syntheticScrollAvailableOk: scrollAvailable,
      syntheticDenyVisibleOk: insideViewport(details.deny),
      syntheticApproveVisibleOk: insideViewport(details.approve),
    },
  };
}

async function unmountSyntheticConfirm(win) {
  await evaluate(
    win.webContents,
    `document.querySelector('[data-ui-visual-synthetic="long-confirm"]')?.remove()`,
  );
  for (const view of win.contentView.children) view.setVisible(true);
}

async function ensureBrowserMode(webContents) {
  await closeWorkspacePage(webContents);
  const inWatch = await evaluate(
    webContents,
    `Boolean(document.querySelector('.watch-workspace'))`,
  );
  if (inWatch) {
    await clickButtonText(webContents, '.watch-header', '← 返回浏览');
    await waitForSelector(webContents, '.content-area');
    await waitFor(
      '等待浏览器工作区恢复 ',
      () => evaluate(webContents, `!document.querySelector('.watch-workspace')`),
      5_000,
    );
  }
  const pressed = await evaluate(
    webContents,
    `document.querySelector('.workspace-nav button[aria-pressed="true"]')?.getAttribute('aria-label') ?? null`,
  );
  if (pressed !== null) {
    const selector = `.workspace-nav button[aria-label=${JSON.stringify(pressed)}]`;
    await clickSelector(webContents, selector);
    await delay(150);
  }
}

async function captureMatrix(win) {
  const webContents = win.webContents;
  const viewports = [
    { width: 1280, height: 800 },
    { width: 1100, height: 760 },
    { width: 800, height: 600 },
  ];
  const themes = ['light', 'dark'];
  const scenes = [
    {
      name: 'browser',
      scene: '浏览器基线',
      panelSelector: null,
      browserVisible: true,
      open: async () => ensureBrowserMode(webContents),
      close: async () => {},
    },
    {
      name: 'ai',
      scene: 'AI 侧栏',
      panelSelector: '.ai-panel',
      browserVisible: true,
      open: async () => {
        await clickSelector(webContents, '.ai-toggle');
        await waitForSelector(webContents, '.ai-panel');
      },
      close: async () => clickSelector(webContents, '.ai-toggle'),
    },
    {
      name: 'sources',
      scene: '信源空态',
      panelSelector: '.sources-panel',
      browserVisible: true,
      open: async () => {
        await clickSelector(webContents, '.sources-toggle');
        await waitForSelector(webContents, '.sources-panel');
      },
      close: async () => clickSelector(webContents, '.sources-toggle'),
    },
    {
      name: 'research',
      scene: '研究空态',
      panelSelector: '.research-panel',
      browserVisible: true,
      open: async () => {
        await clickSelector(webContents, '.research-toggle');
        await waitForSelector(webContents, '.research-panel');
      },
      close: async () => clickSelector(webContents, '.research-toggle'),
    },
    {
      name: 'settings-appearance',
      scene: '设置-外观',
      panelSelector: null,
      browserVisible: false,
      open: async () => openSettingsSection(webContents, '外观'),
      close: async () => closeWorkspacePage(webContents),
    },
    {
      name: 'settings-ai',
      scene: '设置-AI配置',
      panelSelector: null,
      browserVisible: false,
      open: async () => {
        await openSettingsSection(webContents, 'AI 配置');
        await waitForSelector(webContents, '.ai-settings');
      },
      close: async () => closeWorkspacePage(webContents),
    },
    {
      name: 'settings-data',
      scene: '设置-本地数据',
      panelSelector: null,
      browserVisible: false,
      open: async () => {
        await openSettingsSection(webContents, '本地数据');
        await waitForSelector(webContents, '.local-data');
      },
      close: async () => closeWorkspacePage(webContents),
    },
    {
      name: 'settings-advanced',
      scene: '设置-高级',
      panelSelector: null,
      browserVisible: false,
      open: async () => openSettingsSection(webContents, '高级'),
      close: async () => closeWorkspacePage(webContents),
    },
    {
      name: 'history',
      scene: '浏览历史',
      panelSelector: null,
      browserVisible: false,
      open: async () => {
        await clickSelector(webContents, '.history-open');
        await waitForSelector(webContents, '.browser-library-page');
        await waitForSelector(webContents, '.library-list');
      },
      close: async () => closeWorkspacePage(webContents),
    },
    {
      name: 'bookmarks',
      scene: '书签',
      panelSelector: null,
      browserVisible: false,
      open: async () => {
        await clickSelector(webContents, '.bookmarks-open');
        await waitForSelector(webContents, '.browser-library-page');
        await waitForSelector(webContents, '.library-list');
      },
      close: async () => closeWorkspacePage(webContents),
    },
    {
      name: 'diagnostics',
      scene: '诊断面板',
      panelSelector: '.diagnostic-panel',
      browserVisible: true,
      open: async () => {
        await openSettingsSection(webContents, '高级');
        await clickButtonText(webContents, '.settings-advanced-actions', '诊断信息');
        await waitForSelector(webContents, '.diagnostic-panel');
      },
      close: async () => clickSelector(webContents, '[aria-label="关闭诊断信息"]'),
    },
    {
      name: 'snapshot-debug',
      scene: '按需快照调试区',
      panelSelector: null,
      browserVisible: true,
      open: async () => {
        await openSettingsSection(webContents, '高级');
        await clickButtonText(webContents, '.settings-advanced-actions', '页面快照调试');
        await waitForSelector(webContents, '.debug-panel');
      },
      close: async () => clickSelector(webContents, '.debug-toggle'),
    },
    {
      name: 'synthetic-long-confirm',
      scene: '合成长 L2 确认 CSS 压力夹具',
      panelSelector: null,
      browserVisible: false,
      open: async () => mountSyntheticConfirm(win),
      close: async () => unmountSyntheticConfirm(win),
      inspect: inspectSyntheticConfirm,
    },
    {
      name: 'watch-overview',
      scene: 'Watch 概览',
      panelSelector: null,
      browserVisible: false,
      open: async () => {
        await clickSelector(webContents, '.watch-open');
        await waitForSelector(webContents, '[data-watch-view="overview"]');
      },
      close: async () => {},
    },
    {
      name: 'watch-rules',
      scene: 'Watch 规则空态',
      panelSelector: null,
      browserVisible: false,
      open: async () => {
        await clickButtonText(webContents, 'nav[aria-label="监控视图"]', '规则');
        await waitForSelector(webContents, '[data-watch-view="rules"]');
      },
      close: async () => {},
    },
    {
      name: 'watch-wizard',
      scene: 'Watch 创建向导',
      panelSelector: null,
      browserVisible: false,
      open: async () => {
        await clickButtonText(webContents, '[data-watch-view="rules"]', '创建监控');
        await waitForSelector(webContents, '.watch-wizard');
      },
      close: async () => {
        await clickButtonText(webContents, '.watch-wizard', '取消');
        await waitFor(
          '等待监控向导关闭 ',
          () => evaluate(webContents, `!document.querySelector('.watch-wizard')`),
          5_000,
        );
      },
    },
    {
      name: 'watch-health',
      scene: 'Watch 健康',
      panelSelector: null,
      browserVisible: false,
      open: async () => {
        await clickButtonText(webContents, 'nav[aria-label="监控视图"]', '健康');
        await waitForSelector(webContents, '[data-watch-view="health"]');
      },
      close: async () => {
        await clickButtonText(webContents, '.watch-header', '← 返回浏览');
        await waitFor(
          '等待离开监控工作区 ',
          () => evaluate(webContents, `!document.querySelector('.watch-workspace')`),
          5_000,
        );
      },
    },
  ];

  for (const viewport of viewports) {
    await setViewport(win, viewport.width, viewport.height);
    for (const theme of themes) {
      await ensureBrowserMode(webContents);
      await setTheme(webContents, theme);
      for (const scene of scenes) {
        await scene.open();
        await delay(200);
        const name = `${viewport.width}x${viewport.height}-${theme}-${scene.name}`;
        await capture(win, name, {
          viewport,
          theme,
          scene: scene.scene,
          panelSelector: scene.panelSelector,
          browserVisible: scene.browserVisible,
          inspect: scene.inspect,
        });
        await scene.close();
        await delay(150);
      }
    }
  }
}

async function verifyWorkspaceNavigation(win) {
  const wc = win.webContents;
  await ensureBrowserMode(wc);
  const before = await evaluate(wc, `document.querySelectorAll('.tab').length`);
  await clickSelector(wc, '.watch-open');
  await waitForSelector(wc, '.watch-workspace');
  await clickSelector(wc, '.new-tab-button');
  await waitFor('新建标签返回浏览', () =>
    evaluate(
      wc,
      `!document.querySelector('.watch-workspace') && document.querySelectorAll('.tab').length === ${before + 1}`,
    ),
  );
  await clickSelector(wc, '.tab.active .tab-close');
  await clickSelector(wc, '.watch-open');
  await waitForSelector(wc, '.watch-workspace');
  await clickSelector(wc, '.tab');
  await waitFor('激活标签返回浏览', () =>
    evaluate(wc, `!document.querySelector('.watch-workspace')`),
  );
  const visible = inspectWebContentsViews(win).some((view) => view.visible);
  await openSettingsSection(wc, '外观');
  const settingsHidden = inspectWebContentsViews(win)
    .filter((view) => view.type === 'WebContentsView')
    .every((view) => !view.visible);
  await closeWorkspacePage(wc);
  const settingsReturnVisible = inspectWebContentsViews(win).some(
    (view) => view.type === 'WebContentsView' && view.visible,
  );
  await clickSelector(wc, '.history-open');
  await waitForSelector(wc, '.browser-library-page');
  const libraryHidden = inspectWebContentsViews(win)
    .filter((view) => view.type === 'WebContentsView')
    .every((view) => !view.visible);
  await closeWorkspacePage(wc);
  const libraryReturnVisible = inspectWebContentsViews(win).some(
    (view) => view.type === 'WebContentsView' && view.visible,
  );
  result.workspaceNavigation = {
    watchNewTab: true,
    watchActivateTab: true,
    nativeContentVisible: visible,
    settingsHidden,
    settingsReturnVisible,
    libraryHidden,
    libraryReturnVisible,
  };
  if (
    !visible ||
    !settingsHidden ||
    !settingsReturnVisible ||
    !libraryHidden ||
    !libraryReturnVisible
  )
    noteFailure('设置或浏览资料工作区的原生网页可见性不符合契约', result.workspaceNavigation);
  persistResult();
}

async function verifyBrowserLibraryFlow(win) {
  const wc = win.webContents;
  const url = await syntheticServerReady;
  await ensureBrowserMode(wc);
  const created = await evaluate(
    wc,
    `window.aibrowse.tabs.create(${JSON.stringify(url)}).then((tab) => tab?.id ?? null)`,
  );
  if (typeof created !== 'string') throw new Error('生产 tabs.create 未创建合成浏览标签');
  await waitFor(
    '等待合成网页标题 ',
    () =>
      evaluate(
        wc,
        `document.querySelector('.tab.active .tab-title')?.textContent === '合成浏览资料页'`,
      ),
    15_000,
  );
  await clickSelector(wc, '.address-bookmark');
  await waitFor(
    '等待当前页加入书签 ',
    () =>
      evaluate(
        wc,
        `document.querySelector('.address-bookmark')?.getAttribute('aria-label') === '移除当前页书签'`,
      ),
    10_000,
  );

  await clickSelector(wc, '.history-open');
  await waitForSelector(wc, '.browser-library-page');
  await waitFor(
    '等待浏览历史出现 ',
    () =>
      evaluate(
        wc,
        `document.querySelector('.library-list')?.textContent?.includes('合成浏览资料页')`,
      ),
    10_000,
  );
  await setInputValue(wc, 'input[aria-label="搜索历史记录"]', '合成浏览资料');
  await clickButtonText(wc, '.library-search', '搜索');
  await waitFor(
    '等待浏览历史搜索结果 ',
    () => evaluate(wc, `document.querySelectorAll('.library-item').length === 1`),
    10_000,
  );
  await closeWorkspacePage(wc);

  await clickSelector(wc, '.bookmarks-open');
  await waitFor(
    '等待书签出现 ',
    () =>
      evaluate(
        wc,
        `document.querySelector('.library-list')?.textContent?.includes('合成浏览资料页')`,
      ),
    10_000,
  );
  await clickButtonText(wc, '.library-item', '编辑');
  await setInputValue(wc, '.bookmark-editor input[maxlength="1000"]', '合成书签已编辑');
  await clickButtonText(wc, '.bookmark-editor', '保存');
  await waitFor(
    '等待书签编辑保存 ',
    () =>
      evaluate(
        wc,
        `document.querySelector('.library-list')?.textContent?.includes('合成书签已编辑')`,
      ),
    10_000,
  );

  await wc.reload();
  await waitForSelector(wc, '.app', 20_000);
  await waitForSelector(wc, '.bookmarks-open', 20_000);
  await clickSelector(wc, '.bookmarks-open');
  await waitFor(
    '等待 renderer 重载后书签仍在 ',
    () =>
      evaluate(
        wc,
        `document.querySelector('.library-list')?.textContent?.includes('合成书签已编辑')`,
      ),
    10_000,
  );
  await clickButtonText(wc, '.library-item', '删除');
  await waitFor(
    '等待书签删除 ',
    () => evaluate(wc, `document.querySelectorAll('.library-item').length === 0`),
    10_000,
  );
  await closeWorkspacePage(wc);

  await clickSelector(wc, '.history-open');
  await waitForSelector(wc, '.browser-library-page');
  await clickButtonText(wc, '.library-toolbar', '清空历史记录');
  await clickButtonText(wc, '.library-confirm', '确认清空');
  await waitFor(
    '等待历史清空 ',
    () => evaluate(wc, `document.querySelectorAll('.library-item').length === 0`),
    10_000,
  );
  await closeWorkspacePage(wc);
  const returnedVisible = inspectWebContentsViews(win).some(
    (view) => view.type === 'WebContentsView' && view.visible,
  );
  result.browserLibraryFlow = {
    syntheticUrl: url,
    tabId: created,
    historyRecordedAndSearched: true,
    bookmarkAddedEditedAndReloaded: true,
    bookmarkRemoved: true,
    historyCleared: true,
    returnedVisible,
  };
  if (!returnedVisible) noteFailure('浏览资料流程返回后网页不可见');
  persistResult();
}

let activeWindow = null;
let runnerStarted = false;
let completing = false;

async function captureFailureOriginal(win, label) {
  if (win === null || win.isDestroyed()) return;
  try {
    const image = await win.capturePage();
    writeFileSync(join(capturesRoot, `${label}.png`), image.toPNG());
  } catch (error) {
    noteFailure('失败现场截图未能写出', error instanceof Error ? error.message : String(error));
  }
}

async function finish(status, exitCode) {
  if (completing) return;
  completing = true;
  clearTimeout(timeout);
  result.status = status;
  result.finishedAt = new Date().toISOString();
  result.shutdown.requested = true;
  persistResult();
  const serverClosed = new Promise((resolveClose) => syntheticServer.close(() => resolveClose()));
  syntheticServer.closeAllConnections();
  await serverClosed;
  process.exitCode = exitCode;
  app.quit();
}

async function run(win) {
  activeWindow = win;
  win.webContents.on('console-message', (details) => {
    if (result.console.length >= 200) return;
    result.console.push({
      level: details.level,
      message: String(details.message).slice(0, 1000),
      lineNumber: details.lineNumber,
      sourceId: String(details.sourceId).slice(0, 300),
    });
  });
  try {
    await waitFor(
      '等待主窗口 renderer ',
      async () => {
        if (win.isDestroyed() || win.webContents.isDestroyed()) return false;
        const renderer = inspectRendererUrl(win.webContents.getURL());
        if (!renderer.trusted) return false;
        const ready = await evaluate(
          win.webContents,
          `document.readyState === 'complete' && Boolean(document.querySelector('.app')) && Boolean(document.querySelector('.settings-open'))`,
        );
        return ready ? renderer : false;
      },
      30_000,
    );
    result.renderer = inspectRendererUrl(win.webContents.getURL());
    if (!result.renderer.trusted) throw new Error(result.renderer.reason);
    await delay(750);

    await setTheme(win.webContents, 'dark');
    const beforeReload = await evaluate(
      win.webContents,
      `({
        root: document.documentElement.dataset.theme ?? null,
        storage: localStorage.getItem('aibrowse.appearance'),
      })`,
    );
    await win.webContents.reload();
    await waitForSelector(win.webContents, '.settings-open', 20_000);
    const afterReload = await waitFor(
      '等待主题重载保持 ',
      async () => {
        const state = await evaluate(
          win.webContents,
          `({
            root: document.documentElement.dataset.theme ?? null,
            storage: localStorage.getItem('aibrowse.appearance'),
          })`,
        );
        return state.root === 'dark' && state.storage === 'dark' ? state : false;
      },
      10_000,
    );
    await openSettingsSection(win.webContents, '外观');
    const afterReloadSettings = await waitFor(
      '等待设置页显示重载后的主题 ',
      () =>
        evaluate(
          win.webContents,
          `document.querySelector('select[aria-label="界面外观"]')?.value === 'dark'`,
        ),
      5_000,
    );
    await closeWorkspacePage(win.webContents);
    result.persistence = { beforeReload, afterReload, afterReloadSettings, ok: true };
    persistResult();

    result.nativeThemeContract = await verifyNativeThemeContract(win.webContents);
    const nativeThemeFailures = Object.entries(result.nativeThemeContract.checks)
      .filter(([, value]) => value !== true)
      .map(([name]) => name);
    if (
      result.nativeThemeContract.restoredThemeSource !==
      result.nativeThemeContract.originalThemeSource
    ) {
      nativeThemeFailures.push('nativeThemeSourceRestoreOk');
    }
    if (nativeThemeFailures.length > 0) {
      noteFailure('系统主题响应检查失败', nativeThemeFailures);
    } else {
      persistResult();
    }

    await verifyBrowserLibraryFlow(win);
    await captureMatrix(win);
    await verifyWorkspaceNavigation(win);
    for (const [path, expected] of Object.entries({
      ...result.inputs.sourceHashes,
      ...result.inputs.artifactHashes,
    })) {
      if (
        createHash('sha256')
          .update(readFileSync(join(repositoryRoot, path)))
          .digest('hex') !== expected
      ) {
        noteFailure('验收期间源码或构建产物发生变化', path);
      }
    }
    const captureFailures = result.captures.reduce(
      (count, item) => count + item.failures.length,
      0,
    );
    await finish(
      result.failures.length === 0 && captureFailures === 0 ? 'passed' : 'failed',
      captureFailures === 0 && result.failures.length === 0 ? 0 : 1,
    );
  } catch (error) {
    noteFailure(
      'UI 验收执行失败',
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    await captureFailureOriginal(win, 'failure-original');
    await finish('failed', 1);
  }
}

app.on('browser-window-created', (_event, win) => {
  if (runnerStarted) return;
  runnerStarted = true;
  void run(win);
});

app.on('will-quit', () => {
  result.shutdown.willQuit = true;
  preserveAppLogTail();
  persistResult();
});

process.on('exit', (code) => {
  if (result.status === 'running') {
    result.status = 'failed';
    result.finishedAt = new Date().toISOString();
    result.failures.push({
      at: result.finishedAt,
      message: 'Electron 在验收收口前退出',
      details: { exitCode: code },
    });
  }
  persistResult();
});

const timeout = setTimeout(() => {
  void (async () => {
    noteFailure('UI 验收达到顶层超时', { timeoutMs: topLevelTimeoutMs });
    await captureFailureOriginal(activeWindow, 'timeout-original');
    await finish('timed-out', 1);
  })();
}, topLevelTimeoutMs);

persistResult();
// eslint-disable-next-line @typescript-eslint/no-require-imports
require(mainEntry);
