// Shared types: single source of truth for the main/renderer contract (UI bridge part).
// Contract source: doc/detailed-design.md §3.2（AibrowseBridge 白名单，定稿，T1/T3 落地）+
// doc/stage2/detailed-design.md §4.2（Second Stage conversation/config 扩展，S4 落地）。
// 最小权限：仅白名单方法；远程网页无 preload（Tab view 不配置 preload），不触及本 bridge。

import type { PageSnapshot, TabInfo, TabsState } from './browser';
import type {
  AskResult,
  ContextPreview,
  ConversationMessage,
  ConversationSession,
  ProviderInfo,
  StreamChunkEvent,
  TurnDoneEvent,
} from './conversation';
import type {
  AgentConfirmRequest,
  AgentRunDoneEvent,
  AgentStatusEvent,
  AgentStepEvent,
} from './agent';
import type {
  ContentBounds,
  SourcesAddPayload,
  SourcesChangedEvent,
  SourcesGetPayload,
  SourcesGroupsPayload,
  SourcesHardDeletePayload,
  SourcesIdPayload,
  SourcesIdVersionPayload,
  SourcesListPayload,
  SourcesSearchPayload,
  SourcesUndoPayload,
  SourcesUpdatePayload,
} from './ipc';
import type {
  FtsRebuildResult,
  ManualWriteResult,
  PrepareHardDeleteResult,
  QuickAddResult,
  SourceGroupsResult,
  SourceListResult,
  SourceResult,
  SourceSearchResult,
  SourcesState,
  UndoResult,
  UndoableChange,
} from './sources';
import type {
  ExportCsvResult,
  ResearchIpcListValue,
  ResearchIpcResult,
  ResearchIpcTaskValue,
  ResearchProgressEvent,
  ResearchResultView,
  ResearchTaskDoneEvent,
} from './research';
import type { ResearchExportCsvPayload, ResearchListPayload } from './ipc';
import type { WatchBridge } from './watch-ipc';

export interface AppInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

// Minimal-privilege bridge exposed by the preload script to the renderer (React UI only).
export interface AibrowseBridge {
  getAppInfo(): Promise<AppInfo>;
  notifyRendererReady(): void;
  tabs: {
    list(): Promise<TabInfo[]>;
    // 原始地址栏输入（可为空），main 侧统一规范化（§9）；无法解析 → 创建空白 Tab
    create(url?: string): Promise<TabInfo | null>;
    close(tabId: string): Promise<boolean>;
    activate(tabId: string): Promise<boolean>;
    // tabs:updated 全量推送（§3.2）；返回退订函数（preload 内同一通道只注册一次监听）
    onUpdated(listener: (state: TabsState) => void): () => void;
  };
  nav: {
    // 原始输入由 main 侧 IPC handler 统一规范化（UI 不做 URL 判断，First_stage §十）
    navigate(tabId: string, input: string): Promise<boolean>;
    back(tabId: string): Promise<boolean>;
    forward(tabId: string): Promise<boolean>;
    reload(tabId: string): Promise<boolean>;
  };
  page: {
    // null = L3（tab 不存在/已销毁）；L1/L2 降级见 meta.degraded（§4）
    snapshot(tabId: string): Promise<PageSnapshot | null>;
  };
  ui: {
    // 渲染层 ResizeObserver 测量内容容器两维矩形后上报（§11.2，单向 send）
    reportContentBounds(bounds: ContentBounds): void;
    // C8 决议 #158(5)：受控 UI send——切换 WebContentsView 可见性
    // （viewMode='research-result' 时隐藏原生视图露出结果画布；不暴露
    // Electron 对象）
    setBrowserContentVisible(visible: boolean): void;
  };
  // —— Second Stage（§4.2，S4 落地）：AI 共读白名单 ——
  conversation: {
    list(): Promise<ConversationSession[]>; // 新→旧
    create(opts?: { ephemeral?: boolean }): Promise<ConversationSession | null>; // 决议 #19：达上限 → null
    getHistory(sessionId: string): Promise<ConversationMessage[] | null>; // null=会话不存在
    remove(sessionId: string): Promise<boolean>;
    setEphemeral(sessionId: string, ephemeral: boolean): Promise<boolean>;
    ask(sessionId: string, question: string): Promise<AskResult>;
    abort(requestId: string): Promise<boolean>; // 无匹配在途 → false（幂等）
    preview(): Promise<ContextPreview | null>; // 实时快照摘要，不含正文
    // —— Third Stage（A6，§11.1）：Agent 任务与可见性白名单 ——
    agentAsk(sessionId: string, goal: string): Promise<AskResult>; // 共读与 Agent 共享每会话单在途
    confirmTool(toolCallId: string, approve: boolean): Promise<boolean>; // L2 确认决定（未知/迟到 → false）
    // 事件订阅：返回退订函数（preload 内同一通道只注册一次 ipcRenderer 监听，JS 侧管理列表）
    onStreamChunk(listener: (e: StreamChunkEvent) => void): () => void;
    onTurnDone(listener: (e: TurnDoneEvent) => void): () => void;
    onAgentStep(listener: (e: AgentStepEvent) => void): () => void;
    onAgentConfirmRequest(listener: (e: AgentConfirmRequest) => void): () => void;
    onAgentRunDone(listener: (e: AgentRunDoneEvent) => void): () => void;
    onAgentStatus(listener: (e: AgentStatusEvent) => void): () => void;
  };
  config: {
    providers: {
      list(): Promise<ProviderInfo[]>; // 含 hasKey，无 Key 值
      set(cfg: { providerId: string; baseUrl: string; model: string }): Promise<boolean>;
      // API Key 只写不回读（§10）：setKey 之后 Key 无法经任何通道回到渲染层
      setKey(providerId: string, apiKey: string): Promise<boolean>; // apiKey='' = 删除
    };
  };
  // —— Fourth Stage B5（决议 #69/#70/#72/#73/#74）：Sources 面板白名单 ——
  // 全部经 main 侧 sender+主帧校验 + 参数严格白名单验证；audience 由主进程适配器
  // 硬编码 'user'（renderer 无 audience/数据库路径/SQL 通道）；quick-add 无参数
  // （main 在点击时读取当前活动 Tab）；sources:changed 仅成功变更后推送最小
  // payload，renderer 收到后重新读取。原始 ipcRenderer 不暴露（既有 eventRelay 模式）。
  sources: {
    list(payload: SourcesListPayload): Promise<SourceListResult>;
    get(payload: SourcesGetPayload): Promise<SourceResult>;
    search(payload: SourcesSearchPayload): Promise<SourceSearchResult>;
    groups(payload: SourcesGroupsPayload): Promise<SourceGroupsResult>;
    add(input: SourcesAddPayload): Promise<ManualWriteResult>;
    update(payload: SourcesUpdatePayload): Promise<ManualWriteResult>;
    disable(payload: SourcesIdVersionPayload): Promise<ManualWriteResult>;
    restore(payload: SourcesIdVersionPayload): Promise<ManualWriteResult>;
    quickAdd(): Promise<QuickAddResult>; // 无参数：main 读取当前活动 Tab（决议 #72）
    undoable(): Promise<UndoableChange[]>;
    undo(payload: SourcesUndoPayload): Promise<UndoResult>;
    state(): Promise<SourcesState>;
    prepareHardDelete(payload: SourcesIdPayload): Promise<PrepareHardDeleteResult>;
    hardDelete(payload: SourcesHardDeletePayload): Promise<ManualWriteResult>;
    // B7 决议 #91：FTS 诊断性 rebuild——无 payload（零 SQL/路径参数通道）；
    // 仅 normal 状态可用（适配器门控）
    rebuildIndex(): Promise<FtsRebuildResult>;
    onChanged(listener: (e: SourcesChangedEvent) => void): () => void;
  };
  // —— Fifth Stage C8（决议 #156/#158）：Research 白名单 ——
  // invoke 全部经 main 侧 sender+主帧校验 + 参数严格白名单 fail-closed；
  // export-csv 的 dialog/路径/写入全部在主进程（renderer 零路径参数）；
  // 事件订阅 eventRelay 模式（单次注册 + 退订）。
  research: {
    create(goal: string): Promise<ResearchIpcResult<ResearchIpcTaskValue>>;
    start(taskId: string): Promise<ResearchIpcResult<ResearchIpcTaskValue>>;
    stop(taskId: string): Promise<ResearchIpcResult<ResearchIpcTaskValue>>;
    get(taskId: string): Promise<ResearchIpcResult<ResearchIpcTaskValue>>;
    result(taskId: string): Promise<ResearchIpcResult<{ view: ResearchResultView }>>;
    list(payload: ResearchListPayload): Promise<ResearchIpcResult<ResearchIpcListValue>>;
    delete(taskId: string): Promise<ResearchIpcResult<{ deleted: true }>>;
    exportCsv(payload: ResearchExportCsvPayload): Promise<ExportCsvResult>;
    onProgress(listener: (e: ResearchProgressEvent) => void): () => void;
    onTaskDone(listener: (e: ResearchTaskDoneEvent) => void): () => void;
  };
  watch: WatchBridge;
}
