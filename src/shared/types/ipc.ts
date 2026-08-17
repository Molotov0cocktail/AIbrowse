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
  // —— Fourth Stage B5：Sources 面板手工管理通道（决议 #69/#70；全部复用 handle()
  // sender+主帧校验；参数严格白名单验证；audience 由主进程适配器硬编码 'user'）——
  SourcesList: 'sources:list', // payload: SourcesListPayload → SourceListResult
  SourcesGet: 'sources:get', // payload: SourcesGetPayload → SourceResult
  SourcesSearch: 'sources:search', // payload: SourcesSearchPayload → SourceSearchResult
  SourcesGroups: 'sources:groups', // payload: SourcesGroupsPayload → SourceGroupsResult
  SourcesAdd: 'sources:add', // payload: SourcesAddPayload → ManualWriteResult
  SourcesUpdate: 'sources:update', // payload: SourcesUpdatePayload → ManualWriteResult
  SourcesDisable: 'sources:disable', // payload: SourcesIdVersionPayload → ManualWriteResult
  SourcesRestore: 'sources:restore', // payload: SourcesIdVersionPayload → ManualWriteResult
  SourcesUndoable: 'sources:undoable', // → UndoableChange[]（最近 100 条有界）
  SourcesUndo: 'sources:undo', // payload: SourcesUndoPayload → UndoResult
  SourcesQuickAdd: 'sources:quick-add', // 无 payload：main 在点击时读取当前活动 Tab（决议 #72）
  SourcesState: 'sources:state', // → SourcesState（normal/readonly-recovery/unavailable）
  SourcesPrepareHardDelete: 'sources:prepare-hard-delete', // payload: SourcesIdPayload → PrepareHardDeleteResult
  SourcesHardDelete: 'sources:hard-delete', // payload: SourcesHardDeletePayload → ManualWriteResult
  SourcesRebuildIndex: 'sources:rebuild-index', // 无 payload → FtsRebuildResult（B7 决议 #91：
  // 诊断入口零 SQL/路径参数通道；仅 normal 状态门控；不算 Source 数据变更）
  SourcesChanged: 'sources:changed', // main → renderer 事件（仅成功变更后发送最小 payload；
  // renderer 收到后重新读取——不携带任何数据正文）
  // —— Fifth Stage C8：Research 八通道 + 两事件（决议 #156；export-csv 独立第八通道）——
  ResearchCreate: 'research:create', // payload: { goal }（trim 非空 ≤2000；超长拒绝非截断）
  ResearchStart: 'research:start', // payload: { taskId }（UUID 形状）
  ResearchStop: 'research:stop', // payload: { taskId }
  ResearchGet: 'research:get', // payload: { taskId }
  ResearchResult: 'research:result', // payload: { taskId } → 安全结果详情视图（决议 #157）
  ResearchList: 'research:list', // payload: { page ≥1, pageSize 1..20 }（严格拒绝非法值；
  // status 不属 IPC 暴露面——未知字段 fail-closed，决议 #164）
  ResearchDelete: 'research:delete', // payload: { taskId }（仅终态/created；running·预占拒绝）
  ResearchExportCsv: 'research:export-csv', // payload: { taskId, tableBlockIndex, view:{sort,filter} }
  // （决议 #161：view 为受限排序/筛选状态——renderer 零 rows/路径/内容通道；
  // 主进程 dialog 安全通道 + 同一 applyTableView 重投影）
  ResearchProgress: 'research:progress', // main → renderer：ResearchProgressEvent（§6.5 节流推送；
  // 零 goal/URL/模型文本/网页正文/Evidence/Result 正文——FT-16）
  ResearchTaskDone: 'research:task-done', // main → renderer：ResearchTaskDoneEvent
  // （status 收窄 completed|failed|cancelled——决议 #156(6)）
  // —— Fifth Stage C8：受控 UI send 通道（决议 #158(4)）——
  UiBrowserContentVisible: 'ui:browser-content-visible', // payload: { visible: boolean }
  // （sender+主帧校验 + payload 白名单；仅供受信 UI 切换 WebContentsView 可见性，
  // 不进入 AI BrowserController/Tool 能力接口）
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

// —— Fourth Stage B5：Sources 通道 payload 类型（严格白名单；renderer 不得提供
// audience / 数据库路径 / SQL；aiNote 只读展示不进写 payload（决议 #75））——

export interface SourcesListPayload {
  page: number; // ≥0 整数
  pageSize?: number; // 1–20（>20 → source-limit）
  groupId?: string | null; // undefined=不过滤；null=未分组；string=指定组
  enabledOnly?: boolean;
}

export interface SourcesGetPayload {
  sourceId: string; // UUID 形状
}

export interface SourcesSearchPayload {
  query: string; // 非空 ≤500
  limit?: number; // 1–10（>10 → source-limit）
}

export interface SourcesGroupsPayload {
  page: number; // ≥0 整数
  pageSize?: number; // 1–20
}

export interface SourcesAddPayload {
  scope: 'origin' | 'page';
  url: string;
  name?: string;
  groupName?: string;
  tags?: string[];
  priority?: number;
  shareMode?: 'full' | 'metadata' | 'blocked';
  userNote?: string;
  trust?: { value: 'official' | 'primary' | 'secondary' | 'community' | 'unknown' };
  // 无 aiNote（AI note 只读展示，用户只编辑 user note，决议 #75）；
  // trust 无 assertedBy/verification（由 main/SourceService 确定：手工通道恒
  // user-asserted，renderer 不得伪造）。
}

export interface SourcesUpdatePatchPayload {
  name?: string;
  url?: string;
  groupName?: string | null; // null = 移出分组
  tags?: string[];
  priority?: number;
  shareMode?: 'full' | 'metadata' | 'blocked';
  userNote?: string;
  trust?: { value: 'official' | 'primary' | 'secondary' | 'community' | 'unknown' };
  // 无 aiNote / enabled / assertedBy / verification（决议 #75/#51）
}

export interface SourcesUpdatePayload {
  sourceId: string;
  expectedVersion: number; // 正整数（并发令牌，决议 #65/#77 冲突提示刷新）
  patch: SourcesUpdatePatchPayload;
}

export interface SourcesIdVersionPayload {
  sourceId: string;
  expectedVersion: number;
}

export interface SourcesIdPayload {
  sourceId: string;
}

export interface SourcesHardDeletePayload {
  sourceId: string;
  token: string; // 64 位小写 hex 一次性能力令牌（prepare-hard-delete 签发）
}

export interface SourcesUndoPayload {
  idempotencyKey: string; // 非空串
}

// sources:changed 最小 payload（决议 #70）：不含任何数据正文——renderer 收到后
// 重新读取当前视图。
export interface SourcesChangedEvent {
  reason: 'sources-changed';
}

// —— Fifth Stage C8：Research 通道 payload（决议 #156/#161；main 侧 handler
// 严格白名单验证 fail-closed——Service clamp 仅作非 IPC 调用方的纵深防御）——

export interface ResearchCreatePayload {
  goal: string; // trim 后非空且 ≤MAX_GOAL_CHARS（超长拒绝，不截断）
}

export interface ResearchTaskIdPayload {
  taskId: string; // 小写 RFC 4122 UUID 形状
}

// 决议 #164：payload 冻结为 {page, pageSize≤20}（§11）——status 不属 IPC 暴露面，
// 携带 status（含合法枚举值）作为未知字段 fail-closed 拒绝；主进程内部
// ResearchService.listTasks 的 status 筛选能力保留（非 IPC 调用方纵深能力）
export interface ResearchListPayload {
  page: number; // 1-based（≥1 整数；0/负数/非整数/NaN/Infinity 拒绝）
  pageSize?: number; // 1–20（缺省 20；越界拒绝）
}

// 决议 #161(1)：export-csv payload 冻结——view 为受限排序/筛选状态；
// path/rows/content/文件名等任何字段零通道
export interface ResearchExportCsvPayload {
  taskId: string;
  tableBlockIndex: number; // Result.blocks 原始 0-based 索引（非负整数）
  view: {
    sort: {
      columnIndex: number; // 非负整数（< columns.length）
      direction: 'asc' | 'desc';
    } | null;
    filter: string; // ≤200；空串=全部
  };
}

// 决议 #158(4)：受控 UI send 通道 payload——只允许 {visible:boolean}
export interface UiBrowserContentVisiblePayload {
  visible: boolean;
}
