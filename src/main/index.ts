import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { BrowserControllerImpl } from './browser/browser-controller';
import { AppSessionManager } from './browser/session-manager';
import { initLogger, logDebug, logEnvironment, logError, logInfo, logWarn } from './logger';
import { runSessionSmokeScenario, runSmokeScenario, smokeUiFake } from './smoke';
import type { LiveProviderSmoke } from './smoke';
import { resolveUiNavigationAllowed, type UiNavigationPolicy } from './ui-navigation-policy';
import { resolveAddressBarInput } from '../shared/url';
import { IPC } from '../shared/types/ipc';
import type { AppInfo } from '../shared/types/app';
import type {
  AskResult,
  ConversationMessage,
  ConversationSession,
  ContextPreview,
  ProviderInfo,
} from '../shared/types/conversation';
import type {
  ConfigProvidersSetKeyPayload,
  ContentBounds,
  ConversationAskPayload,
  ConversationCreatePayload,
  ConversationSetEphemeralPayload,
  NavNavigatePayload,
  RequestIdPayload,
  SessionIdPayload,
  TabIdPayload,
  TabsCreatePayload,
} from '../shared/types/ipc';
// Second Stage（S3 最小装配 → S4 完整 IPC/bridge）：AI 共读子系统装配——
// 事件回调转发主窗口 send（§3.1/§4，事件只发主窗口）；invoke 通道 S4 全部落地（§4.1）。
import { ConfigStore, validateProviderConfig } from './ai/config-store';
import { SecureCredentialStoreImpl, type SecureCredentialStore } from './ai/credential-store';
import { SafeStorageCipher } from './ai/safe-storage-cipher';
import { ConversationServiceImpl, type ConversationService } from './ai/conversation-service';
import { ConversationStore } from './ai/conversation-store';
import { CONTEXT_BUDGET, truncateWithMark } from './ai/context-budget';
import { FakeProvider } from './ai/provider/fake-provider';
import {
  PROVIDER_KIND_OPENAI_COMPATIBLE,
  registerProviderFactory,
} from './ai/provider/llm-provider';

// 冒烟模式 AI 子系统数据目录（进程专属临时目录，不触碰用户真实 userData）——S4 起
// UI 端到端矩阵经真实 IPC/bridge 链路驱动同一实例；路径经 SmokeOptions 传给冒烟场景断言。
const SMOKE_AI_DATA_DIR = join(app.getPath('temp'), `aibrowse-smoke-ai-${process.pid}`);

// 冒烟自检模式：窗口创建 + 渲染进程就绪后驱动浏览器核心场景（smoke.ts），全部断言通过后正常退出
const SMOKE_MODE = process.env.AIBROWSE_SMOKE === '1';

// S5 真实 Provider 冒烟（§6 可选验证，需用户提供 Key——询问边界）：AIBROWSE_LIVE_PROVIDER=1
// 时冒烟装配走生产 Provider 链路（openai-compatible + 真实 resolveProvider）；baseUrl/model
// 写入进程专属临时配置，Key 只经 AIBROWSE_TEST_API_KEY 环境变量进入并立即从 process.env
// 移除（零暴露扫描由冒烟场景在进程内完成，Key 绝不写入日志/文件/DOM）。
const LIVE_PROVIDER_MODE = SMOKE_MODE && process.env['AIBROWSE_LIVE_PROVIDER'] === '1';
// S6 真实 Provider 多网站共读验证（§10 Exit Gate）：AIBROWSE_LIVE_SITES=1 时冒烟改跑
// 多网站场景（多个真实站点各对应一个明确验收项，见 smoke.ts LIVE_SITES）
const LIVE_SITES_MODE = LIVE_PROVIDER_MODE && process.env['AIBROWSE_LIVE_SITES'] === '1';
let liveSmoke: LiveProviderSmoke | undefined = undefined;
let liveStreamChunkCount = 0; // 真实 Provider 场景 delta 计数（流式证据，index.ts 装配侧统计）

// Session 冒烟/测试隔离（§十四 Session 验收）：指定临时 userData 目录，避免触碰用户真实数据。
// 必须在 app ready 前设置（Electron 官方 API）；仅测试/验证环境使用（AIBROWSE_SESSION_SMOKE）。
const userDataOverride = process.env['AIBROWSE_USER_DATA_DIR'];
if (userDataOverride !== undefined && userDataOverride !== '') {
  app.setPath('userData', userDataOverride);
}

// 开发期日志写项目根目录 log/（AGENTS.md §3 红线）；打包后写入用户数据目录（asar 只读）
initLogger(app.isPackaged ? app.getPath('userData') : app.getAppPath());
logEnvironment();

// 单窗口假设（detailed-design 决议 #14）：当前阶段仅一个 UI 窗口；IPC 调用时解引用。
// 内部持有实现类：setContentBounds（§6 UI 接线）是类方法，不属于 §2.1 AI 契约接口
let browserController: BrowserControllerImpl | null = null;
let mainWindow: BrowserWindow | null = null;
let conversationService: ConversationService | null = null;
// S4：config:providers:* handler 需要直接引用生产 ConfigStore/凭据实例
let configStore: ConfigStore | null = null;
let credentials: SecureCredentialStore | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  logWarn('main', '检测到另一实例正在运行，本实例退出');
  app.quit();
} else {
  logInfo('main', SMOKE_MODE ? '应用启动（冒烟自检模式）' : '应用启动');

  let smokeStarted = false;

  // 冒烟模式兜底：30 秒内渲染进程未就绪视为失败。渲染进程就绪后必须清除
  // （AppRendererReady 处理内）——否则超 30 秒的冒烟场景（如真实 Provider 多网站
  // 验证）会被误杀（S6 验收时实测触发；场景自身有各自的超时与断言）。
  let smokeReadyTimer: ReturnType<typeof setTimeout> | null = null;
  if (SMOKE_MODE) {
    smokeReadyTimer = setTimeout(() => {
      logError('main', '冒烟超时：渲染进程未在 30 秒内就绪');
      app.exit(1);
    }, 30_000);
  }

  app.whenReady().then(() => {
    registerIpcHandlers();
    logDebug(
      'main',
      `日志文件目录：${app.isPackaged ? app.getPath('userData') : app.getAppPath()}/log`,
    );
    createBrowserWindow();
    app.on('activate', () => {
      // macOS 惯例：点击 Dock 图标且无窗口时重建窗口（当前目标平台为 Windows，保留兼容）
      if (BrowserWindow.getAllWindows().length === 0) createBrowserWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    // 退出路径兜底清理（幂等）；主路径为窗口 closed → dispose（§5）
    conversationService?.dispose(); // S3：中止全部在途生成
    browserController?.dispose();
    logInfo('main', '应用退出');
  });

  // 纵深防御（§3.2）：React UI 主窗口是 IPC 的唯一合法调用方；sender 为主窗口且为主帧
  function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent, win: BrowserWindow): boolean {
    return event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  }

  function registerIpcHandlers(): void {
    // invoke 通道：未授权调用一律拒绝 + warn（handler 只注册一次，调用时解引用当前窗口）
    const handle = (channel: string, fn: (payload: unknown) => unknown): void => {
      ipcMain.handle(channel, (event, payload: unknown) => {
        if (mainWindow === null || !isTrustedSender(event, mainWindow)) {
          logWarn('main', `拒绝非主窗口的 IPC 调用：${channel}`);
          throw new Error('未授权的 IPC 调用');
        }
        return fn(payload);
      });
    };

    const readTabId = (payload: unknown): string | null =>
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as TabIdPayload).tabId === 'string'
        ? (payload as TabIdPayload).tabId
        : null;

    const readSessionId = (payload: unknown): string | null => {
      const id =
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as SessionIdPayload).sessionId === 'string'
          ? (payload as SessionIdPayload).sessionId
          : null;
      return id === null || id === '' ? null : id;
    };

    const readRequestId = (payload: unknown): string | null => {
      const id =
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as RequestIdPayload).requestId === 'string'
          ? (payload as RequestIdPayload).requestId
          : null;
      return id === null || id === '' ? null : id;
    };

    // 参数无效的 ask 拒绝（§4.1/§5）：与 service 相同的 AskResult 失败形状，安全返回不抛异常
    const askFail = (): AskResult => ({
      ok: false,
      error: {
        code: 'internal',
        message: '内部错误，详情见日志',
        retryable: false,
        providerId: null,
        model: null,
        requestId: '',
      },
    });

    handle(IPC.AppGetInfo, (): AppInfo => ({
      appVersion: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      platform: `${process.platform}-${process.arch}`,
    }));

    handle(IPC.TabsList, () => browserController?.getTabs() ?? []);

    handle(IPC.TabsCreate, (payload) => {
      // §9：原始地址栏输入在 main 侧统一规范化；无法解析 → 创建空白 Tab + warn
      const input =
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as TabsCreatePayload).url === 'string'
          ? (payload as TabsCreatePayload).url
          : undefined;
      const url = input === undefined ? undefined : resolveAddressBarInput(input);
      if (input !== undefined && url === '') {
        logWarn('main', `tabs:create 输入无法解析，创建空白标签页：${input}`);
      }
      return browserController?.createTab(url === '' ? undefined : url);
    });

    handle(IPC.TabsClose, (payload) => {
      const tabId = readTabId(payload);
      if (tabId === null) return false;
      return browserController?.closeTab(tabId) ?? false;
    });

    handle(IPC.TabsActivate, (payload) => {
      const tabId = readTabId(payload);
      if (tabId === null) return false;
      return browserController?.activateTab(tabId) ?? false;
    });

    handle(IPC.NavNavigate, (payload) => {
      const p = payload as NavNavigatePayload;
      const tabId = typeof p?.tabId === 'string' ? p.tabId : null;
      const input = typeof p?.input === 'string' ? p.input : null;
      if (tabId === null || input === null) return false;
      const url = resolveAddressBarInput(input); // §9：导航输入在 main 侧统一规范化
      if (url === '') {
        logWarn('main', `nav:navigate 输入无法解析（tabId=${tabId}）：${input}`);
        return false;
      }
      return browserController?.navigate(tabId, url) ?? false;
    });

    handle(IPC.NavBack, (payload) => {
      const tabId = readTabId(payload);
      return tabId !== null ? (browserController?.goBack(tabId) ?? false) : false;
    });
    handle(IPC.NavForward, (payload) => {
      const tabId = readTabId(payload);
      return tabId !== null ? (browserController?.goForward(tabId) ?? false) : false;
    });
    handle(IPC.NavReload, (payload) => {
      const tabId = readTabId(payload);
      return tabId !== null ? (browserController?.reload(tabId) ?? false) : false;
    });

    handle(IPC.PageSnapshot, (payload) => {
      const tabId = readTabId(payload);
      return tabId !== null ? browserController?.getPageSnapshot(tabId) : null;
    });

    // —— Second Stage（§4.1，S4 落地）：conversation/config invoke 通道。
    // 全部复用 handle() 的 sender+主帧校验；逐参数验证，非法参数安全返回不抛异常。
    // service/store 方法均为 async——handler 统一返回 Promise（ipcMain.handle 自动 await）。

    handle(
      IPC.ConversationList,
      (): Promise<ConversationSession[]> =>
        conversationService?.listSessions() ?? Promise.resolve([]),
    );

    handle(IPC.ConversationCreate, (payload): Promise<ConversationSession | null> => {
      const ephemeral =
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as ConversationCreatePayload).ephemeral === 'boolean'
          ? (payload as ConversationCreatePayload).ephemeral
          : false;
      return conversationService?.createSession({ ephemeral }) ?? Promise.resolve(null);
    });

    handle(IPC.ConversationHistory, (payload): Promise<ConversationMessage[] | null> => {
      const sessionId = readSessionId(payload);
      if (sessionId === null) return Promise.resolve(null);
      return conversationService?.getHistory(sessionId) ?? Promise.resolve(null);
    });

    handle(IPC.ConversationDelete, (payload): Promise<boolean> => {
      const sessionId = readSessionId(payload);
      if (sessionId === null) return Promise.resolve(false);
      return conversationService?.deleteSession(sessionId) ?? Promise.resolve(false);
    });

    handle(IPC.ConversationSetEphemeral, (payload): Promise<boolean> => {
      const p = payload as ConversationSetEphemeralPayload;
      const sessionId = typeof p?.sessionId === 'string' && p.sessionId !== '' ? p.sessionId : null;
      const ephemeral = typeof p?.ephemeral === 'boolean' ? p.ephemeral : null;
      if (sessionId === null || ephemeral === null) return Promise.resolve(false);
      return conversationService?.setEphemeral(sessionId, ephemeral) ?? Promise.resolve(false);
    });

    handle(IPC.ConversationAsk, (payload): Promise<AskResult> => {
      const p = payload as ConversationAskPayload;
      const sessionId = typeof p?.sessionId === 'string' && p.sessionId !== '' ? p.sessionId : null;
      let question: string | null = typeof p?.question === 'string' ? p.question : null;
      if (sessionId === null || question === null || question.trim() === '') {
        // §4.1：空串/非串 → 参数无效安全返回（internal），不抛异常
        logWarn('main', 'conversation:ask 参数无效（sessionId 或 question 缺失/为空）');
        return Promise.resolve(askFail());
      }
      if (question.length > CONTEXT_BUDGET.questionMaxChars) {
        // §4.1：> 16 000 字符确定性截断（截断标记 + warn）
        question = truncateWithMark(question, CONTEXT_BUDGET.questionMaxChars);
        logWarn(
          'main',
          `conversation:ask 问题超长，已确定性截断（上限 ${CONTEXT_BUDGET.questionMaxChars} 字符）`,
        );
      }
      return conversationService?.ask({ sessionId, question }) ?? Promise.resolve(askFail());
    });

    handle(IPC.ConversationAbort, (payload): Promise<boolean> => {
      const requestId = readRequestId(payload);
      if (requestId === null) return Promise.resolve(false);
      // abort 为同步方法（§3.1），统一包成 Promise 与其余 handler 一致
      return Promise.resolve(conversationService?.abort(requestId) ?? false);
    });

    handle(
      IPC.ConversationPreview,
      (): Promise<ContextPreview | null> =>
        conversationService?.previewContext() ?? Promise.resolve(null),
    );

    handle(
      IPC.ConfigProvidersList,
      (): Promise<ProviderInfo[]> => configStore?.list() ?? Promise.resolve([]),
    );

    handle(IPC.ConfigProvidersSet, (payload): boolean => {
      // 逐参数校验（baseUrl 仅 http/https、providerId/model 非空）——复用 config-store 纯校验
      const valid = validateProviderConfig(payload);
      if (valid === null) {
        logWarn(
          'main',
          'config:providers:set 参数校验失败（baseUrl 仅 http/https、providerId/model 非空）',
        );
        return false;
      }
      return configStore?.set(valid) ?? false;
    });

    handle(IPC.ConfigProvidersSetKey, (payload): Promise<boolean> => {
      // API Key 只写不回读（§10）：无任何读回通道；apiKey='' = 删除（§4.1）
      const p = payload as ConfigProvidersSetKeyPayload;
      const providerId =
        typeof p?.providerId === 'string' && p.providerId !== '' ? p.providerId : null;
      const apiKey = typeof p?.apiKey === 'string' ? p.apiKey : null;
      if (providerId === null || apiKey === null) {
        logWarn('main', 'config:providers:set-key 参数无效（providerId/apiKey 缺失）');
        return Promise.resolve(false);
      }
      if (apiKey === '') {
        return credentials?.delete(providerId) ?? Promise.resolve(false);
      }
      return credentials?.set(providerId, apiKey) ?? Promise.resolve(false);
    });

    // send 通道（单向无回执）：未授权消息忽略 + warn
    ipcMain.on(IPC.UiContentBounds, (event, payload: unknown) => {
      if (mainWindow === null || !isTrustedSender(event, mainWindow)) {
        logWarn('main', `拒绝非主窗口的 IPC 消息：${IPC.UiContentBounds}`);
        return;
      }
      browserController?.setContentBounds(payload as ContentBounds); // 非法值在 controller 内忽略 + warn
    });
    ipcMain.on(IPC.AppRendererReady, (event) => {
      if (mainWindow === null || !isTrustedSender(event, mainWindow)) {
        logWarn('main', '拒绝非主窗口的 renderer-ready 消息');
        return;
      }
      logInfo('main', '渲染进程就绪（React 已挂载，preload bridge 链路正常）');
      if (smokeReadyTimer !== null) {
        clearTimeout(smokeReadyTimer); // 已就绪：取消 30 秒兜底，场景自身超时接管
        smokeReadyTimer = null;
      }
      if (SMOKE_MODE && !smokeStarted && browserController !== null) {
        smokeStarted = true;
        const loadUrl = process.env['AIBROWSE_SMOKE_URL'];
        const sessionMode = process.env['AIBROWSE_SESSION_SMOKE'];
        // Session 跨进程持久化冒烟（T5）：set/check 两进程共用临时 userData（§十四 Session 验收）
        const run =
          sessionMode === 'set' || sessionMode === 'check'
            ? runSessionSmokeScenario(browserController, sessionMode)
            : runSmokeScenario(browserController, {
                loadUrl: loadUrl === '' ? undefined : loadUrl,
                uiWindow: mainWindow, // T3：导航保护拦截与 bounds 上报生效验证
                aiSmokeDir: SMOKE_AI_DATA_DIR, // S4：UI 端到端矩阵断言/清理用
                liveSmoke, // S5：AIBROWSE_LIVE_PROVIDER=1 时非 undefined（真实 Provider 场景）
                liveSites: LIVE_SITES_MODE, // S6：AIBROWSE_LIVE_SITES=1 时启用多网站共读验证
              });
        run
          .then(() => {
            logInfo('main', '冒烟自检通过，正常退出');
            app.quit();
          })
          .catch(() => {
            app.exit(1); // 失败原因已由 runSessionSmokeScenario / runSmokeScenario 记录 error 日志
          });
      }
    });
  }
}

function createBrowserWindow(): void {
  const win = createMainWindow();
  mainWindow = win;
  const controller = new BrowserControllerImpl({
    ownerWindow: win,
    sessionManager: new AppSessionManager(),
    getFallbackBounds: () => {
      // chrome 高度上报（T3）前按窗口内容区兜底设 bounds（§6）
      const [width, height] = win.getContentSize();
      return { x: 0, y: 0, width, height };
    },
    onTabsStateChanged: (state) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC.TabsUpdated, state);
      }
    },
  });
  browserController = controller;
  // S4 完整装配（§3.1/§4）：AI 共读子系统接线——事件回调转发主窗口 send（事件只发
  // 主窗口，§4）。生产走真实 userData + resolveProvider（openai-compatible）；
  // 冒烟模式走进程专属临时目录（不触碰用户 userData）+ FakeProvider 注入（§13.2
  // UI 端到端矩阵经真实 IPC/bridge 链路驱动同一实例；场景 10 凭据文件同样落临时目录）。
  const aiDir = SMOKE_MODE ? SMOKE_AI_DATA_DIR : app.getPath('userData');
  credentials = new SecureCredentialStoreImpl(aiDir, new SafeStorageCipher());
  configStore = new ConfigStore(aiDir, credentials);

  // S5 真实 Provider 装配（AIBROWSE_LIVE_PROVIDER=1 + AIBROWSE_TEST_API_KEY，§6）：
  // baseUrl/model 写入进程专属临时配置（非机密，供冒烟场景对照断言）；Key 经
  // credentials.set 以密文落入临时目录，随后立即从 process.env 移除——Key 只经环境
  // 变量进入一次，此后仅存在于内存引用（零暴露扫描用），绝不出进程。
  const liveKey = LIVE_PROVIDER_MODE ? (process.env['AIBROWSE_TEST_API_KEY'] ?? '') : '';
  const liveBaseUrl = LIVE_PROVIDER_MODE ? (process.env['AIBROWSE_TEST_BASE_URL'] ?? '') : '';
  const liveModel = LIVE_PROVIDER_MODE ? (process.env['AIBROWSE_TEST_MODEL'] ?? '') : '';
  const liveActive = LIVE_PROVIDER_MODE && liveKey !== '';
  if (LIVE_PROVIDER_MODE && !liveActive) {
    logWarn('main', '真实 Provider 冒烟跳过：未提供 AIBROWSE_TEST_API_KEY（回退离线矩阵）');
  }
  if (LIVE_SITES_MODE && !liveActive) {
    logWarn('main', '多网站共读验证跳过：未提供 AIBROWSE_TEST_API_KEY（回退离线矩阵）');
  }
  if (SMOKE_MODE && !liveActive) {
    // 冒烟：注册 'fake' kind 并写入 fake 配置（决议 #20：选择依赖已注册 kind 集合，
    // 与生产 openai-compatible 同路径；注入 resolver 仅替换流式实现）
    registerProviderFactory({ kind: 'fake', create: () => new FakeProvider({}) });
    configStore.set({
      providerId: 'fake',
      baseUrl: 'https://fake.example/v1',
      model: 'fake-model',
    });
  }
  if (liveActive) {
    const valid = validateProviderConfig({
      providerId: PROVIDER_KIND_OPENAI_COMPATIBLE,
      baseUrl: liveBaseUrl,
      model: liveModel,
    });
    if (valid === null) {
      logError(
        'main',
        '真实 Provider 冒烟配置无效（baseUrl 仅 http/https、model 非空），不发起网络请求',
      );
    } else if (!configStore.set(valid)) {
      logError('main', '真实 Provider 冒烟配置写入临时目录失败，不发起网络请求');
    } else {
      // Key 密文落盘（进程专属临时目录）；场景等待 ready 后才允许提问
      const ready = credentials.set(valid.providerId, liveKey);
      liveSmoke = {
        key: liveKey,
        baseUrl: valid.baseUrl,
        model: valid.model,
        ready,
        getStreamChunkCount: () => liveStreamChunkCount,
      };
    }
  }
  if (LIVE_PROVIDER_MODE) {
    delete process.env['AIBROWSE_TEST_API_KEY'];
    delete process.env['AIBROWSE_TEST_BASE_URL'];
    delete process.env['AIBROWSE_TEST_MODEL'];
  }
  conversationService = new ConversationServiceImpl({
    browser: controller, // SnapshotSource 结构兼容：getActiveTab/getPageSnapshot
    store: new ConversationStore(aiDir),
    configStore,
    credentials,
    // 冒烟注入（决议 #17 async 签名同形）：每 ask 新 FakeProvider 实例，脚本由冒烟场景设置；
    // 真实 Provider 模式不注入——走生产 resolveProvider（已注册 openai-compatible 工厂）
    resolveProviderFn:
      SMOKE_MODE && !liveActive
        ? async () => {
            const provider = new FakeProvider(smokeUiFake.script);
            smokeUiFake.holder = provider;
            return provider;
          }
        : undefined,
    onStreamChunk: (e) => {
      if (liveActive) liveStreamChunkCount += 1; // S5：真实事件链路 delta 计数（流式证据）
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC.ConversationStreamChunk, e);
      }
    },
    onTurnDone: (e) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC.ConversationTurnDone, e);
      }
    },
  });
  void controller.createTab(); // 初始空白标签页（浏览器常驻形态）
  win.on('closed', () => {
    controller.dispose(); // 退出路径全量清理（幂等，§2.1）
    if (mainWindow === win) mainWindow = null;
    logInfo('main', '主窗口已关闭');
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'AIbrowse',
    // 安全默认值：本项目自身 React UI 同样不开启 Node 集成（安全红线，第一版起生效）
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    logInfo('main', '主窗口已显示');
  });
  win.webContents.setWindowOpenHandler(() => {
    logWarn('main', '已拦截 window.open 新窗口请求');
    return { action: 'deny' };
  });

  // UI 窗口自身导航保护（§9，安全红线，preload bridge 扩展硬前提）：
  // UI 窗口 preload 随该窗口任何导航加载——若主框架被导航到远程页面，远程页面将获得
  // window.aibrowse bridge（含 page.snapshot）。will-navigate 覆盖页面发起导航
  // （含 location.replace，Electron 43.4.0 实测触发），will-redirect 覆盖服务器重定向
  // （程序化导航遇 302 时唯一拦截点）；两处 handler 共用同一「自身来源」判定。
  const navPolicy = buildUiNavigationPolicy();
  const onUiWillNavigate = (
    details: Electron.Event<Electron.WebContentsWillNavigateEventParams>,
  ): void => {
    if (!resolveUiNavigationAllowed(details.url, navPolicy)) {
      details.preventDefault();
      logWarn('main', `已拦截 UI 窗口导航（自身来源判定失败）：${details.url}`);
    }
  };
  const onUiWillRedirect = (
    details: Electron.Event<Electron.WebContentsWillRedirectEventParams>,
  ): void => {
    if (!resolveUiNavigationAllowed(details.url, navPolicy)) {
      details.preventDefault();
      logWarn('main', `已拦截 UI 窗口重定向（自身来源判定失败）：${details.url}`);
    }
  };
  win.webContents.on('will-navigate', onUiWillNavigate);
  win.webContents.on('will-redirect', onUiWillRedirect);
  win.webContents.on('did-finish-load', () => {
    logInfo('main', '渲染进程页面加载完成');
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    win.loadURL(devUrl).catch((err: unknown) => logError('main', '开发服务器页面加载失败', err));
  } else {
    win
      .loadFile(join(__dirname, '../renderer/index.html'))
      .catch((err: unknown) => logError('main', '本地页面加载失败', err));
  }
  return win;
}

// UI 窗口导航保护的「自身来源」策略（§9）：开发模式仅放行 ELECTRON_RENDERER_URL 的
// origin（重定向目标同样过该判定）；生产仅放行 file: 入口文件 URL 精确匹配（hash/query
// 变体视为同一文档；同目录其他文件/路径穿越/大小写变体一律拒绝，失败关闭）。
function buildUiNavigationPolicy(): UiNavigationPolicy {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    return { selfOrigin: new URL(devUrl).origin, selfFileUrl: null };
  }
  return {
    selfOrigin: null,
    selfFileUrl: pathToFileURL(join(__dirname, '../renderer/index.html')).href,
  };
}

process.on('uncaughtException', (err) => {
  logError('process', '未捕获异常', err);
});
process.on('unhandledRejection', (reason) => {
  logError('process', '未处理的 Promise 拒绝', reason);
});
