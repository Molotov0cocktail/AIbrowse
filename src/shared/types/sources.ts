// Fourth Stage B2: Source domain types — single source of truth (detailed-design
// §2, adjudications #49–#57). Shared across main/renderer; the SourceService
// interface lives here so B4 Source Tools can depend on it without Electron imports.
// Tool-facing allowlist/budget/share-mode filtering is applied at the serialization
// layer (B3/B4) — the service-level types below are the full contract.

export type SourceScope = 'origin' | 'page';
export type SourceShareMode = 'full' | 'metadata' | 'blocked';
// 决议 #58：显式读取视角（必填，无缺省）——agent 视角 blocked 完全不可见；
// user 视角 blocked 可见可管理。B4/B5 主进程适配器硬编码，模型参数与
// renderer 原始 payload 均不能自行选择。
export type SourceReadAudience = 'user' | 'agent';
export type SourceTrustValue = 'official' | 'primary' | 'secondary' | 'community' | 'unknown';
export type SourceTrustAssertedBy = 'user' | 'ai';
export type SourceTrustVerification = 'asserted' | 'unverified';
export type SourceCreator = 'user' | 'ai';
export type SourceUsageOutcome =
  'unknown' | 'reachable' | 'unreachable' | 'auth-required' | 'blocked';

export interface SourceTrust {
  value: SourceTrustValue;
  assertedBy: SourceTrustAssertedBy;
  verification: SourceTrustVerification;
}

export interface Source {
  id: string; // UUID（主进程生成）
  scope: SourceScope;
  canonicalKey: string; // 唯一键（origin：规范化 origin；page：去 fragment 规范化完整 URL）
  url: string; // 展示 URL（保留 fragment 与原始输入形态）
  name: string;
  groupId: string | null;
  tags: string[]; // 规范化标签名（NFC + trim，≤32 字符）
  priority: number; // 1–5 整数（默认 3）
  enabled: boolean;
  shareMode: SourceShareMode;
  trust: SourceTrust;
  userNote: string; // 用户明确写下的自然语言备注（'' = 无）
  aiNote: string; // AI 生成的备注（'' = 无）
  createdBy: SourceCreator;
  version: number; // 乐观并发（每次成功提交 +1）
  createdAt: string; // ISO 8601
  updatedAt: string;
  deletedAt: string | null; // soft delete（决议 #51：enabled=0 ⟺ deletedAt≠NULL）
  lastUsedAt: string | null;
  lastUsageOutcome: SourceUsageOutcome | null;
}

export interface SourceGroup {
  id: string;
  name: string;
  createdAt: string;
  deletedAt: string | null;
}

export interface SourceTag {
  id: string;
  name: string; // NFC + trim
  createdAt: string;
}

export interface SourcePatch {
  name?: string;
  url?: string; // 变更需重新规范化（canonical key 变化按新键唯一约束）
  groupName?: string | null; // null = 移出分组；字符串 = 按名幂等 get-or-create
  tags?: string[];
  priority?: number;
  shareMode?: SourceShareMode;
  userNote?: string;
  aiNote?: string;
  trust?: { value: SourceTrustValue; assertedBy: SourceTrustAssertedBy };
  // enabled 不进 patch：disable/restore 为显式 op（决议 #51）
}

export type SourceChangeOp =
  | {
      kind: 'add';
      scope: SourceScope;
      url: string;
      name?: string;
      groupName?: string;
      tags?: string[];
      priority?: number;
      shareMode?: SourceShareMode;
      userNote?: string;
      aiNote?: string;
      trust?: { value: SourceTrustValue; assertedBy: SourceTrustAssertedBy };
    }
  | { kind: 'update'; sourceId: string; expectedVersion: number; patch: SourcePatch }
  | { kind: 'disable'; sourceId: string; expectedVersion: number }
  | { kind: 'restore'; sourceId: string; expectedVersion: number };

export interface SourceChangeSet {
  ops: SourceChangeOp[]; // 1–20 项
}

export interface SourceChangeOpResult {
  opIndex: number;
  ok: boolean;
  sourceId?: string;
  existingSourceId?: string; // source-duplicate 时回注既有条目 id（§7.4「可能相关」）
  errorCode?: SourceErrorCode;
}

export interface SourceChangeResult {
  ok: boolean;
  idempotencyKey: string; // 成功提交时主进程生成；整体拒绝（零写入）时为空串（决议 #53）
  errorCode?: SourceErrorCode; // ok=false 时整组失败码
  results: SourceChangeOpResult[];
}

export type SourceErrorCode =
  | 'source-invalid-change'
  | 'source-version-conflict'
  | 'source-duplicate'
  | 'source-not-found'
  | 'source-forbidden'
  | 'source-limit'
  | 'source-unavailable'
  | 'source-conflict'
  | 'source-undo-conflict' // §7.5：Undo 前当前版本与 journal after 版本不一致
  | 'source-undo-not-found'; // §7.5：未知/已消费（重复 Undo 安全无操作）幂等键

// --- 服务层视图与结果（B2 冻结；工具层 allowlist/预算/分享模式过滤由 B3/B4 在
// 序列化层裁剪，服务层类型不变） ---

export interface SourceListItem {
  id: string;
  scope: SourceScope;
  canonicalKey: string;
  url: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
  tags: string[];
  priority: number;
  enabled: boolean;
  trust: SourceTrust;
  shareMode: SourceShareMode;
  lastUsedAt: string | null;
  // 永不含 note 正文（决议 #59）——note 摘录只在 SourceSearchItem 上按 §8.2 规则出现
}

export interface SourceView extends Source {
  groupName: string | null; // 服务层视图（UI 手工路径需要 version/deletedAt；工具序列化按 §8.1 裁剪）
}

// 决议 #59：搜索结果条目独立类型——note 摘录只在此类型出现，SourceListItem 永不含 note
export interface SourceSearchNote {
  userNote: string | null; // ≤200 字符截断 + 控制/bidi 剔除后的正文（null = 无）
  aiNote: string | null;
}

export interface SourceSearchItem extends SourceListItem {
  // note 仅 agent 视角 + shareMode='full' + 对应 note 非空时携带；
  // user 视角与 metadata 条目恒 null（零 note 字节，决议 #59/#58）
  note: SourceSearchNote | null;
}

export type SourceSearchResult =
  | { ok: true; query: string; results: SourceSearchItem[] }
  | { ok: false; errorCode: SourceErrorCode };

export type SourceListResult =
  | { ok: true; page: number; pageSize: number; total: number; items: SourceListItem[] }
  | { ok: false; errorCode: SourceErrorCode };

export type SourceResult =
  { ok: true; source: SourceView } | { ok: false; errorCode: SourceErrorCode };

export interface ManualAddInput {
  scope: SourceScope;
  url: string;
  name?: string;
  groupName?: string;
  tags?: string[];
  priority?: number;
  shareMode?: SourceShareMode; // 手工通道可显式设 blocked（决议 #36 通道边界不变）
  userNote?: string;
  aiNote?: string;
  trust?: { value: SourceTrustValue }; // 手工通道：assertedBy 恒 'user'、verification 恒 'asserted'
}

export interface ManualPatch {
  name?: string;
  url?: string;
  groupName?: string | null;
  tags?: string[];
  priority?: number;
  shareMode?: SourceShareMode;
  userNote?: string;
  aiNote?: string;
  trust?: { value: SourceTrustValue };
}

export type ManualWriteResult =
  | { ok: true; source: SourceView; idempotencyKey: string; undoable: boolean }
  | { ok: false; errorCode: SourceErrorCode };
// hardDeleteManual 成功：source = 删除前最终视图、idempotencyKey = ''、undoable = false（不可 Undo）

export type UndoResult =
  | { ok: true }
  | {
      ok: false;
      errorCode: 'source-undo-conflict' | 'source-undo-not-found' | 'source-unavailable';
    };

export interface UndoableChange {
  idempotencyKey: string;
  changeType: 'agent-change-set' | 'manual';
  appliedAt: string;
  sourceIds: string[];
  summary: string; // 中文字段级摘要（版本区间「新增@vN / a→b」，note 正文零出现）
}

export interface SourceService {
  readonly id: string; // 'sources'
  // 检索（§8；audience 必填——决议 #58：agent 视角 blocked 不可见，user 视角可见可管理）
  search(
    query: string,
    opts: { limit?: number; audience: SourceReadAudience },
  ): Promise<SourceSearchResult>; // 默认/硬上限 10
  list(opts: {
    page: number;
    pageSize?: number;
    groupId?: string | null;
    enabledOnly?: boolean;
    audience: SourceReadAudience;
  }): Promise<SourceListResult>; // 每页 ≤20
  get(id: string, audience: SourceReadAudience): Promise<SourceResult>;
  // 写入（Agent change set，§7）
  applyChangeSet(
    cs: SourceChangeSet,
    meta: { runId: string; toolCallId: string },
  ): Promise<SourceChangeResult>;
  // 手工操作（UI 通道，同一事务/审计/journal 语义）
  addManual(input: ManualAddInput): Promise<ManualWriteResult>;
  updateManual(id: string, patch: ManualPatch, expectedVersion: number): Promise<ManualWriteResult>;
  disableManual(id: string, expectedVersion: number): Promise<ManualWriteResult>;
  restoreManual(id: string, expectedVersion: number): Promise<ManualWriteResult>;
  hardDeleteManual(id: string, confirmToken: string): Promise<ManualWriteResult>; // 二次确认，不可 Undo
  // 硬删除确认令牌（决议 #56）：主进程调用方（B5 UI 接线）先签发、用户二次确认后消费
  issueDeleteConfirmToken(sourceId: string): string;
  // Undo（§7.5）
  undoChange(idempotencyKey: string): Promise<UndoResult>;
  listUndoable(): Promise<UndoableChange[]>; // 最近 100 条有界
  // usage（§11；B2 最小 upsert，UsageTracker 归 B7）
  recordUsage(sourceId: string, outcome: SourceUsageOutcome): Promise<void>;
  // 恢复态（§10；B2 恒 normal，装配归 B7）
  getState(): { mode: 'normal' | 'readonly-recovery'; reason: string | null };
  dispose(): void;
}
