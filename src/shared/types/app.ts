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
import type { ContentBounds } from './ipc';

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
    // 事件订阅：返回退订函数（preload 内同一通道只注册一次 ipcRenderer 监听，JS 侧管理列表）
    onStreamChunk(listener: (e: StreamChunkEvent) => void): () => void;
    onTurnDone(listener: (e: TurnDoneEvent) => void): () => void;
  };
  config: {
    providers: {
      list(): Promise<ProviderInfo[]>; // 含 hasKey，无 Key 值
      set(cfg: { providerId: string; baseUrl: string; model: string }): Promise<boolean>;
      // API Key 只写不回读（§10）：setKey 之后 Key 无法经任何通道回到渲染层
      setKey(providerId: string, apiKey: string): Promise<boolean>; // apiKey='' = 删除
    };
  };
}
