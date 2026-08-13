// IPC channel constants + payload types: shared single source of truth (main/preload/renderer).
// Contract source: doc/detailed-design.md §3.1（定稿，T1）.
// preload bridge 白名单（AibrowseBridge）T3 接入；main 侧 handler 已于 T2 落地。

export const IPC = {
  // renderer → main（invoke）
  TabsList: 'tabs:list',
  TabsCreate: 'tabs:create', // payload: { url?: string }（原始地址栏输入，main 侧规范化）
  TabsClose: 'tabs:close', // payload: { tabId }
  TabsActivate: 'tabs:activate', // payload: { tabId }
  NavNavigate: 'nav:navigate', // payload: { tabId, input }（原始输入）
  NavBack: 'nav:back',
  NavForward: 'nav:forward',
  NavReload: 'nav:reload',
  PageSnapshot: 'page:snapshot', // payload: { tabId }
  AppGetInfo: 'app:get-info', // 基线已有
  // renderer → main（send，单向无回执）
  UiContentBounds: 'ui:content-bounds', // payload: ContentBounds（§6）
  AppRendererReady: 'app:renderer-ready', // 基线已有
  // main → renderer（事件推送）
  TabsUpdated: 'tabs:updated', // payload: TabsState（全量推送，渲染层幂等更新）
  // —— Second Stage（main → renderer，事件推送；S3 最小装配，完整清单 §4.1，S4 补 invoke 通道）——
  ConversationStreamChunk: 'conversation:stream-chunk', // payload: StreamChunkEvent
  ConversationTurnDone: 'conversation:turn-done', // payload: TurnDoneEvent（终态恰好一次）
} as const;

export interface ContentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// invoke payload 类型（main 侧 handler 校验用；renderer 经 preload bridge 传入）
export interface TabsCreatePayload {
  url?: string; // 原始地址栏输入，main 侧规范化（§9）
}

export interface TabIdPayload {
  tabId: string;
}

export interface NavNavigatePayload {
  tabId: string;
  input: string; // 原始输入，main 侧规范化（§9）
}
