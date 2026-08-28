import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { BrowserControllerImpl } from './browser/browser-controller';
import { handleUiBrowserContentVisible } from './browser/content-visible-ipc';
import { AppSessionManager } from './browser/session-manager';
import {
  getCurrentLogFilePath,
  initLogger,
  logDebug,
  logEnvironment,
  logError,
  logInfo,
  logWarn,
} from './logger';
import {
  runSessionSmokeScenario,
  runSmokeScenario,
  runSourcesSmokeScenario,
  runSourcesUiSmokeScenario,
  smokeAgentLimits,
  smokeAgentSearchProvider,
  smokeCsvExportPath,
  smokeResearchScript,
  smokeResearchServiceOverride,
  smokeUiFake,
} from './smoke';
import { removeSmokeDirWithRetry } from './smoke-cleanup';
import type { LiveProviderSmoke } from './smoke';
import { resolveResearchGate } from './smoke-research-gate';
// Sixth Stage D4：Watch 存储/生命周期装配（observer 恒 active + 延迟端口绑定 +
// AIBROWSE_WATCH_SMOKE 跨进程门控 + 8.21 store 冒烟）。
import { openWatchStore, type WatchStoreOutcome } from './watch/watch-store';
import {
  WatchLifecycleCoordinator,
  type SourceProjectionReader,
} from './watch/watch-lifecycle-coordinator';
import type { WatchRepository } from './watch/repository/watch-repository';
import { runWatchSmokeGate } from './smoke-watch-store';
import { resolveUiNavigationAllowed, type UiNavigationPolicy } from './ui-navigation-policy';
import { redactUrlForLog, resolveAddressBarInput } from '../shared/url';
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
  AgentAskPayload,
  AgentConfirmPayload,
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
  listProviderKinds,
  registerProviderFactory,
} from './ai/provider/llm-provider';
// Third Stage A2/A3：工具层装配（只读/导航 8 工具 + A3 交互 4 工具 + 确认状态机 +
// 审计 + 执行管线）。A3 的 click/fill 语义来源（getElementSemantics/recordSnapshot）
// 为 A5 AgentLoop 历史提取接线点——本阶段由冒烟场景注入快照语义存储驱动验证。
import { createAuditLogger, type AuditEntry } from './ai/audit-log';
import { ConfirmManager } from './ai/confirm-manager';
import { BingSearchProvider, type SearchProvider } from './ai/search/search-provider';
import { BROWSER_TOOL_DEFINITIONS } from './ai/tools/browser-tools';
import { INTERACTION_TOOL_DEFINITIONS } from './ai/tools/interaction-tools';
import { createSearchTool } from './ai/tools/search-tool';
import { ToolExecutor } from './ai/tools/tool-executor';
import { registerTool } from './ai/tools/tool-registry';
// Fourth Stage B4：Source 子系统装配（<userData>/sources/sources.db + migration v1）
// + Source 工具注册（13 → 17）。初始化失败 → Source 工具安全返回 source-unavailable，
// 不拖垮浏览器其余能力；退出时幂等释放句柄（B4 红线：Source Tool 只经 SourceService）。
// B7：装配改用 openSourcesStore（probe → 迁移前备份 → 逐级迁移 → 完整性/外键检查 →
// normal | readonly-recovery | unavailable——恢复态为真实生产装配能力，非 SMOKE
// override；未知高版本/损坏/截断/坏 magic/备份失败/迁移失败/迁移后检查失败均保留
// 原库与已有备份进入只读恢复态，浏览器其余能力不受影响）。
import { mkdirSync, rmSync } from 'node:fs';
import { openSourcesStore } from './sources/sources-store';
import type { SourceWatchProjectionProvider } from './sources/source-service';
import type { SourceService, SourcesState } from '../shared/types/sources';
import { createSourceTools } from './sources/tools/source-tools';
// B6：usage 接线（决议 #79/#81）——SourceSearchHintStore 每 run 独立 + browser_open
// 打开后比对写 usage；写入失败安全 no-op，不影响工具结果与 Agent 终态。
import { SourceUsageTracker } from './sources/usage/usage-tracker';
// B5：Sources IPC 适配器（参数严格白名单 + audience 硬编码 user + 状态门控 +
// 独立 manual 审计 + sources:changed 仅成功后触发）
import { createSourcesAdapter } from './sources/source-ipc';
// C5（决议 #139）：Research 子系统最小生产装配——store/service 生命周期；生产不建立
// RuntimeFactory（C6/C7 端口缺失 fail-closed）；SMOKE 注入确定性 stub 工厂；
// RESEARCH_SMOKE set/check 双进程门控；退出走安全 shutdown。
import { openResearchStore } from './research/research-store';
import { createProductionResearchRuntimeFactory } from './research/research-runtime-factory';
import { createResearchIpcAdapter } from './research/research-ipc';
import type { ResearchService } from '../shared/types/research';
import {
  SmokeSearchFixture,
  createSmokeResearchRuntimeFactory,
  makeSmokeGateScript,
  runResearchSmokeGate,
} from './smoke';

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
// A7：真实 Provider Agent 验证门控（AIBROWSE_LIVE_AGENT=1；需用户授权——询问边界，
// 沿用仓库外 DPAPI harness：AIBROWSE_LIVE_PROVIDER=1 + AIBROWSE_TEST_API_KEY 注入）
const LIVE_AGENT_MODE = LIVE_PROVIDER_MODE && process.env['AIBROWSE_LIVE_AGENT'] === '1';
// A7 补验：最小 tools 兼容性预检（AIBROWSE_LIVE_AGENT_PRE=1；需用户授权）——仅场景 1
// + 零泄漏终检 + 台账；完整场景 2–7 需用户二次授权后以 AIBROWSE_LIVE_AGENT=1 执行
const LIVE_AGENT_PRE_MODE =
  LIVE_PROVIDER_MODE && process.env['AIBROWSE_LIVE_AGENT_PRE'] === '1' && !LIVE_AGENT_MODE;
// A7 补验补证：定向补验门控（AIBROWSE_LIVE_AGENT_SUPPLEMENT=1；需用户授权）——仅修订
// 场景 2（真实长页面 read/find/scroll 工具链）+ 场景 3（真实搜索后两个不同 origin 公开
// 来源）+ 零泄漏终检 + 台账；与 LIVE_AGENT/LIVE_AGENT_PRE 互斥
const LIVE_AGENT_SUPPLEMENT_MODE =
  LIVE_PROVIDER_MODE &&
  process.env['AIBROWSE_LIVE_AGENT_SUPPLEMENT'] === '1' &&
  !LIVE_AGENT_MODE &&
  !LIVE_AGENT_PRE_MODE;
// B6：真实 Provider AI 自然语言管理验证（AIBROWSE_LIVE_AGENT_SOURCES=1；需用户授权——
// 询问边界；与 LIVE_AGENT/LIVE_AGENT_PRE/LIVE_AGENT_SUPPLEMENT 互斥，同时设置报错
// 退出）。未提供 Key 时回退离线矩阵（离线可测路由），不发起付费请求。
const LIVE_AGENT_SOURCES_MODE =
  LIVE_PROVIDER_MODE &&
  process.env['AIBROWSE_LIVE_AGENT_SOURCES'] === '1' &&
  !LIVE_AGENT_MODE &&
  !LIVE_AGENT_PRE_MODE &&
  !LIVE_AGENT_SUPPLEMENT_MODE;
// C9（决议 #169 + 恢复校准）：真实 Provider/真实主题 Research 验证门控——
// AIBROWSE_LIVE_RESEARCH=1 请求标志**独立读取**（不得因缺 SMOKE 被静默忽略）；
// 从属校验（SMOKE+LIVE_PROVIDER）与全部既有 LIVE/SESSION/SOURCES/SOURCES_UI/
// RESEARCH 门控确定性互斥由纯函数 resolveResearchGate 判定（单测覆盖；失败
// 在 whenReady 装配前明确退出，失败路径零临时目录/零 DB/零进程残留）。
// LIVE_RESEARCH 模式下 Research 子系统装配生产 RuntimeFactory（真实执行经
// 产品 Service/Runtime/C6/C7/C8 路径）。
const researchGate = resolveResearchGate({
  smoke: process.env.AIBROWSE_SMOKE,
  liveProvider: process.env['AIBROWSE_LIVE_PROVIDER'],
  liveResearch: process.env['AIBROWSE_LIVE_RESEARCH'],
  liveSites: process.env['AIBROWSE_LIVE_SITES'],
  liveAgent: process.env['AIBROWSE_LIVE_AGENT'],
  liveAgentPre: process.env['AIBROWSE_LIVE_AGENT_PRE'],
  liveAgentSupplement: process.env['AIBROWSE_LIVE_AGENT_SUPPLEMENT'],
  liveAgentSources: process.env['AIBROWSE_LIVE_AGENT_SOURCES'],
  sessionSmoke: process.env['AIBROWSE_SESSION_SMOKE'],
  sourcesSmoke: process.env['AIBROWSE_SOURCES_SMOKE'],
  sourcesUiSmoke: process.env['AIBROWSE_SOURCES_UI_SMOKE'],
  researchSmoke: process.env['AIBROWSE_RESEARCH_SMOKE'],
});
const LIVE_RESEARCH_MODE = researchGate.ok && researchGate.mode === 'live-research';
let liveSmoke: LiveProviderSmoke | undefined = undefined;
let liveStreamChunkCount = 0; // 真实 Provider 场景 delta 计数（流式证据，index.ts 装配侧统计）

// B-05 Sources UI 跨进程门控（AIBROWSE_SOURCES_UI_SMOKE=set|check）：两独立生产进程
// 共用同一已核验系统 TEMP 临时 userData——生产 SourceService 须指向 userData/sources
// （共享库），而非默认矩阵的 pid 专属临时目录。
const SOURCES_UI_GATE_MODE =
  SMOKE_MODE &&
  (process.env['AIBROWSE_SOURCES_UI_SMOKE'] === 'set' ||
    process.env['AIBROWSE_SOURCES_UI_SMOKE'] === 'check');

// C5 双进程门控（决议 #139）：AIBROWSE_RESEARCH_SMOKE=set|check——两独立生产
// 进程共用受控共享临时 userData（AIBROWSE_USER_DATA_DIR）；set 经产品 Service/
// Runtime 路径创建完成任务 + 遗留 running；check 读回 + interrupted 标记路径。
const RESEARCH_GATE_MODE =
  SMOKE_MODE &&
  (process.env['AIBROWSE_RESEARCH_SMOKE'] === 'set' ||
    process.env['AIBROWSE_RESEARCH_SMOKE'] === 'check');

// D4 跨进程门控（HLD §7/§15.3）：AIBROWSE_WATCH_SMOKE=set|check——两独立生产
// 进程共用受控共享临时 userData；set 经 Store/Coordinator 路径写入 Rule/
// Baseline/Event + 遗留非终态 Run + 未决 intent；check 读回 + interrupted
// 标记 + 启动 reconciliation 判定。D4 阶段断言限于 store 级。
const WATCH_GATE_MODE =
  SMOKE_MODE &&
  (process.env['AIBROWSE_WATCH_SMOKE'] === 'set' ||
    process.env['AIBROWSE_WATCH_SMOKE'] === 'check');

// Session 冒烟/测试隔离（§十四 Session 验收）：指定临时 userData 目录，避免触碰用户真实数据。
// 必须在 app ready 前设置（Electron 官方 API）；仅测试/验证环境使用（AIBROWSE_SESSION_SMOKE）。
const userDataOverride = process.env['AIBROWSE_USER_DATA_DIR'];
if (userDataOverride !== undefined && userDataOverride !== '') {
  app.setPath('userData', userDataOverride);
}

// 开发期日志写项目根目录 log/（AGENTS.md §3 红线）；打包后写入用户数据目录（asar 只读）
initLogger(app.isPackaged ? app.getPath('userData') : app.getAppPath());
// 真实 Provider 场景 Key 零暴露日志扫描起点（独立复验增强，2026-08-14）：在
// logEnvironment 与环境变量读取之前取定日志字节偏移，使扫描覆盖 Key 进入进程 →
// 装配 → 密文落盘 → 请求 → 流式 → 结束清理全过程（此前偏移在冒烟场景开始时才取，
// 装配期不在扫描窗口内）。文件不存在（临时 userData 首跑）时偏移为 0——首个日志
// 写入即创建文件，扫描覆盖全部字节。扫描边界：应用进程内日志文件字节区间；仓库外
// PowerShell harness（独立进程，DPAPI 解密/注入/ZeroFreeBSTR 清零）不在本扫描
// 范围内，其环境变量清理由 harness 自身 finally 强制。
const startupLogFile = getCurrentLogFilePath();
const startupLogScan = {
  file: startupLogFile,
  offsetBefore: existsSync(startupLogFile) ? statSync(startupLogFile).size : 0,
};
logEnvironment();

// 单窗口假设（detailed-design 决议 #14）：当前阶段仅一个 UI 窗口；IPC 调用时解引用。
// 内部持有实现类：setContentBounds（§6 UI 接线）是类方法，不属于 §2.1 AI 契约接口
let browserController: BrowserControllerImpl | null = null;
let mainWindow: BrowserWindow | null = null;
let conversationService: ConversationService | null = null;
// S4：config:providers:* handler 需要直接引用生产 ConfigStore/凭据实例
let configStore: ConfigStore | null = null;
let credentials: SecureCredentialStore | null = null;
// Third Stage A2/A3：工具执行管线（A5 AgentLoop 接线复用；本任务由冒烟工具层探针驱动验证）。
// confirmManager 暴露给冒烟场景程序化驱动 L2 approve/deny（A6 起接 UI）。
let toolExecutor: ToolExecutor | null = null;
let confirmManager: ConfirmManager | null = null;
// Fourth Stage B4：SourceService 唯一实例（UI/B5 与 Source 工具共享；冒烟模式使用
// 系统 TEMP 下 pid 专属目录——不触碰真实 userData 的 Sources 库）
let sourceService: SourceService | null = null;
let smokeSourcesDir: string | null = null;
let researchService: ResearchService | null = null;
let smokeResearchDir: string | null = null;
let researchShutdownDone = false;
// D4：Watch 生命周期协调器（构造先于 Sources 装配——observer 恒注入 active
// coordinator，无论 watch.db 是否存在；缺失库由 Store 正常创建，corrupt/
// future/unavailable 必须返回失败，绝不因文件缺失静默退化为 no-op）
let watchCoordinator: WatchLifecycleCoordinator | null = null;
let watchRepo: WatchRepository | null = null;
let smokeWatchDir: string | null = null;
// B5 冒烟注入点（仅 SMOKE_MODE 消费，生产行为不变）：恢复态/不可用态 UI 断言——
// sources:state 与全部读写入口经适配器 stateOverride 门控（决议 #74 测试落点）
let smokeSourcesStateOverride: { current: SourcesState | null } | null = null;
// B6/B8 补验（2026-08-15）：SMOKE_MODE 审计收集探针——真实 SRT-02 观察场景
// 「审计工具名全部为注册表工具」机器断言用；生产不收集（决议 #84 同精神测试设施）
const smokeAuditCollector: AuditEntry[] = [];

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
    // C9（决议 #169 + 恢复校准）：LIVE_RESEARCH 门控失败 → 在装配前明确退出
    // （请求标志独立读取——缺 SMOKE/LIVE_PROVIDER/非法值/与既有门控冲突一律
    // 明确失败，不静默选路；此时尚无临时目录/DB/子进程，失败路径零残留）
    if (!researchGate.ok) {
      logError('main', researchGate.reason);
      app.exit(1);
      return;
    }
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
  app.on('before-quit', (event) => {
    // C5（决议 #139(5)）：Research 走安全 shutdown（abort → await settle →
    // closeDb；幂等）。shutdown 完成前阻止退出（Windows 下 db 句柄未关时
    // 删除目录会 EPERM——先关库再删临时目录，再放行退出）
    if (!researchShutdownDone) {
      event.preventDefault();
      void (researchService?.shutdown() ?? Promise.resolve()).finally(() => {
        researchShutdownDone = true;
        // 冒烟临时 Research 目录：closeDb 后 Windows 句柄释放有微小窗口——
        // 有限重试（EPERM 不阻塞退出；最终失败保留所有权由下次冒烟自清）
        if (smokeResearchDir !== null) {
          let removed = false;
          for (let attempt = 0; attempt < 3 && !removed; attempt++) {
            try {
              rmSync(smokeResearchDir, { recursive: true, force: true });
              removed = true;
            } catch {
              // 重试间隔由退出路径自然等待（同步循环 10ms 让步）
              const waitUntil = Date.now() + 10;
              while (Date.now() < waitUntil) {
                // 忙等待让步（退出路径无计时器依赖）
              }
            }
          }
          if (removed) {
            smokeResearchDir = null;
          } else {
            logWarn('main', '冒烟临时 Research 目录清理失败（将保留，请勿手动删除用户数据）');
          }
        }
        app.quit(); // 再次触发 before-quit（researchShutdownDone=true → 放行）
      });
    }
    // 退出路径兜底清理（幂等）；主路径为窗口 closed → dispose（§5）
    conversationService?.dispose(); // S3：中止全部在途生成
    sourceService?.dispose(); // B4：Sources 句柄幂等释放（driver closeDb 幂等）
    // D4：Watch dispose 幂等接线（coordinator 解绑 → repo 句柄释放）
    watchCoordinator?.dispose();
    watchRepo?.dispose();
    if (smokeSourcesDir !== null) {
      rmSync(smokeSourcesDir, { recursive: true, force: true }); // 冒烟临时 Sources 目录
      smokeSourcesDir = null;
    }
    if (smokeWatchDir !== null) {
      rmSync(smokeWatchDir, { recursive: true, force: true }); // 冒烟临时 Watch 目录
      smokeWatchDir = null;
    }
    if (SMOKE_MODE) {
      // 冒烟 AI 数据目录兜底清理（默认矩阵由 aiSmoke.cleanup 主路径清理；
      // SESSION/SOURCES/SOURCES_UI 门控跳过矩阵——此前残留 pid 专属目录）
      rmSync(SMOKE_AI_DATA_DIR, { recursive: true, force: true });
    }
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

    // —— Third Stage A6（§11.1）：Agent 任务与确认 invoke 通道（sender+主帧校验复用 handle()）——
    // 逐字段验证安全返回不抛异常；goal 校验/截断与共读 ask 同款纪律（§8.5/§11.1）。

    handle(IPC.AgentAsk, (payload): Promise<AskResult> => {
      const p = payload as AgentAskPayload;
      const sessionId = typeof p?.sessionId === 'string' && p.sessionId !== '' ? p.sessionId : null;
      let goal: string | null = typeof p?.goal === 'string' ? p.goal : null;
      if (sessionId === null || goal === null || goal.trim() === '') {
        // 空串/非串 → 参数无效安全返回（internal），不抛异常
        logWarn('main', 'conversation:agent-ask 参数无效（sessionId 或 goal 缺失/为空）');
        return Promise.resolve(askFail());
      }
      if (goal.length > CONTEXT_BUDGET.questionMaxChars) {
        // > 16 000 字符确定性截断（截断标记 + warn；service 内为纵深防御）
        goal = truncateWithMark(goal, CONTEXT_BUDGET.questionMaxChars);
        logWarn(
          'main',
          `conversation:agent-ask 任务目标超长，已确定性截断（上限 ${CONTEXT_BUDGET.questionMaxChars} 字符）`,
        );
      }
      return conversationService?.agentAsk({ sessionId, goal }) ?? Promise.resolve(askFail());
    });

    handle(IPC.AgentConfirm, (payload): Promise<boolean> => {
      const p = payload as AgentConfirmPayload;
      const toolCallId =
        typeof p?.toolCallId === 'string' && p.toolCallId !== '' ? p.toolCallId : null;
      const approve = typeof p?.approve === 'boolean' ? p.approve : null;
      if (toolCallId === null || approve === null) {
        logWarn('main', 'conversation:agent-confirm 参数无效（toolCallId/approve 缺失）');
        return Promise.resolve(false);
      }
      // 未知/迟到/已终结 id → ConfirmManager 幂等返回 false（不抛异常）
      return conversationService?.confirmTool(toolCallId, approve) ?? Promise.resolve(false);
    });

    // —— Fourth Stage B5（决议 #69/#70/#72/#73/#74/#76）：Sources 面板通道 ——
    // 全部复用 handle() 的 sender+主帧校验；业务校验/audience 硬编码/状态门控/审计/
    // changed 事件在 source-ipc 适配器内（零 Electron import，可单测）。
    // onChanged 只发主窗口（事件只发主窗口纪律）；审计经 logInfo('audit', …) 脱敏链。
    // service 与 stateOverride 均为 getter 调用时解引用：handler 注册早于
    // createBrowserWindow 内的 SourceService 装配与冒烟注入点装配（B-05 dev 冒烟
    // 实测抓出两处构造期捕获 null 的同类缺陷，均已单测固化）。
    const sourcesAdapter = createSourcesAdapter({
      service: () => sourceService,
      audit: (message) => logInfo('audit', message),
      onChanged: () => {
        if (
          mainWindow !== null &&
          !mainWindow.isDestroyed() &&
          !mainWindow.webContents.isDestroyed()
        ) {
          mainWindow.webContents.send(IPC.SourcesChanged, { reason: 'sources-changed' });
        }
      },
      stateOverride: SMOKE_MODE
        ? () => {
            const holder = smokeSourcesStateOverride; // 调用时解引用（装配时序）
            return holder === null ? null : holder.current;
          }
        : undefined,
    });

    handle(IPC.SourcesList, (payload) => sourcesAdapter.list(payload));
    handle(IPC.SourcesGet, (payload) => sourcesAdapter.get(payload));
    handle(IPC.SourcesSearch, (payload) => sourcesAdapter.search(payload));
    handle(IPC.SourcesGroups, (payload) => sourcesAdapter.groups(payload));
    handle(IPC.SourcesAdd, (payload) => sourcesAdapter.add(payload));
    handle(IPC.SourcesUpdate, (payload) => sourcesAdapter.update(payload));
    handle(IPC.SourcesDisable, (payload) => sourcesAdapter.disable(payload));
    handle(IPC.SourcesRestore, (payload) => sourcesAdapter.restore(payload));
    handle(IPC.SourcesUndoable, () => sourcesAdapter.undoable());
    handle(IPC.SourcesUndo, (payload) => sourcesAdapter.undo(payload));
    // 决议 #72：quick-add 不接收 renderer 提供的 URL/标题——main 在点击时读取当前
    // 活动 Tab（仅 http/https，其余由服务层 unsupported-url 结构化拒绝）。
    handle(IPC.SourcesQuickAdd, async () =>
      sourcesAdapter.quickAdd((await browserController?.getActiveTab()) ?? null),
    );
    handle(IPC.SourcesState, () => sourcesAdapter.state());
    handle(IPC.SourcesPrepareHardDelete, (payload) => sourcesAdapter.prepareHardDelete(payload));
    handle(IPC.SourcesHardDelete, (payload) => sourcesAdapter.hardDelete(payload));
    // B7 决议 #91：FTS 诊断性 rebuild——无 payload（零 SQL/路径参数通道）；
    // 状态门控在适配器内（仅 normal 放行）
    handle(IPC.SourcesRebuildIndex, () => sourcesAdapter.rebuildIndex());

    // —— Fifth Stage C8（决议 #156/#157/#162）：Research 八通道 ——
    // 全部复用 handle() 的 sender+主帧校验；payload 严格白名单 fail-closed/
    // 状态门控/审计/export 窄端口在 research-ipc 适配器内（零 Electron import，
    // 可单测）；exportPort 生产装配 = Electron dialog.showSaveDialog + fs 写入
    // （仅主进程；renderer 零路径参数）。audit 经 logInfo('audit', …) 脱敏链。
    const researchIpcAdapter = createResearchIpcAdapter({
      // C8（8.19-B）：SMOKE 专属 override——场景自建受控 service 经真实
      // IPC/preload/bridge 链路驱动 UI；生产/其余冒烟路径 = researchService
      service: () => smokeResearchServiceOverride.current ?? researchService,
      audit: (message) => logInfo('audit', message),
      exportPort: {
        // 决议 #162(2)：生产装配才包装 Electron dialog 和文件写入（仅主进程；
        // renderer 零路径参数）；defaultFileName 由 adapter 传入（安全固定前缀
        // + taskId 短段——不使用 goal/Result title）
        showSaveDialog: async (defaultFileName) => {
          // C8（8.19-B）：SMOKE_MODE 注入 dialog 桩——写系统 TEMP 受控文件
          // （场景读取做字节断言后精确清理；不弹真实对话框）
          if (SMOKE_MODE && smokeCsvExportPath.current !== null) {
            return smokeCsvExportPath.current;
          }
          if (mainWindow === null || mainWindow.isDestroyed()) return null;
          const result = await dialog.showSaveDialog(mainWindow, {
            title: '导出研究表格',
            defaultPath: defaultFileName ?? 'research-export.csv',
            filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
            properties: ['createDirectory'],
          });
          return result.canceled ? null : (result.filePath ?? null);
        },
        writeCsv: async (path, bytes) => {
          await writeFile(path, bytes);
        },
      },
    });
    handle(IPC.ResearchCreate, (payload) => researchIpcAdapter.create(payload));
    handle(IPC.ResearchStart, (payload) => researchIpcAdapter.start(payload));
    handle(IPC.ResearchStop, (payload) => researchIpcAdapter.stop(payload));
    handle(IPC.ResearchGet, (payload) => researchIpcAdapter.get(payload));
    handle(IPC.ResearchResult, (payload) => researchIpcAdapter.result(payload));
    handle(IPC.ResearchList, (payload) => researchIpcAdapter.list(payload));
    handle(IPC.ResearchDelete, (payload) => researchIpcAdapter.delete(payload));
    handle(IPC.ResearchExportCsv, (payload) => researchIpcAdapter.exportCsv(payload));
    // research:progress / research:task-done 事件出口（决议 #157：Service 转发 +
    // 终态时序；只发主窗口；事件零敏感内容——payload 形状已由 Service 保证）。
    // ⚠️ 注册必须位于 Research 装配之后（见 forwardResearchEvents——装配前
    // researchService 为 null，`?.` 会静默 no-op——C9 真实运行发现并修复）。

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
    // C8 决议 #158(4)：受控 UI send 通道——payload 白名单只允许 {visible:boolean}；
    // 其余形态拒绝 + warn（fail-closed）；仅供受信 UI 切换 WebContentsView 可见性。
    // 校验边界为纯逻辑（content-visible-ipc.ts——零 Electron import 单测全矩阵）；
    // 此处只做事件解包与依赖委托（isTrustedSender/browserController），语义恒等
    ipcMain.on(IPC.UiBrowserContentVisible, (event, payload: unknown) => {
      handleUiBrowserContentVisible(payload, {
        isTrusted: mainWindow !== null && isTrustedSender(event, mainWindow),
        warn: (message) => logWarn('main', message),
        setContentVisible: (visible) => browserController?.setContentVisible(visible),
      });
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
        const sourcesMode = process.env['AIBROWSE_SOURCES_SMOKE'];
        const sourcesUiMode = process.env['AIBROWSE_SOURCES_UI_SMOKE'];
        const watchMode = process.env['AIBROWSE_WATCH_SMOKE'];
        // Session 跨进程持久化冒烟（T5）：set/check 两进程共用临时 userData（§十四 Session 验收）
        // B-02 Sources 跨进程冒烟（B2，决议 #57）与 B-05 Sources UI 跨进程冒烟（B5 专属
        // 门控）与 D4 WATCH 门控：四者互斥（同时设置报错退出）
        const exclusiveModes = [sessionMode, sourcesMode, sourcesUiMode, watchMode].filter(
          (m) => m !== undefined,
        );
        if (exclusiveModes.length > 1) {
          logError(
            'main',
            'AIBROWSE_SESSION_SMOKE / AIBROWSE_SOURCES_SMOKE / AIBROWSE_SOURCES_UI_SMOKE / AIBROWSE_WATCH_SMOKE 互斥，请只选其一',
          );
          // 失败路径清理（app.exit 不触发 before-quit；B6 会话实测同类 LIVE 互斥
          // 路径残留 pid 专属目录——此处为同缺陷预防性补齐）
          sourceService?.dispose();
          if (smokeSourcesDir !== null) {
            rmSync(smokeSourcesDir, { recursive: true, force: true });
            smokeSourcesDir = null;
          }
          rmSync(SMOKE_AI_DATA_DIR, { recursive: true, force: true });
          app.exit(1);
          return;
        }
        // B6：AIBROWSE_LIVE_AGENT_SOURCES 与 LIVE_AGENT/PRE/SUPPLEMENT 互斥（决议 #85；
        // 与既有 LIVE 门控同纪律——同时设置报错退出，不静默择一）
        if (
          process.env['AIBROWSE_LIVE_AGENT_SOURCES'] === '1' &&
          (LIVE_AGENT_MODE || LIVE_AGENT_PRE_MODE || LIVE_AGENT_SUPPLEMENT_MODE)
        ) {
          logError(
            'main',
            'AIBROWSE_LIVE_AGENT_SOURCES 与 AIBROWSE_LIVE_AGENT / LIVE_AGENT_PRE / LIVE_AGENT_SUPPLEMENT 互斥，请只选其一',
          );
          // 失败路径清理（app.exit 不触发 before-quit；同 B5 532ea78 修复的
          // SESSION/SOURCES 互斥路径——否则每次失败运行残留 pid 专属冒烟目录）
          sourceService?.dispose();
          if (smokeSourcesDir !== null) {
            rmSync(smokeSourcesDir, { recursive: true, force: true });
            smokeSourcesDir = null;
          }
          rmSync(SMOKE_AI_DATA_DIR, { recursive: true, force: true });
          app.exit(1);
          return;
        }
        // B6/B8 补验（2026-08-15）：AIBROWSE_LIVE_AGENT_SOURCES 与 LIVE_SITES 互斥
        // （决议 #85 仅声明与 LIVE_AGENT/PRE/SUPPLEMENT 互斥；smoke.ts 分支顺序使
        // 同设时静默择一——确定性互斥原则补齐，不静默择一）
        if (LIVE_AGENT_SOURCES_MODE && LIVE_SITES_MODE) {
          logError('main', 'AIBROWSE_LIVE_AGENT_SOURCES 与 AIBROWSE_LIVE_SITES 互斥，请只选其一');
          // 失败路径清理（app.exit 不触发 before-quit；同现有互斥路径纪律）
          sourceService?.dispose();
          if (smokeSourcesDir !== null) {
            rmSync(smokeSourcesDir, { recursive: true, force: true });
            smokeSourcesDir = null;
          }
          rmSync(SMOKE_AI_DATA_DIR, { recursive: true, force: true });
          app.exit(1);
          return;
        }
        // C5（决议 #139）：AIBROWSE_RESEARCH_SMOKE 与 SESSION/SOURCES/SOURCES_UI
        // 门控确定性互斥（互斥先于一切，不静默择一）
        const researchMode = process.env['AIBROWSE_RESEARCH_SMOKE'];
        if (
          RESEARCH_GATE_MODE &&
          (sessionMode !== undefined || sourcesMode !== undefined || sourcesUiMode !== undefined)
        ) {
          logError(
            'main',
            'AIBROWSE_RESEARCH_SMOKE 与 AIBROWSE_SESSION_SMOKE / AIBROWSE_SOURCES_SMOKE / AIBROWSE_SOURCES_UI_SMOKE 互斥，请只选其一',
          );
          // C8 定向修复（2026-08-17）：本互斥分支缺冒烟临时目录清理（与
          // SESSION/SOURCES 互斥分支 532ea78 同款缺陷）——失败路径残留
          // aibrowse-smoke-ai-<pid>/aibrowse-smoke-sources-<pid> 目录
          sourceService?.dispose();
          if (smokeSourcesDir !== null) {
            rmSync(smokeSourcesDir, { recursive: true, force: true });
            smokeSourcesDir = null;
          }
          rmSync(SMOKE_AI_DATA_DIR, { recursive: true, force: true });
          if (smokeResearchDir !== null) {
            try {
              rmSync(smokeResearchDir, { recursive: true, force: true });
            } catch {
              // research db 句柄可能未关（EPERM）——不阻塞退出
            }
            smokeResearchDir = null;
          }
          app.exit(1);
          return;
        }
        if (researchMode !== undefined && !RESEARCH_GATE_MODE) {
          logError('main', `AIBROWSE_RESEARCH_SMOKE 值非法：${researchMode}（仅支持 set|check）`);
          app.exit(1);
          return;
        }
        // D4：AIBROWSE_WATCH_SMOKE 与其余四组门控确定性互斥（互斥先于一切，
        // 不静默择一——与 RESEARCH 门控同纪律）
        if (
          WATCH_GATE_MODE &&
          (sessionMode !== undefined ||
            sourcesMode !== undefined ||
            sourcesUiMode !== undefined ||
            researchMode !== undefined)
        ) {
          logError(
            'main',
            'AIBROWSE_WATCH_SMOKE 与 AIBROWSE_SESSION_SMOKE / AIBROWSE_SOURCES_SMOKE / AIBROWSE_SOURCES_UI_SMOKE / AIBROWSE_RESEARCH_SMOKE 互斥，请只选其一',
          );
          // 失败路径清理（app.exit 不触发 before-quit；与既有互斥路径同纪律）
          sourceService?.dispose();
          watchCoordinator?.dispose();
          watchRepo?.dispose();
          if (smokeSourcesDir !== null) {
            rmSync(smokeSourcesDir, { recursive: true, force: true });
            smokeSourcesDir = null;
          }
          if (smokeWatchDir !== null) {
            rmSync(smokeWatchDir, { recursive: true, force: true });
            smokeWatchDir = null;
          }
          rmSync(SMOKE_AI_DATA_DIR, { recursive: true, force: true });
          if (smokeResearchDir !== null) {
            try {
              rmSync(smokeResearchDir, { recursive: true, force: true });
            } catch {
              // research db 句柄可能未关（EPERM）——不阻塞退出
            }
            smokeResearchDir = null;
          }
          app.exit(1);
          return;
        }
        if (watchMode !== undefined && !WATCH_GATE_MODE) {
          logError('main', `AIBROWSE_WATCH_SMOKE 值非法：${watchMode}（仅支持 set|check）`);
          app.exit(1);
          return;
        }
        let run: Promise<void>;
        if (RESEARCH_GATE_MODE) {
          run = runResearchSmokeGate(researchMode as 'set' | 'check');
        } else if (WATCH_GATE_MODE) {
          run = runWatchSmokeGate(watchMode as 'set' | 'check');
        } else if (sourcesUiMode === 'set' || sourcesUiMode === 'check') {
          run = runSourcesUiSmokeScenario(sourcesUiMode, {
            uiWindow: mainWindow,
            sourcesService: sourceService ?? undefined,
          });
        } else if (sourcesUiMode !== undefined) {
          logError(
            'main',
            `AIBROWSE_SOURCES_UI_SMOKE 值非法：${sourcesUiMode}（仅支持 set|check）`,
          );
          app.exit(1);
          return;
        } else if (sourcesMode === 'set' || sourcesMode === 'check') {
          run = runSourcesSmokeScenario(sourcesMode);
        } else if (sourcesMode !== undefined) {
          logError('main', `AIBROWSE_SOURCES_SMOKE 值非法：${sourcesMode}（仅支持 set|check）`);
          app.exit(1);
          return;
        } else if (sessionMode === 'set' || sessionMode === 'check') {
          run = runSessionSmokeScenario(browserController, sessionMode);
        } else {
          run = runSmokeScenario(browserController, {
            loadUrl: loadUrl === '' ? undefined : loadUrl,
            uiWindow: mainWindow, // T3：导航保护拦截与 bounds 上报生效验证
            aiSmokeDir: SMOKE_AI_DATA_DIR, // S4：UI 端到端矩阵断言/清理用
            liveSmoke, // S5：AIBROWSE_LIVE_PROVIDER=1 时非 undefined（真实 Provider 场景）
            liveSites: LIVE_SITES_MODE, // S6：AIBROWSE_LIVE_SITES=1 时启用多网站共读验证
            liveAgent: LIVE_AGENT_MODE, // A7：AIBROWSE_LIVE_AGENT=1 时启用真实 Provider Agent 验证
            liveAgentPre: LIVE_AGENT_PRE_MODE, // A7 补验：AIBROWSE_LIVE_AGENT_PRE=1 时启用最小 tools 兼容性预检
            liveAgentSupplement: LIVE_AGENT_SUPPLEMENT_MODE, // A7 补验补证：AIBROWSE_LIVE_AGENT_SUPPLEMENT=1 时启用定向补验（仅修订场景 2/3 + 零泄漏终检）
            liveAgentSources: LIVE_AGENT_SOURCES_MODE, // B6：AIBROWSE_LIVE_AGENT_SOURCES=1 时启用真实 Provider 自然语言管理验证（未提供 Key 回退离线矩阵）
            liveResearch: LIVE_RESEARCH_MODE, // C9：AIBROWSE_LIVE_RESEARCH=1 时启用真实 Provider/真实主题 Research 验证（决议 #169）
            researchService: LIVE_RESEARCH_MODE ? researchService : undefined, // C9：LIVE_RESEARCH 生产 factory 装配的 Service（真实执行经产品路径）
            toolExecutor: toolExecutor ?? undefined, // A2/A3：工具层探针（注册表/校验/权限/执行/审计全链路）
            confirmManager: confirmManager ?? undefined, // A3：L2 确认程序化驱动（approve/deny）
            sourcesService: sourceService ?? undefined, // B5：8.11 UI 矩阵后台写/冲突/清理断言
            sourcesStateOverride: smokeSourcesStateOverride, // B5：恢复态/不可用态注入点
            sourcesDbPath:
              smokeSourcesDir !== null && sourceService !== null
                ? join(smokeSourcesDir, 'sources.db')
                : undefined, // B6：8.13 UI 场景 usage_events 只读探针（决议 #84；仅 SMOKE_MODE 注入）
            auditEntries: SMOKE_MODE ? smokeAuditCollector : undefined, // B6/B8 补验：真实 SRT-02 观察场景审计探针
          });
        }
        run
          .then(() => {
            logInfo('main', '冒烟自检通过，正常退出');
            if (RESEARCH_GATE_MODE && researchMode === 'set') {
              // 决议 #139：set 门控经 app.exit 直接退出（不触发 before-quit 的
              // shutdown）——遗留 running 任务保持原状，由 check 进程验证
              // interrupted 自动标记。app.exit 不触发 before-quit：冒烟临时
              // 目录与进程资源在此精确清理（保留共享 userData 的 research.db；
              // EPERM 容忍——db 句柄随进程退出由 OS 释放）
              sourceService?.dispose();
              try {
                rmSync(SMOKE_AI_DATA_DIR, { recursive: true, force: true });
              } catch {
                // 不阻塞退出（EPERM 容忍）
              }
              if (smokeSourcesDir !== null) {
                try {
                  rmSync(smokeSourcesDir, { recursive: true, force: true });
                  smokeSourcesDir = null;
                } catch {
                  smokeSourcesDir = null;
                }
              }
              if (smokeResearchDir !== null) {
                try {
                  rmSync(smokeResearchDir, { recursive: true, force: true });
                  smokeResearchDir = null;
                } catch {
                  smokeResearchDir = null;
                }
              }
              app.exit(0);
              return;
            }
            app.quit();
          })
          .catch(async (err: unknown) => {
            logError('main', '冒烟场景失败（调度层）', err);
            // 失败路径同样清理冒烟 Sources 临时目录（app.exit 不触发 before-quit，
            // 否则每次失败运行残留 pid 专属目录——清理纪律）
            sourceService?.dispose();
            if (smokeSourcesDir !== null) {
              rmSync(smokeSourcesDir, { recursive: true, force: true });
              smokeSourcesDir = null;
            }
            if (smokeResearchDir !== null) {
              // C8 定向修复（2026-08-17，与 factory-smoke 残留同根因）：失败路径
              // 单次 rmSync 遇 db 句柄未关（Windows EPERM）静默放弃 → 每次失败
              // 运行残留 `aibrowse-smoke-research-<pid>` 目录。修复：先
              // researchService.shutdown()（幂等——关闭 store 句柄）再
              // removeSmokeDirWithRetry（有限重试吸收句柄延迟释放窗口）
              try {
                await researchService?.shutdown();
              } catch {
                // 忽略（关闭失败不阻塞退出）
              }
              try {
                await removeSmokeDirWithRetry(smokeResearchDir);
                smokeResearchDir = null;
              } catch {
                smokeResearchDir = null; // 最终保留不阻塞退出（极少数持久占用）
              }
            }
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
  // Third Stage A2/A3/A4：工具层装配——注册表 8 个只读/导航 + 4 个交互 + search_web
  // （工具实现只经 BrowserController/SearchProvider 接口执行，不 import Electron）+
  // 确认状态机 + 审计薄封装 + ToolExecutor 管线。A5 AgentLoop 接线复用本实例；本任务
  // 由冒烟工具层探针驱动验证全链路（校验→权限→确认→执行→审计）。
  // A4：SearchProvider 生产装配（Bing 搜索页实现，临时 Tab 精确所有权 + finally 清理）；
  // 冒烟受控夹具经 ctx.searchProvider 注入（同一 executor、同一管线，仅 URL 基准指向
  // 本地受控页——离线确定性）。A3 的 click/fill 语义来源接线为 A5 历史提取——
  // 本阶段冒烟注入快照语义存储驱动。
  // B4：Source 子系统装配——生产用 <userData>/sources/sources.db + 既有 migration v1；
  // 冒烟模式用系统 TEMP 下 pid 专属目录（不触碰真实 userData，退出时整体清理）。
  // B5 双进程门控（AIBROWSE_SOURCES_UI_SMOKE）例外：两进程共用同一已核验系统 TEMP
  // 临时 userData（isPathInside 断言），生产 SourceService 指向 userData/sources——
  // 共享库才是跨进程读回/Undo/永久删除的验证对象（B-05 dev 冒烟实测抓出 pid 目录
  // 绕开共享状态的缺陷）。
  // B7：openSourcesStore 装配——恢复态 service 也装配（db=null 门控拒绝全部读写），
  // 适配器三态（normal/readonly-recovery/unavailable）经 getState/惰性解引用正确
  // 呈现；初始化失败 → sourceService 保持 null，Source 工具安全返回 source-unavailable
  // （不拖垮浏览器其余能力；中文诊断入日志）。
  // D4（§10.3）：coordinator 先于 Sources 装配构造并作为内部 observer 恒注入
  //（无论 watch.db 是否存在——缺失库由 Store 正常创建；corrupt/future/unavailable
  // 由 coordinator 的 unavailable 状态 fail-closed，绝不静默退化 no-op）。
  watchCoordinator = new WatchLifecycleCoordinator({});
  try {
    const sourcesDir =
      SMOKE_MODE && !SOURCES_UI_GATE_MODE
        ? join(app.getPath('temp'), `aibrowse-smoke-sources-${process.pid}`)
        : join(app.getPath('userData'), 'sources');
    if (SMOKE_MODE && !SOURCES_UI_GATE_MODE) smokeSourcesDir = sourcesDir;
    if (SMOKE_MODE) smokeSourcesStateOverride = { current: null }; // B5：冒烟注入点装配
    mkdirSync(sourcesDir, { recursive: true });
    const outcome = openSourcesStore({
      dbPath: join(sourcesDir, 'sources.db'),
      backupsDir: join(sourcesDir, 'backups'),
      observer: watchCoordinator, // D4：恒注入 active coordinator
    });
    if (outcome.mode === 'normal') {
      sourceService = outcome.service;
      logInfo('main', `Sources 子系统就绪（${join(sourcesDir, 'sources.db')}）`);
    } else if (outcome.mode === 'readonly-recovery') {
      // 只读恢复态：service 已装配（读写全拒），浏览器其余能力继续可用
      sourceService = outcome.service;
    } else {
      sourceService = null;
    }
  } catch (err) {
    sourceService = null;
    logError('main', 'Sources 子系统初始化失败（Source 工具将返回 source-unavailable）', err);
  }
  // B6（决议 #79/#81）：usage tracker 装配——writer 闭包调用时解引用 sourceService
  // （初始化失败为 null → 零写入，无 SourceService 不记录）；bridge 每 run 创建
  // （AgentLoop 终态调用 clearRun）。
  const usageTracker = new SourceUsageTracker(
    (sourceId, outcome) => sourceService?.recordUsage(sourceId, outcome) ?? Promise.resolve(),
  );
  for (const def of BROWSER_TOOL_DEFINITIONS) registerTool(def);
  for (const def of INTERACTION_TOOL_DEFINITIONS) registerTool(def);
  // B4：Source 四工具注册（13 → 17；executor 零 Electron import，只经 ctx.sourceService）
  for (const def of createSourceTools(sourceService)) registerTool(def);
  // A5：SearchProvider 实例化后同时用于工具注册与 Agent 运行时装配（决议 #32⑥ 注入点）
  const searchProvider = new BingSearchProvider({ browser: controller });
  registerTool(createSearchTool(searchProvider));
  // A6 UI 矩阵（仅冒烟模式）：委托 Provider——每次 search() 调用时读取受控夹具 holder
  // （离线确定性；生产模式直用 Bing 实现，行为不变）
  const agentSearchProvider: SearchProvider = {
    id: searchProvider.id,
    search: (query, signal) =>
      smokeAgentSearchProvider.current?.search(query, signal) ??
      searchProvider.search(query, signal),
  };
  confirmManager = new ConfirmManager();
  // B6/B8 补验：审计落盘（logInfo）与 SMOKE_MODE 收集探针共用同一出口——
  // 生产行为不变（仅 logInfo）；真实观察场景经 SmokeOptions.auditEntries 断言
  const auditSink = createAuditLogger();
  const auditWithProbe = (entry: AuditEntry): void => {
    auditSink(entry);
    if (SMOKE_MODE) smokeAuditCollector.push(entry);
  };
  toolExecutor = new ToolExecutor(confirmManager, auditWithProbe);
  // S4 完整装配（§3.1/§4）：AI 共读子系统接线——事件回调转发主窗口 send（事件只发
  // 主窗口，§4）。生产走真实 userData + resolveProvider（openai-compatible）；
  // 冒烟模式走进程专属临时目录（不触碰用户 userData）+ FakeProvider 注入（§13.2
  // UI 端到端矩阵经真实 IPC/bridge 链路驱动同一实例；场景 10 凭据文件同样落临时目录）。
  const aiDir = SMOKE_MODE ? SMOKE_AI_DATA_DIR : app.getPath('userData');
  credentials = new SecureCredentialStoreImpl(aiDir, new SafeStorageCipher());
  configStore = new ConfigStore(aiDir, credentials);

  // C7（决议 #155）：Research 子系统生产装配——<userData>/research/research.db
  // （store 两态：normal|unavailable；Research 不可用不得破坏 Browser/Sources/Agent）。
  // 装配顺序调整（决议 #155(5)）：本块位于 Sources + SearchProvider +
  // ConfigStore + CredentialStore 装配之后——生产 RuntimeFactory 接入真实
  // SearchProvider/SourceService/BrowserController/Provider config+credential
  // 解析与真实 C6+C7 端口（research-runtime-factory，决议 #140 解除——生产
  // startTask 不再固定 research-runtime-unavailable）；SMOKE 注入确定性 stub
  // 工厂（决议 #139(3)，仅测试设施）。状态查询不谎报（决议 #155(4)）：
  // getSourcesState 同步查询 Sources normal；getProviderState 同步仅报能同步
  // 证明的粗粒度状态（Provider kind 工厂已注册）——真正 Key/Provider/tool
  // capability 由异步 resolve 权威判定。退出走安全 shutdown（before-quit）。
  try {
    const researchDir =
      SMOKE_MODE && !RESEARCH_GATE_MODE
        ? join(app.getPath('temp'), `aibrowse-smoke-research-${process.pid}`)
        : join(app.getPath('userData'), 'research');
    if (SMOKE_MODE && !RESEARCH_GATE_MODE) smokeResearchDir = researchDir;
    mkdirSync(researchDir, { recursive: true });
    const researchOutcome = openResearchStore({
      dbPath: join(researchDir, 'research.db'),
      // 决议 #155(4)：真实状态查询（Service 构造注入；闭包解引用——本块已位于
      // Sources/SearchProvider/ConfigStore/CredentialStore 装配之后，变量就绪）
      getSourcesState: () =>
        sourceService !== null && sourceService.getState().mode === 'normal'
          ? 'normal'
          : 'unavailable',
      getProviderState: () => ({
        configured: listProviderKinds().length > 0, // 同步可证明的粗粒度状态
        supportsToolCalling: true, // 乐观粗粒度——真实 capability 由异步 resolve 权威判定
      }),
      // C9（决议 #169(5)）：LIVE_RESEARCH 模式装配生产 RuntimeFactory——真实执行
      // 经产品 ResearchService/ResearchRuntime/C6/C7/C8 路径（真实 SearchProvider/
      // SourceService/config+credential 解析）；其余 SMOKE 模式仍注入确定性 stub
      buildRuntimeFactory:
        SMOKE_MODE && !LIVE_RESEARCH_MODE
          ? (db) =>
              createSmokeResearchRuntimeFactory({
                db,
                browser: controller,
                sourceService,
                searchProvider: new SmokeSearchFixture(null),
                // C8（8.19-B）：懒解析——场景设置 smokeResearchScript.current 驱动
                // 四阶段完成；缺省回退 makeSmokeGateScript（确定性空候选研究）
                providerScript: () => smokeResearchScript.current ?? makeSmokeGateScript(),
                model: 'smoke-model',
              })
          : (db) => {
              // 本块位于装配之后：configStore/credentials 非空（TS 局部解引用收窄）
              if (configStore === null || credentials === null) {
                throw new Error('程序缺陷：Research 装配先于 Provider 配置');
              }
              return createProductionResearchRuntimeFactory({
                db,
                browser: controller,
                sourceService,
                searchProvider,
                configStore,
                credentials,
              });
            },
    });
    researchService = researchOutcome.service;
    if (researchOutcome.mode === 'normal') {
      logInfo('main', `Research 子系统就绪（${join(researchDir, 'research.db')}）`);
    }
    // C9 真实运行发现（2026-08-18，先测后修）：原 research:progress/task-done
    // 转发注册位于 Research 装配**之前**——`researchService?.` 在 null 时静默
    // no-op，生产/真实链路的事件从未到达渲染层（面板不随任务完成自动刷新）。
    // 修复：装配完成后注册（service 实例已就绪；LIVE_RESEARCH 实测渲染层
    // task-done 计数 0 → 修复后 = 场景数）。
    const forwardResearchEvents = (): void => {
      const svc = researchService;
      if (svc === null) return;
      svc.onProgress((event) => {
        if (
          mainWindow !== null &&
          !mainWindow.isDestroyed() &&
          !mainWindow.webContents.isDestroyed()
        ) {
          mainWindow.webContents.send(IPC.ResearchProgress, event);
        }
      });
      svc.onTaskDone((event) => {
        if (
          mainWindow !== null &&
          !mainWindow.isDestroyed() &&
          !mainWindow.webContents.isDestroyed()
        ) {
          mainWindow.webContents.send(IPC.ResearchTaskDone, event);
        }
      });
    };
    forwardResearchEvents();
  } catch (err) {
    researchService = null;
    logError('main', 'Research 子系统初始化失败（研究功能全拒，其余能力不受影响）', err);
  }

  // D4：Watch 存储/生命周期生产装配（FIXED DECISION 12 装配顺序：coordinator
  // 已先构造 → openSourcesStore 已注入 observer → openWatchStore 注入 Source
  // 窄投影读取端口 → bind coordinator↔store）。Sources 为 null 或非 normal →
  // Watch unavailable（fail-closed：coordinator 保持未绑定，后续 prepare 恒
  // watch-unavailable）。缺失 watch.db 由 Store 正常创建；corrupt/future/
  // unavailable 绝不静默退化。D5 只消费 schedulerReady 状态位，本任务不启动调度。
  try {
    if (SMOKE_MODE && WATCH_GATE_MODE) {
      // WATCH 门控：本进程不装配 Watch 存储——门控 runner 以注入的 Source 窄
      // 投影 reader 独占驱动 openWatchStore/coordinator（生产装配函数本身），
      // 避免装配期 reconciliation 使用真实 Sources 事实破坏门控夹具状态
      //（coordinator 保持未绑定 → 任何 Source 写 prepare 恒 fail-closed）。
      logInfo('main', 'AIBROWSE_WATCH_SMOKE 门控：跳过常驻 Watch 装配（门控 runner 独占）');
    } else if (sourceService === null || sourceService.getState().mode !== 'normal') {
      logWarn('main', 'Watch 子系统不可用：Sources 子系统非 normal（Scheduler 不启动）');
    } else {
      const watchDir =
        SMOKE_MODE && !WATCH_GATE_MODE
          ? join(app.getPath('temp'), `aibrowse-smoke-watch-${process.pid}`)
          : join(app.getPath('userData'), 'watch');
      if (SMOKE_MODE && !WATCH_GATE_MODE) smokeWatchDir = watchDir;
      mkdirSync(watchDir, { recursive: true });
      const sourceProjectionReader: SourceProjectionReader = (sourceId) =>
        (
          sourceService as (SourceService & SourceWatchProjectionProvider) | null
        )?.getSourceWatchProjection(sourceId) ?? null;
      const watchOutcome: WatchStoreOutcome = openWatchStore({
        dbPath: join(watchDir, 'watch.db'),
        backupsDir: join(watchDir, 'backups'),
        reconcile: (repo) => watchCoordinator!.reconcileOnStartup(repo, sourceProjectionReader),
      });
      if (watchOutcome.mode === 'normal') {
        watchRepo = watchOutcome.repo;
        watchCoordinator!.bind(watchOutcome.repo, sourceProjectionReader);
        logInfo('main', `Watch 子系统就绪（${join(watchDir, 'watch.db')}）`);
      }
      // unavailable 分支：coordinator 保持未绑定 → prepare 恒 fail-closed
    }
  } catch (err) {
    logError('main', 'Watch 子系统初始化失败（Watch 功能全拒、Scheduler 不启动）', err);
  }

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
        logScan: startupLogScan, // 零暴露扫描起点：早于环境变量读取（见上方 startupLogScan）
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
    // Third Stage A5/A6：Agent 运行时装配（§8.1 构造注入复用 A2–A4 实例）+ 事件出口
    // （A6 起接 conversation:agent-* 事件通道——只发主窗口；日志可见性保持）。
    // SMOKE_MODE 下 limits 为冒烟可注入 holder（A6 UI 矩阵 step-limit/timeout 场景）——
    // 生产模式不传（默认 12 步/420s）；受控 searchProvider 注入同理（离线确定性）。
    agent: {
      browser: controller, // ToolExecutionContext 唯一浏览器通道
      confirmManager, // L2 确认状态机（A2 实例复用）
      searchProvider, // ctx.searchProvider 注入点（决议 #32⑥；冒烟服务自建实例注入受控夹具）
      ...(sourceService !== null ? { sourceService } : {}), // B4：ctx.sourceService 注入点
      usageBridge: (runId) => usageTracker.bridge(runId), // B6：run 级 usage 桥（决议 #79/#81）
      audit: auditWithProbe, // 每次工具调用恰好一条审计（ToolExecutor 单出口保证）
      auditRun: (message) => logInfo('audit', message), // run 开始/终止条目（§10.1）
      // A6 UI 矩阵（仅冒烟模式）：limits 为可注入 holder（step-limit/timeout 场景，每 run
      // 启动时读取）；searchProvider 为委托实现（调用时读取受控夹具 holder——离线确定性）
      ...(SMOKE_MODE ? { limits: smokeAgentLimits, searchProvider: agentSearchProvider } : {}),
    },
    onAgentStep: (e) => {
      logInfo(
        'agent',
        `工具步骤（requestId=${e.requestId}，tool=${e.step.name}，ok=${String(e.step.ok)}，decision=${e.step.decision}${e.step.errorCode !== undefined ? `，errorCode=${e.step.errorCode}` : ''}）`,
      );
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC.AgentStep, e);
      }
    },
    onAgentConfirmRequest: (e) => {
      logInfo(
        'agent',
        `确认请求（requestId=${e.requestId}，tool=${e.toolName}，toolCallId=${e.toolCallId}）`,
      );
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC.AgentConfirmRequest, e);
      }
    },
    onAgentRunDone: (e) => {
      logInfo(
        'agent',
        `Agent run 终态（requestId=${e.requestId}，status=${e.run.status}，步数=${e.run.stepsUsed}/${e.run.maxSteps}）`,
      );
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC.AgentRunDone, e);
      }
    },
    onAgentStatus: (e) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC.AgentStatus, e);
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
  // C8（8.19-B）：SMOKE_MODE 下允许 UI 窗口 navigator.clipboard.writeText
  // （clipboard-sanitized-write 权限——生产 permission-policy 默认拒绝；
  // 冒烟「复制当前视图」断言需要；仅测试设施，生产行为不变）
  if (SMOKE_MODE) {
    win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write');
    });
  }

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
      logWarn('main', `已拦截 UI 窗口导航（自身来源判定失败）：${redactUrlForLog(details.url)}`);
    }
  };
  const onUiWillRedirect = (
    details: Electron.Event<Electron.WebContentsWillRedirectEventParams>,
  ): void => {
    if (!resolveUiNavigationAllowed(details.url, navPolicy)) {
      details.preventDefault();
      logWarn('main', `已拦截 UI 窗口重定向（自身来源判定失败）：${redactUrlForLog(details.url)}`);
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
