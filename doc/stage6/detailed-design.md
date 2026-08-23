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
  watch-lifecycle-coordinator.ts             # Source 生命周期内部观察端口
  watch-acquisition-service.ts               # 路由公开/Session 读取
  public-watch-http-client.ts                # Node 核心公网 GET/HEAD
  network-policy.ts                          # URL/IP/DNS/redirect/robots 决策
  robots-policy.ts                           # RFC 9309 有界缓存与匹配
  feed-discovery.ts                          # parse5 SAX feed link 投影
  feed-parser.ts                             # XML Adapter → FeedProjection
  public-html-sax-reader.ts                  # 公开 HTML → DocumentChannels，零执行/子资源
  browser-watch-reader.ts                    # BrowserController 窄端口
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

既有 BrowserController 公共方法和 SourceService renderer/Agent 公共方法不变。`BrowserWatchReader`
只适配 `getTabs/getPageSnapshot`；`WatchLifecycleCoordinator` 作为 SourceService 构造时内部观察者，
不向 renderer 或模型暴露新能力。

## 2. 预算常量（`src/shared/types/watch.ts` 单一事实源）

| 常量                           |          值 | 语义                           |
| ------------------------------ | ----------: | ------------------------------ |
| `MAX_WATCH_RULES_TOTAL`        |         200 | 包含暂停规则                   |
| `MAX_WATCH_RULES_ENABLED`      |         100 | 实际可调度上限                 |
| `MAX_GLOBAL_WATCH_RUNS`        |           4 | 全局 acquisition 并发          |
| `MAX_HOST_WATCH_RUNS`          |           1 | canonical host 并发            |
| `MAX_DUE_STARTS_PER_TICK`      |          20 | 单次唤醒启动数                 |
| `WATCH_RUN_TIMEOUT_MS`         |      90,000 | 单规则总时间                   |
| `NETWORK_ATTEMPT_TIMEOUT_MS`   |      30,000 | 单网络尝试                     |
| `MAX_REDIRECTS`                |           5 | 每跳复验                       |
| `MAX_FEED_RESPONSE_BYTES`      |   2,097,152 | 解析前硬拒绝                   |
| `MAX_DISCOVERY_HTML_BYTES`     |     262,144 | 仅内存扫描                     |
| `MAX_PAGE_HTML_RESPONSE_BYTES` |   2,097,152 | 公开页面 HTML 流硬上限         |
| `MAX_HTML_NODES`               |      20,000 | SAX 事件节点上限               |
| `MAX_HTML_DEPTH`               |          64 | 元素栈深度上限                 |
| `MAX_HTML_ATTRIBUTES_PER_TAG`  |          64 | 单标签属性上限                 |
| `MAX_FEED_ITEMS`               |         200 | 单 Projection 最新条目         |
| `MAX_FEED_FIELD_BYTES`         |       4,096 | 单标题/摘要/标识等             |
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
  muted: boolean;
  accessMode: WatchAccessMode;
  schedule: WatchSchedule;
  target: FeedTarget | PageTarget;
  condition: StructuredCondition | null;
  notificationLevel: 'normal' | 'important';
  sourceVersion: number;
  nextDueAt: string | null;
  lastDailyLocalDate: string | null;
  consecutiveFailures: number;
  backoffUntil: string | null;
  baselineVersion: number;
  createdAt: string;
  updatedAt: string;
}
```

约束：feed 仅允许 `public`；session 仅允许 page。`muted` 不改变 state/nextDueAt；paused
不进入到期队列。Rule URL 只通过当前 SourceService 解析，Watch 持久化最终规范化 URL 快照仅用于
审计/检测 Source 变化，不能在 Source hard-delete 后继续联网。

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

启动/恢复时：若 `nextDueAt <= now`，为每条规则只创建一个 `catch-up` request；成功提交后立即把
计划推进到第一个 `> now` 的时点。不得枚举或重放中间 missed runs。单次 tick 只启动 20 条，其余
保持有界排序队列 `(effectiveDueAt, ruleId)`。

手动运行使用唯一 requestId，不改变计划锚点。已有同规则运行时返回当前 runId，不排第二次。

### 4.3 退避

- timeout/load/临时 5xx：单次 run 内最多重试一次；仍失败则连续失败数 +1。
- 429：零立即重试，解析有效 `Retry-After`，取其与本地退避较晚者。
- 连续失败退避基线：15 分钟、1 小时、6 小时、24 小时封顶。
- 每次网络开始加入由 `SHA-256(ruleId|host)` 导出的 ±10% 确定性 jitter。
- 成功的 fetched/unchanged 重置连续失败与 backoff。
- 三次连续 `unavailable` 标 degraded 但不覆盖 Baseline。
- `login_required/captcha/robots_disallowed/security_rejected` 立即暂停，零自动重试。
- 连续两次 `parse_changed` 暂停；第一次只 degraded，旧 Baseline 不变。

### 4.4 生命周期

`before-quit` 顺序：停止接收新 run → 清 timer/队列 → abort acquisition/provider → 等待有界 drain →
关闭 WatchStore → 延续既有 Research/Sources/Browser dispose。关窗退出后没有调度。所有 stop/dispose
可重复调用，未完成 running 行在下次启动原子标 `interrupted`，然后按补跑规则处理。

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

1. URL 仅 `http:`/`https:`，拒绝 userinfo、空 host、控制字符、非默认/显式端口越界；
2. 规范化 host 后拒绝 localhost 与保留后缀；
3. 连接 `lookup` 返回的每个候选 IP 都必须是允许的公网 unicast；混合公网+私网整次拒绝；
4. 自定义 lookup 只把已验证地址交给 socket，避免预解析与连接重解析分离；
5. 禁止自动 redirect；Location 解析为绝对 URL后重走 1–4，最多 5 跳；
6. HTTPS→HTTP downgrade 拒绝；最终 URL 主进程记录；
7. 不跟随 DNS/HTTP 指向 file/data/blob/chrome/javascript 或代理隧道；
8. 只读取最多对应字节预算，超出立即 destroy socket；压缩数据同时限制压缩字节和解压后字节；
9. URL 日志去 query/fragment/token，响应正文零日志。

公开 page/feed 请求 User-Agent 固定为产品版本化标识，不包含用户账号/机器 ID。条件请求优先发送
ETag/Last-Modified；304 映射 unchanged-http，不解析空 body。

### 6.2 Robots 与频率

- 公开 page/feed 在首次目标 host 及每次 host 变化前获取并缓存 robots；使用固定 Watch user-agent。
- robots 获取同样经过 NetworkPolicy，最大 256 KiB、30 秒；不可解析/安全拒绝时 fail-closed 为 unavailable/security。
- disallow 立即 `robots_disallowed` 并暂停；用户无 override。
- 登录态 page 不查询 robots，但仍全局/主机并发、最小间隔、退避；这不是绕公开反爬授权。
- robots 只表达 crawler preference，不替代 ToS/法律判断；UI 在创建公开规则时显示诚实提示。

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
- Projection 最多 200 items，按 feed 顺序；字段逐项限长，超限单项安全截断并标记；结构/总预算超限整次失败；
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

| 分类                     | 典型来源                             | 重试             | Baseline | 状态/用户动作            |
| ------------------------ | ------------------------------------ | ---------------- | -------- | ------------------------ |
| `unavailable`            | DNS/连接/临时 5xx                    | 1 次 + 退避      | 保留     | 3 次 degraded            |
| `budget_exceeded`        | 响应/投影/运行超限                   | 否               | 保留     | 显示限制；需调整目标     |
| `robots_disallowed`      | robots deny                          | 否               | 保留     | 立即暂停                 |
| `security_rejected`      | scheme/IP/redirect/downgrade/XML DTD | 否               | 保留     | 立即暂停；安全文案       |
| `login_required`         | 登录跳转/受保护页                    | 否               | 保留     | 立即暂停；重新授权       |
| `captcha`                | challenge/captcha                    | 否               | 保留     | 立即暂停；不绕过         |
| `parse_changed`          | Region/feed 结构失效                 | 首次下次计划重试 | 保留     | 连续 2 次暂停，修复/重建 |
| `dependency_unavailable` | XML 资格/运行装配失败                | 否               | 保留     | feed 全局 fail-closed    |
| `interrupted`            | 退出/崩溃                            | 下次合并补跑     | 保留     | 审计可见                 |

错误检测不得用单一敌手正文字符串直接决定登录/captcha。使用主进程 URL/HTTP 状态、导航结果、
已知 Chromium error URL、受控 DOM 元数据和保守判定；不确定时 unavailable，不回显页面挑战正文。

## 8. PageProjection 与 Region

两条 acquisition 路径严格分离但汇合到同一 `DocumentChannels`：

- **public**：PublicWatchHttpClient → PublicHtmlSaxReader；零 Cookie、零 JavaScript、零子资源，
  `documentId=null`，capturedAt/final URL 由主进程 HTTP acquisition 记录。
- **session**：BrowserWatchReader 每次实时调用 BrowserController，不缓存 PageSnapshot；把已有
  `visibleText/headings/tables/links` 映射为 DocumentChannels，忽略 inputs/form values/buttons 的可变值；
  capturedAt/documentId/final URL 取主进程快照。

public 不自动回退 session；session 只能来自逐规则用户授权。创建/编辑 Rule 的预览必须使用最终选定模式，
不能用共享浏览器预览替公开 HTTP 建基线。

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
`sessionConsent` 的 origin/time/version，不持久化 handle、Cookie 或 session credential。Source URL/origin
变化、用户撤销或 watch.db 恢复会使 consent 失效并进入 login_required。

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

| 表                       | 核心列/约束                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watch_rules`            | id PK、source_id、kind/state/pause_reason/muted/access_mode、schedule_json/target_json/condition_json 严格版本、source_version、due/backoff/failure/baseline_version、时间 |
| `watch_baselines`        | rule_id PK/FK、version、projection_type/json/hash/bytes、final_url/captured_at/document_id；bytes CHECK                                                                    |
| `watch_runs`             | id PK、rule_id FK、request_key UNIQUE、trigger/scheduled_for/start/finish/outcome/health、响应元数据有界                                                                   |
| `watch_audits`           | id PK、rule_id、kind、reason code、created_at；零敌手正文                                                                                                                  |
| `watch_events`           | id PK、rule/source、kind/importance、idempotency_key UNIQUE、fingerprint、观察时间、read_at、item_count                                                                    |
| `watch_event_items`      | id PK、event_id FK、sequence、field_key/label、before/after typed value JSON、双侧元数据；UNIQUE(event_id, sequence)                                                       |
| `digest_schedules`       | id PK、固定 source_ids_json、schedule_json、ai_enabled、cursor、state/time                                                                                                 |
| `watch_digests`          | id PK、schedule_id、facts_json、explanation_json nullable、bytes、created_at                                                                                               |
| `digest_event_refs`      | digest_id/event_id、status active/expired/user-deleted；复合 PK                                                                                                            |
| `notification_outbox`    | id PK、subject_type/id、channel、dedupe_key UNIQUE、privacy_json、state/attempt/time                                                                                       |
| `source_cleanup_intents` | source_id PK、source_version、state prepared/source-deleted/complete/aborted、time                                                                                         |

外键打开；删除 Rule CASCADE baseline/runs/audits/events/outbox；Event CASCADE items；Digest 对 Event 使用
tombstone 状态而非丢失引用真实性。所有 JSON 读取后再次用共享 validator，非法/未来版本使 Store
`unavailable`，不得部分启动 Scheduler。

### 10.2 Store 启动

1. 打开独立 `watch.db`，PRAGMA/foreign key 固定；
2. read-only probe 与 user_version；未来版本 fail-closed；
3. migration（仅已批准编译期 SQL）；
4. quick/integrity check、JSON shape/预算扫描；
5. 单事务 running→interrupted；
6. reconcile `source_cleanup_intents` 和 SourceService 当前事实；
7. 清理超期/超数/超库预算；
8. 只有全部成功才返回 `normal` 并启动 Scheduler，否则 `unavailable`，UI 只读错误态。

v1 复用 Sources 严格 backup 模式但使用独立 Watch 目录/文件名；备份也受 100 MiB 与最多 5 份/30 天
边界。备份中仍是本地明文，文档如实披露。恢复后必须重新 reconcile Source 并使 Session grant 失效。

### 10.3 Source 生命周期跨库协议

- prepare hard-delete：Watch 在自身事务暂停规则、写 intent；失败则 Source hard-delete 不继续。
- SourceService 执行既有 hard-delete。
- complete：Watch 事务级联数据并把 intent 完成后删除。
- 若 Source 删除失败：intent→aborted；恢复此前状态仅限 Source 仍存在且版本相同。
- 崩溃：每次 run 仍经 SourceService revalidate；启动 reconciliation 根据 Source 是否存在完成或取消 intent。
- soft-delete/disable 不删除 Watch 数据；restore 只恢复 `pauseReason=source-disabled/source-deleted` 且 URL/version
  未变、Rule 原 enabled 意图为真者。
- URL/version 变化：pause source-changed；旧 Baseline 只用于用户预览，不再比较；确认 rebaseline 后更新 sourceVersion。

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
最终仅持久化无凭据 consent 元数据。

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

| 情况                                         | 处理                                                      |
| -------------------------------------------- | --------------------------------------------------------- |
| Source 在排队后被禁用/删除                   | run 前 revalidate，零网络，pause/cleanup                  |
| Source URL 在运行中变化                      | CAS sourceVersion 失败，丢弃结果，pause source-changed    |
| 两次运行争用 Baseline                        | 同 Rule 互斥 + expectedVersion CAS，陈旧结果零写入        |
| App 退出时 HTTP/XML/Browser/Provider pending | abort + 受控 drain；下次 interrupted/catch-up             |
| 304 但无 Baseline                            | 协议异常，重新无条件 GET 一次；仍异常 unavailable         |
| feed identity 改变                           | 作为 remove+add，Evidence 双侧 absent/present             |
| PageSnapshot degraded                        | 不生成 Projection/Event，health unavailable/parse_changed |
| Region 多重匹配                              | parse_changed，禁止猜测                                   |
| Hash 变但无 Evidence                         | unexplainable_change，旧 Baseline 保留                    |
| Condition 字段消失                           | ChangeSet 可表示 absent；不支持的操作 no-match + warning  |
| Evidence 超限                                | 整 Event 拒绝 budget_exceeded，不截成无变化               |
| Digest 引用随后删除                          | ref tombstone；隐藏对应 AI 解释                           |
| Windows identity 不可用                      | 应用内通知正常，系统 sink unavailable                     |
| watch.db future/corrupt                      | Store unavailable，Scheduler 不启动                       |
| 网络离线                                     | unavailable + 退避；恢复时一次 catch-up                   |
| Clock 回拨/DST                               | scheduledFor/lastLocalDate 幂等，零重复                   |

## 15. 测试规格

### 15.1 纯逻辑/单元

- Budget：UTF-8、surrogate、每个等于/超过边界；
- Schedule：interval/daily、DST gap/fold、回拨/跳跃、missed coalescing、jitter；
- NetworkPolicy：IPv4/IPv6/混合 DNS/重绑定夹具、每跳 redirect、downgrade/userinfo/scheme；
- Robots：allow/disallow、UA 优先、空/畸形/超长、缓存失效；
- XML：RSS/Atom/namespaces/CDATA/encoding、DTD/entity/XXE/bomb/depth/attr/text/node budgets；
- HTML：parse5 SAX 资格、2 MiB/node/depth/attribute、畸形 HTML、script/iframe/subresource 零执行/零请求；
- PageProjection：四 Region、NFC/bidi/control、table fingerprint、歧义、iframe 诚实边界；
- Diff：新增/删除/修改/反转/排序噪声、table/link/text、hash-only 异常；
- Condition：全 operator、all/any、absent/numeric/field whitelist、零 regex/AI；
- EventValidator：双侧 Evidence、引用/时间/URL/预算/幂等/coalesce；
- Digest/Notification：sharing 三档、blocked 零 prompt、provider 降级、隐私 DTO/去重/muted；
- IPC validators：额外键/超长/原型链/错误类型 fail-closed。

### 15.2 Repository/恢复

真实 node:sqlite：migration v1 表/索引/外键；所有注入串只作数据；CAS；Event+Evidence+Baseline+outbox 原子；
running→interrupted；cleanup intent 的每个崩溃切点；保留时间/数量/100 MiB；恢复/未来版本/corrupt fail-closed；
dispose 幂等；Sources 用户数据和 Research 数据恒等。

### 15.3 Electron 冒烟

- dev + production Watch 工作区创建 Feed/Page Rule、Baseline、真实变化、失败 health、手动 run、muted；
- Session 页面 grant、撤销、login_required，Cookie/token/表单值零 renderer/日志/DB；
- 关窗停止，重启一次 catch-up，用户 Tab 零误关；
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
D3 → D6 public/session page projection
D2 + D4 → D5 scheduler/coordinator
D3 + D4 + D5 + D6 → D7 diff/event/evidence/health
D7 → D8 digest
D4..D8 → D9 UI/IPC/notification/export
D1..D9 → D10 e2e/redteam/live/package gate
D1..D10 → D11 independent Stage Auditor
```

D11 只能在 `Sixth_stage.md` §9 全项、§10 五项、全量/冒烟/跨进程/红队/真实条件均有当前 HEAD 证据后
判 GO/PASS；否则 HOLD/PENDING。PASS 后停止，等待用户进入 Seventh Stage，不夹带产品化代码。

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

产品级待定决议：无。实现发现本契约无法给出红态 oracle、需要扩大网络/Browser/SourceService 公共能力、
需要换 XML 包或新增后台身份时必须停止并 REPLAN。
