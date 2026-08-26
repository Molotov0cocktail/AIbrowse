// Sixth Stage Watch shared types — D1 logger/Clock 基座 + D2 域契约单一事实源。
// Contract source: doc/stage6/detailed-design.md §2 (budget constants)、§3 (domain
// types)、§5 (condition)、§9.3/§9.4 (Evidence/Event)、§10.3 (Source 生命周期)、
// §11 (Digest DTO)、§4.1 (Clock/TimeZone)。D1 只拥有：日志预算常量 + Clock/
// TimerHandle/TimeZoneResolver 所需共享类型。D2 负责其余 Watch DTO、判别联合与
// 全部预算常量；D1 不得提前落地 D2 域类型。
// 纯类型/常量声明：main/preload/renderer 可复用（verbatimModuleSyntax 下类型导入用 import type）。
// 本文件不 import 任何运行时代码（renderer-safe）。所有 §2 常量精确值由
// src/shared/watch/watch-types.test.ts 逐项断言。

// ---------------------------------------------------------------------------
// D1：日志预算常量 + Clock 基座类型（detailed-design §2/§4.1；字符串预算用
// Buffer.byteLength('utf8')，D2 watch-budget 提供工具）
// ---------------------------------------------------------------------------

export const MAX_LOG_LINE_BYTES = 8192;
export const MAX_LOG_FILE_BYTES = 10485760;
export const MAX_LOG_FILES = 10;
export const MAX_LOG_AGE_DAYS = 14;

/** 不透明 timer handle：只允许传回 clearTimeout，禁止对内部结构做任何操作。 */
export interface TimerHandle {
  readonly kind: 'timer';
  readonly id: number;
}

/** 可注入 Clock（detailed-design §4.1）：确定性时间与 timer 控制的唯一入口。 */
export interface Clock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** daily 计划时区解析（detailed-design §4.1）：计算 after 之后第一个有效本地时刻 instant。 */
export interface TimeZoneResolver {
  nextDailyInstant(input: {
    after: Date;
    localTime: string;
    timeZone: string;
    lastLocalDate: string | null;
  }): { instant: Date; localDate: string } | null;
}

// ---------------------------------------------------------------------------
// D2：§2 预算常量（单一事实源；后续模块只能从这里唯一导入，禁止散落魔法数字）
// ---------------------------------------------------------------------------

// 规则与调度
export const MAX_WATCH_RULES_TOTAL = 200; // 包含暂停规则
export const MAX_WATCH_RULES_ENABLED = 100; // 实际可调度上限
export const MAX_GLOBAL_WATCH_RUNS = 4; // 全局 acquisition 并发
export const MAX_HOST_WATCH_RUNS = 1; // canonical host 并发
export const MIN_HOST_REQUEST_GAP_MS = 5_000; // 同 canonical host 请求起点间隔
export const MAX_DUE_STARTS_PER_TICK = 20; // 单次唤醒启动数
export const WATCH_RUN_TIMEOUT_MS = 90_000; // 单规则总时间
export const NETWORK_ATTEMPT_TIMEOUT_MS = 30_000; // 单网络尝试
export const MAX_REDIRECTS = 5; // 每跳复验

// XML / Feed
export const MAX_FEED_RESPONSE_BYTES = 2_097_152; // 解析前硬拒绝
export const MAX_XML_DEPTH = 64; // XML 元素深度硬上限
export const MAX_XML_NODES = 20_000; // XML start/text 事件总数
export const MAX_XML_NAME_BYTES = 256; // 单 QName/localName/namespace
export const MAX_XML_ATTRIBUTES_PER_TAG = 64; // 单元素属性数量
export const MAX_XML_ATTRIBUTE_BYTES = 4_096; // 单属性名和值合计
export const MAX_XML_TEXT_NODE_BYTES = 8_192; // 单次累计文本节点
export const MAX_XML_TOTAL_TEXT_BYTES = 131_072; // 单文档规范化文本累计
export const MAX_DISCOVERY_HTML_BYTES = 262_144; // 仅内存扫描

// 公开页面 HTML / 投影
export const MAX_PAGE_HTML_RESPONSE_BYTES = 2_097_152; // 公开页面 HTML 流硬上限
export const MAX_HTML_NODES = 20_000; // SAX 事件节点上限
export const MAX_HTML_DEPTH = 64; // 元素栈深度上限
export const MAX_HTML_ATTRIBUTES_PER_TAG = 64; // 单标签属性上限
export const MAX_FEED_ITEMS = 200; // 按 feed 顺序前 200 条
export const MAX_FEED_FIELD_BYTES = 4_096; // 单标题/摘要/标识等
export const MAX_FEED_PROJECTION_BYTES = 262_144; // FeedProjection 整体硬上限
export const MAX_REGIONS_PER_RULE = 10; // 页面区域数
export const MAX_PAGE_PROJECTION_BYTES = 65_536; // 单 Baseline 投影
export const MAX_PROJECTION_FIELDS = 50; // 类型化字段数

// 条件 / 证据 / Digest
export const MAX_CONDITIONS_PER_RULE = 10; // 一层 all/any
export const MAX_EVIDENCE_VALUE_BYTES = 4_096; // 单侧单条摘录
export const MAX_EVENT_EVIDENCE_BYTES = 32_768; // Event 所有双侧 Evidence 合计
export const MAX_DIGEST_BYTES = 65_536; // 持久化 Digest 投影
export const MAX_DIGEST_EVENTS = 50; // 单 Digest
export const MAX_DIGEST_PROVIDER_CALLS = 1; // 单 Digest

// 存储 / 保留 / 网络 / 缓存
export const MAX_WATCH_DB_BYTES = 104_857_600; // 100 MiB 逻辑预算；每次写前估算
export const PUBLIC_EVENT_RETENTION_DAYS = 90; // 与数量上限同时生效
export const PUBLIC_EVENTS_PER_RULE = 200; // 公开规则
export const SESSION_EVENT_RETENTION_DAYS = 30; // 登录规则
export const SESSION_EVENTS_PER_RULE = 100; // 登录规则
export const EVENT_COALESCE_WINDOW_MS = 1_800_000; // 30 分钟
export const ROBOTS_CACHE_MS = 86_400_000; // 24 小时；失败不假定允许

// §11.1：Digest Schedule 绑定明确 sourceIds（1..100）
export const MAX_DIGEST_SCHEDULE_SOURCES = 100;

// ---------------------------------------------------------------------------
// D2：闭合 union 数组（校验/测试用编译期常量；类型从数组派生）
// ---------------------------------------------------------------------------

export const WATCH_RULE_KINDS = ['feed', 'page'] as const;
export const WATCH_ACCESS_MODES = ['public', 'session'] as const;
export const WATCH_RULE_STATES = ['enabled', 'paused', 'deleted'] as const;
export const PAUSE_REASONS = [
  'user',
  'source-disabled',
  'source-deleted',
  'source-changed',
  'login-required',
  'captcha',
  'parse-changed',
  'robots-disallowed',
  'security-rejected',
  'dependency-unavailable',
] as const;
export const WATCH_INTERVAL_MINUTES = [15, 60, 360, 1440] as const;
export const CONDITION_OPERATORS = [
  'equals',
  'not-equals',
  'contains',
  'not-contains',
  'changed',
  'increased',
  'decreased',
  'crosses-above',
  'crosses-below',
  'event-kind-is',
] as const;
export const WATCH_FAILURE_CODES = [
  'login_required',
  'captcha',
  'parse_changed',
  'unavailable',
  'robots_disallowed',
  'security_rejected',
  'budget_exceeded',
  'dependency_unavailable',
  'interrupted',
] as const;
export const WATCH_EVENT_KINDS = ['added', 'removed', 'changed', 'reversal', 'mixed'] as const;
export const WATCH_NOTIFICATION_LEVELS = ['normal', 'important'] as const;
export const WATCH_HEALTH_STATES = ['healthy', 'degraded', 'paused'] as const;
export const WATCH_ACQUISITIONS = ['rss', 'browser'] as const;
export const REGION_KINDS = ['main-text', 'headings', 'table', 'links'] as const;
export const FEED_FORMATS = ['rss2', 'atom'] as const;
export const COMBINE_MODES = ['all', 'any'] as const;
export const SOURCE_WATCH_OPERATIONS = [
  'create',
  'update',
  'disable',
  'restore',
  'undo',
  'hard-delete',
] as const;
export const WATCH_SHARING_MODES = ['full', 'metadata', 'blocked'] as const;
export const DIGEST_EVENT_REF_STATES = ['active', 'expired', 'user-deleted'] as const;

export type WatchRuleKind = (typeof WATCH_RULE_KINDS)[number];
export type WatchAccessMode = (typeof WATCH_ACCESS_MODES)[number];
export type WatchRuleState = (typeof WATCH_RULE_STATES)[number];
export type PauseReason = (typeof PAUSE_REASONS)[number];
export type WatchIntervalMinutes = (typeof WATCH_INTERVAL_MINUTES)[number];
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export type WatchFailureCode = (typeof WATCH_FAILURE_CODES)[number];
export type WatchEventKind = (typeof WATCH_EVENT_KINDS)[number];
export type WatchNotificationLevel = (typeof WATCH_NOTIFICATION_LEVELS)[number];
export type WatchHealthState = (typeof WATCH_HEALTH_STATES)[number];
export type WatchAcquisition = (typeof WATCH_ACQUISITIONS)[number];
export type RegionKind = (typeof REGION_KINDS)[number];
export type FeedFormat = (typeof FEED_FORMATS)[number];
export type CombineMode = (typeof COMBINE_MODES)[number];
export type SourceWatchOperation = (typeof SOURCE_WATCH_OPERATIONS)[number];
export type WatchSharingMode = (typeof WATCH_SHARING_MODES)[number];
export type DigestEventRefState = (typeof DIGEST_EVENT_REF_STATES)[number];

// ---------------------------------------------------------------------------
// D2：§3.1 Rule 与调度
// ---------------------------------------------------------------------------

// intervalMinutes 仅允许固定预设；不支持 cron（决策 3）
export type WatchSchedule =
  | { kind: 'interval'; intervalMinutes: WatchIntervalMinutes }
  | {
      kind: 'daily';
      localTime: `${string}:${string}`; // validator 固定 HH:mm 00:00..23:59（复用 D1 isValidLocalTime）
      timeZone: string; // Intl 支持的 IANA id，创建/编辑时冻结（复用 D1 isValidTimeZone）
    };

export interface WatchRule {
  id: string; // UUID
  sourceId: string;
  kind: WatchRuleKind;
  state: WatchRuleState;
  pauseReason: PauseReason | null;
  desiredEnabled: boolean; // 只表达用户意图：用户 pause=false、用户 enable=true；Source 生命周期不覆盖
  muted: boolean; // 只抑制即时通知，不改变 state/nextDueAt/调度资格
  accessMode: WatchAccessMode; // feed 仅 public；session 仅 page
  schedule: WatchSchedule;
  target: FeedTarget | PageTarget;
  condition: StructuredCondition | null;
  notificationLevel: WatchNotificationLevel; // 用户选择，不由 AI 推断
  sourceRowVersion: number; // 最后观察到的 Source 行版本（乐观并发；不决定 locator 变化）
  sourceLocatorFingerprint: string; // locator 身份（决定 locator 是否变化）
  nextDueAt: string | null;
  lastConsumedScheduledFor: string | null;
  lastDailyLocalDate: string | null;
  consecutiveFailures: number;
  backoffUntil: string | null;
  baselineVersion: number;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// D2：§3.2 目标与投影
// ---------------------------------------------------------------------------

export interface FeedTarget {
  type: 'feed';
  feedUrl: string;
  format: FeedFormat;
}

export type RegionDescriptor =
  | { kind: 'main-text'; label: string }
  | { kind: 'headings'; label: string; levels: Array<1 | 2 | 3> }
  | { kind: 'table'; label: string; headerFingerprint: string; occurrence: number }
  | { kind: 'links'; label: string; sameOriginOnly: boolean };

export interface PageTarget {
  type: 'page';
  pageUrl: string;
  regions: RegionDescriptor[]; // ≤ MAX_REGIONS_PER_RULE
  sessionConsent: { version: 1; origin: string; grantedAt: string } | null;
}

export interface ProjectionEnvelope<T> {
  schemaVersion: 1;
  ruleId: string;
  sourceId: string;
  finalUrl: string;
  capturedAt: string;
  documentId: string | null;
  contentHash: string;
  byteLength: number;
  value: T;
}

export interface DocumentChannels {
  mainText: string;
  headings: Array<{ level: 1 | 2 | 3; text: string }>;
  tables: Array<{ headers: string[]; rows: string[][] }>;
  links: Array<{ text: string; url: string }>;
}

// ---------------------------------------------------------------------------
// D2：§3.3 Run、Health 与 Audit
// ---------------------------------------------------------------------------

export type WatchHealthSnapshot =
  | { state: 'healthy'; acquisition: WatchAcquisition; code: null }
  | {
      state: Extract<WatchHealthState, 'degraded' | 'paused'>;
      acquisition: WatchAcquisition;
      code: WatchFailureCode;
    };

export type WatchRunOutcome =
  | { kind: 'baseline-established'; auditId: string }
  | { kind: 'unchanged' }
  | { kind: 'changed-unmatched'; changeFingerprint: string }
  | { kind: 'event-created'; eventId: string }
  | { kind: 'event-deduplicated'; eventId: string }
  | { kind: 'failed'; health: WatchFailureCode; retryable: boolean }
  | { kind: 'aborted'; reason: 'shutdown' | 'user' | 'superseded' };

export const WATCH_RUN_TRIGGERS = ['scheduled', 'catch-up', 'manual'] as const;
export type WatchRunTrigger = (typeof WATCH_RUN_TRIGGERS)[number];

// watch_runs 表（§10.1）投影 DTO：requestKey = ruleId|scheduledFor（reservation）
// 或手动唯一 requestId；trigger 标 catch-up/scheduled/manual（§4.2）。
export interface WatchRun {
  id: string;
  ruleId: string;
  requestKey: string;
  trigger: WatchRunTrigger;
  scheduledFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: WatchRunOutcome | null;
  health: WatchHealthSnapshot | null;
}

// ---------------------------------------------------------------------------
// D2：§5 确定性结构化条件
// ---------------------------------------------------------------------------

export interface ConditionPredicate {
  fieldKey: string; // 必须来自调用方提供的闭合字段目录；拒绝原型链键/通配符/数组索引/嵌套路径
  operator: ConditionOperator;
  operand: string | number | null;
  caseSensitive: boolean;
}

export interface StructuredCondition {
  version: 1; // 未来版本 fail-closed
  combine: CombineMode; // 一层 all/any
  predicates: ConditionPredicate[]; // 1..MAX_CONDITIONS_PER_RULE，禁止嵌套
}

// ---------------------------------------------------------------------------
// D2：§9.3 Evidence
// ---------------------------------------------------------------------------

export type EvidenceValue =
  | {
      kind: 'present';
      excerpt: string;
      valueHash: string;
      normalizedBytes: number; // 截断前规范化字节数
      truncated: boolean;
    }
  | { kind: 'absent' };

export interface ChangeEvidencePair {
  itemId: string;
  fieldKey: string;
  label: string;
  before: EvidenceValue;
  after: EvidenceValue;
  beforeCapturedAt: string;
  afterCapturedAt: string;
  beforeFinalUrl: string;
  afterFinalUrl: string;
  beforeDocumentId: string | null;
  afterDocumentId: string | null;
  feedItemKey: string | null;
}

// ---------------------------------------------------------------------------
// D2：§9.4 Event 与幂等
// ---------------------------------------------------------------------------

export interface WatchEvent {
  id: string;
  ruleId: string;
  sourceId: string;
  eventKind: WatchEventKind;
  importance: WatchNotificationLevel; // 取 Rule 的用户选择，不由 AI 推断
  idempotencyKey: string; // SHA-256(ruleId|baselineVersion|newProjectionHash|conditionVersion)
  changeFingerprint: string;
  firstObservedAt: string;
  lastObservedAt: string;
  itemCount: number;
  readAt: string | null;
}

// ---------------------------------------------------------------------------
// D2：§10.3 Source 生命周期跨库协议（窄投影；D2 只建契约 + 状态协调纯函数）
// ---------------------------------------------------------------------------

export interface SourceWatchProjection {
  sourceId: string;
  rowVersion: number; // 行级乐观并发版本（不决定 locator 变化）
  enabled: boolean;
  deletedAt: string | null;
  scope: 'origin' | 'page';
  canonicalKey: string;
}

export interface SourceWatchMutation {
  mutationId: string; // UUID
  operation: SourceWatchOperation;
  before: SourceWatchProjection | null;
  after: SourceWatchProjection | null;
}

export interface SourceLifecycleObserver {
  prepare(
    changes: SourceWatchMutation[],
  ): { ok: true } | { ok: false; reason: 'watch-unavailable' };
  commit(mutationIds: string[]): { ok: true } | { ok: false; reason: 'watch-unavailable' };
  abort(mutationIds: string[]): void;
}

// ---------------------------------------------------------------------------
// D2：§11 Digest（D2 只声明契约，不实现运行行为——D8 负责实现）
// ---------------------------------------------------------------------------

// §11.1：绑定明确 sourceIds（1..100，创建时冻结）；只生成每日计划（localTime/
// timeZone 使用 §4 时区语义）；独立 cursor=(createdAt,eventId)；ai_enabled 显式启用。
export interface DigestSchedule {
  id: string;
  sourceIds: string[]; // 1..MAX_DIGEST_SCHEDULE_SOURCES
  localTime: string; // HH:mm（每日计划）
  timeZone: string; // IANA（创建/编辑时冻结）
  aiEnabled: boolean;
  cursor: { createdAt: string; eventId: string } | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
}

// §11.2：程序事实（确定性；D8 生成，模型不可控制）
export interface DigestRunStats {
  changed: number;
  failed: number;
  unchanged: number;
}

export interface DigestEventProjection {
  eventId: string;
  ruleId: string;
  sourceId: string;
  eventKind: WatchEventKind;
  importance: WatchNotificationLevel;
  firstObservedAt: string;
  lastObservedAt: string;
  itemCount: number;
  readAt: string | null;
}

export interface DigestFacts {
  scheduleId: string;
  period: { from: string; to: string };
  eventCount: number;
  runStats: DigestRunStats;
  events: DigestEventProjection[]; // 排序后 Event 投影，≤ MAX_DIGEST_EVENTS；超出分批
  evidenceMap: Record<string, ChangeEvidencePair[]>; // eventId → 有界双侧 Evidence
  referenceStates: Record<string, DigestEventRefState>; // eventId → 过期/删除引用状态
  fetchedAt: string; // 程序生成
}

// §11.4：模型只返回该不可信草案（strict whitelist；DigestValidator，D8）
export interface ExplanationDraft {
  sections: ExplanationDraftSection[];
}
export interface ExplanationDraftSection {
  eventIds: string[]; // 必须存在且对当前模型投影可见；未知/重复/blocked 整份拒绝
  explanation: string;
}
