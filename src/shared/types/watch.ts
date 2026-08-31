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
export const MAX_CONDITIONAL_FIELD_BYTES = 1_024; // ETag/Last-Modified 单字段（§2/#S6-056）
export const MAX_RUN_RESPONSE_META_BYTES = 4_096; // Run 响应/Condition 元数据整体（§8.1/#S6-058）
export const MAX_DIGEST_BYTES = 65_536; // 持久化 Digest 投影
export const MAX_DIGEST_FACTS_BYTES = 49_152;
export const MAX_DIGEST_EXPLANATION_BYTES = 12_288;
export const MAX_DIGEST_PROVIDER_REQUEST_BYTES = 65_536;
export const MAX_DIGEST_PROVIDER_OUTPUT_BYTES = 16_384;
export const MAX_DIGEST_EXPLANATION_SECTIONS = 50;
export const MAX_DIGEST_EXPLANATION_SECTION_CHARS = 1_000;
export const MAX_DIGEST_EXPLANATION_SECTION_BYTES = 2_048;
export const MAX_DIGEST_EXPLANATION_TOTAL_CHARS = 6_000;
export const MAX_DIGEST_EVENTS = 50; // 单 Digest
export const MAX_DIGEST_PROVIDER_CALLS = 1; // 单 Digest

// 存储 / 保留 / 网络 / 缓存
export const MAX_WATCH_DB_BYTES = 104_857_600; // 100 MiB 逻辑预算；每次写前估算
export const MAX_ROBOTS_RESPONSE_BYTES = 512_000; // robots 独立响应/解析上限（RFC 9309 §2.5 最低 500 KiB，不复用 discovery 预算）
export const MAX_ROBOTS_RULES = 1024; // robots.txt 规则条数上限（D3 防御纵深；文件本身 512,000-byte 有界）
export const MAX_DISCOVERY_CANDIDATES = 10; // feed discovery 候选上限（detailed-design §6.3）
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
  'condition_error',
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

export type DigestScheduleState = 'active' | 'paused';
export type DigestRunState = 'running' | 'budget_exceeded' | 'completed';
export type DigestProviderState =
  'disabled' | 'pending' | 'claimed' | 'succeeded' | 'failed' | 'uncertain' | 'skipped';
export type DigestProviderResultCode =
  | 'disabled'
  | 'success'
  | 'provider-error'
  | 'timeout'
  | 'aborted'
  | 'invalid-output'
  | 'uncertain-after-restart'
  | 'no-visible-events'
  | 'request-budget'
  | 'key-unavailable';

export interface DigestExplanationSection {
  eventIds: string[];
  explanation: string;
}

export interface DigestExplanation {
  sections: DigestExplanationSection[];
}

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
// D6：有界 PageProjection 闭合类型（detailed-design §8；字段 key 固定目录直接
// 成为 D2 Condition 的闭合 fieldKey 目录，禁止另存可漂移副本）
// ---------------------------------------------------------------------------

export type PageProjectionField =
  | {
      fieldKey: string;
      regionIndex: number;
      kind: 'main-text';
      label: string;
      value: string;
    }
  | {
      fieldKey: string;
      regionIndex: number;
      kind: 'heading';
      label: string;
      level: 1 | 2 | 3;
      ordinal: number;
      value: string;
    }
  | {
      fieldKey: string;
      regionIndex: number;
      kind: 'table-header';
      label: string;
      occurrence: number;
      column: number;
      value: string;
    }
  | {
      fieldKey: string;
      regionIndex: number;
      kind: 'table-cell';
      label: string;
      occurrence: number;
      row: number;
      column: number;
      columnLabel: string;
      value: string;
    }
  | {
      fieldKey: string;
      regionIndex: number;
      kind: 'link';
      label: string;
      ordinal: number;
      text: string;
      url: string;
    };

export interface PageProjectionValue {
  type: 'page';
  fields: PageProjectionField[];
}

export type PageProjection = ProjectionEnvelope<PageProjectionValue>;

// D6 Session grant（§12.2）：主进程内存一次性授权记录 TTL（精确 300,000ms；
// now == expiresAt 视为已过期）
export const SESSION_GRANT_TTL_MS = 300_000;

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
  | { kind: 'event-coalesced'; eventId: string }
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
// D7：#S6-054/#S6-056/#S6-058 Acquisition → Processing 窄接口（§8.1）——
// 统一判别联合与不可变 Baseline hint；Feed/Page 共用同一 processing service。
// ---------------------------------------------------------------------------

/** §8.1：acquisition 前由 ProcessingService 经 Repository 验证 Baseline 产出的不可变 hint。 */
export type WatchBaselineHint =
  | { kind: 'none'; expectedBaselineVersion: 0 }
  | {
      kind: 'feed';
      expectedBaselineVersion: number;
      contentHash: string;
      validators: { etag: string | null; lastModified: string | null };
    }
  | {
      kind: 'page';
      expectedBaselineVersion: number;
      contentHash: string;
    };

export interface WatchAcquisitionInput {
  rule: WatchRule;
  baselineHint: WatchBaselineHint;
  signal: AbortSignal;
  deadlineMs: number;
}

/** §7/§8：页面采集闭合 disposition（D6 定义；D7 统一 acquisition 判别联合复用）。 */
export type PageAcquisitionDisposition =
  | 'ok'
  | 'aborted'
  | 'consent-missing'
  | 'consent-mismatch'
  | 'origin-mismatch'
  | 'source-changed'
  | 'login'
  | 'captcha'
  | 'suspicious'
  | 'tab-error'
  | 'tab-closed-by-user'
  | 'tab-missing'
  | 'timeout'
  | 'snapshot-invalid'
  | 'cleanup-failed'
  | 'workspace-failed'
  | 'network'
  | 'robots'
  | 'budget'
  | 'parse'
  | 'security'
  | 'redirect-status'
  | 'protocol'
  | 'invalid-target'
  | 'internal';

export type AcquiredProjection = FeedProjection | PageProjection;

/** §8.1：WatchAcquisitionResult 统一判别联合（D7 替换 D5 的 {ok:true} 占位）。 */
export type WatchAcquisitionResult =
  | {
      ok: true;
      kind: 'projection';
      projection: AcquiredProjection;
      expectedSourceLocatorFingerprint: string;
      responseMetadata: ConditionalResponseMetadata | null;
    }
  | {
      ok: true;
      kind: 'not-modified'; // 仅 Feed + 已存在 Baseline
      finalUrl: string;
      fetchedAt: string;
      expectedSourceLocatorFingerprint: string;
      responseMetadata: ConditionalResponseMetadata;
    }
  | {
      ok: false;
      health: WatchFailureCode;
      retryable: boolean;
      retryAfterSeconds: number | null;
      disposition: FeedAcquisitionDisposition | PageAcquisitionDisposition;
    };

/** §8.1：统一 processing service 端口（ProcessingService 是唯一 main-process 编排者）。 */
export interface WatchProcessingService {
  prepareAcquisition(input: {
    rule: WatchRule;
  }): { ok: true; baselineHint: WatchBaselineHint } | { ok: false; code: 'store-unavailable' };

  process(input: {
    rule: WatchRule;
    runId: string;
    baselineHint: WatchBaselineHint;
    acquisition: Extract<WatchAcquisitionResult, { ok: true }>;
    sourceAfterAcquisition: SourceWatchProjection;
  }): WatchProcessingResult;
}

export type WatchProcessingResult =
  | { ok: true; outcome: WatchRunOutcome }
  | {
      ok: false;
      code:
        | 'identity-conflict'
        | 'baseline-conflict'
        | 'event-conflict'
        | 'validation-failed'
        | 'budget-exceeded'
        | 'store-unavailable';
      terminalWritten: false;
    };

/** §8.1/#S6-058：Run 成功/失败终态统一 exact-key 元数据（只作有界诊断，不作条件请求输入）。 */
export interface WatchRunResponseMetadata {
  schemaVersion: 1;
  http: null | ConditionalResponseMetadata;
  conditionWarnings: ConditionWarningCode[];
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

// §5/#S6-058：Condition 不匹配的闭合 warning（unsupported/no-match，不是 error）。
// warnings 去重后按编译期顺序排序，只进入有界 Run response metadata/UI 安全文案。
export type ConditionWarningCode =
  'field-absent' | 'numeric-value-unavailable' | 'operator-not-applicable';

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
  version: number;
  sourceIds: string[]; // 1..MAX_DIGEST_SCHEDULE_SOURCES
  localTime: string; // HH:mm（每日计划）
  timeZone: string; // IANA（创建/编辑时冻结）
  aiEnabled: boolean;
  cursor: { changeSequence: number };
  state: DigestScheduleState;
  nextDueAt: string;
  lastConsumedScheduledFor: string | null;
  lastDailyLocalDate: string | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastPeriod: { fromExclusive: string; toInclusive: string } | null;
  lastRunStats: DigestRunStats | null;
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
  firstIncludedAt: string;
  lastIncludedAt: string;
  observationCount: number;
  itemCount: number;
}

export interface DigestFacts {
  schemaVersion: 1;
  scheduleId: string;
  digestRunId: string;
  batchIndex: number;
  period: { fromExclusive: string; toInclusive: string };
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

// ---------------------------------------------------------------------------
// D3：§6.4 Feed 投影最小稳定类型（D3 追加；不改 D2 常量/union 语义）
// ---------------------------------------------------------------------------

/** 单个 Feed 文本字段：UTF-8 字节安全截断并标记（§6.4：不把截断值冒充完整值）。 */
export interface FeedField {
  text: string;
  truncated: boolean;
  originalBytes: number; // 截断前规范化 UTF-8 字节数
  valueHash: string; // #S6-046：截断前完整规范化值 SHA-256（小写 64 hex），D7 Evidence 只消费该值
}

/** Feed item 稳定 identity（§6.4：Atom id / RSS guid 首选，其次 canonical link，最后受控复合键）。 */
export type FeedIdentityKind = 'id' | 'guid' | 'link' | 'composite';

/** 有界 Feed item（§6.4：字段逐项 ≤ MAX_FEED_FIELD_BYTES 且标记截断；整体随 FeedProjection 预算）。 */
export interface FeedItem {
  identity: string; // 稳定 identity（去重键；§6.4）
  identityKind: FeedIdentityKind;
  title: FeedField;
  link: FeedField; // RSS item link / Atom entry alternate link（规范化文本，仅作数据）
  summary: FeedField; // RSS description / Atom summary 或 content（纯文本安全子集）
  publishedAt: FeedField | null; // RSS pubDate / Atom published（缺省用 updated）
  updatedAt: FeedField | null; // Atom updated；RSS 无则 null
  author: FeedField; // Atom author/name；RSS item author
}

/** Feed 投影 value（§6.4/#S6-054：FeedParser 只拥有 XML→规范化 value 的 canonical JSON）。 */
export interface FeedProjectionValue {
  type: 'feed';
  format: FeedFormat; // 'rss2' | 'atom'
  title: FeedField; // channel title / feed title
  description: FeedField; // channel description / feed subtitle
  siteUrl: FeedField; // channel link / feed alternate link
  feedUrl: FeedField; // Atom feed link rel=self；RSS 无则空
  items: FeedItem[];
  itemsTruncated: boolean; // 遇到第 MAX_FEED_ITEMS+1 项停止收集并标记（§6.4）
}

/**
 * FeedParser 闭合结果（#S6-054：FeedParser 只产 value + canonical JSON，不伪造
 * acquisition 元数据）。canonicalJson 必须逐字节等于固定键序 JSON.stringify(value)。
 */
export type ParsedFeedProjection =
  | { ok: true; value: FeedProjectionValue; canonicalJson: string; byteLength: number }
  | { ok: false; health: WatchFailureCode; reason: FeedParseReasonCode };

export type FeedParseReasonCode =
  | 'encoding-invalid'
  | 'xml-security-rejected'
  | 'xml-budget-exceeded'
  | 'xml-shape-invalid'
  | 'projection-invalid'
  | 'dependency-unavailable';

/** 完整 Feed envelope（§6.4：FeedAcquisitionService 盖章 ruleId/sourceId/capturedAt、contentHash）。 */
export type FeedProjection = ProjectionEnvelope<FeedProjectionValue>;

export type FeedAcquisitionDisposition =
  | 'ok'
  | 'not-modified'
  | 'first-baseline-304'
  | 'network'
  | 'robots'
  | 'security'
  | 'budget'
  | 'parse'
  | 'dependency'
  | 'aborted'
  | 'internal';

/** §6.4/#S6-056：条件请求响应元数据 exact-key；两个字符串 UTF-8 ≤ MAX_CONDITIONAL_FIELD_BYTES。 */
export interface ConditionalResponseMetadata {
  httpStatus: 200 | 304;
  etag: string | null;
  lastModified: string | null;
  warnings: ('etag-oversize' | 'last-modified-oversize')[];
}

/** Feed acquisition 闭合结果（§6.4）。 */
export type FeedAcquisitionResult =
  | {
      ok: true;
      kind: 'projection';
      projection: FeedProjection;
      expectedSourceLocatorFingerprint: string;
      responseMetadata: ConditionalResponseMetadata;
    }
  | {
      ok: true;
      kind: 'not-modified';
      finalUrl: string;
      fetchedAt: string;
      expectedSourceLocatorFingerprint: string;
      responseMetadata: ConditionalResponseMetadata;
    }
  | {
      ok: false;
      health: WatchFailureCode;
      retryable: boolean;
      retryAfterSeconds: number | null;
      disposition: FeedAcquisitionDisposition;
    };

/** Feed discovery 候选（detailed-design §6.3：最多 MAX_DISCOVERY_CANDIDATES，文档序，canonical URL 去重）。 */
export interface FeedDiscoveryCandidate {
  url: string; // 规范化且经 NetworkPolicy 纯 URL 校验的 http/https 地址
  rel: string; // 规范化 rel（小写 token 拼接）
  type: string; // 规范化 type（小写）
}
