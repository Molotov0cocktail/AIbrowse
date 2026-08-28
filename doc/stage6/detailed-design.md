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
src/shared/watch/digest-validator.ts         # Digest facts/模型草案白名单
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
  digest-service.ts                          # facts + 可选 Provider 解释
  notification-service.ts                    # 应用内/Windows sink
  watch-export-service.ts                    # CSV/Markdown + dialog
  repository/watch-repository.ts             # 唯一业务 SQL 点
  db/watch-migrations.ts                     # schema v1
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

| 常量                           |          值 | 语义                           |
| ------------------------------ | ----------: | ------------------------------ |
| `MAX_WATCH_RULES_TOTAL`        |         200 | 包含暂停规则                   |
| `MAX_WATCH_RULES_ENABLED`      |         100 | 实际可调度上限                 |
| `MAX_GLOBAL_WATCH_RUNS`        |           4 | 全局 acquisition 并发          |
| `MAX_HOST_WATCH_RUNS`          |           1 | canonical host 并发            |
| `MIN_HOST_REQUEST_GAP_MS`      |       5,000 | 同 canonical host 请求起点间隔 |
| `MAX_DUE_STARTS_PER_TICK`      |          20 | 单次唤醒启动数                 |
| `WATCH_RUN_TIMEOUT_MS`         |      90,000 | 单规则总时间                   |
| `NETWORK_ATTEMPT_TIMEOUT_MS`   |      30,000 | 单次公开资源获取总周期         |
| `MAX_REDIRECTS`                |           5 | 每跳复验                       |
| `MAX_FEED_RESPONSE_BYTES`      |   2,097,152 | 解析前硬拒绝                   |
| `MAX_XML_DEPTH`                |          64 | XML 元素深度硬上限             |
| `MAX_XML_NODES`                |      20,000 | XML start/text 事件总数        |
| `MAX_XML_NAME_BYTES`           |         256 | 单 QName/localName/namespace   |
| `MAX_XML_ATTRIBUTES_PER_TAG`   |          64 | 单元素属性数量                 |
| `MAX_XML_ATTRIBUTE_BYTES`      |       4,096 | 单属性名和值合计               |
| `MAX_XML_TEXT_NODE_BYTES`      |       8,192 | 单次累计文本节点               |
| `MAX_XML_TOTAL_TEXT_BYTES`     |     131,072 | 单文档规范化文本累计           |
| `MAX_DISCOVERY_HTML_BYTES`     |     262,144 | 仅内存扫描                     |
| `MAX_ROBOTS_RESPONSE_BYTES`    |     512,000 | robots 独立响应/解析上限       |
| `MAX_PAGE_HTML_RESPONSE_BYTES` |   2,097,152 | 公开页面 HTML 流硬上限         |
| `MAX_HTML_NODES`               |      20,000 | SAX 事件节点上限               |
| `MAX_HTML_DEPTH`               |          64 | 元素栈深度上限                 |
| `MAX_HTML_ATTRIBUTES_PER_TAG`  |          64 | 单标签属性上限                 |
| `MAX_FEED_ITEMS`               |         200 | 按 feed 顺序前 200 条          |
| `MAX_FEED_FIELD_BYTES`         |       4,096 | 单标题/摘要/标识等             |
| `MAX_FEED_PROJECTION_BYTES`    |     262,144 | FeedProjection 整体硬上限      |
| `MAX_REGIONS_PER_RULE`         |          10 | 页面区域数                     |
| `MAX_PAGE_PROJECTION_BYTES`    |      65,536 | 单 Baseline 投影               |
| `MAX_PROJECTION_FIELDS`        |          50 | 类型化字段数                   |
| `MAX_CONDITIONS_PER_RULE`      |          10 | 一层 all/any                   |
| `MAX_EVIDENCE_VALUE_BYTES`     |       4,096 | 单侧单条摘录                   |
| `MAX_EVENT_EVIDENCE_BYTES`     |      32,768 | Event 所有双侧 Evidence 合计   |
| `MAX_DIGEST_BYTES`             |      65,536 | 持久化 Digest 投影             |
| `MAX_DIGEST_EVENTS`            |          50 | 单 Digest                      |
| `MAX_DIGEST_PROVIDER_CALLS`    |           1 | 单 Digest                      |
| `MAX_WATCH_DB_BYTES`           | 104,857,600 | 100 MiB 逻辑预算；每次写前估算 |
| `PUBLIC_EVENT_RETENTION_DAYS`  |          90 | 与数量上限同时生效             |
| `PUBLIC_EVENTS_PER_RULE`       |         200 | 公开规则                       |
| `SESSION_EVENT_RETENTION_DAYS` |          30 | 登录规则                       |
| `SESSION_EVENTS_PER_RULE`      |         100 | 登录规则                       |
| `EVENT_COALESCE_WINDOW_MS`     |   1,800,000 | 30 分钟                        |
| `ROBOTS_CACHE_MS`              |  86,400,000 | 24 小时；失败不假定允许        |
| `MAX_LOG_LINE_BYTES`           |       8,192 | 超长结构化字段截断             |
| `MAX_LOG_FILE_BYTES`           |  10,485,760 | 10 MiB 后滚动                  |
| `MAX_LOG_FILES`                |          10 | 含当前文件                     |
| `MAX_LOG_AGE_DAYS`             |          14 | 与文件数同时生效               |

字符串预算全部用 `Buffer.byteLength(value, 'utf8')`，截断不得拆 surrogate；截断后记录
`truncated=true` 与截断前规范化字节数。超出整体预算时 fail-closed，不把残缺 Projection 当无变化。
`MAX_ROBOTS_RESPONSE_BYTES=512_000` 精确等于 RFC 9309 §2.5 的最低 500 KiB，不得复用
`MAX_DISCOVERY_HTML_BYTES`。robots 仍同时受 `MAX_ROBOTS_RULES=1_024`、严格 UTF-8、单次公开资源
获取 30 秒总周期和仅内存解析约束；响应压缩字节、解压后字节任一达到 `MAX+1` 都立即销毁并
`budget_exceeded`，`==MAX` 可用。

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
- `login_required/captcha/robots_disallowed/security_rejected` 立即暂停，零自动重试。
- 连续两次 `parse_changed` 暂停；第一次只 degraded，旧 Baseline 不变。

### 4.4 生命周期

`before-quit` 顺序：停止接收新 run → 清 timer/队列 → abort acquisition/provider → 等待有界 drain →
关闭 WatchStore → 延续既有 Research/Sources/Browser dispose。关窗退出后没有调度。所有 stop/dispose
可重复调用，未完成 queued/running 行在下次启动原子标 `interrupted`；其已消费 slot 不重放，只有仍未消费的
过期 `nextDueAt` 才按补跑规则处理。

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
  UTF-8 字节安全截断到4,096并标记，不把截断值冒充完整值；结构/累计文本/整体 Projection 预算则不截断，
  整次失败。DTD/custom entity 已禁止，因此不存在可配置的递归实体预算，任何声明直接 security_rejected。
- HTML 内容字段转纯文本安全子集，零 HTML 落盘/渲染。

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

| 分类                     | 典型来源                             | 重试               | Baseline | 状态/用户动作            |
| ------------------------ | ------------------------------------ | ------------------ | -------- | ------------------------ |
| `unavailable`            | DNS/连接/临时 5xx                    | 1 次 + 退避        | 保留     | 3 次 degraded            |
| `budget_exceeded`        | 响应/投影/运行超限                   | 否                 | 保留     | 显示限制；需调整目标     |
| `robots_disallowed`      | robots deny                          | 否                 | 保留     | 立即暂停                 |
| `security_rejected`      | scheme/IP/redirect/downgrade/XML DTD | 否                 | 保留     | 立即暂停；安全文案       |
| `login_required`         | 登录跳转/受保护页                    | 否                 | 保留     | 立即暂停；重新授权       |
| `captcha`                | challenge/captcha                    | 否                 | 保留     | 立即暂停；不绕过         |
| `parse_changed`          | Region/feed 结构失效                 | 首次下次计划重试   | 保留     | 连续 2 次暂停，修复/重建 |
| `dependency_unavailable` | XML 资格/运行装配失败                | 否                 | 保留     | feed 全局 fail-closed    |
| `interrupted`            | 退出/崩溃                            | 已消费 slot 不重放 | 保留     | 审计可见                 |

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

### 8.1 Session task-tab acquisition

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
parse_changed/degraded），零 Event、零 Baseline 推进。任何摘录截断都保留原规范化字节数与完整值哈希。

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
- `idempotencyKey = SHA-256(ruleId|baselineVersion|newProjectionHash|conditionVersion)`；唯一约束。
- `changeFingerprint` 对排序后的 `(eventKind,itemKey,fieldKey,beforeHash,afterHash)` 编码哈希。
- 相同 fingerprint 再观察：返回 deduplicated，不新建通知/事件。
- 30 分钟内同 Rule 的不同 fingerprint 可合并为同 Event，但每个 change item 保留独立 Evidence pair；
  同字段再次变化也追加独立 pair，不用“首旧末新”吞掉中间变化。超过 32 KiB 时结束当前 Event并创建新 Event。
- 内容恢复到历史旧值生成 reversal，不删除历史。
- Event、Evidence items、新 Baseline、RunOutcome 和通知 outbox 在 watch.db 单事务提交。

Event 字段不可编辑。用户可 read/unread、批量标记和永久删除；删除级联 Evidence/notification outbox，
Digest 引用变为 `user-deleted` tombstone，AI 解释不再显示。

## 10. `watch.db`、迁移、恢复与清理

### 10.1 Schema v1

| 表                       | 核心列/约束                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watch_rules`            | id PK、source_id、kind/state/pause_reason/desired_enabled/muted/access_mode、schedule/target/condition 严格版本、source_row_version/source_locator_fingerprint、next_due/last_consumed_scheduled_for/backoff/failure/baseline_version、时间 |
| `watch_baselines`        | rule_id PK/FK、version、projection_type/json/hash/bytes、final_url/captured_at/document_id；bytes CHECK                                                                                                                                     |
| `watch_runs`             | id PK、rule_id FK、request_key UNIQUE、trigger/scheduled_for/start/finish/outcome/health、响应元数据有界                                                                                                                                    |
| `watch_audits`           | id PK、rule_id、kind、reason code、created_at；零敌手正文                                                                                                                                                                                   |
| `watch_events`           | id PK、rule/source、kind/importance、idempotency_key UNIQUE、fingerprint、观察时间、read_at、item_count                                                                                                                                     |
| `watch_event_items`      | id PK、event_id FK、sequence、field_key/label、before/after typed value JSON、双侧元数据；UNIQUE(event_id, sequence)                                                                                                                        |
| `digest_schedules`       | id PK、固定 source_ids_json、schedule_json、ai_enabled、cursor、state/time                                                                                                                                                                  |
| `watch_digests`          | id PK、schedule_id、facts_json、explanation_json nullable、bytes、created_at                                                                                                                                                                |
| `digest_event_refs`      | digest_id/event_id、status active/expired/user-deleted；复合 PK                                                                                                                                                                             |
| `notification_outbox`    | id PK、subject_type/id、channel、dedupe_key UNIQUE、privacy_json、state/attempt/time                                                                                                                                                        |
| `source_cleanup_intents` | mutation_id PK、source_id、operation、before/after_projection_json、affected_rule_state_json、state prepared/source-committed/complete/aborted、time；source_id 索引                                                                        |

外键打开；删除 Rule CASCADE baseline/runs/audits/events/outbox；Event CASCADE items；Digest 对 Event 使用
tombstone 状态而非丢失引用真实性。所有 JSON 读取后再次用共享 validator，非法/未来版本使 Store
`unavailable`，不得部分启动 Scheduler。

### 10.2 Store 启动

1. 打开独立 `watch.db`，PRAGMA/foreign key 固定；
2. read-only probe 与 user_version；未来版本 fail-closed；
3. migration（仅已批准编译期 SQL）；
4. quick/integrity check、JSON shape/预算扫描；
5. 单事务 queued/running→interrupted；
6. reconcile `source_cleanup_intents` 和 SourceService 当前事实；
7. 清理超期/超数/超库预算；
8. 只有全部成功才返回 `normal` 并启动 Scheduler，否则 `unavailable`，UI 只读错误态。

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
   变化且 fingerprint 相同则事务更新 `sourceRowVersion`，不丢弃已经形成的有效结果。结果提交 CAS 的身份条件
   是 fingerprint + baselineVersion，而不是 Source rowVersion。

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
未读也不能突破硬上限。清理 Event 后更新 Digest ref=`expired` 并移除对应解释段；不保留失证断言。

Baseline 不因普通清理删除。若单 Baseline 本身超限，Rule health=budget_exceeded 并保持旧 Baseline。

## 11. Digest 与模型边界

### 11.1 DigestSchedule

Schedule 绑定明确 sourceIds（1..100），Group 创建时解析并预览；组后续变化不自动加入。只生成每日计划，
使用 §4 时区语义和独立 `cursor=(createdAt,eventId)`。无新 Event 时只更新 lastChecked/运行统计，零 artifact、
零 Provider、零通知。手动 preview 不推进 cursor。

“今日更新/本周更新”中的本周是手动 preview 的固定最近7天窗口，不是自动 weekly cron；手动 preview
仍受50 Event/64 KiB/一次 Provider预算且不推进任何正式 Schedule cursor。

### 11.2 程序事实

`DigestFacts` 包含：scheduleId、期间、事件 count、changed/failed/unchanged run 统计、排序后的 Event 投影、
EvidenceMap、过期/删除引用状态、程序生成 fetchedAt。Event 最多 50；超出分批，不能静默丢弃。

### 11.3 sharing mode

- full：模型可见有界来源元数据 + old/new Evidence；
- metadata：只见名称/规范化 URL 元数据、事件种类/数量/时间，不见摘录/值；若无法有证据解释，程序摘要；
- blocked：该来源零 Watch 内容进入模型；程序摘要保留。

Source note 默认不进入 Digest prompt。所有可见远程文本置于固定 `UNTRUSTED_WATCH_EVIDENCE` 块，system
prompt 编译期常量；工具列表为空，模型无网络/Browser/Source/SQL 能力。

### 11.4 模型草案验证

模型只返回：`{ sections: [{ eventIds: string[], explanation: string }] }`。严格白名单、每个 eventId 必须存在且
对当前模型投影可见；未知/重复/blocked 引用、超长、额外字段整份解释拒绝。程序 facts 始终保留。
Provider 无 Key/失败/超时/预算/验证失败 → explanation=null，Digest 成功。

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

watch.db v1 明文边界：规则目标、规范化 Baseline、old/new Evidence、事件和 Digest 本地明文；不保存凭据。
UI 创建登录规则时必须披露 30 天保留和锁屏通知默认隐藏。hard-delete/Rule 删除级联；用户 Event 删除不可 Undo。

## 14. 边界情况

| 情况                                         | 处理                                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| Source 在排队后被禁用/删除                   | run 前 revalidate，零网络，pause/cleanup                    |
| Source 仅 metadata/enable/version 变化       | locator fingerprint 相同；更新 rowVersion，按用户意图处理   |
| Source/Rule locator 在运行中变化             | fingerprint CAS 失败，丢弃结果，pause source-changed        |
| 两次运行争用 Baseline                        | 同 Rule 互斥 + expectedVersion CAS，陈旧结果零写入          |
| Session 原授权 Tab 已关闭/应用重启           | 不依赖旧 tabId；gate 后新建 task Tab，共享 Session 重读     |
| task Tab 被用户关闭/redirect/login           | attempt 失败；零重建/零 Baseline 覆盖；按 health 暂停       |
| task Tab cleanup 失败                        | 保留精确 ownership；Watch unavailable；shutdown 重试        |
| App 退出时 HTTP/XML/Browser/Provider pending | abort + 受控 drain；已 reservation 的 slot 只记 interrupted |
| 304 但无 Baseline                            | 协议异常，重新无条件 GET 一次；仍异常 unavailable           |
| feed identity 改变                           | 作为 remove+add，Evidence 双侧 absent/present               |
| PageSnapshot degraded                        | 不生成 Projection/Event，health unavailable/parse_changed   |
| Region 多重匹配                              | parse_changed，禁止猜测                                     |
| Hash 变但无 Evidence                         | unexplainable_change，旧 Baseline 保留                      |
| Condition 字段消失                           | ChangeSet 可表示 absent；不支持的操作 no-match + warning    |
| Evidence 超限                                | 整 Event 拒绝 budget_exceeded，不截成无变化                 |
| Digest 引用随后删除                          | ref tombstone；隐藏对应 AI 解释                             |
| Windows identity 不可用                      | 应用内通知正常，系统 sink unavailable                       |
| watch.db future/corrupt                      | Store unavailable，Scheduler 不启动                         |
| 网络离线                                     | unavailable + 退避；恢复时一次 catch-up                     |
| Clock 回拨/DST                               | scheduledFor/lastLocalDate 幂等，零重复                     |

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
- HTML：parse5 SAX 资格、2 MiB/node/depth/attribute、畸形 HTML、script/iframe/subresource 零执行/零请求；
- Session task Tab：敌手 create 返回用户 id、精确 provisional ownership、焦点恢复三态、用户关闭、ready/error/
  timeout/abort、final origin/locator、close false/throw、cleanupAll drain、重启无旧 tabId；
- PageProjection：四 Region、NFC/bidi/control、table fingerprint、歧义、iframe 诚实边界；
- Diff：新增/删除/修改/反转/排序噪声、table/link/text、hash-only 异常；
- Condition：全 operator、all/any、absent/numeric/field whitelist、零 regex/AI；
- EventValidator：双侧 Evidence、引用/时间/URL/预算/幂等/coalesce；
- Digest/Notification：sharing 三档、blocked 零 prompt、provider 降级、隐私 DTO/去重/muted；
- IPC validators：额外键/超长/原型链/错误类型 fail-closed。

### 15.2 Repository/恢复

真实 node:sqlite：migration v1 表/索引/外键；所有注入串只作数据；CAS；Event+Evidence+Baseline+outbox 原子；
running→interrupted 且已消费 slot 不重放；Source rowVersion 与 locator fingerprint 分离；disable→restore 版本递增仍
按 desiredEnabled 恢复；metadata-only、locator-change、用户 pause、prepare/source/commit/abort 每个崩溃/失败切点；
保留时间/数量/100 MiB；恢复/未来版本/corrupt fail-closed；
dispose 幂等；Sources 用户数据和 Research 数据恒等。

### 15.3 Electron 冒烟

- dev + production Watch 工作区创建 Feed/Page Rule、Baseline、真实变化、失败 health、手动 run、muted；
- Session 页面 grant、撤销、login_required，Cookie/token/表单值零 renderer/日志/DB；
- 关窗停止，重启一次 catch-up；Session catch-up 新建/关闭 task Tab，Cookie Session 可用但旧 tabId/handle 不存在；
  用户 Tab id/url/title/active 按 §8.1 oracle 恒等；
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

产品级待定决议：无。实现发现本契约无法给出红态 oracle、需要扩大网络/Browser/SourceService 公共能力、
需要换 XML 包或新增后台身份时必须停止并 REPLAN。
