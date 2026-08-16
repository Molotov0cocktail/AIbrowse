// Fifth Stage C1: Research domain types + deterministic budget constants —
// the single source of truth for the Research contract (detailed-design §2/§6.8,
// adjudications #101–#110). Renderer-safe (types/constants only, no node imports).

// ---------- 常量（单一事实源：§6.8 全表 + 决议 #110 字段常量；禁止魔法数字） ----------

export const MAX_GOAL_CHARS = 2000;
export const MAX_SOURCE_CANDIDATES = 24;
export const MAX_SELECTED_SOURCES = 8;
export const MAX_RESEARCH_TABS = 3;
export const MAX_PAGE_CAPTURE_CHARS = 60000;
export const MAX_PAGE_READ_RETRIES = 1;
export const MAX_CAPTURES_PER_TASK = 16;
export const MAX_EVIDENCE_EXCERPT_CHARS = 500;
export const MAX_EVIDENCE_FIELD_VALUE_CHARS = 200;
export const MAX_EVIDENCE_PER_TASK = 60;
export const MAX_CLAIMS_PER_TASK = 30;
export const MAX_CONFLICTS_PER_TASK = 10;
export const MAX_RESEARCH_ROUNDS = 24;
export const MAX_RESEARCH_TOOL_STEPS = 64;
export const RESEARCH_TOTAL_TIMEOUT_MS = 1_800_000;
export const MAX_REQUEST_CONTEXT_CHARS = 200_000;
export const MAX_TRANSCRIPT_REPLAY_ROUNDS = 6;
export const MAX_RESULT_CHARS = 200_000;
export const MAX_RESULT_BLOCKS = 20;
export const MAX_TABLE_ROWS = 200;
export const MAX_TABLE_COLUMNS = 20;
export const MAX_CARDS_ITEMS = 20;
export const MAX_RANKING_ITEMS = 20;
// 决议 #103：UTF-8 字节数（Buffer.byteLength）——实际持久化大小有界（P2-3 目标）
export const MAX_TASK_PERSISTED_CHARS = 500_000;
// 决议 #104：任务总数硬上限（含 created；清理对象仅最旧终态）
export const MAX_STORED_TASKS = 30;

// 决议 #110：§2 字段注释全部数值上限集中于此（单一事实源）
export const MAX_CANDIDATE_TITLE_CHARS = 200;
export const MAX_CANDIDATE_NOTE_CHARS = 200;
export const MAX_CLAIM_TEXT_CHARS = 500;
export const MAX_CONFLICT_TOPIC_CHARS = 200;
export const MAX_CONFLICT_POSITION_CHARS = 300;
export const MAX_RESULT_TITLE_CHARS = 120;
export const MAX_RESULT_SUMMARY_CHARS = 2000;
export const MAX_MARKDOWN_BLOCK_CHARS = 4000;
export const MAX_TABLE_CELL_CHARS = 200;
export const MAX_CARDS_TITLE_CHARS = 120;
export const MAX_CARDS_BODY_CHARS = 1000;
export const MAX_RANKING_TITLE_CHARS = 120;
export const MAX_RANKING_DETAIL_CHARS = 1000;
export const MAX_UNCERTAIN_TEXT_CHARS = 1000;
export const MAX_EVIDENCE_LOCATOR_FIELD_PATH_CHARS = 200;

// 决议 #133：规划轮 webQueries 数量上限（小型编译期上限，C5 基线）
export const MAX_PLAN_WEB_QUERIES = 1;
// 决议 #132(6)：单条 Research 工具结果序列化上限（确定性截断 + 标记；
// 只进模型回放消息，不进日志/UI/持久化）
export const RESEARCH_TOOL_RESULT_CONTENT_MAX = 8000;

// 决议 #132：Research 模型轮六工具编译期固定集合（名称与注册表同名工具
// 一致——测试交叉断言；描述与执行器为 Research 专属，不经 ToolRegistry/
// ToolExecutor/权限链/ConfirmManager）
export const RESEARCH_TOOL_NAMES = [
  'browser_open',
  'browser_read',
  'search_web',
  'source_search',
  'source_list',
  'source_get',
] as const;

export type ResearchToolName = (typeof RESEARCH_TOOL_NAMES)[number];

// ---------- 枚举表（决议 #105/#108：校验用编译期常量） ----------

export const RESEARCH_STATUSES = [
  'created',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;

export const RESEARCH_PHASES = ['planning', 'reading', 'verifying', 'synthesizing'] as const;

export const RESEARCH_ERROR_CODES = [
  'research-invalid-goal',
  'research-busy',
  'research-not-found',
  'research-invalid-state',
  'research-unavailable',
  'research-sources-unavailable',
  'research-provider-unavailable',
  'research-budget-exhausted',
  'research-timeout',
  'research-task-limit',
  'research-internal',
  // 决议 #134(3)：Runtime 未装配/无法构造（生产 C6/C7 端口缺失或端口构造
  // 失败）→ startTask 前置拒绝——扩展决议 #108 的 11 码结论（#108 不改写）
  'research-runtime-unavailable',
] as const;

// ---------- 任务 ----------

export type ResearchTaskStatus = (typeof RESEARCH_STATUSES)[number];

export type ResearchPhase = (typeof RESEARCH_PHASES)[number];

export type ResearchErrorCode = (typeof RESEARCH_ERROR_CODES)[number];

export interface ResearchTaskStats {
  candidateCount: number; // 合并后候选数
  selectedCount: number; // 选定来源数
  captureCount: number; // 捕获次数（含失败）
  failedReadCount: number; // 读取失败数（Fifth §7.7 明确记录）
  evidenceCount: number; // 验证通过证据数
  rejectedEvidenceCount: number; // 验证拒绝数（回注修正）
  claimCount: number; // 综合结论数
  conflictCount: number; // 显式冲突数
  stepsUsed: number; // 工具步数
  roundsUsed: number; // 模型轮次
}

export interface ResearchTask {
  id: string; // UUID（主进程生成）
  goal: string; // ≤MAX_GOAL_CHARS 字符（非串/空拒绝；超长确定性截断 + warn，决议 #107）
  status: ResearchTaskStatus;
  phase: ResearchPhase | null; // running 时的子相位
  createdAt: string; // ISO 8601
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  interruptedAt: string | null; // interrupted 标记时间
  errorCode: ResearchErrorCode | null;
  resultId: string | null;
  stats: ResearchTaskStats;
}

// ---------- 候选来源（C3） ----------

export type CandidateOrigin = 'sources' | 'search';

export interface SourceCandidate {
  id: string; // 主进程生成（合并后唯一）
  url: string; // 展示 URL（http/https 白名单）
  displayUrl: string;
  title: string; // ≤MAX_CANDIDATE_TITLE_CHARS（Sources 名称或搜索结果标题）
  canonicalKey: string; // normalizeSourceUrl 身份键
  scope: 'origin' | 'page';
  discoveredVia: CandidateOrigin[]; // 双发现路径保留（决策 D6）
  sourceId: string | null; // Sources 命中才有
  trust: {
    value: SourceTrustValue;
    assertedBy: SourceTrustAssertedBy;
    verification: SourceTrustVerification;
  } | null;
  // 继承 Sources trust 三元组；search 命中恒 null
  priority: number | null; // 仅 Sources 命中（1–5）
  lastUsedAt: string | null; // 仅 Sources 命中
  note: string | null; // ≤MAX_CANDIDATE_NOTE_CHARS 摘录（仅 UI 展示用；不进入模型上下文）
  sortKey: string; // 确定性排序键（纯函数生成，见 §4）
}

export type SourceTrustValue = 'official' | 'primary' | 'secondary' | 'community' | 'unknown';
export type SourceTrustAssertedBy = 'user' | 'ai';
export type SourceTrustVerification = 'asserted' | 'unverified';

// ---------- Capture（C4） ----------

export type CaptureFailureReason =
  | 'page-load-failed'
  | 'snapshot-degraded'
  | 'tab-closed-by-user'
  | 'timeout'
  | 'aborted'
  | 'http-scheme-rejected';

export interface CaptureSummary {
  sectionCount: number; // 实际保留的非空 textSections 数
  tableCount: number; // 实际保留的表格数量（决议 #128：不是单元格数量/行列合计）
  headingCount: number; // 实际保留的 heading 数
  charCount: number; // 最终 canonicalText.length（≤ MAX_PAGE_CAPTURE_CHARS）
}

export interface Capture {
  captureId: string; // UUID
  taskId: string;
  candidateId: string;
  tabId: string; // 本次读取的精确 tabId
  url: string;
  title: string;
  accessTime: string; // 主进程盖章 ISO 时间（Fifth §3.4）
  documentId: string; // 快照 meta.documentId（主进程盖章，页面不可伪造）
  contentHash: string; // 规范化正文 SHA-256 前 32 hex
  summary: CaptureSummary;
  failed: boolean;
  failureReason: CaptureFailureReason | null;
}

// ---------- Evidence（C4/C6，Fifth_stage.md §3.4 字段集） ----------

export type EvidenceType = 'quote' | 'table-cell' | 'field' | 'summary-point';
export type EvidenceVerification = 'verified' | 'rejected';

export type EvidenceLocator =
  | { kind: 'text'; excerpt: string } // ≤MAX_EVIDENCE_EXCERPT_CHARS 字符
  | {
      kind: 'table';
      tableIndex: number; // 决议 #129：多表唯一定位——0-based 非负整数；
      // 缺失/负数/非整数/字符串/超界全部 fail-closed
      row: number; // 0-based 数据行（不含 header）
      col: number; // 0-based
      header: string | null; // 程序由真实表头生成；proposal 提供非空 header 须与
      // 真实表头一致；仅 string | null | 缺省合法（非法形态整体拒绝——决议 #115）
    }
  | { kind: 'field'; fieldPath: string }; // 提取字段路径（≤MAX_EVIDENCE_LOCATOR_FIELD_PATH_CHARS，闭合白名单）

export interface Evidence {
  evidenceId: string;
  taskId: string;
  captureId: string; // 归属捕获（验证要求：属于当前任务）
  candidateId: string; // 来源引用（验证要求：来源存在）
  sourceId: string | null; // Sources 命中时携带
  url: string;
  title: string;
  accessTime: string; // 主进程盖章
  documentId: string;
  contentHash: string; // 快照摘要哈希
  type: EvidenceType;
  locator: EvidenceLocator;
  excerpt: string; // 受控 excerpt/字段值：≤ MAX_EVIDENCE_EXCERPT_CHARS（500），
  // 规范化后来自捕获内容（验证结果）
  value: string | null; // table-cell/field 的单元格/字段值（≤MAX_EVIDENCE_FIELD_VALUE_CHARS）
  verification: EvidenceVerification; // 运行期判别联合：'rejected' 仅回注模型修正，
  // 永不进 Evidence 集合与 research.db（决议 #102：Repository 写入仅接受
  // verified 窄类型 + schema CHECK 兜底）
}

// 决议 #102：Repository 写入 API 仅接受 verified 窄类型
export type VerifiedEvidence = Evidence & { verification: 'verified' };

// ---------- Evidence 验证（C4；决议 #130） ----------

// 模型只提「不可信 proposal」——仅允许六个字段；evidenceId 由可信调用方
// 预分配；taskId/sourceId/url/title/accessTime/documentId/contentHash/
// verification 全部不得由 proposal 提供（未知字段 fail-closed）。
// 模型绝不能直接构造 Evidence。
export interface EvidenceProposal {
  captureId: string;
  candidateId: string;
  type: EvidenceType;
  locator: EvidenceLocator;
  excerpt: string | null; // text/summary-point：非空摘录草案；table-cell/field：受控值草案（可与 value 二选一）
  value: string | null; // table-cell/field 的单元格/字段值草案
}

export type EvidenceRejectionCode =
  | 'proposal-invalid' // 形状/未知字段/字段长度/type-locator 组合非法
  | 'capture-not-found' // captureId 不属于当前 task（跨任务引用）
  | 'capture-failed' // failed capture（sentinel 先拒）
  | 'candidate-mismatch' // candidateId 不存在或与 capture.candidateId 不一致
  | 'content-missing' // 对应 CaptureContent 缺失/绑定错位
  | 'excerpt-invalid' // 摘录为空/超长/与 locator 不一致
  | 'excerpt-not-in-content' // 规范化后不是任一 section 的连续子串（伪造/错绑/跨 section 拼接）
  | 'table-coordinate-invalid' // tableIndex/row/col 越界或非法
  | 'table-value-mismatch' // 单元格真实值与 proposal 不一致
  | 'table-header-mismatch' // proposal 提供非空 header 且与真实表头不一致
  | 'field-path-invalid' // fieldPath 不在闭合字段白名单（含原型链键/通配符/动态路径）
  | 'field-value-mismatch' // 字段真实值与 proposal 不一致
  | 'value-invalid'; // value 形状/长度非法

export type EvidenceVerifyResult =
  | { ok: true; evidence: VerifiedEvidence }
  | { ok: false; code: EvidenceRejectionCode; reason: string }; // reason ≤200 安全中文短句

// ---------- Cross-check（C6） ----------

export type ClaimSeverity = 'high' | 'medium' | 'low'; // high = 高影响事实（必须多源）
export type CoverageKind = 'multi-source' | 'single-source';
export type SourceTypeClass = 'vendor' | 'third-party' | 'community';

export interface Claim {
  claimId: string;
  taskId: string;
  text: string; // ≤MAX_CLAIM_TEXT_CHARS 字符（规范化）
  severity: ClaimSeverity;
  coverage: CoverageKind; // 确定性程序计算：引用的不同 canonicalKey 来源数 ≥2
  sourceTypes: SourceTypeClass[]; // 厂商自述/第三方区分（§5 判定规则）
  evidenceIds: string[]; // 已验证证据引用
  singleSourceFields: string[]; // 单一来源字段显式标注（Fifth §5）
  conflictIds: string[];
}

export interface ConflictPosition {
  positionText: string; // ≤MAX_CONFLICT_POSITION_CHARS 字符
  sourceRefs: string[]; // candidateId 引用
}

export interface Conflict {
  conflictId: string;
  taskId: string;
  topic: string; // ≤MAX_CONFLICT_TOPIC_CHARS 冲突主题
  positions: ConflictPosition[]; // ≥2（程序校验）
  claimIds: string[];
  resolved: 'explicit' | 'unresolved'; // v1 恒 'unresolved'（不自动裁决、不静默抹平）
}

// ---------- Result Schema（C7/C8；Fifth_stage.md §3.6/§5） ----------

export type ResultBlock =
  | { kind: 'markdown'; text: string } // ≤MAX_MARKDOWN_BLOCK_CHARS 字符/块
  | { kind: 'table'; columns: string[]; rows: string[][]; sourceRefs: string[] }
  // columns ≤ MAX_TABLE_COLUMNS(20)；rows ≤ MAX_TABLE_ROWS(200)；单元格 ≤MAX_TABLE_CELL_CHARS 字符；
  // sourceRefs = candidateId[]（每列至少映射来源语义见 §8.3）
  | {
      kind: 'cards';
      items: { title: string; subtitle: string | null; body: string; sourceRefs: string[] }[];
    }
  // items ≤ MAX_CARDS_ITEMS；title ≤MAX_CARDS_TITLE_CHARS/subtitle ≤MAX_CARDS_TITLE_CHARS/
  // body ≤MAX_CARDS_BODY_CHARS
  | {
      kind: 'ranking';
      items: { rank: number; title: string; detail: string; sourceRefs: string[] }[];
    }
  // items ≤ MAX_RANKING_ITEMS；rank 1-based 连续（程序校验）；
  // title ≤MAX_RANKING_TITLE_CHARS/detail ≤MAX_RANKING_DETAIL_CHARS
  | { kind: 'uncertain'; text: string; reason: string }; // 「不确定」正式输出类型
// text/reason ≤MAX_UNCERTAIN_TEXT_CHARS

export interface ResearchResult {
  resultId: string;
  taskId: string;
  title: string; // ≤MAX_RESULT_TITLE_CHARS
  summary: string; // ≤MAX_RESULT_SUMMARY_CHARS 摘要
  blocks: ResultBlock[]; // ≤MAX_RESULT_BLOCKS 块
  evidenceMap: Record<
    string,
    { candidateId: string; url: string; title: string; accessTime: string }
  >;
  // evidenceId → 展示元数据（≤ MAX_EVIDENCE_PER_TASK 项）
  conflicts: { conflictId: string; topic: string; positions: ConflictPosition[] }[];
  coverage: {
    total: number;
    multiSource: number;
    singleSource: number;
    vendor: number;
    thirdParty: number;
    community: number;
  };
  // 覆盖情况（计数类事实，非虚构百分比——Fifth §5）
  fetchedAt: string; // 数据获取时间
}

// ---------- 服务层契约（决议 #109：接口单一事实源，C1 骨架 / C5 接线） ----------

export interface ResearchListOptions {
  page?: number; // ≥1（非法安全 clamp）
  pageSize?: number; // 1–20（非法安全 clamp）
  status?: ResearchTaskStatus;
}

export type ResearchCreateResult =
  { ok: true; task: ResearchTask } | { ok: false; errorCode: ResearchErrorCode };

export type ResearchTaskResult =
  { ok: true; task: ResearchTask } | { ok: false; errorCode: ResearchErrorCode };

export type ResearchListResult =
  | { ok: true; page: number; pageSize: number; total: number; items: ResearchTask[] }
  | { ok: false; errorCode: ResearchErrorCode };

export type ResearchDeleteResult = { ok: true } | { ok: false; errorCode: ResearchErrorCode };

export type ResearchStartResult =
  { ok: true; task: ResearchTask } | { ok: false; errorCode: ResearchErrorCode };

export type ResearchStopResult =
  { ok: true; task: ResearchTask } | { ok: false; errorCode: ResearchErrorCode };

// 决议 #107：start 前置状态查询注入点（C1 缺省就绪；C5 接线真实查询）
export type ResearchSourcesState = 'normal' | 'readonly-recovery' | 'unavailable';

export interface ResearchProviderState {
  configured: boolean;
  supportsToolCalling: boolean;
}

// ---------- C5 规划/端口/进度/工厂契约（决议 #133/#134/#135/#138） ----------

// 决议 #133：ResearchPlan 判别联合——全部模型字段视为不可信输入（白名单/
// 类型/长度/数量校验）；groupId 只能引用程序在轮 1 上下文提供的 group 集合；
// selectedCandidateIds 只能引用已合并候选集合（轮 1 时该集合不存在，必须空）
export interface ResearchPlan {
  sourceMode: 'search' | 'group';
  sourceQuery: string; // search 模式必填非空 ≤SEARCH_QUERY_MAX_LENGTH；group 模式必须空串/缺省
  groupId: string | null; // 仅 group 模式非 null；必须 ∈ 程序提供的 group 集合
  webQueries: string[]; // ≤MAX_PLAN_WEB_QUERIES；每项非空 ≤SEARCH_QUERY_MAX_LENGTH
  selectedCandidateIds: string[]; // ≤MAX_SELECTED_SOURCES；必须 ⊆ 已合并候选集合
}

// 决议 #138(1)：进度快照——仅确定性运行事实；phase/status/stats 语义变化
// 才发新快照；事件中零 goal/URL/模型文本/网页正文/Evidence 内容
export interface ResearchProgressEvent {
  taskId: string;
  status: ResearchTaskStatus;
  phase: ResearchPhase | null;
  stats: ResearchTaskStats;
  finishedAt: string | null;
}

// 决议 #134(2)：C6/C7 稳定端口（C5 定义；C6 research-prompts/claim-model、
// C7 result-validator 替换实现——形状冻结，C6/C7 按此实现不得另设）

// 阶段提示词四槽（C6 提供真实常量；verifying 为决议 #134(4) 引入的第四槽）
export interface ResearchPromptsPort {
  planning: string;
  reading: string;
  verifying: string;
  synthesizing: string;
}

export interface ResearchSynthesisContext {
  taskId: string;
  candidates: readonly SourceCandidate[];
  evidence: readonly VerifiedEvidence[];
  createId: () => string; // claimId/conflictId 预分配（主进程可信）
}

// 合成端口（C6 替换）：coverage/sourceTypes/positions≥2/refs∈候选集等
// 确定性装配全部在端口实现内完成——返回的 claims/conflicts 可直接持久化
export interface ResearchSynthesisPort {
  processVerification(
    raw: string,
    ctx: ResearchSynthesisContext,
  ): { ok: true; claims: Claim[]; conflicts: Conflict[] } | { ok: false; reason: string }; // 安全中文 ≤200
  parseResultDraft(raw: string): { ok: true; draft: unknown } | { ok: false; reason: string };
}

export interface ResearchResultValidationContext {
  taskId: string;
  candidates: readonly SourceCandidate[];
  evidence: readonly VerifiedEvidence[]; // evidenceMap 主进程元数据来源
  createId: () => string; // resultId 预分配（主进程可信）
}

// C7 结果校验端口（result-validator 实现；§8.1 校验规则不变）
export interface ResearchResultValidationPort {
  validate(
    draft: unknown,
    ctx: ResearchResultValidationContext,
  ): { ok: true; result: ResearchResult } | { ok: false; reasons: string[] }; // 回注：块索引 + 安全中文原因
}

// 决议 #135：异步 Runtime 工厂（Provider/config/key/tool-support 检查在
// 进入 running 前完成）；launch 失败不得留下永久 running
export interface ResearchRuntimeLaunchInput {
  taskId: string;
  goal: string;
  runToken: string; // 运行身份（Service 生成；slot CAS 与守卫用）
  onProgress: (event: ResearchProgressEvent) => void;
  onSettle: () => void; // 同一运行实例 finally 中调用（Service 按 runToken CAS 清 slot）
}

export interface ResearchRuntimeHandle {
  readonly taskId: string;
  readonly runToken: string;
  readonly done: Promise<void>; // run() 完整收敛（含终态写入与 cleanupAll）
  abort(): void; // 幂等（stop/shutdown 请求）
}

export interface ResearchRuntimeFactory {
  // 异步 Provider 解析：config + credential + supportsToolCalling 检查；
  // 不可用 → null（startTask → research-provider-unavailable，任务零变化）
  resolveProvider(): Promise<unknown>;
  launch(input: ResearchRuntimeLaunchInput): ResearchRuntimeHandle; // 抛错 = 装配失败
}

export interface ResearchService {
  createTask(goal: string): Promise<ResearchCreateResult>;
  getTask(id: string): Promise<ResearchTaskResult>;
  listTasks(opts?: ResearchListOptions): Promise<ResearchListResult>;
  deleteTask(id: string): Promise<ResearchDeleteResult>;
  startTask(id: string): Promise<ResearchStartResult>;
  stopTask(id: string): Promise<ResearchStopResult>;
  shutdown(): Promise<void>; // 决议 #135(7)：幂等 async——abort → await settle → cleanupAll → closeDb
  dispose(): void;
}

// 决议 #109：store 两态装配（normal | unavailable；无备份/恢复态）
export type ResearchStoreOutcome =
  | { mode: 'normal'; service: ResearchService; reason: null }
  | { mode: 'unavailable'; service: null; reason: string };
