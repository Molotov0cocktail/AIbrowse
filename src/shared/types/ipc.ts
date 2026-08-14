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
  // —— Second Stage（main → renderer，事件推送；S3 最小装配）——
  ConversationStreamChunk: 'conversation:stream-chunk', // payload: StreamChunkEvent
  ConversationTurnDone: 'conversation:turn-done', // payload: TurnDoneEvent（终态恰好一次）
  // —— Second Stage（renderer → main，invoke；S4 落地，§4.1 完整清单）——
  ConversationList: 'conversation:list',
  ConversationCreate: 'conversation:create', // payload: { ephemeral?: boolean }
  ConversationHistory: 'conversation:get-history', // payload: { sessionId }
  ConversationDelete: 'conversation:delete', // payload: { sessionId }
  ConversationSetEphemeral: 'conversation:set-ephemeral', // payload: { sessionId, ephemeral }
  ConversationAsk: 'conversation:ask', // payload: { sessionId, question } → AskResult
  ConversationAbort: 'conversation:abort', // payload: { requestId } → boolean
  ConversationPreview: 'conversation:preview', // → ContextPreview | null
  ConfigProvidersList: 'config:providers:list', // → ProviderInfo[]（含 hasKey，无 Key 值）
  ConfigProvidersSet: 'config:providers:set', // payload: { providerId, baseUrl, model } → boolean
  ConfigProvidersSetKey: 'config:providers:set-key', // payload: { providerId, apiKey } → boolean
  //（apiKey='' = 删除；只写不回读）
  // —— Third Stage（A6，§11.1）：Agent 操作可见性通道 ——
  AgentAsk: 'conversation:agent-ask', // payload: { sessionId, goal } → AskResult
  AgentConfirm: 'conversation:agent-confirm', // payload: { toolCallId, approve } → boolean
  //（未知/迟到/已终结 id → false 幂等，主进程 ConfirmManager 保证）
  AgentStep: 'conversation:agent-step', // AgentStepEvent（每步终态，含审计同源 argsSummary）
  AgentConfirmRequest: 'conversation:agent-confirm-request', // AgentConfirmRequest（L2 pending 建立）
  AgentRunDone: 'conversation:agent-run-done', // AgentRunDoneEvent（run 终态恰好一次）
  AgentStatus: 'conversation:agent-status', // AgentStatusEvent（A6 实时状态：starting/thinking/
  // executing/waiting-confirm/confirm-resolved/finalizing——确定性运行事实，非思维过程）
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

// —— Second Stage（S4，§4.1）：conversation/config invoke payload 类型 ——

export interface ConversationCreatePayload {
  ephemeral?: boolean;
}

export interface SessionIdPayload {
  sessionId: string;
}

export interface ConversationSetEphemeralPayload {
  sessionId: string;
  ephemeral: boolean;
}

export interface ConversationAskPayload {
  sessionId: string;
  question: string;
}

export interface RequestIdPayload {
  requestId: string;
}

export interface ConfigProvidersSetPayload {
  providerId: string;
  baseUrl: string;
  model: string;
}

export interface ConfigProvidersSetKeyPayload {
  providerId: string;
  apiKey: string; // 只写不回读；'' = 删除
}

// —— Third Stage（A6，§11.1）：Agent invoke payload ——

export interface AgentAskPayload {
  sessionId: string;
  goal: string; // 空串/非串 → internal 拒绝；>16000 字符 main 侧确定性截断（与 ask 同款纪律）
}

export interface AgentConfirmPayload {
  toolCallId: string; // 非空串；未知/迟到/已终结 → false（幂等，不抛异常）
  approve: boolean; // true=允许一次；false=拒绝（deny）
}
