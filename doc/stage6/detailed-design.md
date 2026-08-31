# AIbrowse 第六阶段详细设计（RSS、网页 Diff、Watch 与持续信息更新）

> **唯一产品契约源**。上位需求为 `Sixth_stage.md`，安全契约为
> `doc/stage6/threat-model.md`。实现、测试、任务文档和 Reviewer 必须引用本文件具体章节；
> 若冲突，先 REPLAN 并修改正式契约，不得修改测试迁就实现。

## 0. 契约优先级与不变量

1. 远程 feed、HTML、PageSnapshot、Projection、Diff 文本、Source note 和模型输出全部不可信。
2. Diff equality、Condition、Event、EvidenceMap、DigestFacts、Notification DTO 由确定性程序所有。
3. 哈希只用于完整性、快速比较和去重；正式变化事件必须有可解释的 before/after Evidence。
4. 原始 HTTP body、HTML、完整 PageSnapshot、完整页面正文和模型 transcript 零落盘。
5. Scheduler 不持有 BrowserController、SQLite、HTTP、LLMProvider、NotificationSink。
6. renderer/preload 零 SQL、零任意网络、零 Cookie、零文件路径、零 Provider Key。
7. 业务 SQL 只在 WatchRepository 编译期常量或 migration；参数绑定。
8. Watch 不修改 AgentLoop 12 步/420 秒、17 工具注册表、ResearchRuntime 或 Research Result Schema。
9. 时间来自可注入 Clock；预算和频率是编译期常量；清理与 dispose 幂等。
10. v1 仅应用进程运行时调度；关窗退出后不运行。
11. 公开 page/feed/discovery 的网络能力必须经 RobotsPolicy 装配；缺失 RobotsGate 时零 DNS、零
    socket 并 fail-closed。`purpose=robots` 只属于内部 raw robots client，不能成为通用公开客户端。

## 1. 规划文件布局

```text
src/shared/types/watch.ts                    # DTO、判别联合、预算常量单一事实源
src/shared/watch/condition-engine.ts         # 纯函数结构化条件
src/shared/watch/diff/                       # Feed/Page normalization + diff + fingerprint
src/shared/watch/event-validator.ts          # 双侧 Evidence/Event 严格验证
src/shared/watch/digest-facts.ts             # observation slice → 程序 DigestFacts
src/shared/watch/digest-sharing-projector.ts # full/metadata/blocked prompt 前投影
src/shared/watch/digest-validator.ts         # facts/模型草案 canonical 白名单
src/shared/watch/notification-policy.ts      # 隐私投影/去重纯函数

src/main/watch/
  watch-service.ts                           # renderer 唯一业务入口
  watch-rule-service.ts                      # Rule 生命周期/验证
  watch-query-service.ts                     # 有界查询投影
  watch-run-coordinator.ts                   # 运行所有权/并发/abort/drain
  watch-scheduler.ts                         # Clock/timer/到期 ruleId
  host-request-gate.ts                       # public/session 共用 host start 间隔
  watch-lifecycle-coordinator.ts             # Source 生命周期内部观察端口
  watch-acquisition-service.ts               # 路由公开/Session 读取
  public-watch-http-client.ts                # Node 核心公网 GET/HEAD
  network-policy.ts                          # URL/IP/DNS/redirect/robots 决策
  robots-policy.ts                           # RFC 9309 有界缓存与匹配
  feed-discovery.ts                          # parse5 SAX feed link 投影
  feed-parser.ts                             # XML Adapter → FeedProjection
  public-html-sax-reader.ts                  # 公开 HTML → DocumentChannels，零执行/子资源
  watch-task-tab-workspace.ts                # Session run 精确 task-tab 所有权/焦点/清理
  browser-watch-reader.ts                    # task-tab → 实时 PageSnapshot 窄读取
  page-projector.ts                          # DocumentChannels → PageProjection
  digest-scheduler.ts                        # 只提交到期 scheduleId/logicalDate
  digest-service.ts                          # cycle/batch/facts + 可选 Provider 解释
  digest-prompt.ts                           # 编译期 prompt + UNTRUSTED 块
  notification-service.ts                    # 应用内/Windows sink
  watch-export-service.ts                    # CSV/Markdown + dialog
  repository/watch-repository.ts             # 唯一业务 SQL 点
  db/watch-migrations.ts                     # schema v1→v4 追加迁移（既有语句字节冻结）
  watch-store.ts                             # probe/migrate/check/recover/dispose

src/preload/index.ts                         # watch 白名单 bridge（只加精确方法）
src/renderer/src/watch/                      # 顶层 Watch 工作区
src/main/smoke-watch-*.ts                    # 独立门控、红队、隐私扫描
```

既有 BrowserController 公共方法和 SourceService renderer/Agent 公共方法不变。`WatchTaskTabWorkspace` 只适配
既有 `createTab/closeTab/activateTab/getTabs/getActiveTab`，`BrowserWatchReader` 只适配
`getTabs/getPageSnapshot`；二者均为 main 内部结构端口，不向 renderer、模型或 WatchScheduler 暴露 tabId/
Cookie/任意导航。`WatchLifecycleCoordinator` 作为 SourceService 构造时内部观察者。

## 2. 预算常量（`src/shared/types/watch.ts` 单一事实源）

| 常量                                   |          值 | 语义                           |
| -------------------------------------- | ----------: | ------------------------------ |
| `MAX_WATCH_RULES_TOTAL`                |         200 | 包含暂停规则                   |
| `MAX_WATCH_RULES_ENABLED`              |         100 | 实际可调度上限                 |
| `MAX_GLOBAL_WATCH_RUNS`                |           4 | 全局 acquisition 并发          |
| `MAX_HOST_WATCH_RUNS`                  |           1 | canonical host 并发            |
| `MIN_HOST_REQUEST_GAP_MS`              |       5,000 | 同 canonical host 请求起点间隔 |
| `MAX_DUE_STARTS_PER_TICK`              |          20 | 单次唤醒启动数                 |
| `WATCH_RUN_TIMEOUT_MS`                 |      90,000 | 单规则总时间                   |
| `NETWORK_ATTEMPT_TIMEOUT_MS`           |      30,000 | 单次公开资源获取总周期         |
| `MAX_REDIRECTS`                        |           5 | 每跳复验                       |
| `MAX_FEED_RESPONSE_BYTES`              |   2,097,152 | 解析前硬拒绝                   |
| `MAX_XML_DEPTH`                        |          64 | XML 元素深度硬上限             |
| `MAX_XML_NODES`                        |      20,000 | XML start/text 事件总数        |
| `MAX_XML_NAME_BYTES`                   |         256 | 单 QName/localName/namespace   |
| `MAX_XML_ATTRIBUTES_PER_TAG`           |          64 | 单元素属性数量                 |
| `MAX_XML_ATTRIBUTE_BYTES`              |       4,096 | 单属性名和值合计               |
| `MAX_XML_TEXT_NODE_BYTES`              |       8,192 | 单次累计文本节点               |
| `MAX_XML_TOTAL_TEXT_BYTES`             |     131,072 | 单文档规范化文本累计           |
| `MAX_DISCOVERY_HTML_BYTES`             |     262,144 | 仅内存扫描                     |
| `MAX_ROBOTS_RESPONSE_BYTES`            |     512,000 | robots 独立响应/解析上限       |
| `MAX_PAGE_HTML_RESPONSE_BYTES`         |   2,097,152 | 公开页面 HTML 流硬上限         |
| `MAX_HTML_NODES`                       |      20,000 | SAX 事件节点上限               |
| `MAX_HTML_DEPTH`                       |          64 | 元素栈深度上限                 |
| `MAX_HTML_ATTRIBUTES_PER_TAG`          |          64 | 单标签属性上限                 |
| `MAX_FEED_ITEMS`                       |         200 | 按 feed 顺序前 200 条          |
| `MAX_FEED_FIELD_BYTES`                 |       4,096 | 单标题/摘要/标识等             |
| `MAX_FEED_PROJECTION_BYTES`            |     262,144 | FeedProjection 整体硬上限      |
| `MAX_CONDITIONAL_FIELD_BYTES`          |       1,024 | ETag/Last-Modified 单字段      |
| `MAX_RUN_RESPONSE_META_BYTES`          |       4,096 | Run 响应/Condition 元数据整体  |
| `MAX_REGIONS_PER_RULE`                 |          10 | 页面区域数                     |
| `MAX_PAGE_PROJECTION_BYTES`            |      65,536 | 单 Baseline 投影               |
| `MAX_PROJECTION_FIELDS`                |          50 | 类型化字段数                   |
| `MAX_CONDITIONS_PER_RULE`              |          10 | 一层 all/any                   |
| `MAX_EVIDENCE_VALUE_BYTES`             |       4,096 | 单侧单条摘录                   |
| `MAX_EVENT_EVIDENCE_BYTES`             |      32,768 | Event 所有双侧 Evidence 合计   |
| `MAX_DIGEST_BYTES`                     |      65,536 | 持久化 Digest 投影             |
| `MAX_DIGEST_FACTS_BYTES`               |      49,152 | canonical facts JSON           |
| `MAX_DIGEST_EXPLANATION_BYTES`         |      12,288 | canonical explanation JSON     |
| `MAX_DIGEST_PROVIDER_REQUEST_BYTES`    |      65,536 | 完整 canonical ProviderRequest |
| `MAX_DIGEST_PROVIDER_OUTPUT_BYTES`     |      16,384 | Provider 原始文本累计          |
| `MAX_DIGEST_EXPLANATION_SECTIONS`      |          50 | explanation section 数量       |
| `MAX_DIGEST_EXPLANATION_SECTION_CHARS` |       1,000 | 单 section UTF-16 code units   |
| `MAX_DIGEST_EXPLANATION_SECTION_BYTES` |       2,048 | 单 section UTF-8               |
| `MAX_DIGEST_EXPLANATION_TOTAL_CHARS`   |       6,000 | 全部 explanation 文本          |
| `MAX_DIGEST_EVENTS`                    |          50 | 单 Digest                      |
| `MAX_DIGEST_PROVIDER_CALLS`            |           1 | 单 Digest                      |
| `MAX_DIGEST_SCHEDULE_SOURCES`          |         100 | 固定成员 Source IDs            |
| `MAX_WATCH_DB_BYTES`                   | 104,857,600 | 100 MiB 逻辑预算；每次写前估算 |
| `PUBLIC_EVENT_RETENTION_DAYS`          |          90 | 与数量上限同时生效             |
| `PUBLIC_EVENTS_PER_RULE`               |         200 | 公开规则                       |
| `SESSION_EVENT_RETENTION_DAYS`         |          30 | 登录规则                       |
| `SESSION_EVENTS_PER_RULE`              |         100 | 登录规则                       |
| `EVENT_COALESCE_WINDOW_MS`             |   1,800,000 | 30 分钟                        |
| `ROBOTS_CACHE_MS`                      |  86,400,000 | 24 小时；失败不假定允许        |
| `MAX_LOG_LINE_BYTES`                   |       8,192 | 超长结构化字段截断             |
| `MAX_LOG_FILE_BYTES`                   |  10,485,760 | 10 MiB 后滚动                  |
| `MAX_LOG_FILES`                        |          10 | 含当前文件                     |
| `MAX_LOG_AGE_DAYS`                     |          14 | 与文件数同时生效               |

字符串预算全部用 `Buffer.byteLength(value, 'utf8')`，截断不得拆 surrogate；截断后记录
`truncated=true` 与截断前规范化字节数。超出整体预算时 fail-closed，不把残缺 Projection 当无变化。
`MAX_ROBOTS_RESPONSE_BYTES=512_000` 精确等于 RFC 9309 §2.5 的最低 500 KiB，不得复用
`MAX_DISCOVERY_HTML_BYTES`。robots 仍同时受 `MAX_ROBOTS_RULES=1_024`、严格 UTF-8、单次公开资源
获取 30 秒总周期和仅内存解析约束；响应压缩字节、解压后字节任一达到 `MAX+1` 都立即销毁并
`budget_exceeded`，`==MAX` 可用。

Digest 的 `MAX_DIGEST_BYTES` 精确计量 canonical
`{"facts":<facts-json>,"explanation":<explanation-json-or-null>}` 的 UTF-8 字节；`byte_length` 必须与其恒等。
`facts_json` 与 `explanation_json` 还分别受上表子预算，不能借另一个字段未使用而越界。ProviderRequest 预算
计量固定键序 `JSON.stringify(request)` 的完整 UTF-8 字节（含 requestId/model/system/messages；`tools` 字段
必须不存在）；超限时零 Provider 调用、deterministic artifact 仍成功。Provider 流文本在累计第
`MAX_DIGEST_PROVIDER_OUTPUT_BYTES+1` 字节前 abort 并整份拒绝。

## 3. 域类型

### 3.1 Rule 与调度

```ts
type WatchRuleKind = 'feed' | 'page';
type WatchAccessMode = 'public' | 'session';
type WatchRuleState = 'enabled' | 'paused' | 'deleted';
type PauseReason =
  | 'user'
  | 'source-disabled'
  | 'source-deleted'
  | 'source-changed'
  | 'login-required'
  | 'captcha'
  | 'parse-changed'
  | 'robots-disallowed'
  | 'security-rejected'
  | 'dependency-unavailable';

type WatchSchedule =
  | { kind: 'interval'; intervalMinutes: 15 | 60 | 360 | 1440 }
  | {
      kind: 'daily';
      localTime: `${string}:${string}`; // validator 固定 HH:mm 00:00..23:59
      timeZone: string; // Intl 支持的 IANA id，创建/编辑时冻结
    };

interface WatchRule {
  id: string;
  sourceId: string;
  kind: WatchRuleKind;
  state: WatchRuleState;
  pauseReason: PauseReason | null;
  desiredEnabled: boolean;
  muted: boolean;
  accessMode: WatchAccessMode;
  schedule: WatchSchedule;
  target: FeedTarget | PageTarget;
  condition: StructuredCondition | null;
  notificationLevel: 'normal' | 'important';
  sourceRowVersion: number;
  sourceLocatorFingerprint: string;
  nextDueAt: string | null;
  lastConsumedScheduledFor: string | null;
  lastDailyLocalDate: string | null;
  consecutiveFailures: number;
  backoffUntil: string | null;
  baselineVersion: number;
  createdAt: string;
  updatedAt: string;
}
```

约束：feed 仅允许 `public`；session 仅允许 page。`muted` 不改变 state/nextDueAt；paused
不进入到期队列。`desiredEnabled` 只表达用户意图：用户 pause 置 false，用户 enable 置 true；Source
生命周期造成的有效 pause 不覆盖它。Rule URL 只通过当前 SourceService 解析，Watch 持久化最终规范化
locator 快照仅用于审计/检测 Source 变化，不能在 Source hard-delete 后继续联网。

### 3.2 目标与投影

```ts
interface FeedTarget {
  type: 'feed';
  feedUrl: string;
  format: 'rss2' | 'atom';
}

type RegionDescriptor =
  | { kind: 'main-text'; label: string }
  | { kind: 'headings'; label: string; levels: Array<1 | 2 | 3> }
  | { kind: 'table'; label: string; headerFingerprint: string; occurrence: number }
  | { kind: 'links'; label: string; sameOriginOnly: boolean };

interface PageTarget {
  type: 'page';
  pageUrl: string;
  regions: RegionDescriptor[];
  sessionConsent: { version: 1; origin: string; grantedAt: string } | null;
}

interface ProjectionEnvelope<T> {
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

interface DocumentChannels {
  mainText: string;
  headings: Array<{ level: 1 | 2 | 3; text: string }>;
  tables: Array<{ headers: string[]; rows: string[][] }>;
  links: Array<{ text: string; url: string }>;
}
```

公开 HTML SAX 与 Session PageSnapshot 都必须先映射为相同 `DocumentChannels`，再进入 PageProjector；
切换 accessMode 需要重新预览和 rebaseline。v1 不支持任意 CSS selector、XPath、脚本或跨域 iframe。
`main-text` 必须由用户显式选择；不存在“自动整页 fallback”。table 通过规范化 header fingerprint +
occurrence 重新定位，歧义或缺失为 `parse_changed`。

### 3.3 Run、Health 与 Audit

```ts
type WatchFailureCode =
  | 'login_required'
  | 'captcha'
  | 'parse_changed'
  | 'unavailable'
  | 'robots_disallowed'
  | 'security_rejected'
  | 'budget_exceeded'
  | 'condition_error'
  | 'dependency_unavailable'
  | 'interrupted';

type WatchHealthSnapshot =
  | { state: 'healthy'; acquisition: 'rss' | 'browser'; code: null }
  | {
      state: 'degraded' | 'paused';
      acquisition: 'rss' | 'browser';
      code: WatchFailureCode;
    };

type WatchRunOutcome =
  | { kind: 'baseline-established'; auditId: string }
  | { kind: 'unchanged' }
  | { kind: 'changed-unmatched'; changeFingerprint: string }
  | { kind: 'event-created'; eventId: string }
  | { kind: 'event-coalesced'; eventId: string }
  | { kind: 'event-deduplicated'; eventId: string }
  | { kind: 'failed'; health: WatchFailureCode; retryable: boolean }
  | { kind: 'aborted'; reason: 'shutdown' | 'user' | 'superseded' };
```

`baseline-established` 是 WatchAudit，不是 Event，不计入 Digest/未读/通知。失败 reason 是闭合中文
安全映射，日志/IPC 不回显敌手正文。

## 4. 调度、Clock、并发与退避

### 4.1 Clock/TimeZone 接口

```ts
interface Clock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

interface TimeZoneResolver {
  nextDailyInstant(input: {
    after: Date;
    localTime: string;
    timeZone: string;
    lastLocalDate: string | null;
  }): { instant: Date; localDate: string } | null;
}
```

- 不存在的 DST 本地时间：在该本地日期时钟跳变后的第一个有效 instant 执行一次。
- 重复的本地时间：选择较早 instant；`lastDailyLocalDate` 保证同一逻辑日期只运行一次。
- 系统时区变化不改已存 rule.timeZone；用户编辑计划才改变。
- wall clock 回拨不重复执行已消费 `scheduledFor`；向前跳触发一次合并补跑。

### 4.2 到期和补跑

`effectiveDueAt = max(nextDueAt, backoffUntil)`；paused/deleted 无 effective due。Scheduler 只提交
`ruleId`，Coordinator 必须在 `watch.db` 单事务执行 `reserveScheduledRun(expectedNextDueAt, now)`：

1. 复验 Rule enabled、无同 Rule queued/running 且 expected due 未变化；
2. 以消费前 `nextDueAt` 写 `scheduledFor` 和唯一 `requestKey=ruleId|scheduledFor` 的 queued Run；
3. 写 `lastConsumedScheduledFor=scheduledFor`，并按原 schedule 锚点用 O(1) 算法推进 `nextDueAt` 到第一个
   `> now` 的时点；daily 同时写本次 logical local date；
4. 三项同事务提交才允许入内存队列；事务失败时三项均不改变，Store 进入 unavailable、Scheduler 停止。

启动/恢复时若 `nextDueAt <= now`，该 reservation 的 trigger 标 `catch-up`；无论错过多少时点，每 Rule
只消费最旧 due 并直接推进到第一个 `> now`，不枚举中间 missed runs。普通 tick/backoff 到期使用
`scheduled`。单次 tick 只启动20条，其余保持有界排序队列 `(effectiveDueAt, ruleId)`。

reservation 已提交即代表该 schedule slot 被消费；后续 acquisition 成功、失败、pause、abort 或进程崩溃
都不回拨 `nextDueAt`。终态事务只写 Run outcome/health/backoff；崩溃恢复把 queued/running 原子标
`interrupted`，同一 `requestKey` 不重放。若进程在 reservation 提交前崩溃，due 仍在，下次启动只补跑一次。
这把“应用关闭时错过一次”与“已开始但中断”明确区分，避免崩溃重放风暴。

手动运行使用唯一 requestId，不写 `lastConsumedScheduledFor`、不改变 `nextDueAt`/daily logical date；仍复验
Rule/Source、等待 backoff 和 host gate，不能绕过安全/频率策略。已有同规则运行时返回当前 runId，不排第二次。
手动运行成功可重置 failure/backoff，失败可延长 backoff，但计划锚点保持不变。

### 4.3 退避

- timeout/load/临时 5xx：单次 run 内最多重试一次；仍失败则连续失败数 +1。
- 429：零立即重试，解析有效 `Retry-After`，取其与本地退避较晚者。
- 连续失败退避基线：15 分钟、1 小时、6 小时、24 小时封顶。
- 每个实际 HTTP socket 请求（含 robots、redirect、retry）按 canonical `host:effectivePort` 排队；相邻请求
  start time 至少相隔 `MIN_HOST_REQUEST_GAP_MS`。redirect 到新 host 重新进入对应 gate；Session 模式无法控制
  Chromium 内部 redirect/子资源，但每次 task-tab `createTab(pageUrl)` 顶层导航调用前必须取得同一 host gate。
  `HostRequestGate` 是 main 进程单例，PublicWatchHttpClient 与 WatchTaskTabWorkspace 共用同一
  `host:effectivePort → lastStartedAt` 注册表，不能各自计时。全局/host 并发释放不缩短间隔；同 Rule retry 新建
  新 task-tab 并重新过 gate。
- 每次顶层 acquisition 加入由 `SHA-256(ruleId|host|scheduledFor)` 导出的 0..500ms 确定性附加 jitter
  （`MIN_HOST_REQUEST_GAP_MS` 的 0..10%）；实际 start 为 due/backoff/host-gap 全部满足后再延迟该值，
  永不提前于 due。手动运行以 requestId 代替 scheduledFor，同样适用。
- 成功的 fetched/unchanged 重置连续失败与 backoff。
- 三次连续 `unavailable` 标 degraded 但不覆盖 Baseline。
- `login_required/captcha/robots_disallowed/security_rejected/condition_error` 立即暂停，零自动重试；
  condition_error 不设置时间 backoff，Rule pauseReason 复用既有 `dependency-unavailable`，等待用户修复
  Condition；精确 health/audit 仍是 condition_error/condition-error。
- 连续两次 `parse_changed` 暂停；第一次只 degraded，旧 Baseline 不变。

### 4.4 生命周期

`before-quit` 顺序：停止接收新 Watch/Digest run → 清两类 timer/队列 → abort acquisition/provider → 等待有界 drain →
关闭 WatchStore → 延续既有 Research/Sources/Browser dispose。关窗退出后没有调度。所有 stop/dispose
可重复调用，未完成 queued/running 行在下次启动原子标 `interrupted`；其已消费 slot 不重放，只有仍未消费的
过期 `nextDueAt` 才按补跑规则处理。

上一句的 `interrupted` 只适用于网络 `watch_runs`。D8 的本地 `digest_runs.state='running'` 保存冻结上下界和
已提交 batch cursor，启动后必须从最后一次原子提交处继续；不得重新冻结上界或重做已提交 artifact。若进程在
Provider claim 后退出/崩溃，恢复只把该 artifact 标为 `uncertain` 并保持 `explanation=null`，绝不再次调用。

## 5. 确定性结构化条件

```ts
type ConditionOperator =
  | 'equals'
  | 'not-equals'
  | 'contains'
  | 'not-contains'
  | 'changed'
  | 'increased'
  | 'decreased'
  | 'crosses-above'
  | 'crosses-below'
  | 'event-kind-is';

interface ConditionPredicate {
  fieldKey: string;
  operator: ConditionOperator;
  operand: string | number | null;
  caseSensitive: boolean;
}

interface StructuredCondition {
  version: 1;
  combine: 'all' | 'any';
  predicates: ConditionPredicate[]; // 1..10
}
```

- `fieldKey` 必须来自 Target 创建时的闭合字段目录，禁止 `__proto__`/`prototype`/`constructor`、
  通配符、数组任意索引和模型自造字段。
- 数值只接受规范化 ASCII 十进制（可有负号/小数），拒绝 NaN/Infinity/单位混入/locale 猜测。
- crosses 使用 old/new 双侧数值；不存在值不能冒充 0。
- 文本先 NFC、控制/bidi 清除、空白折叠；contains 是线性字面匹配，无 regex。
- 无 Condition 等价于“所有有效 ChangeSet 匹配”。
- Condition 不匹配仍推进有效新 Baseline并记录 `changed-unmatched`，避免重复比较同一变化。
- AI 不参与解析、求值、字段映射或触发。

ConditionEngine 的闭合返回契约为：

```ts
type ConditionWarningCode =
  'field-absent' | 'numeric-value-unavailable' | 'operator-not-applicable';

type ConditionEvaluationResult =
  | { ok: true; matched: boolean; warnings: ConditionWarningCode[] }
  | { ok: false; code: ConditionErrorCode };
```

`warnings` 去重后按上述编译期顺序排序，只进入有界 Run response metadata/UI 安全文案，不进入
fingerprint、Event Evidence 或敌手正文审计。求值器必须遍历全部 predicate（不因 all/any 短路）并按以下
闭合矩阵求值；同一 predicate 对同 `fieldKey` 的全部 ChangeField 先合并判定，避免 Feed 多 item 同字段时由
输入顺序改变 warning：

| operator                                                | typed pair 要求                                                    | 不支持时的唯一 warning                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `event-kind-is`                                         | 只比较 ChangeSet.eventKind，不读取 field pair                      | 永不产生 warning                                                                                                              |
| `changed`                                               | 至少一个同 fieldKey 的已验证 pair；按 typed before/after 判等      | 无该字段 → `field-absent`                                                                                                     |
| `equals`/`not-equals`/`contains`/`not-contains`         | after=present；string/number 沿用规范文本比较，contains 为字面匹配 | 无该字段 → `field-absent`；after=absent → `operator-not-applicable`                                                           |
| `increased`/`decreased`/`crosses-above`/`crosses-below` | before/after 均 present 且均可解析为规范 finite ASCII 十进制       | 无该字段 → `field-absent`；任一侧 absent → `operator-not-applicable`；两侧 present 但任一非数值 → `numeric-value-unavailable` |

同一 fieldKey 有多个 pair 时：任一可适用 pair 命中则 predicate=true；否则只要存在可适用 pair，predicate=false
且不因其它不适用 sibling 产生 warning；只有全部 pair 均不适用才 predicate=false 并产生恰一个 warning，优先级
固定为 `numeric-value-unavailable` 后 `operator-not-applicable`。无同字段 pair 才是 `field-absent`。全部
predicate 求值后再按 all/any 组合，warning 去重排序；因此 `any` 的其它 predicate 命中时整体仍可 matched=true
并保留未命中 predicate 的 warning。上述不支持情形属于 **unsupported/no-match**，不是 error。整体
matched=false 才写 Run=`changed-unmatched`、推进有效新 Baseline，健康恢复 `healthy`、
`consecutiveFailures=0`、`backoffUntil=null`，审计 `run/changed-unmatched`；不得把不存在值猜成0，也不得
仅因 warning 阻止其它确定性命中产生 Event。

Condition/ChangeSet 形状、版本、字段目录或值类型验证失败，或求值器抛出/返回闭合集外状态，属于
**condition error**，不是 unmatched：Run=`failed(condition_error,retryable=false)`，旧 Baseline 保留，
零 Event/observation/item/outbox；`consecutiveFailures += 1`，`backoffUntil=null`，Rule 立即暂停为
`pauseReason='dependency-unavailable'`（schema v2 已有的调度暂停码；精确事实由 health/audit 的
`condition_error/condition-error` 承载，D7 不为此重建被多表引用的 watch_rules 父表），
health=`paused/condition_error`，同一终态事务写恰好一条
`run/condition-error` 与首次有效暂停的一条 `lifecycle-pause/condition-error` 审计。已处于相同暂停态的
幂等重入不重复写 lifecycle audit。用户修复/删除 Condition 并重新预览后才可恢复；恢复不自动 rebaseline。

## 6. 公开网络、Feed/XML 与公开 HTML

### 6.1 PublicWatchHttpClient

只暴露：

```ts
interface PublicWatchHttpClient {
  head(input: PublicRequest): Promise<PublicResponseMeta>;
  get(input: PublicRequest): Promise<BoundedPublicResponse>;
}
```

`PublicRequest` 只含已校验 URL、purpose、固定 Accept、条件请求 ETag/Last-Modified、Clock deadline。
调用者不能传 method/body/Authorization/Cookie/Proxy/任意 header。

NetworkPolicy：

1. URL 仅 `http:`/`https:`，拒绝 userinfo、空 host、控制字符；端口白名单闭合为 HTTP 80、HTTPS 443，
   省略端口或显式写对应默认端口均接受并规范化为省略形式，所有非默认端口一律 `security_rejected`；
2. 规范化 host 后拒绝 localhost 与保留后缀；
3. 连接 `lookup` 返回的每个候选 IP 都必须是允许的公网 unicast；混合公网+私网整次拒绝；
4. 自定义 lookup 只把已验证地址交给 socket，避免预解析与连接重解析分离；
5. 禁止自动 redirect；Location 解析为绝对 URL后重走 1–4，最多 5 跳；
6. HTTPS→HTTP downgrade 拒绝；最终 URL 主进程记录；
7. 不跟随 DNS/HTTP 指向 file/data/blob/chrome/javascript 或代理隧道；
8. 只读取最多对应字节预算，超出立即 destroy socket；压缩数据同时限制压缩字节和解压后字节；
9. URL 日志去 query/fragment/token，响应正文零日志。

IPv6 不以“落在 `2000::/3` 且未命中少量 denylist”冒充公网。D3 冻结以下基于 IANA
`IPv6 Global Unicast Address Space`（registry last updated 2025-10-10）和
`IPv6 Special-Purpose Address Space`（last updated 2025-10-09）的编译期策略；运行时不联网更新：

1. 先拒绝 IPv4-mapped/compatible、NAT64、discard、6to4、ULA、link-local、site-local、multicast、
   IETF special-purpose、文档、benchmark/transition 及其它非普通公网用途；
2. 再且仅再放行下列 IANA 当前 `ALLOCATED` 的普通 GUA 前缀：
   `2001:200::/23`、`2001:400::/23`、`2001:600::/23`、`2001:800::/22`、
   `2001:c00::/23`、`2001:e00::/23`、`2001:1200::/23`、`2001:1400::/22`、
   `2001:1800::/23`、`2001:1a00::/23`、`2001:1c00::/22`、`2001:2000::/19`、
   `2001:4000::/23`、`2001:4200::/23`、`2001:4400::/23`、`2001:4600::/23`、
   `2001:4800::/23`、`2001:4a00::/23`、`2001:4c00::/23`、`2001:5000::/20`、
   `2001:8000::/19`、`2001:a000::/20`、`2001:b000::/20`、`2003::/18`、
   `2400::/12`、`2410::/12`、`2600::/12`、`2610::/23`、`2620::/23`、
   `2630::/12`、`2800::/12`、`2a00::/12`、`2a10::/12`、`2c00::/12`；
3. 上述父前缀中的 `2001:db8::/32` 与 `2620:4f:8000::/48` 仍由第一步特殊用途拒绝；
   `2001::/23`、`2002::/16`、`3fff::/20` 和 IANA 标为 `RESERVED` 或未列出的 `2000::/3`
   空间均不放行；
4. IANA 登记变化不是运行时自动扩权理由；更新表必须另走正式设计、测试和安全 Reviewer。

一次 `get/head` 在公开入口读取一次 Clock，冻结 `startedAt` 与
`internalDeadline=startedAt+NETWORK_ATTEMPT_TIMEOUT_MS`，再计算
`effectiveDeadline=min(internalDeadline, externalDeadline)`。外部 deadline 缺省时只用内部截止；传入
`Invalid Date`（`getTime()` 非有限数）或 `externalDeadline<=startedAt` 时，必须在 URL 派生之后、DNS/
request factory/socket 之前受控 `unavailable`。外部 deadline 晚于 `internalDeadline` 不得延长 30 秒。

DNS、robots、全部候选地址、连接、响应头、redirect 链、压缩/解压和 body 读取共用这个不可变的
`effectiveDeadline`；每个等待点只读取 `remaining=effectiveDeadline-now`，`remaining<=0` 立即销毁并
返回，否则 timer 只能设为该 remaining，不得用地址、robots 子请求、retry 或 redirect 重新计算
`startedAt`/获得完整 30 秒。无响应 socket、静默 body、多地址连续失败和 redirect 链均须在同一截止内
销毁当前 request/response/inflater 并受控返回。

请求生命周期分成两个相互隔离的终态阶段：

1. **业务终态（business terminal）**：deadline、AbortSignal、request error、body end/error/aborted 或预算
   失败中第一个结果通过单一 settlement latch 取得所有权。取得所有权后，在同一同步清理栈内立即禁止新
   DNS/request/redirect、正文累计和 inflater 驱动；清除 deadline/socket timer 与 AbortSignal listener；
   移除 request 的 response/error/timeout **业务 listener**、response 的 data/end/error/aborted 业务
   listener 和 inflater 的 data/end/error 业务 listener；随后逐项异常隔离地销毁 inflater、response、
   request。Promise 在同步 cleanup/destroy 完成，且任何同步抛错的受控 fallback 返回或抛错后，立即按已取得
   的业务结果结算；不等待 transport 的 error/close，也不为 drain 新建 timer。因此 transport 永不 close
   不能越过 absolute deadline 或挂住调用方。
2. **Transport drain 终态**分成两个 emitter-local 类型；它们都不是业务 listener，也都不参与 Promise
   settlement：
   - **Request drain**：`ClientRequest` 创建成功后立即安装独立 named `error` sink + named `close`
     cleanup listener；业务终态前另有独立 request business error handler 决定业务结果。drain error sink
     从安装起对所有 request error 都无条件 no-op，不读取 settlement，不区分业务终态前后；business error
     handler 可在业务终态移除，drain 必须保留至 request close。两个 drain callback 只闭包 request 和彼此，
     不捕获 Promise resolve/reject、业务结果、timer、AbortSignal、body buffer、response、inflater 或 process/
     全局 registry/listener。request close cleanup 幂等移除 drain error/close 两个 listener；两次
     `removeListener` 必须各自单独 try/catch，一个 remove 抛错不能形成 uncaught exception 或阻止另一个
     listener 的清理，清理后重复调用保存的 callback 仍为 no-op。request close 永不到达时，该自包含 drain
     pair 可随不可达 request 被 GC，业务 Promise 已经结算且它不保有任何上述业务/重型/全局资源。
   - **IncomingMessage drain**：每个 response 一经交付，无论将进入正常 body reader、redirect/HEAD
     discard、业务终态后的迟到 discard，还是 destroy/resume fallback，都必须先安装独立 named `error`
     sink + named `close` cleanup listener。业务终态前另有独立 response business error handler 决定业务
     结果；drain error sink 从安装起对所有 response error 都无条件 no-op，不读取 settlement。业务终态移除
     response 的 data/end/error/aborted 等业务 listener 后，drain 保留至 response close；若 transport 在
     aborted、request close 之后发出 response `ECONNRESET`，必须由该 drain 接收。response close cleanup
     幂等移除 drain error/
     close 两个 listener；两次 `removeListener` 各自单独 try/catch，保存 callback 重复调用幂等。该 drain
     只闭包对应 response emitter 和两个 drain callback，不捕获 Promise settlement、业务结果、timer、
     AbortSignal、body buffer、inflater、request、全局 registry 或 process listener。response 永不 close
     时不得阻塞业务 Promise或保留正文、解压器、timer 或业务闭包；只允许 emitter-local drain pair 随
     不可达 transport 对象 GC。

固定清理/事件语义如下：

- 先把 settlement latch 置为终态，再按「清 timer/AbortSignal → release body/inflater/response/request
  业务 listener → 确认对应 request/response drain 已安装 → destroy inflater/response/request」执行；所有
  remove/destroy/abort/resume 单项独立 try/catch，后一步不得因前一步抛错而跳过。局部业务闭包持有的
  response/inflater/body 等重型引用在调用 destroy/fallback 后立即置空；response drain 只保留 emitter-local
  自引用。
- `request.destroy()` 同步抛错不改变业务结果；在 drain 已安装的前提下至多再调用一次受控 `request.abort()`
  fallback，fallback 返回或抛错后立即结算，不重试、不等待 close。真实 Node 24 的 destroy 不应抛错；该
  分支是 transport seam/防御纵深 oracle。
- 为覆盖敌手 seam 在 `request.destroy()` 调用栈内同步发出 response，可在该次调用前安装一个仅调用栈存活的
  response discard guard。guard 收到 response 后必须先安装该 IncomingMessage 自己的 drain，再尝试
  `response.destroy()`；只有 destroy 缺失或同步抛错时才调用 `response.resume()` 排空，绝不接入 body
  reader/inflater，也禁止安装匿名、无法由 response close cleanup 移除的 error listener。guard 在 request
  destroy/abort fallback 调用栈的 finally 中必定移除，且必须在业务 Promise 结算前归零；它不是允许跨事件
  轮暂存的 listener。跨事件轮允许的只有 request drain，以及每个已交付、迟到或需要 discard 的
  IncomingMessage 自身 response drain。
- 异步 request error（包括无参数 destroy 后的 `ECONNRESET`）由 drain sink 吸收；error→close 在 close
  清零 drain，对同一 close/已保存 callback 的重复调用幂等；only-close 直接清零 drain。Node 24 文档不定义
  request close 后再次发 request error，忠实 seam 不得伪造该顺序；未来 Node 若改变顺序，真实 transport
  子进程 oracle 必须失败并触发 REPLAN，而不是增加 process 级兜底。
- 已交付 response 的 destroy/abort 可在 IncomingMessage 上产生 aborted/error/close；业务 listener 已归零，
  response drain 仍接收异步 error 直至 response close 并在 close 自清理，response 不再累计或解压。任何
  业务终态后到达的 DNS callback、socket event、redirect response、body chunk/end 或解压事件都只能丢弃，
  不能创建新请求、写 body 或改变终态。

Node 24.18.0 官方依据：`request.destroy()` 可异步发出 error 并发出 close；其事件顺序表明确 destroy 在
socket 分配前/连接成功前为 `error ECONNRESET → close`，response 后 destroy 的 aborted/error/close 位于
IncomingMessage。localhost 对照实测同时证明 response error 是当前实现的**条件发射**：原 response-after
destroy/abort 探针安装了 response error listener，观察到 response aborted → request close → response error
`ECONNRESET` → response close；在 destroy/abort 前移除 response 最后一个 error listener，则观察到 response
aborted → request close → response close，exit 0 且 `uncaughtExceptionMonitor` 未命中。测试 observer 会改变
该观察路径，不能作为透明探针或掩盖产品结构缺陷。此事实不取消 IncomingMessage drain：request drain 已在
request close 自清理，不能替 response emitter 接收实际发出的 error；产品仍必须用自己的 named response
drain 覆盖实际发出的 error、确定性敌手 seam、未来 Node/实现差异及统一生命周期。未监听且实际发出的
EventEmitter `error` 会抛出并使进程退出。因此本契约要求立即清除全部**业务** listener，同时在各自 emitter
close 前保留上述有界 request/response transport drain；二者均不是业务 listener。
依据：<https://nodejs.org/download/release/v24.18.0/docs/api/http.html#requestdestroyerror>、
<https://nodejs.org/download/release/v24.18.0/docs/api/http.html#http_client_request>、
<https://nodejs.org/download/release/v24.18.0/docs/api/events.html#error-events>。

公开 page/feed 请求 User-Agent 固定为产品版本化标识，不包含用户账号/机器 ID。条件请求优先发送
ETag/Last-Modified；304 映射 unchanged-http，不解析空 body。

### 6.2 Robots 与频率

- 公开 page/feed/discovery 在首次目标 host 及每次 host 变化前获取并缓存 robots；使用固定 Watch user-agent。
- robots 获取同样经过 NetworkPolicy，独立最大 `MAX_ROBOTS_RESPONSE_BYTES=512_000` bytes；其 DNS、
  地址、redirect、响应体必须受调用方同一次公开资源获取的更早总 deadline 约束。文件级 fatal UTF-8、
  网络不可达或超时 fail-closed 为 unavailable；地址/scheme/redirect 安全拒绝为 security。
- disallow 立即 `robots_disallowed` 并暂停；用户无 override。
- 登录态 page 不查询 robots，但仍全局/主机并发、最小间隔、退避；这不是绕公开反爬授权。
- §4.3 的 5 秒间隔是请求 start-to-start 硬下限，不是平均值；robots、目标、redirect 和 retry 都不能绕过。
- robots 只表达 crawler preference，不替代 ToS/法律判断；UI 在创建公开规则时显示诚实提示。

D3 内部装配冻结为唯一产品构造入口 `createPublicWatchHttpStack(...)`：它在模块内部创建未导出的
raw robots transport → `RobotsPolicy` → target-gated client。产品代码不得导出 raw transport、其
constructor、`robots-only` client、任意 URL fetch seam 或能自行构造未装 gate 客户端的 constructor；
工厂只返回 target-gated client 与生命周期所需的 `RobotsPolicy` 窄端口。测试只能向该安全工厂注入
DNS/request factory/Clock 等受控依赖并经工厂返回的窄能力观察行为，不能取得或导出任意网络客户端。

每次 page/feed/discovery 调用先由工厂从已经通过 NetworkPolicy URL 层 canonical 校验的目标 URL 内部
派生 robots 初始 URL：保持目标的 scheme、canonical host 与有效 port，path 精确为小写
`/robots.txt`，query/fragment 必须为空；调用方不能提交 robots URL。任何公开入口或伪造请求试图用
`purpose=robots` 指定其它 host、path、query、fragment、method 或 body，必须在 URL 解析、DNS、
request factory 和 socket 前 `security_rejected`。raw 初始请求只允许 `GET` 该派生 URL；robots
redirect 只能由 raw transport 内部
消费响应 `Location` 后产生，每跳仍完整执行 NetworkPolicy、地址封印、redirect/downgrade 检查和 robots
响应预算，并继承外层资源获取已建立的同一个 `effectiveDeadline`。redirect 不把新 URL 重新暴露为调用
能力，也不获得新的 30 秒。

target-gated client 只允许 page/feed/discovery。运行时收到伪造/缺失能力配置，或任何路径未持有
RobotsGate 时，必须在 URL/DNS/request factory/socket 前返回受控
`unavailable/robots-gate-missing`，绝不能默认跳过。D5 只把 HostRequestGate、并发和 5 秒
start-to-start 间隔注入该安全工厂，不负责补救 D3 的缺省开放能力。

Robots 解析/匹配按 RFC 9309 §2.2.2、§2.3.1.5 的 octet 语义实现，并严格区分文件级与逐行错误：

1. **文件级解码**：先对整个 body 做 fatal UTF-8 解码，允许且只移除正文开头的一个 UTF-8 BOM。
   任何非法/截断 UTF-8 都使本次 robots `unavailable`，不得使用部分规则；合法 UTF-8 解码完成后，
   后续 ABNF、控制字符或 percent 语法错误都只是逐行问题，不得反向升级为文件级 UTF-8 失败。
2. **行与结构空白**：按 RFC 的 `NL = CR / LF / CRLF` 切分，CRLF 必须作为一个换行处理；`SP`
   (`0x20`) 与 `HTAB` (`0x09`) 只允许出现在 ABNF 的 `WS`/`empty-pattern`/行尾 comment 结构位置。
   其它原始 C0（`U+0000..U+001F`，不含结构位置的 HTAB/CR/LF）、DEL (`U+007F`) 与 C1
   (`U+0080..U+009F`) 使其所在逻辑行不可解析；该行不得创建/终止 UA group 或加入规则，解析器必须
   继续尝试后续行。未知 record 与其它单行语法错误同样忽略且不得干扰已定义 record 的解析。
3. **逐行 percent 错误隔离**：每个 allow/disallow 行独立解析；在 percent 编码处理中，只有 `%` 后
   不足两个十六进制位，或两位中任一不是十六进制的 malformed/truncated percent triplet，才使
   **该条规则**不可解析并忽略。
   解析器继续使用同组及后续组的其它 parseable rules；坏规则不计入 `MAX_ROBOTS_RULES`，也不使整份
   文件 unavailable。fatal UTF-8 与这一行级容错不得共用同一错误分支。
4. **octet 规范化**：规则和已通过 NetworkPolicy 的目标 `path+query` 规范化为可比较 token。原始
   非 ASCII 字符先按 UTF-8 展开为 octet，再以大写十六进制 percent 编码身份表示；percent-encoded
   unreserved ASCII（`ALPHA / DIGIT / "-" / "." / "_" / "~"`）解码为对应单 octet；percent-encoded
   reserved、其它非 unreserved ASCII（包括 `%00`、其它控制 octet、`%7F`）及非 ASCII octet均保留
   percent 编码身份并统一十六进制为大写。故 `%2F` 不等于字面 `/`，`%00` 是可解析、可比较的
   `%00` token，`%2A`/`%24` 也不成为通配/锚点；不得要求 percent-encoded 非 ASCII octet 单独组成
   UTF-8 序列。目标 URL 若含 malformed/truncated percent triplet，须在 NetworkPolicy URL 校验阶段
   零网络拒绝，不能把它解释为 robots 文件级失败。
5. **匹配与 group**：`*` 只在规则中匹配零个或多个规范化 token，只有规则末尾未编码 `$` 是结尾
   锚点；匹配从目标第一 octet 开始。specificity 是规范化规则中除 `*` 和末尾 `$` 外的 octet 数，
   不是 wildcard 吞掉的目标长度；最长者胜，等长 allow 优先。所有大小写不敏感的相同 product-token
   UA 组规则合并；只要 specific 组存在就绝不回退 `*`，合并后规则为空即允许全部；只有 specific 组
   完全不存在时才合并并使用所有 `*` 组。
6. **有界性**：`MAX_ROBOTS_RULES=1_024` 对合并前的 parseable allow/disallow records 计数，
   `==MAX` 接受、遇到第 `MAX+1` 条 parseable rule 时整次 `unavailable`；匹配不得构造正则，响应
   512,000-byte 上限、逐行扫描、规则数和同一总 deadline 共同限定时间与内存。

### 6.3 HTML 依赖资格与 Feed Discovery

D3 对 `parse5-sax-parser@8.0.0` + `parse5@8.0.1` 执行与 XML 相同级别的许可证、供应链、Node24/
Electron build、敌手和兼容资格门。通过后精确固定直接依赖及 lockfile；任一失败即 REPLAN。

Feed discovery 对公开页面最多读取 256 KiB 解压后 HTML，通过已资格化 SAX 事件只识别 `<link>` 的
`rel/type/href`。parser 不执行 JavaScript、不创建 WebContents、不请求 script/style/image/iframe，不序列化
DOM。接受 `application/rss+xml`、`application/atom+xml`；候选 URL 解析后重走 NetworkPolicy，再用
FeedParser 验证。用户也可手工输入 URL。最多返回10个候选，按文档顺序，同 canonical URL 去重。

### 6.4 XML 资格与 Parser

D3 先对 `@federicocarboni/saxe@0.8.0` 执行资格门。通过后精确固定版本和 lockfile；若任一门失败，
D3 停止为 REPLAN，不能改用其他包或自实现。

Parser 配置/外层防线：

- `dtd: 'prohibit'`；DOCTYPE、ENTITY 声明、外部实体、XInclude namespace、未知自定义实体全部拒绝；
- 不注册 resolver、不发网络、不读取文件；
- 深度、名称、文本、属性、节点和总输出都设置不高于 §2 的项目上限；
- 仅支持 UTF-8、UTF-16LE/BE BOM，以及 TextDecoder 明确支持的 UTF-8/UTF-16/
  windows-1252/ISO-8859-1 声明；冲突/未知编码 fail-closed；
- 接受 RSS 2.0 channel/item 和 Atom feed/entry；namespace 按 URI+localName，不信任前缀；
- entry 身份：Atom id / RSS guid 首选，其次 canonical link，最后
  SHA-256(title|published|canonicalLink) 受控复合键；身份缺失且复合键字段不足则丢弃该 item；
- XML depth/name/attributes/text-node/node-count 任一达到“下一事件将使计数 `> MAX_*`”时整次
  `budget_exceeded`；等于上限允许。累计文本超过 `MAX_XML_TOTAL_TEXT_BYTES` 或编码后的完整
  FeedProjection 超过 `MAX_FEED_PROJECTION_BYTES` 也整次失败，旧 Baseline 保留。
- Projection 最多保留 feed 顺序前 200 items；遇到第 201 项停止收集并标 `itemsTruncated=true`。字段逐项按
  UTF-8 字节安全截断到4,096并标记，不把截断值冒充完整值；截断前必须先计算完整规范化值的
  `SHA-256` 并写入 `FeedField.valueHash`（#S6-046），截断后不得也无法重建该哈希；结构/累计文本/整体
  Projection 预算则不截断，整次失败。DTD/custom entity 已禁止，因此不存在可配置的递归实体预算，任何声明直接
  security_rejected。
- HTML 内容字段转纯文本安全子集，零 HTML 落盘/渲染。

FeedParser 只拥有 XML→规范化 value，不伪造 acquisition 元数据。D7 把 D3 的裸投影收窄为以下接口
（#S6-054）；`FeedField.valueHash` 在截断前生成，`FeedProjection` 名称专用于完整 envelope：

```ts
interface FeedField {
  text: string;
  truncated: boolean;
  originalBytes: number;
  valueHash: string; // 截断前完整规范化值 SHA-256，小写 64 hex
}

interface FeedProjectionValue {
  type: 'feed';
  format: 'rss2' | 'atom';
  title: FeedField;
  description: FeedField;
  siteUrl: FeedField;
  feedUrl: FeedField;
  items: FeedItem[];
  itemsTruncated: boolean;
}

type ParsedFeedProjection =
  | { ok: true; value: FeedProjectionValue; canonicalJson: string; byteLength: number }
  | { ok: false; health: WatchFailureCode; reason: FeedParseReasonCode };

type FeedProjection = ProjectionEnvelope<FeedProjectionValue>;

type FeedParseReasonCode =
  | 'encoding-invalid'
  | 'xml-security-rejected'
  | 'xml-budget-exceeded'
  | 'xml-shape-invalid'
  | 'projection-invalid'
  | 'dependency-unavailable';

type FeedAcquisitionDisposition =
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

interface ConditionalResponseMetadata {
  httpStatus: 200 | 304;
  etag: string | null;
  lastModified: string | null;
  warnings: ('etag-oversize' | 'last-modified-oversize')[];
}
```

`canonicalJson` 必须逐字节等于固定键序 `JSON.stringify(value)`；`byteLength` 是其 UTF-8 字节数。
FeedParser、Feed normalize 与其 validator 共同拥有该 canonical encoding。main-process
`FeedAcquisitionService` 在 HTTP 成功且 parser/validator 通过后，以 HTTP 主进程记录填入
`ruleId/sourceId/capturedAt`、固定 `documentId=null`；`finalUrl` 必须先经与 Evidence 相同的安全投影，
只保留 `scheme://host[:port]/path` 并移除 userinfo/query/fragment，无法形成合法 http/https 安全 URL 时
`security_rejected`。随后以
`SHA-256(utf8(canonicalJson))` 生成 envelope `contentHash`；网络层、Coordinator、Repository 和 D7 Diff
不得重新选择另一编码。PageProjection 继续以 `JSON.stringify(PageProjectionValue)` 同口径生成 hash，故
两类 envelope 都可由统一 processing service 验证与消费。

`MAX_FEED_PROJECTION_BYTES=262,144` 是 parser/内存输出上限，不扩大 v1 Baseline 的 65,536-byte 持久化
上限：Feed envelope 可在预览中达到 parser 上限，但作为 Watch Baseline/新 Projection 进入 processing 时
若 `byteLength>MAX_PAGE_PROJECTION_BYTES(65,536)`，映射 `budget_exceeded`、旧 Baseline 保留/首次零
Baseline。schema v3 不放宽 `watch_baselines.byte_length<=65,536`；常量现名因 D6 历史保留，语义仍是单
Baseline 上限。不得截断整个 feed Projection 来迁就持久化。

Feed acquisition 的闭合结果为：

```ts
type FeedAcquisitionResult =
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
```

`ConditionalResponseMetadata` exact-key 只含 `httpStatus/etag/lastModified/warnings`；两个字符串分别 UTF-8
≤ `MAX_CONDITIONAL_FIELD_BYTES`。超限字段置 null，并分别追加 `etag-oversize`/
`last-modified-oversize`，不截成可回发的另一 validator；warnings 按该编译期顺序去重，原始 header/body 不进入
DTO。整个 Run metadata 的固定键序 JSON 还受 `MAX_RUN_RESPONSE_META_BYTES` 限制，超限不是截断而是
`validation-failed`。HTTP 304 且 acquisition 输入含已验证 Feed Baseline hint 才能返回 `not-modified`，零
Parser/Diff/Event/Baseline version 写；Processing 仍须对 hint 做结果事务 CAS，成功才把 Run 终结为
`unchanged` 并重置健康/失败计数。首次运行或 Baseline hint 缺失收到 304 时，在同一 acquisition、同一绝对
deadline、同一 host gate 内恰好再发一次不带条件 header 的 GET；返回 200 才建立 Baseline，第二次仍304或没有
完整 body →
`failed(unavailable,retryable=false)`，零 Baseline。Feed parser 成功但 envelope validator 失败按
`parse_changed`；任何路径都不能用 304 建空 Baseline。

Baseline `projection_json` 只保存对应 envelope 的 canonical `value` JSON；`rule_id/source_id/final_url/
captured_at/document_id/content_hash/byte_length` 由表列承载并重建 envelope。Feed/Page 持久化 validator 必须
exact-key 校验 schema/type、Rule/Source 绑定、URL/ISO 时间/documentId、64-hex hash、预算和 JSON；重新编码
value 后要求 JSON、UTF-8 byteLength 与 SHA-256 分别逐字节/逐值恒等。Feed 还校验每个 `FeedField`：
`originalBytes >= utf8(text)`，`truncated=false` 时二者相等且可重算 valueHash；`truncated=true` 时要求
`utf8(text)<=MAX_FEED_FIELD_BYTES` 且 `originalBytes>utf8(text)`（多字节安全截断可使 excerpt 少于预算数个
bytes），valueHash 只接受 64-hex；非法/未来/超限数据使 Store unavailable，禁止部分启动。

### 6.5 公开页面 HTML SAX

公开 Page Rule 通过 PublicWatchHttpClient 获取最多 2 MiB 解压后 HTML，流式交给
`PublicHtmlSaxReader`。只从 body/main/article/heading/table/a 的解析事件构造 `DocumentChannels`；忽略
script/style/noscript/template/svg/math/iframe/object/embed/form/input/button 内容与属性。HTML 中的 URL 只
作为 link 数据规范化，不触发请求。

- 解码先缓存最多 1024 bytes，按 BOM、HTTP Content-Type、`<meta charset>` 的确定性优先级选择
  TextDecoder；只接受 UTF-8/UTF-16/windows-1252/ISO-8859-1 明确映射，冲突/未知编码受控失败；
- 最大 20,000 节点、深度64、单标签64属性；达到任一上限整次 `budget_exceeded`；
- 文本边到达边规范化并受 64 KiB最终 Projection预算，原始 HTML/DOM/位置信息零落盘；
- base URL 只接受首个同文档合法 http/https `<base href>`，重走 NetworkPolicy 的纯 URL 校验；不发请求；
- parser error、编码冲突或通道无法形成 Target 所需 Region → `parse_changed/unavailable`；
- 页面依赖 JavaScript 才有内容时不自动创建 WebContents；UI 允许用户显式切换为 Session 模式并重新授权/
  rebaseline。

## 7. Acquisition 失败闭环

| 分类                     | 典型来源                             | 重试               | Baseline | 状态/用户动作                                    |
| ------------------------ | ------------------------------------ | ------------------ | -------- | ------------------------------------------------ |
| `unavailable`            | DNS/连接/临时 5xx                    | 1 次 + 退避        | 保留     | 3 次 degraded                                    |
| `budget_exceeded`        | 响应/投影/运行超限                   | 否                 | 保留     | 显示限制；需调整目标                             |
| `robots_disallowed`      | robots deny                          | 否                 | 保留     | 立即暂停                                         |
| `security_rejected`      | scheme/IP/redirect/downgrade/XML DTD | 否                 | 保留     | 立即暂停；安全文案                               |
| `login_required`         | 登录跳转/受保护页                    | 否                 | 保留     | 立即暂停；重新授权                               |
| `captcha`                | challenge/captcha                    | 否                 | 保留     | 立即暂停；不绕过                                 |
| `parse_changed`          | Region/feed 结构失效                 | 首次下次计划重试   | 保留     | 连续 2 次暂停，修复/重建                         |
| `condition_error`        | Condition/ChangeSet 验证或求值失败   | 否                 | 保留     | 立即 dependency-unavailable 暂停；修复 Condition |
| `dependency_unavailable` | XML 资格/运行装配失败                | 否                 | 保留     | feed 全局 fail-closed                            |
| `interrupted`            | 退出/崩溃                            | 已消费 slot 不重放 | 保留     | 审计可见                                         |

缺失 RobotsGate、robots 文件级非法 UTF-8、网络总 deadline 用尽均映射为 `unavailable`；robots 中
单条 ABNF/控制字符/percent 语法错误只忽略该行并继续使用其它 parseable rules。robots
地址/scheme/redirect/伪造 raw 请求安全拒绝仍为 `security_rejected`，robots 响应字节超限仍为
`budget_exceeded`。所有失败均零目标 socket 或立即销毁当前 socket，旧 Baseline 不变。

错误检测不得用单一敌手正文字符串直接决定登录/captcha。使用主进程 URL/HTTP 状态、导航结果、
已知 Chromium error URL、受控 DOM 元数据和保守判定；不确定时 unavailable，不回显页面挑战正文。

## 8. PageProjection 与 Region

两条 acquisition 路径严格分离但汇合到同一 `DocumentChannels`：

- **public**：PublicWatchHttpClient → PublicHtmlSaxReader；零 Cookie、零 JavaScript、零子资源，
  `documentId=null`，capturedAt/final URL 由主进程 HTTP acquisition 记录。
- **session**：WatchTaskTabWorkspace 每次运行创建精确 task-owned Tab，BrowserWatchReader 从该 Tab 实时调用
  BrowserController，不复用用户 Tab、不缓存 PageSnapshot；把已有 `visibleText/headings/tables/links` 映射为
  DocumentChannels，忽略 inputs/form values/buttons 的可变值；capturedAt/documentId/final URL 取主进程快照。

public 不自动回退 session；session 只能来自逐规则用户授权。创建/编辑 Rule 的预览必须使用最终选定模式，
不能用共享浏览器预览替公开 HTTP 建基线。

### 8.1 Acquisition → Processing 窄接口与所有权

D7 将 D5 的占位 `{ok:true}` 成功形态替换为闭合判别联合；Page/Feed 不各自复制 Baseline/Event 逻辑：

```ts
type AcquiredProjection = FeedProjection | PageProjection;

type WatchBaselineHint =
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

interface WatchAcquisitionInput {
  rule: WatchRule;
  baselineHint: WatchBaselineHint;
  signal: AbortSignal;
  deadlineMs: number;
}

type WatchAcquisitionResult =
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
      disposition: PageAcquisitionDisposition | FeedAcquisitionDisposition;
    };

interface WatchProcessingService {
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

type WatchProcessingResult =
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
```

所有权和调用顺序冻结：`WatchAcquisitionService` 只按 Rule kind/accessMode 路由到 FeedAcquisitionService 或
PageAcquisitionRouter 并返回上述 DTO；WatchRunCoordinator 保持 run/abort/retry/host gate 与两次 Source
revalidation 所有权。第一次 Source revalidation 成功后、任何网络前，Coordinator 必须调用
`prepareAcquisition`；ProcessingService 经 Repository 读取并严格验证 Rule 当前 Baseline，把**与该
baselineVersion 绑定**的 contentHash/Feed validators 作为不可变 hint 返回，再传给 acquisition。Acquisition
不得读 SQL，Feed 只能从该 hint 生成 `If-None-Match`/`If-Modified-Since`，不得从最新 Run metadata 猜测
validator。Baseline 行缺失时只允许 Rule.baselineVersion=0 并返回 `none`；行存在时 Rule/Baseline version、
projectionType、contentHash 与 JSON validator 必须全部恒等，否则 Store unavailable。第二次 Source
revalidation 成功后，Coordinator 把同一 hint、不可变 acquisition 和
`sourceAfterAcquisition` 交回 ProcessingService。ProcessingService 是 Baseline JSON validator、Feed/Page Diff、Condition、
EventValidator、reversal 查询与 Repository 结果事务的唯一 main-process 编排者。Repository 仍是唯一 SQL
点，ProcessingService 不自行执行 SQL；Diff/Condition/EventValidator 仍为 shared 纯函数。`not-modified`
只能在 hint.kind=feed 且结果事务内当前 Baseline version/contentHash 与 hint 精确相等时走 unchanged，禁止进入
Diff；`none`/`page` hint 收到 not-modified 是 validation-failed。任何第二次 revalidation 非 ok 都在调用
Processing 前停止；locator prepare 若在此后发生，仍由结果事务内 Rule 状态/fingerprint CAS 整体拒绝。
`identity/baseline/event-conflict` 都是零写 conflict：Coordinator 不把它改写成 unchanged/failed，也不另写
Run audit；Source/Rule 协调或下一启动恢复拥有后续状态。validation/budget 若尚能正常访问 Store，则
ProcessingService 以 §5/§7 的闭合 failed outcome 在单事务终结并返回 ok=true；只有无法安全形成该事务才
返回 store-unavailable 并停止 Scheduler。

Feed validator 的持久化语义（#S6-056）冻结如下：validator 是 Baseline 身份的一部分，而非 Run 派生状态。
HTTP 200 建立/推进 Baseline，或 contentHash 相同而只更新成功元数据时，提交值都精确等于该 200 响应经边界
validator 后的 `etag/lastModified`；header 缺失或超限即存 null，不能沿用旧 validator。HTTP 304 成功时，
响应中存在且合法的新值替换旧值，缺失/超限值保留 hint 中对应旧值；Baseline version/contentHash 不变。
这两类 validator 更新都与 Run/health/audit、`sourceRowVersion=max(...)` 及适用的 Baseline/Event 写在同一结果
事务。condition_error、unexplainable/budget/validation failure、identity/baseline/event conflict、事务回滚或
进程崩溃均不保存本次响应 validator。Page Baseline 的两列固定为 null；rebaseline 的 Feed 只接受本次 200
validator。Run `response_metadata_json` 只是有界诊断记录，任何后续 acquisition 都不得读取它作为条件请求输入。

`projection` 的 contentHash 与 Feed/Page hint 相等时固定为 `Run=unchanged`，零 Diff/Event/observation/item/
outbox、Baseline version/content JSON 不变；Feed 的 200 validator、Run/health/audit 与 rowVersion 仍按上段同
事务提交。该路径及 304 都必须经过 #S6-057 完整身份 CAS，不能因为“内容没变”绕过暂停/locator 并发防线。

Run 成功/失败终态统一使用以下 exact-key schema；Session Page 的 `http=null`，Public Page 可记录已存在的
200 状态但不得生成/消费条件 validator。数组均去重并按各自 union 声明顺序排序，整体 canonical JSON UTF-8
≤ `MAX_RUN_RESPONSE_META_BYTES`；D7+ Repository 写入端对额外键、未来 schemaVersion、非法类型/状态、超限
或未排序数据一律拒绝：

```ts
interface WatchRunResponseMetadata {
  schemaVersion: 1;
  http: null | ConditionalResponseMetadata;
  conditionWarnings: ConditionWarningCode[];
}
```

acquisition 结束前尚未运行 Condition 时 `conditionWarnings=[]`；成功 Diff 后精确写入 §5 的 warning。原始
header、正文、敌手错误串及未验证字段不得进入该 JSON。

v2 对既有 `response_metadata_json` 只要求可解析 JSON，无法在不改列值的前提下追溯证明其为新 schema。
因此 v2→v3 必须逐字节保留该列：读取时只有 exact-key `schemaVersion=1` 才提升为上述可信 DTO；其它既有
parseable JSON 只作为 `legacy-opaque` 保留，永不作为 acquisition 输入、Condition warning、renderer/prompt/
日志内容或新写模板。新写 API 不接受 `legacy-opaque`。这项兼容边界既满足 v2 数据逐列恒等，也不把旧宽松
JSON 提升为程序事实。

### 8.2 Session task-tab acquisition

```ts
interface WatchTaskTabBrowser {
  createTab(url: string): Promise<TabInfo>;
  closeTab(tabId: string): Promise<boolean>;
  activateTab(tabId: string): Promise<boolean>;
  getTabs(): Promise<TabInfo[]>;
  getActiveTab(): Promise<TabInfo | null>;
}

interface BrowserWatchReadPort {
  getTabs(): Promise<TabInfo[]>;
  getPageSnapshot(tabId: string): Promise<PageSnapshot | null>;
}
```

每次 Session attempt 的固定时序如下；`WatchRunCoordinator` 持有 AbortSignal 和 deadline，Workspace/Reader
零 timer 所有权，等待使用注入 Clock：

1. 复验 Rule enabled、Source locator fingerprint、`sessionConsent.version===1`、consent origin 与
   `PageTarget.pageUrl` origin 精确一致；撤销/恢复失效/不一致直接 `login_required`，零 Tab、零网络。
2. 对 `pageUrl` 的 canonical `host:effectivePort` 取得 §4.3 host gate；只有 gate 成功且 signal 未 abort 才可调用
   `createTab(pageUrl)`。该调用是 Session attempt 唯一的应用发起顶层导航；禁止先建 URL Tab 再二次 navigate。
3. create 前记录 `tabsBefore` 与 `activeBefore`。返回后先证明 tabId 非空且不在 `tabsBefore`；若敌手/异常实现
   返回既有 id，零关闭、零登记、`unavailable`。确认全新 id 后立即 provisional owned，再检查 abort/后置快照。
4. BrowserController create 会激活新 Tab；Workspace 按第五阶段已验证的三态恢复焦点：若当前仍是 task Tab 且
   `activeBefore` 仍存在，则立即 activate 原 Tab；若用户已切到其他用户 Tab，零 activate；原 Tab 已关闭则不重建、
   不猜替代。恢复失败先清理 task Tab，本 attempt 失败；在焦点处理完成前不读取页面。
5. 最多用 `NETWORK_ATTEMPT_TIMEOUT_MS` 等待精确 tabId 到 ready；error/missing/用户关闭/timeout/abort 都失败。
   ready 后 `getPageSnapshot(tabId)`，随后再次检查 signal、tabId 仍存在、快照非 degraded 且 documentId/readyState
   合规；任何迟到结果丢弃。
6. 先用受控 URL/导航状态判定 login/captcha/challenge。再要求 final URL 为 http/https、final origin 精确等于
   consent origin，且去 fragment 后 canonical final URL 等于 `PageTarget.pageUrl`；跨 origin 安全拒绝，登录/
   challenge 暂停为相应 health，同 origin locator redirect 视为 `source-changed` 并要求 rebaseline，绝不自动改 Rule。
7. 仅验证后的 Snapshot 进入 DocumentChannels/PageProjection。`finally` 只对 provisional/owned 的精确 tabId
   close；`false`/抛错不冒充已清理，保留内存所有权供 `cleanupAll()` 在终态与 shutdown 重试，并使 Watch
   unavailable、零结果提交。用户关闭 task Tab 视为已清理，但当前 attempt 仍失败。

并发由 `MAX_GLOBAL_WATCH_RUNS=4` 和同 Rule 单运行共同约束，因此 Watch task Tab 同时最多4个。Workspace 对
in-flight create 设置 closing/drain 屏障：stop/timeout/shutdown 期间不接新建；已开始 create 落定后先做所有权证明，
再精确清理。进程崩溃由 Electron 销毁未持久化 WebContentsView；Watch 从不保存 tabId，也不恢复旧 task Tab。
下次启动只凭已持久化 `sessionConsent` 与 `persist:aibrowse` Cookie 分区重新走上述完整流程；Cookie 仍无读取通道。

用户 Tab 保护 oracle：attempt 前存在的每个用户 tabId/url/title 在 attempt 后不被 close/navigate；若用户未在
create 窗口主动切换，active Tab 恢复并保持 `activeBefore`；若用户切换，Workspace 不抢回焦点。日志/DB/IPC 只记
runId、数量与闭合错误码，不记录 task tabId、Cookie、PageSnapshot 或 URL query。

规范化顺序：

1. Unicode NFC；
2. 删除 C0/C1 控制与 bidi 控制；
3. CRLF→LF，空白折叠，trim；
4. URL 去 fragment、敏感 query 脱敏后 canonicalize；
5. table header/cell 逐格规范化，保持行列边界；
6. navigation/广告/时间戳不做不可证明的全局黑名单；用户通过 Region 排除噪声；
7. 生成字段目录、byteLength 和 SHA-256。

Region 重新定位：

- main-text：整个 `visibleText`，UI 明示高噪声风险；
- headings：按明确 levels 输出顺序列表；
- table：header fingerprint 必须唯一匹配指定 occurrence，列数/关键 header 漂移为 parse_changed；
- links：仅输出规范化 link text + URL；sameOriginOnly=true 时过滤跨域。

公开 HTML 与 Session PageSnapshot 均不采集跨域 iframe，UI 显示主文档限制。创建/编辑时，主进程签发
单 Rule 绑定的一次性 opaque grant handle；renderer 只能短暂持有该无凭据 handle，主进程消费后只持久化
`sessionConsent` 的 origin/time/version；`PageTarget.pageUrl` 是 locator 而非凭据。不持久化 preview tabId、运行
task tabId、handle、Cookie 或 session credential。Source URL/origin 变化、用户撤销或 watch.db 恢复会使 consent
失效并进入 login_required。

## 9. Baseline、Diff、Event 与 Evidence

### 9.1 Baseline

每 Rule 仅一个 last-known-good Baseline。写入使用 `expectedBaselineVersion` CAS；并发/陈旧运行不能覆盖。
首次成功只写 Baseline + `baseline-established` audit。手动 rebaseline 需要预览确认；写新 Baseline、递增
version、记录原因，不创建变化事件。

### 9.2 Diff

FeedDiff：

- item 新增/删除；
- 同 item 的 title/link/published/summary 字段变化；
- feed 顺序变化本身不构成 Event；
- 重复 item identity 取首次，记录安全 warning，不重复事件。

PageDiff：

- Region/field exact normalized equality；
- 文本生成有界共同前后文 old/new 摘录；
- table 生成 cell/row 类型化 change；
- links 按 canonical URL key 生成 added/removed/label-changed；
- 不运行语义模型或模糊相似度决定 equality。

### 9.3 Evidence

```ts
type EvidenceValue =
  | {
      kind: 'present';
      excerpt: string;
      valueHash: string;
      normalizedBytes: number;
      truncated: boolean;
    }
  | { kind: 'absent' };

interface ChangeEvidencePair {
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
```

新增用 `before.kind='absent'`，删除用 `after.kind='absent'`，所以每个变化仍有可解释双侧证据。
Evidence 必须绑定本 Rule 的旧 Baseline/新 Projection；URL、时间、documentId 由 acquisition 记录，模型
不能提供或覆盖。

若 contentHash 不同但 Diff 无法生成至少一个合规 pair，结果为 `unexplainable_change`（映射
parse_changed/degraded，run 终态 `failed/parse_changed` 不可重试），零 Event、零 Baseline 推进。任何摘录
截断都保留原规范化字节数与完整值哈希。

`EvidenceValue.present` 的取值口径冻结如下（#S6-046）：

- Feed：`FeedField` 携带 `valueHash`（截断前完整规范化值的 SHA-256 小写 hex，§6.4）。Evidence 的
  `valueHash` 只消费该字段；`excerpt=FeedField.text`、`truncated=FeedField.truncated`、
  `normalizedBytes=FeedField.originalBytes`（`MAX_FEED_FIELD_BYTES == MAX_EVIDENCE_VALUE_BYTES`）。
  对已截断 excerpt 重新计算哈希冒充完整值哈希一律禁止。
- Page：`PageProjectionField.value` 完整持有（无字段级截断），`valueHash=SHA-256(utf8(field.value))`、
  `normalizedBytes=utf8ByteLength(field.value)`，由 Diff/Evidence 确定性计算；`excerpt` 取完整规范化值
  前 `MAX_EVIDENCE_VALUE_BYTES` UTF-8 字节（不拆 surrogate）并标 `truncated`。
- URL 安全投影：`before/afterFinalUrl` 取对应 envelope `finalUrl` 去 fragment 与去 query 形态
  （scheme://host[:port]/path）；Cookie、表单、认证数据不得进入 Evidence。
- 身份派生：Feed `itemId=FeedItem.identity` 且 `feedItemKey` 取同值；Page `itemId` 对 link 字段取
  canonical URL，其余字段取 fieldKey；Page `feedItemKey` 恒 null。
- Feed 变化比较仅限 title/link/published/summary 四字段（§9.2）；updatedAt/author 在 v1 不产生变化对，
  也不进入 Feed 条件字段目录。
- Condition 求值字段目录：Page 取 Baseline 与新 Projection fieldKey 的并集；Feed 为闭合集
  `{title, link, summary, published}`。Condition error 不是 unmatched：求值/校验失败保留旧 Baseline，
  精确映射 `failed/condition_error/retryable=false` 并按 §5 立即暂停；字段不存在/typed operator 不适用则是
  no-match+warning，推进 Baseline，二者不得共用分支。

### 9.4 Event 与幂等

```ts
interface WatchEvent {
  id: string;
  ruleId: string;
  sourceId: string;
  eventKind: 'added' | 'removed' | 'changed' | 'reversal' | 'mixed';
  importance: 'normal' | 'important';
  idempotencyKey: string;
  changeFingerprint: string;
  firstObservedAt: string;
  lastObservedAt: string;
  itemCount: number;
  readAt: string | null;
}
```

- `importance` 取 Rule 的用户选择，不由 AI 推断。
- **idempotencyKey（#S6-050）**：`SHA-256(utf8("watch-event-idem-v1\0" + ruleId + "\0" +
baselineVersion 十进制串 + "\0" + newProjectionHash + "\0" + conditionVersion))`，观察级 UNIQUE
  （schema v3）。`newProjectionHash` 取新 Projection envelope 的 `contentHash`（Feed 为 canonical 编码的
  SHA-256）；`conditionVersion` 在 Rule.condition 为 null 时取 `"none"`，否则取经验证
  StructuredCondition 的 canonical JSON（固定键序 `version/combine/predicates`，谓词键序
  `fieldKey/operator/operand/caseSensitive`）的 SHA-256 小写 hex。
- **changeFingerprint（#S6-050）**：pair 级 kind 先行——before=absent/after=present 为 `added`、
  before=present/after=absent 为 `removed`、双侧 present 为 `changed`、命中 reversal oracle 记
  `reversal`；fingerprint = `SHA-256(utf8("watch-change-fp-v1\0" + 各元组按 UTF-8 字节序排序后以 \0
连接))`，元组 = `itemKey \x01 fieldKey \x01 pairKind \x01 beforeToken \x01 afterToken`，
  token = `"absent"` 或 `"p:" + valueHash`。
- **幂等与 fingerprint 职责（#S6-049/#S6-051）**：唯一的业务去重键是观察级
  `idempotencyKey`（`watch_event_observations.idempotency_key` UNIQUE），只表示“同一旧 Baseline、同一新
  Projection、同一 Condition 版本的处理重放”。`changeFingerprint` 是观察内容的确定性签名，只用于
  查询、审计投影、固定向量和 Event 首观察兼容列；**不拥有跳过观察、items、Event 合并或 Baseline 推进的
  权力**。同 Event 或跨 Event 再现相同 fingerprint 都必须作为新真实观察处理，除非
  idempotencyKey 也相同。因此窗口内 `A→B→A→B→A` 的四个变化观察全部持久化、Baseline 依次
  `B/A/B/A`，任何 coalesce 都不得吞掉中间 pair；跨窗口首个 pair 仍可按最近对镜像判为 reversal。
- **真正重放的精确终态（#S6-051/#S6-057）**：结果事务先做 Rule enabled/desired/unpaused 与
  source/fingerprint 身份复验（此步不以
  expectedBaselineVersion 提前挡住合法 replay），再查询 observation idempotencyKey。不存在时必须再要求
  当前 `baselineVersion===expectedBaselineVersion` 才走新建/合并；已存在时必须验证其
  Event/Rule/Source 与输入一致，且当前 Baseline version `>= expectedBaselineVersion+1`，否则 Store
  unavailable（数据完整性失败）。合法重放不新增/修改 Event、observation、item、outbox 或 Baseline，
  Baseline 保持数据库当前版本（原观察若成功，已在原子事务中推进，绝不“退回旧值”）。若本次 `runId`
  仍是 running，则同一事务只把该 Run 终结为 `event-deduplicated`、健康恢复 healthy、失败计数/backoff
  重置，并写恰好一条 `run/event-deduplicated` 审计；若该 Run 已以原观察终态完成，则幂等返回既有
  outcome，零新审计/零写入。locator/source 不满足或 replay 的 Baseline 仍落后于应有提交版本时，不得借
  既有 observation 绕过 CAS，整体返回 conflict/unavailable、Run/Baseline/observation 全不写；Baseline 已由
  后续真实观察推进到更高版本是合法，不得倒写或回退。
- **reversal oracle（#S6-048）**：对当前对 P=(itemId, fieldKey, before, after)，取同 Rule 同
  `(itemId, fieldKey)` 最近一次已持久化变化对 Q（按 §10.1 冻结的 observation/Event/item 全序做有界
  查找）；P 为 `reversal` 当且仅当 P 是 Q 的 typed 镜像——
  P.before 与 Q.after、P.after 与 Q.before 逐侧一致（absent↔absent；present 按 valueHash 相等）。
  禁止搜索更早历史或任意其它字段；无历史对必不是 reversal。add/remove 的反转同由镜像 oracle 判定。
- **观察与 Event 种类（#S6-049）**：每个成功变化处理先创建不可变 observation；pair kind 按观察聚合——
  全 added→`added`、全 removed→`removed`、
  全 changed→`changed`、全 reversal→`reversal`、其余→`mixed`；Event 合并多个观察时，
  `watch_events.event_kind` 按其全部观察重新聚合同样规则更新，`change_fingerprint` 保持首个观察值，
  `lastObservedAt`/`itemCount` 更新。部分 pair 为 reversal 的观察 kind 为 `mixed`。
- **coalesce oracle（#S6-047）**：新观察仅当同时满足以下条件才合并——① 候选取该 Rule 最近一个
  Event；② `nowMs - event.firstObservedAtMs < EVENT_COALESCE_WINDOW_MS`（达到或超过边界必新建）；
  ③ 既有 items 序列化字节 + 新 items 序列化字节 ≤ `MAX_EVENT_EVIDENCE_BYTES`；④ 身份与 CAS 复验
  通过。否则新建 Event。32 KiB 预算只计 Event 全部 ChangeEvidencePair 的序列化 JSON（不含
  observation 元数据；后者按有界开销计入全库 100 MiB 预算）。合并绝不创建或修改 outbox 行；
  outbox 已发送不阻止合并。每个变化项保留独立 Evidence pair，同字段再次变化追加独立 pair，禁止
  “首旧末新”折叠。
- **outbox（#S6-047）**：outbox 行只在新建 Event 时写入，且仅当 Rule 非 muted；D7 冻结
  `channel='in-app'`、`subjectType='event'`、`dedupeKey="in-app|event|" + eventId + "|1"`、
  `privacy_json` 为有界程序事实 `{eventKind, importance, itemCount}`（零远程文本、零摘录）。
  muted Rule 的 Event 正常持久化但零 outbox。Windows/系统通知展示由 D9/D10 负责。
- **原子性**：新建 = watch_events + watch_event_observations + watch_event_items + Baseline +
  Run 终态 + outbox + audit 单事务提交；合并 = observation 与 items 插入 + Event 行更新 +
  Baseline + Run 终态 + audit 单事务提交。合并事务不以 fingerprint 作为 CAS 或去重条件；除
  expectedBaselineVersion 身份 CAS 外，
  必须同事务复验 Event 存在、`first_observed_at` 与 `item_count` 等于期望值。任一失败整体回滚，
  旧 Baseline 与既有 Event 不变。

Event 字段不可编辑。用户可 read/unread、批量标记和永久删除；删除级联 Evidence/notification outbox，
Digest 引用变为 `user-deleted` tombstone，AI 解释不再显示。

## 10. `watch.db`、迁移、恢复与清理

### 10.1 Schema v1→v4

D6 关闭点的实际 Store 为 schema v2（v1 业务表 + v2 audit CHECK 表重建）；D7 只追加
`WATCH_MIGRATION_V3`。D8 只追加 `WATCH_MIGRATION_V4`；v1–v3 statement bytes 全部冻结。D8 完成后
latest=4、`user_version>4` 才是 future schema；迁移前 v3 仍是合法输入。

| 表                         | 核心列/约束                                                                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watch_rules`              | id PK、source_id、kind/state/pause_reason/desired_enabled/muted/access_mode、schedule/target/condition 严格版本、source_row_version/source_locator_fingerprint、next_due/last_consumed_scheduled_for/backoff/failure/baseline_version、时间           |
| `watch_baselines`          | rule_id PK/FK、version、projection_type/json/hash/bytes、final_url/captured_at/document_id、conditional_etag/conditional_last_modified；bytes/validator CHECK；Page validator 必为 null                                                               |
| `watch_runs`               | id PK、rule_id FK、request_key UNIQUE、trigger/scheduled_for/start/finish/outcome/health、响应元数据有界                                                                                                                                              |
| `watch_audits`             | id PK、rule_id、kind、reason code、created_at；零敌手正文                                                                                                                                                                                             |
| `watch_events`             | id PK、rule/source、kind/importance、idempotency_key UNIQUE（首个观察键）、fingerprint（首个观察指纹）、观察时间、read_at、item_count                                                                                                                 |
| `watch_event_observations` | v3：id PK、event_id FK CASCADE、sequence ≥0、idempotency_key UNIQUE（观察级）、change_fingerprint 64 hex、event_kind 闭合、observed_at、first_item_sequence、item_count ≥1；UNIQUE(event_id,sequence) 与 UNIQUE(id,event_id)                          |
| `watch_event_items`        | id PK、event_id、observation_id、sequence ≥0、observation_item_sequence ≥0、field_key/label、before/after typed value JSON、双侧元数据；UNIQUE(event_id,sequence)、UNIQUE(observation_id,observation_item_sequence)、复合 FK(observation_id,event_id) |
| `digest_change_state`      | v4：singleton id=1、last_sequence ≥0；journal 清理后仍保存单调 high-water                                                                                                                                                                             |
| `digest_change_journal`    | v4：sequence PK、observation_id UNIQUE、event/source/observed_at、status active/expired/user-deleted；零 Evidence/正文                                                                                                                                |
| `digest_schedules`         | v4：id/version、排序去重固定 source_ids_json、daily schedule_json、ai_enabled、cursor_sequence、state active/paused、next_due/last_consumed/last_daily_local_date、created/updated/last_checked、last_period_json/last_run_stats_json                 |
| `digest_runs`              | v4：id/schedule_id、request_key UNIQUE、logical_date、lower/upper/next sequence、period、run_stats_json、state running/budget_exceeded/completed、blocked 时间/required/available bytes、created/finished；UNIQUE(schedule_id,logical_date)           |
| `watch_digests`            | v4：id/schedule_id/run_id/batch_index/sequence range、canonical facts/hash/revision、canonical explanation nullable、bytes、provider state/result、claimed facts revision/hash、claimed/finished/created 时间；UNIQUE(run_id,batch_index)             |
| `digest_event_refs`        | digest_id/event_id、status active/expired/user-deleted；复合 PK                                                                                                                                                                                       |
| `notification_outbox`      | id PK、subject_type/id、channel、dedupe_key UNIQUE、privacy_json、state/attempt/time                                                                                                                                                                  |
| `source_cleanup_intents`   | mutation_id PK、source_id、operation、before/after_projection_json、affected_rule_state_json、state prepared/source-committed/complete/aborted、time；source_id 索引                                                                                  |

外键打开；删除 Rule CASCADE baseline/runs/audits/events/outbox；Event CASCADE observations；items 通过
`FOREIGN KEY(observation_id,event_id) REFERENCES watch_event_observations(id,event_id) ON DELETE CASCADE`
级联，parent 的 `UNIQUE(id,event_id)` 使数据库层拒绝“item.event_id=E1、observation 属于 E2”的跨 Event
错配；禁止退回两个互不相关的单列 FK。Digest 对 Event 使用 tombstone 状态而非丢失引用真实性。所有 JSON 读取后再次用
共享 validator，非法/未来版本使 Store `unavailable`，不得部分启动 Scheduler。

Schema v3（#S6-049/#S6-055/#S6-056，D7）：同一 migration 同时扩展 `watch_audits` CHECK、表重建
`watch_baselines` 追加两个 nullable 条件 validator、新增 `watch_event_observations`，并表重建
`watch_event_items` 追加 observation 关系。Baseline validator 每列 runtime 精确检查 UTF-8 ≤
`MAX_CONDITIONAL_FIELD_BYTES`；SQL CHECK 只作 defense-in-depth，`projection_type='page'` 时两列必须均为 null。
v2→v3 copy 时既有 Baseline 全部旧列逐列恒等、两新列固定 null，不能从 `watch_runs.response_metadata_json`
回填或猜测。v2 既有每个 Event 回填
恰好一个 observation：`idempotency_key/change_fingerprint/event_kind` 逐列取 Event 行值、
`observed_at=last_observed_at`、`sequence=0`、`first_item_sequence=0`、`item_count` 取 Event 行值，id 为
SQL 可直接且可逆生成的 `"v2:" || eventId`；新观察使用小写 v4 UUID，validator 对回填形态要求 suffix
逐字等于所属 Event id，不接受任意 `v2:` 字符串，因此只接受这两种闭合 id 形态。
既有 items 的 id 与全部 v2 列逐列恒等，只追加该 observation id 和按
原 `sequence` 相同值的 `observation_item_sequence`。回填前必须用 migration 内临时 CHECK guard 验证每个
Event `item_count>=1`、实际 item count 恰等于 Event.item_count、sequence 为无缺口 `0..item_count-1`；零 item、
计数不一致或序列缺口使任一 guard INSERT 失败并整体回滚。确定性 observation id 若发生 UNIQUE 冲突，禁止
随机 fallback/覆盖，migration 整体失败并保持 v2。

v2→v3 全程在引擎单事务完成；任一 CREATE/guard/copy/drop/rename/index/CHECK/user_version 语句（包括
Baseline 表重建的任一步）失败，
`user_version` 仍为2、全部 v2 表/索引/行逐列恒等，临时 v3 表不可见；成功后除明确新增列/回填 observation 与
Baseline validator null 列/audit CHECK 集合外，`watch_baselines` 与 `watch_events`、`watch_event_items` 既有列、
`watch_audits` 及其余所有表逐列恒等。
`watch_runs.response_metadata_json` 尤其不得为了升级为 v3 DTO 而重写；§8.1 的 legacy-opaque 读取边界适用。
v1/v2 语句字节冻结。`FeedField.valueHash` 自 v3 起为 Feed Baseline JSON 读回校验必需字段：旧形态
（无 valueHash）feed projection JSON 读回校验失败 → 按 §10.2 Store `unavailable`（fail-closed，
不静默改写；产品首个正式版本不携带任何既有 watch.db 用户数据，该路径仅为防御性契约）。

新写序列冻结：新 Event 的 observation.sequence=0、item.sequence=0..n-1；coalesce 时
`observation.sequence=MAX(existing)+1`，`first_item_sequence=expected Event.item_count`，新 items 的 Event
sequence 从该值连续递增，observation_item_sequence 从0连续递增。所有 MAX/计数读取与 Event
`expected item_count/first_observed_at` CAS 同事务，禁止 `COUNT()+INSERT` 跨事务竞态。新建/合并输入
items=0 直接 validation-failed，零 Event。提交后以及 Store 启动扫描必须验证：每 Event 至少一个
observation、Event.item_count = observations.item_count 总和 = items 实际数；每 observation 的 item_count、
first_item_sequence 与所属连续 items 精确一致；Event/observation/item 两级 sequence 均从0无缺口。
为兼容 v2 保留在 `watch_events` 的 `idempotency_key/change_fingerprint` 必须逐值等于该 Event
observation.sequence=0 的同名列；不一致视为 corrupt/unavailable，后续 observation 不回写这两个首观察列。

确定性排序 oracle：最近 Event 列表按
`last_observed_at DESC, first_observed_at DESC, id DESC`；coalesce 候选按
`first_observed_at DESC, id DESC LIMIT 1`；同 Rule/itemId/fieldKey 最近 pair 按
`observation.observed_at DESC, event.first_observed_at DESC, event.id DESC,
observation.sequence DESC, item.sequence DESC, item.id DESC LIMIT 1`。所有时间相同仍由 id/sequence 构成
全序；SQL `ORDER BY` 必须写全，不依赖 rowid/插入偶然顺序。

Schema v4（D8，#S6-059～#S6-067）冻结如下：

1. v3 已预建的三个 Digest 占位表从未有产品写路径，不具备可证明的 canonical shape。迁移先用临时 guard 要求
   `digest_schedules/watch_digests/digest_event_refs` **全部为空**；任一非空即整体回滚并使 Store
   `unavailable`，不得把宽松 JSON 猜成正式 D8 数据。guard 通过后按 FK 顺序删除空占位表并创建上表 v4
   结构；v1–v3 表、列与行除下述 observation journal 回填外逐列恒等。
2. `digest_change_state` 固定恰一行 `(id=1,last_sequence)`。migration 以
   `observed_at ASC,event.first_observed_at ASC,event.id ASC,observation.sequence ASC,observation.id ASC`
   对现有 observation 排序，从1连续回填 journal sequence，并令 `last_sequence=MAX(sequence)`；同时间戳仍
   全序。之后每个 D7 新建/合并 Event 结果事务先原子递增 high-water，再与 observation/Event/Baseline/Run/
   audit 同事务插入一条 journal；replay/deduplicated 不插入。任何一步失败整笔结果回滚。
3. journal 不以 wall clock 作 cursor，也不对 Event/observation 建删除级联 FK。它只保存 ID、sourceId、
   observedAt 与 tombstone 状态；Event 过期/用户删除/Source 级联前在同一事务分别改为
   `expired/user-deleted/expired`。这样删除 Evidence 后仍能让已冻结 cycle 跨过该 sequence，而不会保留正文。
4. `digest_schedules.state` 只允许 `active/paused`；删除是硬删除而不是第三种行状态。`digest_runs` 只允许
   `running/budget_exceeded/completed`，且 `lower_sequence <= next_sequence <= upper_sequence`；`next_sequence`
   表示最后一个已经由 artifact 事务提交或被确定性跳过的 journal sequence。`running` 要求 blocked/finished
   全 null；`budget_exceeded` 要求 `next_sequence<upper_sequence`、`blocked_at` 非 null、required/available 为安全
   非负整数且 required>available、finished null；`completed` 要求 `next_sequence=upper_sequence`、blocked 三列
   null、finished 非 null。部分 UNIQUE 索引保证每 schedule 最多一条 state 属于
   `running/budget_exceeded` 的非终态 run；同 logical date 唯一。`watch_digests` 的 sequence 区间必须严格递增且
   落在所属 run 上下界内；batch_index 从0连续。
   Schedule 的 created/updated/nextDue 和非 null 可选时间全部是 canonical ISO，`created_at<=updated_at`；
   lastConsumedScheduledFor/lastDailyLocalDate 必须同 null 或同非 null，lastChecked/lastPeriod/lastRunStats 也必须
   三者同 null 或同非 null，非 null period 要求 from<to 且 to=lastChecked。source IDs、daily/IANA、cursor/high-water、
   localDate 与 scheduledFor 的 zone 对应由同一 runtime validator 复验。Run 的 period 要求 from<to，created/blocked/
   finished 时间按状态存在且不早于 created，period/runStats JSON 必须 canonical exact-key。
5. `facts_hash=SHA-256(utf8(facts_json))`，`facts_revision>=1`。`provider_state` 只允许
   `disabled/pending/claimed/succeeded/failed/uncertain/skipped`；`provider_result_code`、claim 列、时间与 explanation
   的唯一合法组合按 §11.5 矩阵同时写入 table CHECK 和 runtime validator。table CHECK 覆盖闭合集合、scalar
   null/non-null、数值与 canonical 时间字典序关系；runtime 再覆盖 JSON、hash、跨行/cursor/ref 关系。`claimed`
   是调用资格已持久化，不证明
   外部服务已收到请求；启动恢复只能 `claimed→uncertain`，不能回到 pending。
6. migration 的 CREATE/guard/backfill/copy/drop/rename/index/CHECK/user_version 任一句失败，都必须保持
   `user_version=3`、全部 v3 schema/index/行逐列恒等、零可见临时表；journal 回填 ID/计数/全序、Digest 空表
   guard 和 v4 runtime 完整性扫描均有逐语句失败注入 oracle。

D8 的审计时间写入统一用 `max(clock.now().toISOString(), 该行已有的最晚前序时间)`，包括 schedule.updated、
run.blocked/finished 与 provider.claimed/finished；这只对审计列防回拨，不改变 Scheduler 的真实 Clock、scheduledFor、
period 或正式 journal cursor。由此即使 wall clock 回拨，上述 SQL 时间序关系仍可机械验证。

### 10.2 Store 启动

1. 打开独立 `watch.db`，PRAGMA/foreign key 固定；
2. read-only probe 与 user_version；未来版本 fail-closed；
3. migration（仅已批准编译期 SQL）；
4. quick/integrity check、JSON shape/预算扫描；
5. 单事务把网络 Watch queued/running→interrupted；把 Digest `provider_state=claimed`→`uncertain`，写
   `result_code='uncertain-after-restart'`、`finished_at=clock.now()`、`explanation=null`，保留 Digest run 原
   `running/budget_exceeded` 状态；
6. reconcile `source_cleanup_intents` 和 SourceService 当前事实；
7. 以全部 active/paused schedule cursor 与所有 running/budget_exceeded cycle next cursor 的最小安全水位清理
   可删 tombstone journal，`digest_change_state.last_sequence` 永不回退；再清理超期/超数/超库预算；
8. 校验全部非终态 Digest cycle；只恢复 active schedule 的 running cycle，并对 active 的 budget_exceeded cycle
   执行 §10.4 容量复验；paused cycle 原样休眠。之后注册 active DigestSchedule/WatchRule 并启动两类 Scheduler；
   任何恢复失败都返回 `unavailable`，UI 只读错误态。

v1 复用 Sources 严格 backup 模式但使用独立 Watch 目录/文件名；备份也受 100 MiB 与最多 5 份/30 天
边界。备份中仍是本地明文，文档如实披露。恢复后必须重新 reconcile Source 并使 Session grant 失效。

### 10.3 Source 生命周期跨库协议

Stage4 的 `Source.version` 是行级乐观并发版本：disable、restore 和每次成功写都会递增。因此它只进入
`sourceRowVersion` 作为“最后观察到的行版本”，**绝不**用来判断 locator 是否变化或是否自动恢复。

```ts
interface SourceWatchProjection {
  sourceId: string;
  rowVersion: number;
  enabled: boolean;
  deletedAt: string | null;
  scope: 'origin' | 'page';
  canonicalKey: string;
}

interface SourceWatchMutation {
  mutationId: string;
  operation: 'create' | 'update' | 'disable' | 'restore' | 'undo' | 'hard-delete';
  before: SourceWatchProjection | null;
  after: SourceWatchProjection | null;
}

interface SourceLifecycleObserver {
  prepare(
    changes: SourceWatchMutation[],
  ): { ok: true } | { ok: false; reason: 'watch-unavailable' };
  commit(mutationIds: string[]): { ok: true } | { ok: false; reason: 'watch-unavailable' };
  abort(mutationIds: string[]): void;
}
```

`SourceWatchProjection` 是 SourceService 的本地 user-audience 窄投影；不含 note、正文、usage 或 DB 句柄。
Rule 的 locator 身份为
`SHA-256(utf8("watch-locator-v1\0" + sourceId + "\0" + scope + "\0" + canonicalKey + "\0" + kind + "\0" + canonicalTargetUrl))`。
`canonicalTargetUrl` 是 FeedTarget.feedUrl 或 Page Rule 建立时的规范化目标 URL，均经当前 SourceService/
NetworkPolicy 重新求值；fragment/display-only 变化不改变身份，scheme/host/port/path/query 中任何有效定位变化、
Rule target 编辑或 Source scope/canonicalKey 变化都改变身份并要求 rebaseline。原始/规范化 URL 不拼接为日志。

SourceService 构造时接收内部 observer；不新增 renderer/Agent/IPC API，原有 SourceService 公共返回类型和
`expectedVersion` 语义不变。manual write、AI change set、Undo、disable/restore/update 和 hard-delete 全走同一顺序：

1. SourceService 完成原有输入/权限/expectedVersion/confirm 校验，在 Source 写事务前生成不可变 before/after
   窄投影和 UUID `mutationId`；批量 change set 作为一个 observer batch。
2. `observer.prepare` 先在 watch.db 单事务写 prepared intent 与受影响 Rule 的 prepare 前状态，并按 after 预先
   fail-closed：disable/delete 暂停
   关联 Rule，locator 改变暂停为 `source-changed`。prepare 绝不把 Rule 从 paused 改为 enabled；restore 只能在
   Source 事务已提交后的 commit 恢复。它只改有效 state/pauseReason/sourceRowVersion；不覆盖
   `desiredEnabled`、Baseline 或 Evidence。
3. SourceService 再执行原有单一 sources.db 事务。若 Source 事务回滚，调用 `abort`：Watch 仅在当前 Source
   仍等于 before locator/state 时恢复 prepare 前有效 state，并把 intent aborted；否则交启动 reconciliation。
4. Source 事务提交后调用 `commit`。Watch 根据实际 SourceService 窄投影而非传入 after 猜测：同 locator
   的普通元数据/version 变化只更新 `sourceRowVersion`；restore 在 locator 相同、`desiredEnabled=true` 且
   pauseReason 是 source-disabled/source-deleted 时自动 enabled；用户 pause (`desiredEnabled=false`) 永不自动恢复；
   locator 改变保持 `source-changed`，必须预览确认 rebaseline；hard-delete 级联 Rule/Baseline/Event/Evidence/
   Digest ref/outbox，并完成 intent。commit 幂等。
5. 每次 run 在 acquisition 前、结果事务前各调用一次 SourceService 取窄投影并重算 fingerprint。Source
   不存在/disabled 则零新网络并暂停；fingerprint 不同则 abort/丢弃结果并 `source-changed`；仅 rowVersion
   变化且 fingerprint 相同则事务更新 `sourceRowVersion`，不丢弃已经形成的有效结果。结果提交 CAS 的完整
   身份条件（#S6-057）为：Rule 仍存在，`state='enabled'`、`desired_enabled=1`、`pause_reason IS NULL`，
   sourceId/fingerprint 与 acquisition 前身份一致，baselineVersion 与 Baseline hint 一致；Source rowVersion
   不参与 CAS。D4 locator prepare 按既有协议先暂停 Rule 为 `source-changed` 且故意保留旧 fingerprint，避免把
   旧 Baseline 绑定新 locator；因此 state CAS 单独即可拒绝 prepare 与 commit 之间的窗口，绝不能要求 prepare
   预写新 fingerprint。用户 pause、Source disable/delete、health pause 也由同一 state/desired/pause CAS 拒绝。
   写入必须是单调协议（#S6-052）：结果事务在身份 CAS 通过后执行等价于
   `source_row_version = max(current watch_rules.source_row_version, revalidation.rowVersion)` 的条件更新，绝不
   直接 `SET source_row_version = revalidation.rowVersion`。因此第二次 revalidation 后、结果提交前完成的
   metadata-only Source commit 若已把 Watch 行推进到更高版本，有效结果照常提交且版本不回退；若此窗口完成
   locator prepare/commit，即使 fingerprint 尚未改变，Rule state/pause 已改变，结果事务身份 CAS 必须整体失败，Baseline/Run/Event/
   observation/item/outbox/audit/sourceRowVersion 全不写。SQLite 写事务串行化使 metadata 写要么先发生并被
   `max` 保留，要么后发生并继续推进，任何交错下 `sourceRowVersion` 单调不减。

失败传播冻结如下：正常 WatchStore 下 prepare/commit/abort 都是同步有界 DB 操作。prepare 失败时 Watch 全局
Scheduler 立即 stop/abort 并进入 unavailable；hard-delete 返回现有 `source-unavailable` 且 sources.db 零写，避免
承诺级联却留下本地 Watch 私有数据。update/disable/restore/Undo 仍允许原 Source 操作提交，保持 Sources 的既有
可用性，但不得报告 Watch 已协调；只写脱敏错误码，Watch 恢复前零调度。Source 已提交后的 commit 失败不能跨库
回滚：Source API 如实返回原操作成功，Watch 保持 unavailable，prepared intent 留待启动 reconciliation。Source
事务失败后的 abort 失败同样使 Watch unavailable，但 Source API 返回原 Source 失败。

只有 D4 尚未接入产品的旧构建中 observer 才是显式 no-op；D4 接线后的应用版本无论 watch.db 是否存在都必须
active。缺失数据库由 Store 正常创建，corrupt/future/unavailable 必须返回失败并停止 Scheduler，不能因文件缺失或
打开失败静默改回 no-op。
启动 reconciliation 在 Scheduler 前扫描全部 Rule + intent，对照 SourceService 当前窄投影重放 commit/abort；
hard-delete 只以 Source 当前不存在为完成依据。全部成功才删 completed/aborted intent 并启动 Scheduler。此协议
保证 Source.version 因 disable→restore 递增时 locator 未变仍可按用户原意恢复，也保证任一崩溃切点后 orphan
Rule 零网络。

### 10.4 保留与全库预算

每次成功写 Event/Digest 前在同事务估算逻辑 UTF-8 bytes；若写入将超过单对象上限，整次拒绝。
清理顺序：已读最旧 Event → 未读最旧 Event；登录态按 30天/100、公开按90天/200；再按全库 100 MiB。
未读也不能突破硬上限。清理 Event 时必须先走同一 Repository scrub 事务：journal/ref 改为 `expired`，
从每个受影响 `facts_json.evidenceMap` 移除该 eventId、把 `referenceStates[eventId]` 改为 `expired`，删除任何
包含该 eventId 的完整 explanation section，重新 canonical 编码 facts/explanation、递增 factsRevision、重算
factsHash/byte_length，再删除 Event/Evidence/outbox。用户永久删除用相同事务但状态为 `user-deleted`；Source/
Rule 级联用 `expired`。任一 Digest 读回/重编码/预算/CAS 失败必须整体回滚并使 Store unavailable，不得半 scrub。

scrub 后仍保留安全 Event 投影（eventId/ruleId/sourceId/kind/importance/所含 observation 时间与计数）和
tombstone，确保历史引用诚实；不得保留 old/new Evidence 或依赖该 Event 的模型断言。若删除相关段后零 section，
`explanation_json` 必须置 null，禁止写不满足 validator 的 `{"sections":[]}`。若 Provider 正在 `claimed`，scrub
同一事务把它终结为 `failed/aborted` 并写 `finished_at`；factsRevision 变化与 state CAS 共同使迟到 explanation
整份丢弃。

journal 不按时间保留。status=active 且仍有 Event/observation 的行随 Event 保留，用于最近7天/今日 preview；不能因
所有 schedule 已消费或不存在而提前删除。只有 tombstone 行才可在
`sequence <= min(全部 active/paused schedule cursorSequence, 全部 running/budget_exceeded run nextSequence)` 时
删除；集合为空时可删全部 tombstone。singleton high-water 保留，未来 schedule 创建从 high-water 开始，不回读
已清理历史；active journal 指向缺失 Event/observation 一律 corrupt/unavailable。

Digest artifact 受全库100 MiB 硬上限；v1 不另设时间保留，用户经 D9 显式删除 schedule 时才级联其
runs/artifacts/refs。写下一 artifact 的同一事务必须先执行既定清理并计算 required/available；仍不足时不写
artifact/ref/cursor，而把 run `running→budget_exceeded`，原子写 `blocked_at/required/available`，schedule cursor
不推进。该态是可恢复的非终态且阻止同 schedule 新 reservation。启动、schedule resume 或 D9 显式“重试”只可
调用 D8 的同一容量复验：重新构造同一 nextSequence 后的候选并执行清理；仅当 required<=available 时才以事务
CAS `budget_exceeded→running`、清空 blocked 三列，提交后且 schedule=active 才重新入队；否则只刷新三项安全
预算数并保持 blocked。普通 timer 不自旋重试，未消费 journal 不清理，也不能删除未消费 Event 或截断 facts 冒充
成功。

Baseline 不因普通清理删除。若单 Baseline 本身超限，Rule health=budget_exceeded 并保持旧 Baseline。

## 11. Digest 与模型边界

### 11.1 Schedule、成员冻结与调度所有权

```ts
interface DigestCursor {
  changeSequence: number; // >=0，唯一正式 cursor；不是时间戳/Event row cursor
}

type DigestScheduleState = 'active' | 'paused';

interface DigestSchedule {
  id: string;
  version: number;
  sourceIds: string[]; // 1..100，按 UTF-8 字节序排序且去重
  localTime: string; // HH:mm
  timeZone: string; // Intl 支持的 IANA id，创建/编辑时冻结
  aiEnabled: boolean; // 默认 false
  cursor: DigestCursor;
  state: DigestScheduleState;
  nextDueAt: string;
  lastConsumedScheduledFor: string | null;
  lastDailyLocalDate: string | null;
  lastCheckedAt: string | null;
  lastPeriod: { fromExclusive: string; toInclusive: string } | null;
  lastRunStats: DigestRunStats | null;
  createdAt: string;
  updatedAt: string;
}

type DigestRunState = 'running' | 'budget_exceeded' | 'completed';

interface DigestRun {
  id: string;
  scheduleId: string;
  requestKey: string;
  logicalDate: string;
  lowerSequence: number;
  upperSequence: number;
  nextSequence: number;
  period: { fromExclusive: string; toInclusive: string };
  runStats: DigestRunStats;
  state: DigestRunState;
  blockedAt: string | null;
  blockedRequiredBytes: number | null;
  blockedAvailableBytes: number | null;
  createdAt: string;
  finishedAt: string | null;
}
```

创建/preview 的 selector 可是显式 Source IDs 或 groupId，但只能交给 main 内部 `DigestMembershipPort`；该端口
通过 SourceService user-audience 窄投影解析一次，返回当前存在的 Source ID。Service 在确认页展示排序去重后的
1..100 个 ID/安全显示名，确认后只持久化 ID，不持久化 groupId，也不订阅 Group 变化。此端口不含 note、正文、
DB 句柄或 IPC 形状；D9 只负责把 UI 选择转交，不能重新定义冻结语义。

新 Schedule 在创建事务中把 cursor 初始化为 `digest_change_state.last_sequence`，所以自动计划只处理创建后的
新 observation；历史“今日/最近7天”只由 preview 提供。成员、localTime 或 timeZone 编辑必须显式确认 reset，
在无 running/budget_exceeded cycle 时更新 version、把 cursor 重置为当时 high-water 并重算 nextDue；
`aiEnabled` 可原位切换且不
重置 cursor。系统时区变化不改冻结 IANA zone；DST gap/fold/逻辑日期完全复用 §4.1。

Schedule 状态机冻结如下；除 create 外所有写都要求 expectedVersion，并在状态/字段实际变化成功时
`version+=1/updatedAt=clock.now()`：

- create 只创建 `active`，`createdAt=updatedAt`，`nextDueAt` 是当前冻结 zone 的下一 daily occurrence；
- pause 只允许 `active→paused`；提交成功后作废 due heap 项并请求当前 worker 在下个 Repository 边界休眠，保留
  nextDue/cursor 与 running/budget_exceeded cycle。每个 batch、completion 与 Provider claim 事务都复验
  schedule=active；因此 pause 提交后不能产生新 artifact/claim。pause 前已经提交的 claim 代表已开始的唯一
  attempt，可完成或被 abort，但不能重试；
- resume 只允许 `paused→active`，不改 nextDue/cursor/lastDailyLocalDate。先恢复原 running cycle 或对原
  budget_exceeded cycle 做容量复验；无非终态 cycle 时，过期 nextDue 按 §4.1 只形成一次 catch-up reservation，
  不为每个错过时点突发补跑；
- 成员/localTime/timeZone 编辑只允许无 running/budget_exceeded cycle 时执行并按上段 reset；aiEnabled 切换不改
  cursor。true→false 同事务把该 schedule 尚未 claim 的 pending artifact 终结为 disabled/disabled；false→true
  不回放既有 disabled/skipped artifact，只影响未来 artifact；
- delete 是显式、不可 Undo 的硬删除，允许从 active/paused 执行：先使 heap/worker token 失效，再单事务删除
  schedule 并级联 run/artifact/ref；不删除 Event/observation。晚到 batch/Provider 写回因 schedule/digest CAS 不存在
  而零写；journal tombstone 水位在提交后按 §10.4 重算。不存在持久化 `deleted` state。

同态 pause/resume 作为幂等读取返回且零版本/时间变化；非法跨态、陈旧 version 或删除竞态返回闭合 conflict。
paused schedule 仍参与 journal 安全水位，Store 启动校验其非终态 cycle 但不执行，直到 resume。
D8 的 DigestService/Repository 独占上述状态写入与预算重试；D9 只能把已验证 UI/IPC 请求绑定到这些冻结方法并
查询安全 DTO（包括 run state、blockedAt/required/available），不得直接写 SQL、补造状态或重定义转换。

`DigestScheduler` 是 D8 新增的零能力调度器：只持有 Clock/TimeZoneResolver、内存 due heap/timer，并提交
`scheduleId + expectedNextDueAt + logicalDate` 给 DigestService；不持有 SQLite/SourceService/Provider/通知。
D8 在 WatchStore normal 且非终态 cycle 校验/恢复完成后于 `src/main/index.ts` 注册/启动，在 before-quit 按 §4.4
停止。它不修改 WatchScheduler 的 ruleId 契约。D9 通知只消费已经提交的 artifact；D8 零 notification/outbox。

### 11.2 Cycle reservation、正式 cursor 与可恢复分批

每个 due 先由 Repository 单事务 reservation：

1. 复验 schedule state=active/expectedNextDueAt、同 schedule 无 running/budget_exceeded cycle、
   logicalDate 未消费；
2. `lowerSequence=schedule.cursor.changeSequence`，`upperSequence=digest_change_state.last_sequence`；该上界在
   cycle 全程冻结，之后产生的 late coalesce 必有更大 sequence，只能进入下一 cycle；
3. `period=(schedule.lastCheckedAt ?? schedule.createdAt, clock.now()]`，以同一 `clock.now()` 冻结
   `toInclusive/fetchedAt`；在该半开闭区间按 Watch run `finishedAt` 计算并 canonical 持久化 runStats；
4. 创建唯一 running `digest_run`，写 lower/upper/next=lower、period/runStats，消费 scheduledFor、推进
   nextDueAt/lastDailyLocalDate；全部同事务后才允许入队。崩溃后使用原 run 上界恢复，绝不重新 reservation。

正式 change order 只用 journal `sequence ASC`。每条 active journal 绑定一个不可变 observation；artifact builder
按 sequence 前缀读取 `(lower,upper]`，只选择 schedule 固定 sourceIds，tombstone/其它来源确定性跳过。对同一
eventId 的多个所选 observation 在**当前 artifact 内**合并为一个 Event slice；Evidence 只取这些 observation
的 items，不能读取 Event 当前聚合 items，否则 upper 冻结后新增 observation 会泄漏进旧 cycle。Event slice 的
kind 按所含 observation kinds 重新聚合，时间/observationCount/itemCount 也只描述该 slice。

greedy batching 每加入一条 observation 都重新 canonical 构造候选 facts：unique Event slices ≤50 且
facts≤49,152 bytes 才接受；下一条超任一边界就关闭当前 batch。D7 单 observation Evidence ≤32 KiB，加上固定
facts overhead 必须能装入一个空 batch；若实际仍不能装入，视为 Store/validator 不一致，cycle 零推进并
fail-closed，不允许截 Evidence。51 个不同 Event 固定形成至少两个 artifact；同 Event 的多个 observation 只
占一个 Event slot但字节全部计入。

每个 batch 使用单一事务复验 schedule state=active 与预期 cursor，再插入 canonical facts + active refs +
`digest-created` 持久化状态，并把
`digest_run.next_sequence` 与 schedule cursor 推进到该 batch 已覆盖的最后 sequence。事务失败则 artifact/ref/
cursor 全无；事务成功后崩溃，恢复从新 cursor 继续，UNIQUE(runId,batchIndex) 纵深拒绝重复。尾部只有被跳过的
其它 Source/tombstone 时，完成事务同样复验 schedule state=active，再把 cursor 推到 frozen upper、更新
lastChecked/lastPeriod/lastRunStats 和
run=completed；无 active Event 的整个 cycle 只做该状态事务，零 Digest、零 Provider、零通知。

正式 cycle 可产生任意必要数量的 artifact，但 provider 工作串行、每提交一个 artifact 后向事件循环 yield；
停止/重启保留 running/budget_exceeded cycle。不能用每轮 cap 截断 frozen upper。手动 preview 查询固定
`(now-7days,now]` 或“今日”窗口，每次只返回一个同预算 batch及 `hasMore/nextPreviewSequence`；继续预览由调用者
显式传回 sequence。preview 不写 schedule/run/artifact/ref/lastChecked/cursor，每次 preview 最多一次 Provider。

### 11.3 程序事实与 runStats

```ts
interface DigestEventProjection {
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

interface DigestFacts {
  schemaVersion: 1;
  scheduleId: string;
  digestRunId: string;
  batchIndex: number;
  period: { fromExclusive: string; toInclusive: string };
  eventCount: number;
  runStats: DigestRunStats;
  events: DigestEventProjection[];
  evidenceMap: Record<string, ChangeEvidencePair[]>;
  referenceStates: Record<string, DigestEventRefState>;
  fetchedAt: string;
}
```

以上根对象和全部子对象都按声明键序 canonical `JSON.stringify`；events 按首次所含 journal sequence ASC、
eventId UTF-8 字节序收尾，evidence items 按 observation sequence/item sequence/id。`referenceStates` 必须为
每个 events key 恰一项且按 events 顺序；`evidenceMap` 只允许 status=active 的 key 恰一项并保持该相对顺序，
expired/user-deleted key 必须不存在。`eventCount===events.length`，初建 ref 全 active；URL/capturedAt/documentId/
Evidence 只来自 D7 验证行。模型不能提供或覆盖任何 facts 字段。

runStats 只统计 `finishedAt` 落在 `(fromExclusive,toInclusive]`、且 Rule Source 属固定成员的运行：

- changed：`changed-unmatched`、`event-created`、`event-coalesced`；
- unchanged：`unchanged`、`baseline-established`、`event-deduplicated`；
- failed：全部 `failed`、`aborted` 与 Store 恢复写成 `interrupted` 的 run；
- reservation 时仍 queued/running 的 run 不计，待其有 finishedAt 后进入下一期间。

三类计数互斥；`eventCount` 是当前 artifact 的 Event slice 数，不等于 changed run 数。runStats 在 cycle
reservation 时冻结并供该 cycle 全部 artifact 复用；Provider/删除/scrub 不能修改。

### 11.4 sharing mode 与 prompt

本地 facts 始终保存有界 Evidence；sharing 只控制当次 ProviderRequest。调用前经 SourceService 内部窄端口
重新读取当前 shareMode（设置变更立即收紧），端口只返回 sourceId、安全显示名和 canonical URL：

- full：模型可见 UTF-8 ≤256 bytes 的名称、≤2,048 bytes 的规范化 URL、Event 元数据与 old/new Evidence；
- metadata：只见同样有界名称/URL、Event kind/count/time，零 excerpt、old/new value/valueHash/
  normalizedBytes/documentId/feedItemKey；不能形成证据解释时由程序摘要承担；
- blocked、Source 缺失或投影失败：该来源的名称、URL、Event、计数、时间、Evidence 均零进入 request。

Source note 永不进入 Digest prompt，Source adapter 也不得返回 note。投影必须发生在 prompt builder 前，后者只接收
已投影 DTO，不接收 Source/Event/DB row。`SYSTEM_DIGEST_PROMPT` 为编译期常量；唯一 user message 由可信的
`DIGEST_FACTS`（只含程序 ID/计数/时间）与固定 `UNTRUSTED_WATCH_EVIDENCE` 块组成，边界字符转义固定。请求
不带 `tools` 字段，模型无网络/Browser/Source/SQL 能力。全部来源 blocked、Key 不可用或完整 canonical
ProviderRequest 超预算时零调用、explanation=null；不得为迁就模型而删减 facts 或改变 artifact 边界。

### 11.5 Provider at-most-once 与模型草案验证

AI 默认关闭。artifact 创建时若 schedule.aiEnabled=false，直接写 provider=disabled/result=disabled；否则写
pending。pending claim 前在同一读取快照重新复验 schedule active+aiEnabled、sharing/request/Key：ai 已关闭时
`pending→disabled/disabled`；零可见 Event、请求超预算或 Key 不可用分别
`pending→skipped/no-visible-events|request-budget|key-unavailable`，全部零调用。只有检查通过才可用独立事务 CAS
`pending→claimed`，保存 `claimedAt` 与当时 `factsRevision/factsHash`，**提交成功后才调用**。一次 claim 只允许
一次 `LLMProvider.stream`；进程崩溃、shutdown abort、超时、adapter error、非法输出都不能 claimed→pending。
该协议承诺“每 artifact 最多一次尝试”，不承诺外部 Provider 恰好收到一次；claim 提交后、网络发送前崩溃会
保守失去解释，这是明确选择。

Provider 列的闭合矩阵如下；表外组合一律 corrupt/unavailable。`—` 表示 SQL NULL，`✓` 表示非 null；claim
revision 必须为安全整数≥1、claim hash 必须为64位小写 hex。所有时间为 canonical ISO 且
`createdAt <= claimedAt <= finishedAt`（缺失项跳过）；存在 claim 的行必须
`factsRevision>=claimedFactsRevision`，相等时 `factsHash===claimedFactsHash`：

| providerState | providerResultCode                                   | claimedAt + claimed facts | finishedAt | explanationJson                                                                                    |
| ------------- | ---------------------------------------------------- | ------------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| disabled      | disabled                                             | —                         | ✓          | —                                                                                                  |
| pending       | —                                                    | —                         | —          | —                                                                                                  |
| claimed       | —                                                    | ✓                         | —          | —                                                                                                  |
| succeeded     | success                                              | ✓                         | ✓          | 合法 canonical 1..50 sections；仅 scrub 后 `factsRevision>claimedFactsRevision` 且零剩余段时可为 — |
| failed        | provider-error / timeout / aborted / invalid-output  | ✓                         | ✓          | —                                                                                                  |
| uncertain     | uncertain-after-restart                              | ✓                         | ✓          | —                                                                                                  |
| skipped       | no-visible-events / request-budget / key-unavailable | —                         | ✓          | —                                                                                                  |

初建 disabled 的 `finishedAt=createdAt`；pending→disabled/skipped 以转换时刻写 finishedAt。合法单向迁移仅为
`pending→disabled|skipped|claimed`、`claimed→succeeded|failed` 以及启动恢复的 `claimed→uncertain`；终态不再迁移，
唯一例外是 succeeded 后的证据 scrub 只改 facts/explanation 而保留 succeeded/success。Provider 正常完成映射
succeeded/success；adapter/HTTP 错误映射 failed/provider-error；超时映射 failed/timeout；有序 shutdown abort、
schedule/Event scrub 或 claim 后 facts CAS 失配映射 failed/aborted；原始输出超16,384 bytes 或任一草案验证失败
映射 failed/invalid-output；启动发现 claimed 映射 uncertain/uncertain-after-restart。pending 永不写 failed，
Key/sharing/请求预算不是 Provider attempt failure。

Provider 原始成功文本必须**不经 trim 或其它改写**逐字节等于 canonical JSON：
`{"sections":[{"eventIds":[...],"explanation":"..."}]}`。root exact-key 仅 `sections`，section exact-key 顺序
仅 `eventIds/explanation`；因此首尾/内部非 canonical whitespace、duplicate key、额外键、code fence、非 canonical
escape/键序全部整份拒绝。sections 1..50；每 section eventIds 非空且按当前 artifact events 次序严格递增，全部
sections 的 eventIds 展平后也必须严格递增（即前段最后一个必须早于后段第一个），每个 eventId 全文最多出现
一次。每个 ID 必须对当前 Provider 投影可见；unknown/duplicate、blocked/缺失或其它不可见引用拒绝，metadata
投影可见的 Event 允许被引用并只能解释其可见元数据。

explanation 必须非空、已 trim/NFC、无 C0/C1/bidi 控制；单段 `String.length<=1,000` 且 UTF-8≤2,048，全部
文本 `String.length<=6,000`，canonical explanation JSON≤12,288。任一 shape/顺序/可见性/字符/字节预算失败
整份 explanation=null，不保留合法子段。写回事务要求 provider=claimed 且 factsRevision/factsHash 与 claim
恒等；Event scrub 或其它变化使 CAS 失败时迟到输出整份丢弃并按上表终结为 failed/aborted。成功/失败只更新 explanation/provider 安全状态、
finishedAt/byte_length，不改 facts/ref/cursor/runStats；不持久化 prompt、模型原始响应、思维过程或 tool call。

### 11.6 删除/过期与审计

§10.4 的 scrub 是 Event 删除/保留清理/Source 级联的唯一入口。一个 explanation section 只要包含被 scrub 的
eventId 就整段删除，不把同段剩余文字假定为仍有证据。canonical facts 保留 tombstone 和安全 Event slice、
EvidenceMap 删除该 key；D9 只能消费 scrub 后 validator 结果。

`digest_runs` 是每个正式周期的持久化运行审计，`watch_digests` 的 provider state/result/timestamps 是每个
artifact/Provider attempt 的持久化审计；D8 不把 scheduleId/digestId 塞进仅有 ruleId 的 `watch_audits`，也不
新增含敌手正文的通用 audit payload。日志只记录 ID、batchIndex、eventCount、bytes、provider 结果闭合码和耗时。

## 12. Notification、UI、IPC 与导出

### 12.1 NotificationPolicy

- muted Rule：零即时 notification outbox，但 Event/Digest 正常；解除后不补发。
- 应用内：用户打开 Watch 工作区后可看完整有界 Evidence。
- Windows 默认只含来源显示名、变化类型/数量；session Rule 固定“受保护来源发生变化”。
- `showDetails=true` 逐 Rule 显式允许后，只可用安全截断字段；仍禁止 query、Cookie、表单、认证细节和 AI 文本。
- `dedupeKey=channel|subjectType|subjectId|privacyVersion`；成功/失败写 outbox 状态，重复不得再次发。
- Windows sink 仅在 production identity probe PASS 时注册；否则返回 unavailable，不影响应用内。
- 点击通知只携带内部 event/digest UUID，经 WatchService 查询；通知不能注入外部 URL/路由。

### 12.2 Watch 工作区

内部视图：Overview、Rules、Events、Digests、Health。必须显示 enabled/paused/muted、access mode、lastChecked、
lastChanged、nextDue、health/backoff、保留期限、主文档限制和应用关闭不运行提示。

创建入口：Source 详情“创建监控”；浏览器“监控此页”。流程固定为选择类型/Region → 公开或 Session 授权 →
Schedule → Condition → 通知隐私 → Baseline 预览 → 最终确认。Session grant record 存在主进程内存，5 分钟
失效并绑定 tabId/sourceId/final origin/目标摘要；renderer 只拿一次性 opaque handle，handle 零 DB/日志，
最终仅持久化无凭据 consent 元数据和 `PageTarget.pageUrl`。preview tabId 与后续每次 run 的 task tabId 都不持久化，
也不要求原授权 Tab 在运行时仍存在。

### 12.3 IPC/bridge 白名单

```text
watch:listRules / watch:getRule / watch:createRule / watch:updateRule
watch:setPaused / watch:setMuted / watch:deleteRule / watch:runNow
watch:previewFeed / watch:previewPageRegions / watch:issueSessionGrant
watch:listEvents / watch:setEventsRead / watch:deleteEvent
watch:listDigestSchedules / watch:saveDigestSchedule / watch:deleteDigestSchedule
watch:listDigests / watch:getDigest / watch:generateDigestPreview
watch:exportEventsCsv / watch:exportDigestMarkdown
watch:getStatus / watch:subscribe
```

每个 payload exact object key、UUID/分页/字符串/数组/字节上限；unknown key 拒绝。写操作主进程统一脱敏审计；
subscribe 只推送闭合状态 DTO，返回 unsubscribe，窗口销毁/dispose 幂等移除。无任意 URL fetch/SQL/file path/HTML。

### 12.4 导出

CSV 只导出当前过滤事件表投影，单元格以 `= + - @` 或制表/CRLF 风险开头时加 `'`，UTF-8 BOM 规则沿用
既有安全导出。Markdown 只导出单 Digest 的程序 facts、有效 Evidence、链接和已验证 explanation；raw HTML
关闭，URL 只 http/https，过期/删除证据显式标记。路径仅由主进程 save dialog 产生，renderer 不读写路径。

## 13. 日志、审计与隐私

D1 在任何周期 Watch 接线前硬化既有 logger：初始化/日期切换时按 14 天和 10 文件清理；写前按 10 MiB
滚动；单行 8 KiB；失败降级受控 console，不递归记录。清理只匹配受控 `aibrowse-YYYY-MM-DD(.N).log` 文件名，
禁止通配删除未知文件。

Watch 日志允许：rule/run/event ID、host 脱敏值、状态码、HTTP 状态、耗时、字节数、重试数、预算分类。
禁止：query/fragment、正文/Evidence、Cookie/Header、session token、Source note、模型 prompt/response、文件路径、Key。

### 13.1 D7 Run/Event 审计闭环

#S6-044 的适用边界正式写回：D5 只冻结 schema v2 与当时可执行的 Run 结果——`unchanged`、闭合
acquisition failure、`interrupted/aborted`；它明确预留 D7–D9 通过后续表重建迁移扩展 CHECK，**不授权**把
未来 `baseline-established/changed-unmatched/event-*` 冒充 `unchanged`。D7 的 schema v3 保持 audit kind
集合不新增（继续使用 `run`、`baseline-established`、`rebaseline` 等 v2 kind），但向 reason CHECK/TS 单一
事实源追加：`changed-unmatched`、`event-created`、`event-coalesced`、`event-deduplicated`、
`condition-error`；v3 必须用与 observation/items 相同的单一 migration 事务重建 `watch_audits`，显式列清单
复制 v2 全部 audit，任一步失败按 §10.1 整体回滚。

每个已取得 Run 终态所有权的运行恰好一条 `kind='run'` 审计，精确映射：

| RunOutcome                | run audit reason       | 额外事实审计                                       |
| ------------------------- | ---------------------- | -------------------------------------------------- |
| `unchanged`               | `unchanged`            | 无                                                 |
| `baseline-established`    | `baseline-established` | 恰一条 `baseline-established/baseline-established` |
| `changed-unmatched`       | `changed-unmatched`    | 无                                                 |
| `event-created`           | `event-created`        | 无；该 run audit 即新 Event 的受控创建审计         |
| `event-coalesced`         | `event-coalesced`      | 无；明确表示向既有 Event 追加真实 observation      |
| `event-deduplicated`      | `event-deduplicated`   | 无；明确表示观察重放，绝不冒充 unchanged           |
| `failed(condition_error)` | `condition-error`      | 首次暂停再加 lifecycle-pause/condition-error       |
| 其它 `failed` / `aborted` | v2 既有闭合映射        | 按 §4/§7 的首次暂停规则                            |

Event 新建/合并的 run audit 与 Event/Baseline/Run 同一结果事务；合法 dedup 若 Run 仍 running 则与该 Run
终态同一事务，若同一 Run 已终态则零重复 audit。这样“每次 Event 事实动作恰有受控审计”与“每个网络 Run 恰有
run audit”由同一行同时满足，不创建第二条含义重复的 `event` kind。audit 仍只含 id/ruleId/kind/reason/time，
不新增敌手正文、Evidence、URL 或 event title。

### 13.2 D8 Digest 审计闭环

每个正式 logicalDate 恰一条 `digest_runs`；无 Event 也以 completed + frozen runStats/period 留下程序检查事实，
但零 artifact/ref/provider。每个 artifact 恰一条 `watch_digests`，provider 状态只能按
§11.5 矩阵单向迁移；任何状态都不能回到 pending，`MAX_DIGEST_PROVIDER_CALLS=1` 由持久化 CAS 而非进程内计数
证明。provider result code 的闭合集合与唯一 state 映射也是 §11.5 矩阵；不记录 prompt、原始输出、敌手解释、
Provider error message 或 Key。每个 run 的 state/blocked/finished 组合只按 §10.1 迁移；budget_exceeded 是可恢复
非终态，不得伪装成 completed 审计。

watch.db v1 明文边界：规则目标、规范化 Baseline、old/new Evidence、事件和 Digest 本地明文；不保存凭据。
UI 创建登录规则时必须披露 30 天保留和锁屏通知默认隐藏。hard-delete/Rule 删除级联；用户 Event 删除不可 Undo。

## 14. 边界情况

| 情况                                         | 处理                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| Source 在排队后被禁用/删除                   | run 前 revalidate，零网络，pause/cleanup                                  |
| Source 仅 metadata/enable/version 变化       | locator fingerprint 相同；更新 rowVersion，按用户意图处理                 |
| Source/Rule locator 在运行中变化             | enabled/pause 或 fingerprint CAS 失败，丢弃结果                           |
| 两次运行争用 Baseline                        | 同 Rule 互斥 + expectedVersion CAS，陈旧结果零写入                        |
| Session 原授权 Tab 已关闭/应用重启           | 不依赖旧 tabId；gate 后新建 task Tab，共享 Session 重读                   |
| task Tab 被用户关闭/redirect/login           | attempt 失败；零重建/零 Baseline 覆盖；按 health 暂停                     |
| task Tab cleanup 失败                        | 保留精确 ownership；Watch unavailable；shutdown 重试                      |
| App 退出时 HTTP/XML/Browser/Provider pending | abort + 受控 drain；已 reservation 的 slot 只记 interrupted               |
| 304 但无 Feed Baseline hint                  | 同 deadline/gate 无条件 GET 恰一次；仍304则 unavailable                   |
| 200 成功但结果事务失败                       | Baseline 与条件 validator 都保留旧值，Run metadata 不作下次请求输入       |
| feed identity 改变                           | 作为 remove+add，Evidence 双侧 absent/present                             |
| PageSnapshot degraded                        | 不生成 Projection/Event，health unavailable/parse_changed                 |
| Region 多重匹配                              | parse_changed，禁止猜测                                                   |
| Hash 变但无 Evidence                         | unexplainable_change，旧 Baseline 保留                                    |
| coalesce 窗口边界                            | 达到/超过 Event firstObservedAt+30 分钟必新建 Event                       |
| 窗口内 A→B→A→B→A                             | 四观察/四组 pair 全保留；Baseline 逐次推进，fingerprint 不丢弃            |
| 观察重放（同进程/跨进程）                    | 仅 observation idempotency_key 去重；按 §9.4 终结 Run，Baseline 不回退    |
| 窗口边界/重启后的 reversal                   | 最近 pair 全序跨 Event/重启可复现；新 idempotencyKey 即真实观察           |
| Source 仅 rowVersion 变化                    | 不进身份 CAS；事务内 max 单调更新，不丢弃有效结果                         |
| revalidation 后 locator prepare              | enabled/desired/pause CAS 失败；即使旧 fingerprint 保留也全部结果零写     |
| Condition 字段消失/typed 不适用              | no-match + 闭合 warning；推进 Baseline、健康恢复                          |
| Condition 验证/求值错误                      | condition_error 非重试失败；旧 Baseline、dependency-unavailable 暂停      |
| Evidence 超限                                | 整 Event 拒绝 budget_exceeded，不截成无变化                               |
| 已消费 Event 后 late coalesce                | 新 observation 原子取得更大 journal sequence；下一 cycle 必可见           |
| Digest cycle 中途崩溃                        | 保留 frozen upper/next sequence；只从最后提交 batch 恢复                  |
| Provider claim 前/后崩溃                     | claim 前可首次调用；claim 后 uncertain 且永不重试，facts 保留             |
| Digest 引用随后删除/过期                     | 同事务 scrub Evidence/涉及的整段解释并重算 canonical bytes/tombstone      |
| Digest 无 Event                              | 推进 frozen upper/lastChecked/runStats；零 artifact/provider/notification |
| Digest 单 observation 无法装入 facts 预算    | Store/validator 不一致；cycle 零推进并 fail-closed，不截 Evidence         |
| Windows identity 不可用                      | 应用内通知正常，系统 sink unavailable                                     |
| watch.db future/corrupt                      | Store unavailable，Scheduler 不启动                                       |
| 网络离线                                     | unavailable + 退避；恢复时一次 catch-up                                   |
| Clock 回拨/DST                               | scheduledFor/lastLocalDate 幂等；Digest cursor 只用单调 sequence          |

## 15. 测试规格

### 15.1 纯逻辑/单元

- Budget：UTF-8、surrogate、每个等于/超过边界；
- Schedule：interval/daily、DST gap/fold、回拨/跳跃、reservation 三写原子性、各崩溃点、失败/pause/abort
  不回拨、missed coalescing、手动不移锚点、jitter；
- NetworkPolicy：IPv4/IPv6/混合 DNS/重绑定夹具、每跳 redirect、downgrade/userinfo/scheme、仅80/443；
  IPv6 至少覆盖 `3fff::/20`、`2001:db8::/32`、`2001:2::/48`、`fec0::/10`、未分配
  `2000::1` 与 IANA `RESERVED` 的 `2d00::1` 纯分类与零 socket 负例，并保留 IANA 已分配
  普通公网 GUA 正例；
- Public HTTP：缺 RobotsGate 的 page/feed/discovery 零 DNS/零 socket；安全工厂是唯一产品构造入口，
  raw/constructor/任意 URL 测试 seam 均不导出；初始 robots URL 只能由目标 authority 派生为规范化
  `/robots.txt` 且无 query/fragment，伪造 `purpose=robots` + 任意 host/path/query 为零 DNS/零 socket；
  raw 内部 redirect 逐跳复验并继承同一 deadline；30 秒统一覆盖 DNS、robots、所有地址、redirect 和
  body。Invalid Date、已过期外部 deadline 均零 DNS/零 socket；外部 deadline 晚于内部 30 秒仍由内部
  截止，所有路径不得续杯，迟到事件不得改变终态。生命周期红态必须分层：真实 Node 24.18.0 `node:http`
  localhost 的 pre-socket/pre-response deadline/AbortSignal destroy 证明旧 R5 因未处理 request `ECONNRESET`、
  `uncaughtExceptionMonitor` 命中或子进程非零退出而转红；response-after 不能要求旧 R5 必然崩溃，必须由
  产品结构断言证明业务终态后缺少 product-owned named IncomingMessage drain、listener 分层错误或 close 无
  自清理而转红；另由 FakeIncoming/transport 敌手 seam 强制投递 aborted → asynchronous error → close，
  证明旧 R5 缺少 response drain 时明确转红，但不得声称真实 Node 在零 error listener 时必然发出该 error。
  业务 Promise 在同步 cleanup/destroy/fallback 完成后立即结算，不等待 drain、不增加 drain timer。
  ClientRequest 创建后立即安装 named request error sink + close cleanup，response 一经交付则在接入 body
  reader、discard、destroy 或 resume 前安装其 product-owned named response error sink + close cleanup；
  两类 drain sink 均从安装起无条件 no-op，业务终态前由各自独立 business error handler 处理业务结果。正常
  success/end、redirect/HEAD discard、budget/body error、response 后 deadline/abort 均须证明业务 listener
  立即归零，request/response drain 分别在各自 close 后归零；真实 Node 24 localhost 的 response-after 绿态
  须证明业务 Promise 立即结算、request close 清除 request drain、product-owned response drain 在 destroy 前
  已安装；若 Node 发出 response error 则由该 drain 安全吸收，无论是否发出 error，response close 后 drain
  均为 0、子进程 exit 0 且 `uncaughtExceptionMonitor`/unhandledRejection 均为零。测试不得额外安装匿名
  response error listener；listenerCount、具名 callback 身份和闭包可达性断言必须识别 product-owned drain，
  并排除测试自身 observer，observer 不得吞掉原本应暴露的产品缺陷。
  destroy 调用栈内同步 response 先安装 response drain 再 destroy，destroy 缺失或抛错才 resume；call-stack
  guard 在 Promise 结算前归零，且零 body reader/inflater/新 socket/结果变化。禁止匿名 response error
  listener。request/response close cleanup 的每次 `removeListener` 抛错均有独立异常隔离 oracle，一个 remove
  失败不阻止另一个清理；保存 callback 重复调用幂等。never-close seam 证明 Promise 已结算且零 timer、
  AbortSignal、body buffer、inflater、业务闭包和 global registry，仅允许相应 emitter 自包含 drain pair。
  FakeRequest/FakeIncoming 必须忠实模拟 Node 24 request 路径，并以明确标注的确定性敌手 response seam 强制
  异步 error/close，不得以 destroy 后零投递制造假绿，也不得把敌手 seam 冒充 Node 必然事件序列。另用受控
  子进程退出码证明 pre-response 零未监听 EventEmitter error，并独立监控 unhandledRejection；
  success/deadline/abort/request-error/body-error/budget-error 全部单次结算；保留 R2–R5 仍有效的工厂、IPv6、
  deadline、robots 与资源清理回归；
- Robots：512,000 bytes `==` 接受、512,001 bytes destroy + `budget_exceeded`，1,024 parseable rules
  边界、文件级 fatal UTF-8；CR/LF/CRLF 与结构位置 SP/HTAB 正例；其它原始 control、坏 ABNF 与
  malformed/truncated percent triplet 仅隔离所在行并继续使用其它 parseable rules；非 ASCII、reserved、
  `%00` 与 percent-encoded unreserved 的 octet 身份，`*`/末尾 `$`、最长 octet、等长 allow、相同 UA
  组合并和空 specific 组不回退 `*`；
- XML：RSS/Atom/namespaces/CDATA/encoding、DTD/entity/XXE/bomb、depth/name/attribute/text-node/node/
  total-text/FeedProjection 每个 `==` 接受与 `+1` 拒绝；
- Feed envelope/acquisition：FeedField 截断前 valueHash 固定向量；parser canonicalJson/bytes 与 envelope
  contentHash 精确恒等；finalUrl/capturedAt/documentId=null 由 HTTP 主进程记录；200→projection、已有
  Baseline 的304→unchanged 且零 parser/diff/baseline、首次304→同 deadline 无条件 GET 一次、再次304→
  unavailable 零 Baseline；条件 header 只来自 Baseline hint；200 成功推进/同 hash、304 header present/absent/
  oversize、失败/conflict/rollback/崩溃逐项断言 validator 与 Baseline 同事务且绝不被未推进 Baseline 的 Run
  metadata 污染；Feed/Page 持久化 JSON exact-key/hash/byteLength/预算/未来版本 validator；
- HTML：parse5 SAX 资格、2 MiB/node/depth/attribute、畸形 HTML、script/iframe/subresource 零执行/零请求；
- Session task Tab：敌手 create 返回用户 id、精确 provisional ownership、焦点恢复三态、用户关闭、ready/error/
  timeout/abort、final origin/locator、close false/throw、cleanupAll drain、重启无旧 tabId；
- PageProjection：四 Region、NFC/bidi/control、table fingerprint、歧义、iframe 诚实边界；
- Diff：新增/删除/修改/反转/排序噪声、table/link/text、hash-only 异常；Feed 仅
  title/link/published/summary 产生变化对、identity 变化按 remove+add；Page link 按 canonical URL
  配对（added/removed/label-changed），Region 外噪声零 pair；
- Condition：全 operator、all/any、absent/numeric/field whitelist、零 regex/AI；字段不存在/数值不可用/
  typed 不适用为 no-match + 固定顺序 warning 并推进 Baseline；同 fieldKey 多 pair 的 match/applicable/全部
  unsupported 优先级与 all/any 非短路 warning 矩阵；统一 Run metadata exact-key/排序/预算/额外键拒绝；
  shape/version/catalog/value/throw 为
  condition_error，断言 retryable=false、counter+1、无 backoff、立即 health=paused/condition_error 且 Rule
  pauseReason=dependency-unavailable、旧 Baseline、run+lifecycle 两类审计且幂等暂停不重复；
- EventValidator：双侧 Evidence、引用/时间/URL 去 query/预算/幂等/coalesce；idempotencyKey 与
  changeFingerprint 固定向量（含 conditionVersion=none 与 canonical JSON 形态）；reversal 镜像
  oracle 固定向量（A→B→A、add→remove→add、仅最近对、部分反转→mixed、无历史对必非反转）；
  coalesce 29:59 合并/30:00 必新建/超 32 KiB 新建（预算不含 observation 元数据）；窗口内完整
  A→B→A→B→A 断言四 observation、全部中间 pair、Baseline=A、重复 fingerprint 未丢弃；窗口边界让下一
  reversal 新建 Event；重启读回后相同最近 pair 得到同一 reversal 判定；仅同 idempotencyKey replay 才
  event-deduplicated，断言 Event/observation/item/outbox/Baseline 零增量、running Run 精确终结并审计，已终态
  Run 再入零写；
- Digest：journal sequence/lower-upper-next cursor、late coalesce、同 Event slice、49/50/51/100/101/120 Event、
  49,152/65,536 字节边界、full/metadata/blocked prompt 前投影、Source note/Key canary、runStats 全 outcome 映射、
  Schedule active/paused 与 run running/budget_exceeded/completed 全状态/转换、canonical facts/explanation、
  provider state×result×claim/time/explanation 全矩阵、claim at-most-once/降级、scrub facts/ref/explanation；
  Notification：隐私 DTO/去重/muted；
- IPC validators：额外键/超长/原型链/错误类型 fail-closed。

### 15.2 Repository/恢复

真实 node:sqlite：migration v1 表/索引/外键；所有注入串只作数据；CAS；Event+Evidence+Baseline+outbox 原子；
running→interrupted 且已消费 slot 不重放；Source rowVersion 与 locator fingerprint 分离且 rowVersion 不进
结果事务 CAS；disable→restore 版本递增仍按 desiredEnabled 恢复；metadata-only、locator-change、用户
pause、prepare/source/commit/abort 每个崩溃/失败切点；保留时间/数量/100 MiB；恢复/未来版本/corrupt
fail-closed；dispose 幂等；Sources 用户数据和 Research 数据恒等。
D7 追加（#S6-047～#S6-055）：migration v2→v3 无损升级与观察回填、v3 表/索引/复合外键/UNIQUE、
future schema fail-closed；数据库直接插入跨 Event observation/item 错配必须被 composite FK 拒绝；零 item、
Event/observation/item_count 不一致、两级 sequence 缺口在新写与启动扫描均 fail-closed；相同时间戳的最近
Event/coalesce candidate/最近 pair 按 §10.1 全序恒定；observation idempotency 同进程与跨进程重放零重复；
合并事务在
observation/items/Event 行/Baseline/Run 每个写入点故障注入全部回滚；合并事务对陈旧
`first_observed_at`/`item_count`/baselineVersion 零部分写入（fingerprint 相同不得失败）；muted Rule 零
outbox；outbox 行只随新建 Event 产生。v2 fixture 对所有表逐列快照，成功迁移后既有列逐列恒等；每条 v3
migration statement 独立失败注入均断言 user_version=2、v2 schema/索引/数据恒等、零临时表；确定性回填 id
冲突整体回滚。Source 第二次 revalidation 后、结果事务前完成 metadata-only update：有效结果提交且
sourceRowVersion=max 不回退；同一窗口 locator prepare：新建/合并/dedup/unchanged/304 路径均整体 identity CAS 失败，
Run/Baseline/Event/observation/items/audit/outbox 全恒等；locator prepare 仅暂停且保留旧 fingerprint 的实际 D4
交错，以及用户 pause/Source disable/health pause，均由 enabled/desired/pause CAS 拒绝，不允许测试伪造
prepare 已写新 fingerprint。

D8 追加（#S6-059～#S6-067）：migration v3→v4 的旧 Digest 三空表 guard、observation journal 全序回填/
high-water、任一句失败 v3 schema/index/行逐列恒等；Event 新建/合并与 journal 同事务、dedup 零 journal；
schedule 创建 high-water cursor、daily reservation 三写、running cycle 跨进程恢复；batch artifact+refs+cursor
原子与 UNIQUE 幂等。51/120 Event、同 Event 多 observation、freeze 后新增 observation、每个事务边界崩溃注入
不得漏/重 artifact 或越过未提交 sequence。Provider 在 pending→claimed 提交前零调用，claim 后所有崩溃点恢复
均零重试；factsRevision/hash CAS 拒绝 scrub 后迟到输出。expire/user-delete/source cascade 对 refs/facts/
explanation/journal/Event 删除逐点失败全部回滚；v4 启动扫描拒绝 interval/空、重复、未排序或>100成员、非法
IANA/daily state、Schedule state/时间、run state/blocked/finished、cursor/run/batch 缺口、非 canonical
facts/explanation、byte/hash/revision 及 §11.5 任一非法 Provider 矩阵组合。pause/resume/delete、budget block/retry 与
provider 每个转换的事务前/中/后崩溃注入必须分别得到唯一旧态或新态，不能依赖进程内推断。

### 15.3 Electron 冒烟

- dev + production Watch 工作区创建 Feed/Page Rule、Baseline、真实变化、失败 health、手动 run、muted；
- Session 页面 grant、撤销、login_required，Cookie/token/表单值零 renderer/日志/DB；
- 关窗停止，重启一次 catch-up；Session catch-up 新建/关闭 task Tab，Cookie Session 可用但旧 tabId/handle 不存在；
  用户 Tab id/url/title/active 按 §8.2 oracle 恒等；
- Digest daily timer、51 Event 两 artifact、running cycle 恢复、claim-after-crash explanation=null 且零重复 Provider；
- 应用内通知与点击内部路由；Windows sink 身份失败安全降级；
- CSV/Markdown dialog 导出与公式/HTML/URL 防线；
- `AIBROWSE_WATCH_SMOKE=set|check` 临时 userData 跨进程 Baseline/Event/清理；精确清理进程和临时目录。

### 15.4 红队/真实条件

threat-model WRT-01～WRT-19 每项独立机器断言；少量公开 RSS/Atom/robots/redirect 场景；真实 Provider
仅在现有长期授权、本地凭据可用且 Digest AI 明确开启时调用，台账只记次数/用途/结果分类。真实网络不承担
确定性 parser/diff oracle；FakeProvider 不冒充真实语义证据。

### 15.5 全量门控

每个行为任务至少：聚焦红→绿、`npm test -- --maxWorkers=1`、typecheck、lint、format:check、build、
`git diff --check`。主进程/renderer/preload 增加 dev+production 对应冒烟；安全/存储任务增加红队、跨进程、
隐私扫描与新的独立 Reviewer。

## 16. 任务依赖与验收

```text
D1 logger/Clock
  → D2 domain/condition
       ├─→ D3 network/XML/HTML/feed
       └─→ D4 storage/lifecycle
D2 + D4 → D5 scheduler/coordinator/host gate
D3 + D5 → D6 public/session page projection/task-tab acquisition
D3 + D4 + D5 + D6 → D7 diff/event/evidence/health
D7 → D8 digest
D4..D8 → D9 UI/IPC/notification/export
D1..D9 → D10 e2e/redteam/live/package gate
D1..D10 → D11 independent Stage Auditor
```

D11 只能在 `Sixth_stage.md` §9 全项、§10 五项、全量/冒烟/跨进程/红队/真实条件均有当前 HEAD 证据后
判 GO/PASS；否则 HOLD/PENDING。PASS 后停止，等待用户进入 Seventh Stage，不夹带产品化代码。

D3 必须交付安全 PublicWatchHttpClient 工厂、raw robots purpose 限制、强制 RobotsGate、IPv6 当前 IANA
普通公网 allowlist、robots 512,000-byte 预算、单资源 30 秒总 deadline 与 RFC 9309 octet 匹配。D5 只能
在其上装配共享 HostRequestGate/并发/5 秒间隔，不能把 D3 的缺省开放能力列为后续留白；D3-R2 未经新的
独立安全 Reviewer `PASS` 前，D4 及后续任务不得开始。

## 17. 决议记录

- **#S6-U01～#S6-U31**：逐项对应 proposal §9 U01–U31，2026-08-23 用户明确批准。
- **#S6-031**：D3 的公网“fetch”语义用 Node 核心 `http/https` + 连接时受控 lookup 实现；这是为同时满足
  U02 隔离公开请求和 U03 DNS rebinding 防线的技术落点，不增加通用 HTTP 能力。
- **#S6-032**：Condition 不匹配仍推进有效 Baseline并记录 changed-unmatched；否则同一变化会每次重算并在
  后续配置变化时冒充新变化。
- **#S6-033**：Event 添加/删除用 typed absent 构成完整 before/after Evidence；哈希永不单独成证。
- **#S6-034**：跨库硬删除采用 durable intent + 每次运行 Source revalidation；不宣称两库单事务原子性。
- **#S6-035**：XML/HTML 候选资格与 Windows notification identity 都是 fail-closed Gate；失败不授权替代或夸大。
- **#S6-036**：v1 页面 Region 只接受公共 HTML SAX 或既有安全 PageSnapshot 映射出的
  main-text/headings/table/links，不扩展任意 DOM selector 或 BrowserController 公共能力；跨域 iframe
  保持诚实限制。
- **#S6-037**：U31 冻结公开页面为 Node 核心 HTTP + 资格化 `parse5-sax-parser@8.0.0`/
  `parse5@8.0.1`；零脚本、零子资源、零共享 Session。资格失败 REPLAN，禁止自动回退。
- **#S6-038**：RFC 9309 §2.5 要求 parser limit 至少 500 KiB；robots 独立冻结
  `MAX_ROBOTS_RESPONSE_BYTES=512_000`，不复用 256 KiB discovery 预算。
- **#S6-039**：IPv6 只放行 2025-10-10 IANA Global Unicast registry 已分配的普通 GUA 编译期表，
  并先排除 Special-Purpose registry；`2000::/3` 不再作为整体 allowlist，登记更新必须重新评审。
- **#S6-040**：D3 安全工厂是唯一产品构造入口并在模块内封装 raw robots transport → RobotsPolicy →
  gated target client；raw、constructor 和任意 URL 测试 seam 均不导出。初始 robots 请求只可由目标
  authority 派生为无 query/fragment 的 `/robots.txt`，内部 redirect 逐跳复验且共享 deadline；缺 gate
  的公开 target 请求 fail-closed，D5 只追加 HostRequestGate/并发/间隔，不补救 robots 能力。
- **#S6-041**：`NETWORK_ATTEMPT_TIMEOUT_MS=30_000` 对单次 PublicWatch `get/head` 是从入口开始、
  覆盖 DNS/robots/全部地址/redirect/body 的总预算，并与外部 deadline 取更早者，任何子步骤不续杯。
- **#S6-042**：Robots 使用 RFC 9309 octet 规范化、相同 UA 组合并、空 specific 组不回退、最长
  octet 与等长 allow。非法 UTF-8 是文件级 unavailable；合法 UTF-8 中其它原始控制字符、ABNF 错误或
  malformed/truncated percent triplet 只使所在行不可解析，必须继续使用其它 parseable rules；`%00` 等
  well-formed 非 unreserved octet 保持规范化 percent 编码身份。
- **#S6-043**：D3 Public HTTP 请求采用“业务终态 + emitter-local transport drain”两阶段协议。业务首终态
  立即禁止所有新副作用、清除全部业务 listener/计时器/重型业务引用，并在同步 cleanup/destroy/fallback
  完成后立即结算 Promise；不等待 close/error、不增加 drain timer。ClientRequest 创建成功后立即安装
  named request error sink + close cleanup；每个 IncomingMessage 一经交付，在 body reader/discard/destroy/
  resume 前安装自己的 named response error sink + close cleanup。两类 sink 从安装起都无条件 no-op，业务
  结果由独立 business error handler 决定；各 close cleanup 幂等且每次 removeListener 独立 try/catch。
  request drain 只闭包 request/两个 callback；response drain 只闭包对应 response/两个 callback，均不持有
  settlement、业务结果、timer、AbortSignal、正文、buffer、inflater、另一 emitter 或全局 registry/listener。
  response drain 必须覆盖 request close 后实际发出的异步 response `ECONNRESET`，并在 response close 自清理；
  Node 24.18.0 当前可能在移除最后一个 response error listener 后只发 aborted/close，这一条件发射不削弱产品
  drain 决策。真实测试必须识别 product-owned named drain，并从 listenerCount/callback/闭包断言中排除测试
  observer；不得用额外匿名 response error listener 改变事件路径或掩盖缺陷。
  destroy 同步 late response 仍由 finally 必移除的 call-stack guard 捕获，但 guard 必须先安装 response drain，
  再 destroy，且仅在 destroy 缺失/抛错时 resume。真实 Node 24 transport + 子进程退出码/
  `uncaughtExceptionMonitor` 是权威 oracle，FakeRequest/FakeIncoming 不得通过 destroy 后零投递制造假绿。
  等待 transport terminal 的方案被否决：close 可永不到达，而另设 drain timer 会重新引入终态资源并可能
  破坏 #S6-041 absolute deadline；never-close 时仅 emitter-local drain pair 可随 transport 对象 GC。
- **#S6-044**（D5 审计适用边界，正式回填于 D7 REPLAN）：D5 的 schema v2 只冻结当时可执行的
  unchanged/acquisition-failure/interrupted/aborted Run 审计，并明确允许 D7–D9 以表重建 migration 扩展
  CHECK/TS 同源码集；它不授权未来成功终态映射为 unchanged。D7 schema v3 不新增 kind，追加
  changed-unmatched/event-created/event-coalesced/event-deduplicated/condition-error reason，精确映射见 §13.1。
- **#S6-045**（D7 REPLAN，2026-08-29）：Source rowVersion 身份裁决采用方案 A——结果事务 CAS 的身份
  中 sourceId/`sourceLocatorFingerprint`/`baselineVersion` 必须一致；Source `rowVersion` **永不**进入结果
  事务 CAS。Rule 有效状态的独立 CAS 由 #S6-057 补齐。理由：`Source.version` 是
  Sources 行级乐观并发版本，任何 Source 写（含与 Watch 无关的备注/优先级元数据）都会递增；把它纳入
  CAS 会使无关 Source 编辑丢弃有效 Watch 结果，直接违反 §10.3“仅 rowVersion 变化且 fingerprint 相同
  不丢弃已经形成的有效结果”与 §14“Source 仅 metadata/version 变化按用户意图处理”。陈旧身份防线为
  每运行两次 Source revalidation + fingerprint/baselineVersion CAS + rowVersion 同事务 `max(current,
revalidated)` 单调更新。方案 B
  （rowVersion 入 CAS）否决；D4/D5 revalidation 端口与既有测试不需改动。
- **#S6-046**（D7 REPLAN，2026-08-29）：Feed 截断前完整哈希——`FeedField` 增加 `valueHash`，由
  规范化管线在截断前对完整规范化值计算 SHA-256（小写 hex；非字符串防御分支取空串哈希），D7 Evidence
  只消费该值；禁止对已截断 excerpt 重新计算并冒充完整值哈希。Page 字段值在 Projection 中完整持有、
  无字段级截断，`valueHash/normalizedBytes` 由 Diff/Evidence 对投影值确定性计算。旧形态（无
  valueHash）feed projection JSON 读回校验失败按 §10.2 fail-closed。
- **#S6-047**（D7 REPLAN，2026-08-29）：coalesce 与 outbox 语义冻结——合并窗口锚定 Event
  `firstObservedAt`，`nowMs - firstObservedAtMs < EVENT_COALESCE_WINDOW_MS` 才可合并（达到/超过边界
  必新建）；候选只取该 Rule 最近一个 Event，不做更早扫描；`MAX_EVENT_EVIDENCE_BYTES` 只计 Event 全部
  Evidence item 序列化 JSON（既有 + 新增），不含 observation 元数据（后者按有界开销计入全库预算）。
  合并绝不创建/修改 outbox，outbox 已发送不阻止合并；outbox 行只在新建 Event 且 Rule 非 muted 时
  写入，D7 固定 `in-app` 通道、`dedupeKey="in-app|event|"+eventId+"|1"`、privacy_json 为程序事实
  `{eventKind, importance, itemCount}`（零远程文本）。
- **#S6-048**（D7 REPLAN，2026-08-29）：reversal 采用“最近对镜像”有界 oracle——当前对 P 为 reversal
  当且仅当同 Rule 同 `(itemId, fieldKey)` 最近一次已持久化对 Q 满足 P.before≡Q.after 且
  P.after≡Q.before（absent↔absent；present 按 valueHash 相等）。不搜索更早历史、不搜索任意旧值；
  add/remove 反转同由镜像判定；观察内部分反转时观察与 Event kind 为 `mixed`。
- **#S6-049**（D7 REPLAN，2026-08-29）：正式批准 schema v3 observation 身份——新增
  `watch_event_observations`（观察级 `idempotency_key` UNIQUE），`watch_event_items` 重建追加
  observation 关系；v2 既有 Event 无损回填恰好一个观察。观察级 idempotencyKey 全局 UNIQUE 是唯一业务
  去重；fingerprint 无论 Event 内外都不丢弃真实观察（完整 reversal 循环合法复现）。
- **#S6-050**（D7 REPLAN，2026-08-29）：idempotencyKey/changeFingerprint 编译期算法定稿（§9.4）：
  域分离前缀 `watch-event-idem-v1`/`watch-change-fp-v1`；conditionVersion=`none` 或条件 canonical
  JSON 的 SHA-256；newProjectionHash 取 envelope contentHash；指纹元组
  `(itemKey, fieldKey, pairKind, beforeToken, afterToken)` 排序连接，pairKind ∈ added/removed/
  changed/reversal。
- **#S6-051**（D7 第二次 REPLAN，2026-08-29）：观察幂等与 fingerprint 职责拆分——只有相同
  idempotencyKey 是 replay；合法 replay 不写 Event/observation/item/outbox/Baseline，但 running Run 必须
  精确终结并审计，已终态重入零写。相同 fingerprint 是合法事实再现，必须持久化并推进 Baseline。
- **#S6-052**（D7 第二次 REPLAN，2026-08-29）：Source rowVersion 防回退采用事务内单调
  `max(current,revalidated)`；metadata-only 并发不丢结果、不回退，locator prepare 由 #S6-057 的 Rule 状态
  CAS（及 commit 后适用的 fingerprint CAS）使整个结果事务失败。
- **#S6-053**（D7 第二次 REPLAN，2026-08-29）：Condition 非适用/字段缺失/数值不可用是
  no-match+闭合 warning，推进 Baseline；验证/求值错误是 `condition_error` 非重试失败，旧 Baseline、立即
  health=paused/condition_error（Rule pauseReason 复用 dependency-unavailable）、闭合 health/counter/audit
  语义见 §5。
- **#S6-054**（D7 第二次 REPLAN，2026-08-29）：FeedParser 只产规范化
  FeedProjectionValue/canonical JSON/valueHash；FeedAcquisitionService 盖章统一 ProjectionEnvelope 与
  contentHash，闭合 200/304/首次 Baseline；Feed/Page 统一进入 WatchProcessingService，接口见 §6.4/§8.1。
- **#S6-055**（D7 第二次 REPLAN，2026-08-29）：schema v3 items 以 `(observation_id,event_id)` 复合
  外键绑定 observation 所属 Event；两级 sequence、item_count、最近 Event/pair 全序、确定性回填冲突与
  逐语句失败整体回滚按 §10.1 冻结。v2 原列逐列恒等，不静默修补 corrupt 数据。
- **#S6-056**（D7 第三次 REPLAN，2026-08-29）：Feed 条件 validator 与其 Feed Baseline version/contentHash
  同身份、同事务持久化；acquisition 前只从已验证 Baseline 生成不可变 hint，绝不从最新 Run metadata 读取。
  200 缺失/超限值清空，304 缺失/超限值保留 hint 旧值；失败/conflict/rollback 零 validator 写。schema v3
  重建 Baseline 子表追加两列，v2 旧列恒等且新列 null。
- **#S6-057**（D7 第三次 REPLAN，2026-08-29）：结果事务除 sourceId/fingerprint/baselineVersion 外还必须
  CAS `state='enabled' AND desired_enabled=1 AND pause_reason IS NULL`。D4 locator prepare 合法地先暂停并保留
  旧 fingerprint，state CAS 必须使新建/合并/dedup/304/unchanged 全部零写；不得把新 locator 提前写入旧
  Baseline 身份。
- **#S6-058**（D7 第三次 REPLAN，2026-08-29）：Condition warning 按 §5 的 operator/typed-pair 矩阵、
  多 pair 适用性优先级与全 predicate 非短路求值冻结；统一 `WatchRunResponseMetadata` exact-key schema 同时
  承载 HTTP 与 Condition warnings，但只作有界诊断，不作为条件请求事实源。
- **#S6-059**（D8 REPLAN，2026-08-31）：正式 Digest cursor 改为 observation 事务内单调 journal
  `changeSequence`；否决 Event `(createdAt,eventId)`（字段不存在）、`firstObservedAt`（late coalesce 永久漏）和
  `lastObservedAt`（可变 row 不能作稳定前缀）。Event 新建/合并与 journal 同事务，replay 零 journal。
- **#S6-060**（D8 REPLAN，2026-08-31）：每日 cycle reservation 冻结 lower/upper sequence、实际检查期间与
  runStats；artifact+refs+cursor 按 batch 原子推进，running cycle 跨重启从 nextSequence 恢复。Event slice 只读
  上界内 observation，不读取随后增长的 Event 聚合 Evidence。
- **#S6-061**（D8 REPLAN，2026-08-31）：Provider 采用持久化 claim 后调用的 at-most-once 方案；claimed 永不
  回 pending，崩溃恢复 uncertain。否决“崩溃后重试”（可能重复计费/调用）和“调用后才记 attempt”（无法证明
  最多一次）；确定性 facts/cursor 在 Provider 前已成功提交。
- **#S6-062**（D8 REPLAN，2026-08-31）：canonical 预算冻结为 facts 49,152 bytes、explanation 12,288 bytes、
  artifact 65,536 bytes、完整 ProviderRequest 65,536 bytes、原始输出 16,384 bytes，以及 §2 的 section 字符/
  字节上限。模型文本必须是 exact-key/顺序/无空白差异的 canonical JSON，任一非法整份拒绝。
- **#S6-063**（D8 REPLAN，2026-08-31）：runStats 以 cycle 冻结期间内 finishedAt 计数：changed=
  changed-unmatched/event-created/event-coalesced；unchanged=unchanged/baseline-established/event-deduplicated；
  failed=failed/aborted/interrupted；queued/running 延后到终结期间。
- **#S6-064**（D8 REPLAN，2026-08-31）：新增零能力 DigestScheduler 并由 D8 在 main 生命周期接线；不扩展
  WatchScheduler ruleId 契约。D8 只生成/恢复 artifact，零通知/outbox；D9 消费已验证结果。
- **#S6-065**（D8 REPLAN，2026-08-31）：Event expire/user-delete/Source cascade 必须在删除 Event 前原子 scrub
  facts Evidence、涉及 Event 的完整 explanation section、ref/journal 状态并重算 hash/revision/bytes；Provider
  写回 CAS factsRevision/hash，任一失败全部回滚。
- **#S6-066**（D8 REPLAN，2026-08-31）：v3 宽松 Digest 占位表从未有产品写路径，必须三表全空才可在
  WATCH_MIGRATION_V4 重建严格 schema；非空 fail-closed，不猜测旧 JSON。v4 同事务全序回填 observation journal，
  v1–v3 statement bytes 冻结且任一句失败保持 v3 逐列恒等。
- **#S6-067**（D8 REPAIR，2026-08-31）：DigestSchedule 只持久化 active/paused，删除为硬删除；Digest run 只允许
  running/budget_exceeded/completed 并持久化预算阻塞事实；Provider state/result/claim/time/explanation 采用 §11.5
  完整矩阵。pause/resume/delete、容量重试与启动恢复均由数据库状态判定，禁止依赖进程内猜测。

产品级待定决议：无。实现发现本契约无法给出红态 oracle、需要扩大网络/Browser/SourceService 公共能力、
需要换 XML 包或新增后台身份时必须停止并 REPLAN。
