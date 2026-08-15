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
  sectionCount: number; // 可见文本章节数
  tableCount: number; // 表格数（行×列合计）
  headingCount: number;
  charCount: number; // 规范化正文总字符（≤ MAX_PAGE_CAPTURE_CHARS）
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
  | { kind: 'table'; row: number; col: number; header: string | null } // 0-based 行列
  | { kind: 'field'; fieldPath: string }; // 提取字段路径（≤MAX_EVIDENCE_LOCATOR_FIELD_PATH_CHARS）

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

export interface ResearchService {
  createTask(goal: string): Promise<ResearchCreateResult>;
  getTask(id: string): Promise<ResearchTaskResult>;
  listTasks(opts?: ResearchListOptions): Promise<ResearchListResult>;
  deleteTask(id: string): Promise<ResearchDeleteResult>;
  startTask(id: string): Promise<ResearchStartResult>;
  stopTask(id: string): Promise<ResearchStopResult>;
  dispose(): void;
}

// 决议 #109：store 两态装配（normal | unavailable；无备份/恢复态）
export type ResearchStoreOutcome =
  | { mode: 'normal'; service: ResearchService; reason: null }
  | { mode: 'unavailable'; service: null; reason: string };
