# AIbrowse 第六阶段高层设计（RSS、网页 Diff、Watch 与持续信息更新）

> 上位需求：`Sixth_stage.md`。产品细节唯一契约源：`doc/stage6/detailed-design.md`；
> 安全契约：`doc/stage6/threat-model.md`。本文件说明模块边界与依赖方向，不复制全部字段和预算。

## 1. 架构总览

```text
Browser UI
  → BrowserController
  → TabManager / PageReader / SessionManager
  → Electron APIs

Sources UI / Agent Source Tools
  → SourceService
  → SourceRepository / SearchIndex / ChangeJournal
  → sources.db

Research UI
  → ResearchService / ResearchRuntime
  → SourceService / BrowserController / SearchProvider / LLMProvider
  → research.db

Watch UI
  → WatchService
  → WatchRuleService / WatchQueryService / WatchLifecycleCoordinator
  → WatchRunCoordinator
       → WatchScheduler（只提交到期 ruleId，不持有 Browser/DB/Provider）
       → WatchAcquisitionService
            → PublicWatchHttpClient（公网 feed/公开页面；Node 核心网络）
            → PublicHtmlSaxReader（公开 HTML；零脚本/子资源）
            → BrowserWatchReader（逐规则授权的登录态页面；BrowserController 窄端口）
       → FeedParser / DocumentChannelBuilder / PageProjector
       → DiffEngine / ConditionEngine / EventValidator
       → WatchRepository（watch.db 唯一业务 SQL 点）
  → DigestService
       → WatchQueryService / SourceService sharing projection / LLMProvider
  → NotificationService
       → InAppNotificationSink / WindowsNotificationSink（feature-gated）
  → WatchExportService
       → Electron dialog 窄通道
```

依赖只向下。Watch 不进入 AgentLoop，不新增 AI 工具，不反向调用 renderer，不直接访问 Sources/Research Repository。Research 不依赖 Watch；Digest 复用 Provider 接口但不复用 ResearchRuntime 或 research.db。

## 2. 关键技术决策

| 主题     | 选择                                                        | 被否决方案与理由                                                             |
| -------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 后台边界 | 仅应用进程运行时                                            | 托盘/系统任务/服务扩大安装、更新、凭据与单实例边界                           |
| 存储     | 独立 `watch.db`                                             | `sources.db` 会污染 journal/backup；`research.db` 生命周期错误               |
| 网络     | 公网 Node 核心客户端 + 明确 Session 页面读取                | 自动 Session/回退不可审计；普通 fetch 预解析无法充分约束连接时 DNS           |
| XML      | `@federicocarboni/saxe@0.8.0` 候选 + D3 资格门              | `saxes` 已归档；`fast-xml-parser` 面更宽且近期实体安全修复频繁               |
| HTML     | `parse5-sax-parser@8.0.0` + `parse5@8.0.1` 候选 + D3 资格门 | 隔离 Chromium 会执行脚本/子资源并扩大 SSRF；共享 Session 会泄露公开/登录边界 |
| 页面范围 | 用户确认命名 Region                                         | 整页默认噪声高；AI 自动选区不确定                                            |
| Diff     | 来源类型专属确定性算法                                      | 通用文本/AI equality 无法给出稳定 oracle                                     |
| Evidence | 持久化有界 old/new 投影                                     | 哈希不可解释；正文/HTML 隐私与容量风险高                                     |
| 条件     | 闭合确定性白名单                                            | AI/regex/script 触发不可复现且扩大攻击面                                     |
| Digest   | 程序事实 + 可选 AI 解释                                     | AI 自选事件会改变事实层与成本                                                |
| Group    | 创建/编辑时解析为明确成员                                   | 动态成员会静默扩大联网授权                                                   |
| 通知     | 应用内必达，Windows 条件式                                  | 开发态通知不能证明打包身份可用                                               |

## 3. 模块职责

### 3.1 WatchService

renderer/preload 的唯一 Watch 业务入口。验证 DTO、权限和生命周期；委派规则、查询、手动运行、Digest、通知设置和删除。它不执行 SQL、XML、网络或模型调用。

### 3.2 WatchRuleService

创建、编辑、暂停、恢复、静音和删除规则；把 Source/Group 选择解析为明确 ID；校验 Schedule、Region、Condition、授权和产品预算。URL 更新不迁移 Baseline。

### 3.3 WatchScheduler

持有可注入 Clock、到期堆/队列和应用进程内 timer。只向 `WatchRunCoordinator.requestRun(ruleId, reason)` 提交 ID；不得持有 BrowserController、SQLite、HTTP、LLMProvider 或 NotificationSink。

### 3.4 WatchRunCoordinator

单一运行所有权、全局/主机并发、同规则互斥、补跑合并、5 秒同主机请求起点间隔、退避、abort 与 shutdown drain。计划 slot 的 Run reservation、消费记录和 next due 推进由 Repository 单事务完成。每次运行前经 SourceService 复核 Source locator fingerprint 与状态，防跨库孤儿规则联网。

### 3.5 WatchAcquisitionService

按 Rule 类型选择唯一路径：

- 公开 Feed：`PublicWatchHttpClient` → `FeedParser`；
- 公开页面：`PublicWatchHttpClient` → `PublicHtmlSaxReader`，零 JavaScript/子资源；
- 登录态页面：用户明确授权后通过 `BrowserWatchReader`；
- feed 失败不自动浏览器回退；登录 feed v1 不支持。

### 3.6 PublicWatchHttpClient

项目自有 Fetch-like 窄接口。只 GET/HEAD，只接受 HTTP 80/HTTPS 443；禁止任意 method/body/header。连接时 DNS 地址由确定性 NetworkPolicy 校验；重定向逐跳、scheme/host/port/DNS 全复验；应用 robots、条件请求、响应/时间/频率预算和脱敏。

### 3.7 FeedDiscovery / FeedParser / PublicHtmlSaxReader

Discovery 与公开页面投影共用已资格化的 parse5 SAX 事件流；前者只读取 `<link rel=alternate>`，后者只构造有界 `DocumentChannels`（mainText/headings/tables/links），不执行脚本、不请求子资源、不持久化 HTML。FeedParser 使用已资格化的流式 XML 依赖，只构造闭合 FeedProjection，不构造通用 XML DOM；DTD/ENTITY/XInclude，或 depth/name/attribute/text/node/total-text/Projection 任一预算超限均 fail-closed。

### 3.8 BrowserWatchReader / DocumentChannelBuilder / PageProjector

公开页面从 HTML SAX 流得到 `DocumentChannels`；Session 页面复用 BrowserController 安全设置，把 PageSnapshot 映射到同一结构。RegionDescriptor 是闭合语义定位，不含任意 JS/CSS 执行；投影由主进程 acquisition 记录盖章 final URL、capturedAt、documentId（公开模式为 null）。定位歧义/失效变为 health，不猜测替代区域。需要 JavaScript 的公开页面只能由用户显式切换并重新授权为 Session 模式，不能自动回退。

### 3.9 DiffEngine / ConditionEngine / EventValidator

纯函数、零 IO。FeedDiff 按 item identity/字段；PageDiff 按 Region/类型化字段。Condition 只读 ChangeSet 的验证字段。EventValidator 要求 before/after Evidence、引用完整、预算、时间和来源绑定；哈希仅加速/去重。

### 3.10 WatchRepository / Store

`watch.db` 的唯一 SQL 执行点；prepared statement 参数绑定。Store 负责 probe、migration、integrity、启动恢复、遗留 queued/running→interrupted、清理和幂等 dispose。捕获正文零落盘。

### 3.11 WatchLifecycleCoordinator

作为 SourceService 内部 prepare/commit/abort 装配端口接收全部写路径的窄 before/after projection，不改变 SourceService 对 renderer/Agent 的公共语义。`Source.version` 仅是行版本；Watch 用 scope/canonicalKey/目标 URL 的独立 locator fingerprint 判断恢复或重建。每次运行仍做 SourceService revalidation，作为跨库崩溃纵深防线。

### 3.12 DigestService

根据明确 DigestSchedule 游标选事件；程序生成来源、时间、状态、EvidenceMap 和确定性摘要。分享模式决定模型投影；模型只能返回引用事件 ID 的解释草案，验证失败即降级。

### 3.13 NotificationService / ExportService

NotificationPolicy 生成隐私安全 DTO、做幂等去重和 muted 过滤。Windows Sink 在身份探针未通过时不可用。ExportService 只导出当前过滤事件 CSV 或单个 Digest Markdown，经主进程 dialog，CSV 防公式注入。

## 4. 关键数据流

### 4.1 创建 Feed Watch

```text
用户输入 Source/页面
→ WatchRuleService 校验 Source 与分享/启用状态
→ FeedDiscovery（公开、公网、robots、限量）
→ FeedParser validation（DTD/entity 禁止）
→ UI 预览最终 URL/类型/健康/计划
→ 用户确认
→ Repository 写 Rule
→ 首次 acquisition
→ baseline_established audit（不是 Event/通知/Digest）
→ Scheduler 登记 nextDueAt
```

### 4.2 页面 Watch

```text
用户点击“监控此页”
→ 选择 public 或 session 模式
→ public：受限 HTTP + HTML SAX；session：BrowserController 实时 PageSnapshot + grant
→ 两路映射为同一 DocumentChannels
→ 用户选择/命名 Region
→ PageProjector 生成预览
→ 保存 Rule/Region
→ 首次 baseline audit
```

### 4.3 周期运行

```text
Clock 到期/启动 catch-up/手动检查
→ Scheduler 提交 ruleId
→ scheduled/catch-up：Repository 单事务建 Run + 消费 scheduledFor + 推进 nextDueAt
→ Coordinator 做单例、并发、5秒主机间隔、退避与 Source locator revalidation
→ Acquisition 得到 fetched | unchanged-http | health-failure
→ Projector/Parser 生成 Projection
→ DiffEngine 比较 last-known-good Baseline
   ├─ unchanged → RunOutcome=unchanged，更新健康/条件请求元数据
   ├─ failure → 保留 Baseline，更新 health/backoff
   └─ changed → ConditionEngine → EventValidator
                 ├─ 不匹配 → 推进 Baseline，记录 changed-unmatched run
                 └─ 匹配 → 事务写 Event + before/after Evidence + 新 Baseline
→ NotificationPolicy（muted/隐私/去重）
```

仅在完整 Projection、ChangeSet、Condition 和 Event 验证后推进 Baseline。哈希变化但双侧 Evidence 不可构造时进入 `unexplainable_change`，不推进。

### 4.4 Digest

```text
DigestSchedule 到期
→ 固定成员 + 独立游标查询新 Event/失败统计
→ 无 Event：更新 lastChecked，不建空 Digest、不调模型
→ 程序构造 DigestFacts/EvidenceMap
→ SourceService sharing projection
→ 可选 LLMProvider（一次、有界）
→ ResultValidator 校验 event refs/白名单/预算
→ 持久化 deterministic result + 可选 explanation
→ 通知
```

### 4.5 Source 生命周期

- disable/soft-delete：observer prepare 先暂停；`desiredEnabled` 保留用户原意；运行前复核确保无新请求。
- restore：行 version 必然递增但不等于 locator 改变；fingerprint 相同、原意 enabled 且仅因 Source 状态暂停才恢复，用户 pause 不恢复。
- locator 更新：`source_changed`，旧基线冻结，用户确认后重建；metadata-only/行版本变化不误判。
- hard-delete：先在 watch.db 写 durable intent 并暂停，再删除 Source，最后级联 Watch 数据；prepare 失败阻止删除，Source 已提交后的 commit 失败留 intent 且 Watch unavailable。崩溃后启动 reconciliation 完成。任何中间态均因运行前 Source revalidation 而不能联网。

## 5. 存储与保留

```text
sources.db   Source 事实、change journal、既有 backup（不新增 Watch 表）
research.db  一次性 Research 任务（不新增 Watch 表）
watch.db     Rule / Baseline / Run / Event / Evidence / Digest / cleanup intent
```

- 公开 Evidence：90 天且每规则最多 200 事件；登录态：30 天且最多 100。
- 全库 100 MiB；Baseline 64 KiB；Event 双侧 Evidence 合计 32 KiB；Digest 64 KiB。
- 原始 HTTP body、HTML、完整 PageSnapshot、Cookie、凭据、模型 transcript 零落盘。
- 清理按事件时间/ID 确定性全序，Digest 对过期/删除证据诚实显示状态。
- `watch.db` v1 本地明文，UI/文档必须披露；不宣称静态加密。

## 6. 安全模型摘要

- **结构层**：renderer/preload 零网络/SQL/Provider；Scheduler 零能力；Repository 唯一 SQL；六个窄端口。
- **能力层**：公网 GET/HEAD、逐跳地址校验、Session 逐规则授权、零 Cookie 读通道、XML 无外部解析。
- **决策层**：Diff/Condition/Event/Digest facts/Notification DTO 程序所有权。
- **持久化层**：有界投影、old/new Evidence、UTF-8 字节预算、分级保留、删除级联。
- **运行时层**：单规则互斥、全局/主机并发、Clock、abort、shutdown drain、补跑合并。
- **审计层**：只记录 ID、状态、耗时、字节数、分类和脱敏 URL；零敌手正文。

完整威胁和红队矩阵见 `threat-model.md`。

## 7. 测试策略

- 纯函数：NetworkPolicy、Schedule、Backoff、Normalization、Diff、Condition、Evidence/Event/Digest/Notification Validator。
- Repository：真实 `node:sqlite` migration、注入仅作参数、事务原子、崩溃恢复、预算清理。
- 网络/Parser：本地敌手服务器 + 受控 DNS/redirect 夹具 + RSS/Atom/畸形 XML 语料。
- Electron：Region 选择、Session 授权、应用退出停止、通知降级、dialog 导出。
- 跨进程：`AIBROWSE_WATCH_SMOKE=set|check` 临时 userData，验证 Baseline/Event/恢复/清理。
- 真实外部条件：少量公开 feed、robots、重定向、真实 Provider Digest；调用台账和 Key 零暴露。
- 独立 D11 Stage Auditor 复跑全量、dev/production、跨进程、红队、真实条件并逐项判定 §9/§10。

## 8. 风险与替代方案

| 风险                   | 缓解                                                    | 诚实限制                           |
| ---------------------- | ------------------------------------------------------- | ---------------------------------- |
| 小生态 XML 候选        | D3 资格门、精确版本、敌手/兼容/构建矩阵                 | 通过项目测试不等于第三方形式化审计 |
| DNS rebinding/代理差异 | 连接时 lookup、每跳复验、禁止任意代理配置               | 系统/企业网络异常可能导致安全拒绝  |
| DOM 结构变化           | 用户 Region、语义定位、连续失败后暂停                   | 不能保证所有网站长期稳定           |
| 登录内容敏感           | 逐规则授权、短保留、通知默认隐藏、shareMode             | watch.db v1 本地明文               |
| 模型 Prompt Injection  | 程序事实、UNTRUSTED 块、引用验证、确定性降级            | AI 解释仍可能语义偏差              |
| Windows 通知           | feature gate + 已打包冒烟                               | 未验证身份时仅应用内通知           |
| 应用关闭遗漏           | 单次合并补跑、清晰 UI                                   | v1 不承诺退出后监控                |
| 两库生命周期           | durable intent + 每次运行 revalidation + reconciliation | 跨库没有单事务原子性               |

## 9. 不确定性状态

产品决策已由 U01–U31 冻结。条件性事项是 XML/HTML 候选资格与 Windows 打包通知资格；三者都有明确 fail-closed 结果，不授权替代实现或夸大能力。
