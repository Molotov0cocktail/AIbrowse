# AIbrowse 第六阶段威胁模型（Watch，2026-08-23）

> 本文件必须先于任何第六阶段产品实现定稿。上位需求 `Sixth_stage.md`，产品契约
> `doc/stage6/detailed-design.md`。远程 feed、HTML、PageSnapshot、Projection、Diff、Source note、
> 模型输出和通知标题一律不可信。本模型不宣称能解决网站 ToS 判断或模型语义完全免疫。

## 1. 攻击面变化

Fifth Stage 是用户显式启动、一次性、有界 Research；Sixth Stage 增加长期重复执行，因此放大：

- 网络目标重复访问、DNS/redirect/SSRF 与站点资源压力；
- XML parser 的 DTD/entity/深度/编码/内存攻击；
- 公开 HTML parser 的畸形树、巨型节点、脚本/子资源执行和共享 Cookie 污染；
- 登录态页面被周期读取的隐私与认证挑战风险；
- 页面噪声、结构漂移和哈希变化被误报为事实；
- old/new Evidence、事件、Digest 和通知的长期本地暴露；
- 调度重入、时钟变化、离线补跑、退出/崩溃和跨库孤儿状态；
- feed/页面 Prompt Injection 进入自动 Digest；
- Windows 锁屏通知泄露或伪造跳转；
- 日志、数据库和队列无界增长造成桌面应用资源耗尽。

## 2. 威胁枚举（WT-01～WT-23）

| ID    | 威胁                                                        | 资产/影响                   |
| ----- | ----------------------------------------------------------- | --------------------------- |
| WT-01 | URL 指向 localhost/私网/link-local/保留地址                 | 内网服务、用户机器          |
| WT-02 | DNS rebinding 或公网+私网混合解析                           | 绕过预校验                  |
| WT-03 | redirect 转向危险 scheme/私网或 HTTPS downgrade             | SSRF/凭据暴露               |
| WT-04 | 巨型/压缩炸弹/慢响应                                        | 内存、CPU、event loop       |
| WT-05 | robots disallow、429、反爬挑战被绕过                        | 站点友好性、封禁            |
| WT-06 | XML DTD/XXE/实体扩张/XInclude                               | 文件/网络读取、DoS          |
| WT-07 | XML 深度、属性、编码和畸形输入                              | parser crash/DoS            |
| WT-08 | feed identity 欺骗、重复、字段超长                          | 假事件/存储增长             |
| WT-09 | 登录态 Rule 未经知情授权或授权扩大                          | 私人页面持续读取            |
| WT-10 | Cookie/token/表单值进入 renderer/DB/日志/prompt             | 凭据泄露                    |
| WT-11 | captcha/login/challenge 被自动反复访问                      | 账号风险/反爬绕过           |
| WT-12 | DOM 噪声/结构变化/iframe 缺失制造假变化                     | 错误结论/通知骚扰           |
| WT-13 | 只有哈希、无 old/new Evidence 的不可解释事件                | 证据链失真                  |
| WT-14 | 模型决定 equality/条件/事件/重要性                          | 不确定事实层                |
| WT-15 | feed/page Prompt Injection 控制 Digest                      | 欺骗性摘要/越权             |
| WT-16 | sharing=blocked/metadata 被 Watch 绕过                      | 模型隐私越界                |
| WT-17 | 通知显示敏感摘录、URL query 或伪造路由                      | 锁屏泄露/钓鱼               |
| WT-18 | scheduler 重入、时钟回拨、missed replay 风暴                | 重复请求/事件               |
| WT-19 | Source 删除/URL 更新后孤儿 Rule 继续联网                    | 删除语义/隐私破坏           |
| WT-20 | watch.db/Event/Digest/log 无界增长                          | 磁盘耗尽/隐私扩大           |
| WT-21 | SQLite 注入、未来 schema/corrupt 部分启动                   | 数据完整性/任意查询         |
| WT-22 | 退出/崩溃时句柄、Tab、timer、请求泄漏                       | 生命周期与重复运行          |
| WT-23 | 公开 HTML 解析执行脚本/加载子资源、树膨胀或误用共享 Session | SSRF、Cookie 隐私、CPU/内存 |

## 3. 纵深防御

### 3.1 结构层

1. Watch UI → WatchService 是 renderer 唯一业务入口；renderer/preload 零 HTTP/SQL/Provider/Cookie。
2. WatchScheduler 只能提交 `ruleId` 给 WatchRunCoordinator；不持有网络、Browser、DB、模型或通知对象。
3. PublicWatchHttpClient、BrowserWatchReader、FeedParser、Repository、DigestProvider、NotificationSink 六类
   能力互不合并；不存在通用“任意 URL/方法/脚本/SQL/IPC”端口。
4. WatchRepository/migration 是唯一业务 SQL 点；Watch 不进入 SourceRepository/ResearchRepository。
5. WatchTaskTabWorkspace 只使用既有 BrowserController create/close/activate/getTabs/getActiveTab；
   BrowserWatchReader 只使用 getTabs/getPageSnapshot。两者不暴露 webContents/executeJavaScript/Cookie，task tabId
   只在 main 内存所有权集合流转，不进 renderer/模型/DB/日志。
6. 模型无 Watch 工具、无 AgentLoop、无网络、无 SQL；只收到程序投影。

**结构性证明**：静态 import/grep、工具注册表恒等、preload 白名单、SQL 执行点分类、依赖图循环检查。

### 3.2 能力层：网络与 XML

- 公网客户端只 GET/HEAD，固定 header；调用者不能给 method/body/auth/proxy。
- URL 初始、连接时 DNS 地址、每跳 redirect 均验证；混合公网/私网整次拒绝；禁止 downgrade/userinfo，
  端口只允许 HTTP 80/HTTPS 443。
- 自定义 connection lookup 只返回已批准 IP；避免只做 DNS 预解析的 TOCTOU。
- 响应/解压/时间/redirect/host concurrency 全硬上限；同 canonical host:port 每次 socket start 至少间隔
  5秒（含 robots/redirect/retry），socket 超限立即销毁。
- 公开 page/feed 严格 robots；429 遵守 Retry-After；captcha/challenge/login 停止。
- XML candidate 先资格门；DTD prohibit、零 resolver、零 external entity/XInclude，depth/name/attribute-count/
  attribute-bytes/text-node/nodes/total-text/FeedProjection 都有 `==` 可用、`+1` 拒绝的编译期上限。
- HTML candidate 同样先资格门；公开 HTML 只经 Node 核心 HTTP + parse5 SAX 事件流，零 WebContents、
  JavaScript、Cookie 和 script/image/iframe 子资源；2 MiB/node/depth/attribute/Projection 全预算。
- feed 解析失败不浏览器 fallback；登录 feed v1 不支持。

**诚实限制**：企业代理、DoH、系统网络中间层可能造成可用性拒绝；本产品选择安全拒绝，不承诺访问所有网络。

### 3.3 决策层

- NetworkPolicy、RobotsPolicy、Normalization、Diff equality、Condition、EventValidator、DigestFacts、
  NotificationPrivacyPolicy 均为纯确定性程序。
- AI 不能创建/删除/合并事件，不能提供可信 URL/时间/documentId/Evidence，不能决定触发或重要性。
- Rule importance 由用户选择；Group 只在创建/编辑时展开，成员增加不自动联网。
- Hash 变化但无法形成双侧 Evidence → `unexplainable_change`，零 Event/零 Baseline 推进。
- login/captcha/parse 判定不直接信任敌手正文；使用受控主进程状态并保守降级。

**结构性证明**：类型只让模型返回 explanation+eventIds；ResultValidator 严格白名单；Event insert 只接受
程序生成窄类型。

### 3.4 登录态与隐私层

- session Rule 必须逐规则预览和明确确认；main 内存保存一次性 grant record，renderer 只见无凭据 opaque
  handle，不见 Cookie/session credential；handle 零 DB/日志。
- grant 绑定 sourceId/tabId/final origin/target 摘要，5 分钟单次使用；消费后只持久化 consent
  origin/time/version；URL/Source 变化使授权失效。
- preview tabId、grant handle 和周期 task tabId 均零持久化。每个 attempt 在 host gate 后新建全新 task-owned
  Tab，ready/snapshot/final origin/locator 复验后 finally 精确关闭；原授权 Tab 可以关闭，不作为运行依赖。
- task Tab 所有权只凭 create 前后集合和返回的全新精确 id 证明；provisional 登记先于 abort/清理。敌手返回
  用户 id 时零关闭；cleanup false/throw 保留 ownership、Watch unavailable、shutdown 重试。
- create 自动激活后的焦点按三态立即恢复；用户已切换则零 activate，原 Tab 已关闭则不重建。attempt 前用户
  Tab 不被 Watch navigate/close，final origin 跨授权边界或 locator 改变均零 Projection/Baseline 推进。
- Session Rule Evidence 30 天/100 事件，Windows 通知默认“受保护来源发生变化”。
- inputs/form values 不进入 PageProjection；query/fragment/headers/token 不进日志/通知/DB/prompt。
- sharing full/metadata/blocked 在 Digest 前程序投影；blocked 零 Watch 内容进模型。
- app 关闭即停止，UI 明示；v1 不声称后台继续保护或采集。

**诚实限制**：watch.db v1 本地明文；拥有用户 OS 账户/磁盘读取权限的攻击者可能读取有界 Evidence。

### 3.5 持久化层

- 独立 watch.db；原始 body/HTML/PageSnapshot/完整正文/transcript 零落盘。
- 每个 Event 必须持久化 typed before/after Evidence；新增/删除用 absent 显式表示。
- UTF-8 单字段/单投影/单事件/单 Digest/全库预算；公开与 Session 分级保留。
- Event 删除级联 Evidence；Digest ref 标 expired/user-deleted 并隐藏失证解释。
- Source 行 version 与 locator fingerprint 分离；disable→restore 的版本递增不误判 URL 改变，用户 pause 意图
  单独保存。hard-delete durable intent + prepare/commit/abort + run 前 revalidation + startup reconciliation；
  不冒充跨库单事务。
- future/corrupt/非法 JSON/超限数据使 Watch Store unavailable，Scheduler 不启动。
- SQL 编译期常量、参数绑定、foreign key、CAS 和事务；不可信文本不得成为表/列/ORDER BY。

### 3.6 运行时层

- 同 Rule 单运行、全局4、同 host1且请求起点间隔5秒、单 tick20、总90秒、网络30秒、redirect5。
- scheduled reservation 在同事务创建 Run、消费 scheduledFor、推进 nextDue；提交后失败/pause/abort/crash 都不
  回拨或重放。未消费的 missed runs 只合并一次；DST logical date 幂等；手动 run 不改变计划、无安全旁路。
- 0..500ms 确定性附加 jitter（永不提前于 due）+ 指数退避；429 零立即重试；login/captcha/security 立即暂停。
- Baseline 只在完整验证事务中 CAS 推进；失败/abort/陈旧 result 零覆盖。
- before-quit stop-admission → abort → drain → store close；启动 queued/running→interrupted。
- Session abort/timeout/shutdown 先阻止新 task Tab，等待 in-flight create 落定并证明 ownership，再 closeOwned/
  cleanupAll；进程崩溃由 Electron 销毁未持久化 Tab，下次不引用旧 id。
- muted 只过滤即时通知，不改变网络；paused 才停止调度，UI 明确区分。

### 3.7 输出与通知层

- 应用内事件 UI只渲染结构化字段和安全文本，不用 `dangerouslySetInnerHTML`。
- Windows Sink 必须通过 production identity probe；失败仅应用内，不伪称成功。
- Windows 默认不显示 Evidence；Session 固定通用内容；详情逐 Rule opt-in，仍脱敏。
- 通知点击只携带内部 UUID，经 WatchService 查询；敌手 URL/标题不能控制内部路由。
- CSV 公式注入防护；Markdown raw HTML 关闭、URL http/https、过期/删除 Evidence 诚实标记。

### 3.8 日志与审计层

- Watch 运行只记 ID、状态、host 脱敏、耗时、字节、分类；零正文/Evidence/prompt/response/Key。
- 单行8KiB、文件10MiB、最多10份/14天；删除只匹配受控日志文件名。
- 每个网络运行、Baseline 建立/重建、暂停、授权、Event、Digest、Notification、导出和删除恰有受控审计。
- 审计 reason 是闭合码，不回显 XML/HTML/模型敌手文本。

## 4. Prompt Injection 防线

```text
编译期 SYSTEM_DIGEST_PROMPT
  + 程序生成 DIGEST_FACTS（可信结构，不含敌手自由指令）
  + UNTRUSTED_WATCH_EVIDENCE（按 sharing 投影、有界）
  → LLMProvider（零工具）
  → 不可信 ExplanationDraft
  → DigestValidator（eventIds/白名单/长度/分享可见性）
  → 程序 DigestFacts + 可选 explanation
```

模型即使服从 feed 中“忽略规则/访问 URL/发送数据”的文字，也没有相应能力。若输出新增事件、未知引用、
blocked 引用或额外字段，整份 explanation 丢弃，确定性 Digest 仍成功。

**诚实限制**：验证器能证明引用与结构，不能证明自然语言解释完全没有误导、遗漏或偏见；UI 必须把 AI
解释标记为“基于以下变化的可选解释”，并保留 Evidence 下钻。

## 5. 跨重启与跨库安全

| 崩溃点                       | 恢复动作                                     | 网络安全性质               |
| ---------------------------- | -------------------------------------------- | -------------------------- |
| hard-delete prepare 前       | Source 未删，Watch 原状态                    | 无变化                     |
| intent 写入后、Source 删除前 | Rule 已暂停；reconcile 可 abort              | 零新请求                   |
| Source 删除后、Watch 清理前  | Source revalidation 失败；reconcile 级联     | 零孤儿请求                 |
| Event 事务中                 | SQLite 原子回滚或完整提交                    | 不出现半 Event/半 Baseline |
| reservation 提交前           | Run/消费记录/nextDue 三者全无                | 下次只补未消费 due         |
| reservation 提交后/HTTP 前   | queued→interrupted；slot 不重放              | 不重复相同 requestKey      |
| HTTP 后、结果事务前          | result 仅内存；run→interrupted；slot 不重放  | 不落半数据、不重复该 slot  |
| Session task Tab create 中   | 启动 drain 等落定后精确清理；崩溃由进程销毁  | 用户 Tab 零 close/navigate |
| Session snapshot 后/close 前 | 结果未提交；finally/cleanupAll 只关 owned id | 旧 tabId 零持久化/重用     |
| Provider explanation 中      | Digest facts 可重建；解释丢弃                | Event 不受影响             |
| Notification 发送后、ack 前  | dedupe outbox 可能保守不重发或标 uncertain   | 不重复创建 Event           |

不把“最终一定只通知一次”作为分布式 exactly-once 承诺；结构保证 Event exactly-once，通知采用幂等键和
at-most-once 优先的本地策略，崩溃窗口 UI 如实显示 delivery unknown。

## 6. 红队矩阵（WRT-01～WRT-19）

| ID     | 敌手场景                                                                    | 必须机器证明的 oracle                                                     | 任务      |
| ------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------- |
| WRT-01 | localhost/127/::1/私网/link-local/组播/保留 URL                             | 零 socket、security_rejected、零正文日志                                  | D3/D10    |
| WRT-02 | DNS 公私混合/连接时换绑                                                     | 整次拒绝；连接 lookup 只返回已批地址                                      | D3/D10    |
| WRT-03 | 非80/443、redirect 到私网/file/javascript/HTTPS→HTTP                        | 每跳拒绝、零后续请求                                                      | D3/D10    |
| WRT-04 | 慢流/巨型/压缩炸弹/redirect loop                                            | deadline/字节/跳数内受控失败，进程存活                                    | D3/D10    |
| WRT-05 | robots disallow/429/captcha/同 host 突发请求                                | 暂停或退避；所有请求起点≥5秒；零 override/绕过/重试风暴                   | D3/D5/D10 |
| WRT-06 | XXE/外部 DTD/XInclude/Billion Laughs                                        | 零文件/网络，预算内失败，后续正常 feed 可解析                             | D3/D10    |
| WRT-07 | XML depth/name/attr/text/node/total/projection 各边界与畸形编码/CDATA       | 每项 `==` 接受、`+1` fail-closed，零未捕获异常/正文日志                   | D3/D10    |
| WRT-08 | 重复/冲突 GUID、字段超长、feed 重排                                         | 去重稳定、顺序噪声零事件、预算有效                                        | D3/D7     |
| WRT-09 | 未授权 Session/grant 重放/跨 origin/敌手 create 返回用户 tabId              | 零导航/创建或零关闭用户 Tab；Cookie/handle/task tabId 零持久化            | D6/D10    |
| WRT-10 | 原授权 Tab 已关/重启 catch-up/用户关 task Tab/登录跳转/captcha/cleanup 失败 | 新建 owned Tab 或受控失败；不建 Event/覆盖 Baseline；用户 Tab/焦点 oracle | D6/D7/D10 |
| WRT-11 | DOM 噪声/table 歧义/跨域 iframe                                             | 零假 Event；parse_changed/诚实限制                                        | D6/D7     |
| WRT-12 | Hash 变但 Diff 无 Evidence                                                  | unexplainable_change、零 Event/推进                                       | D7        |
| WRT-13 | feed/page 注入模型指令/未知 eventId                                         | 零工具；ExplanationDraft 拒绝；facts 保留                                 | D8/D10    |
| WRT-14 | metadata/blocked Source 混入 prompt                                         | 字节扫描零 Evidence/零 blocked 内容                                       | D8/D10    |
| WRT-15 | 通知标题伪造 URL/query/锁屏敏感摘录                                         | 安全 DTO、内部 UUID 路由、默认隐藏                                        | D9/D10    |
| WRT-16 | 时钟回拨/DST/离线一万次 missed/reservation 各崩溃与终态                     | 三写原子；每规则最多一次 catch-up；已消费 slot 零重放                     | D5/D10    |
| WRT-17 | Source disable→restore 版本递增、metadata/locator 变化、hard-delete 崩溃点  | 意图/identity 正确；orphan 零网络；最终级联；不可 Undo                    | D4/D10    |
| WRT-18 | DB/log/event/digest 预算压力与 corrupt/future schema                        | 有界清理或 unavailable，Scheduler 不启动                                  | D1/D4/D10 |
| WRT-19 | 公开 HTML 含 script/iframe/私网子资源、畸形/巨深/巨节点或共享 Cookie canary | 零执行/子请求/Cookie，预算内 DocumentChannels 或受控失败                  | D3/D6/D10 |

每项必须独立结果，不能用一条泛化日志字符串冒充。敌手正文随机 canary 逐字节扫描：日志、audit、
ConversationStore、sources.db、research.db、watch.db 非 Evidence 列、renderer DOM、通知 DTO、导出、Provider
request。Evidence 允许面只包含已验证且在分享/保留边界内的有界投影。

## 7. 结构性证明 / 真实观察 / 诚实限制

### 7.1 结构性证明

- 工具/IPC/SQL/网络端口闭合；Scheduler 零能力；模型零工具；
- 地址/redirect/XML/预算/状态机/Condition/Event/Digest validator 的纯函数 oracle；
- 原子 Event+Evidence+Baseline、CAS、外键、清理和生命周期协议；
- 分享三档与通知隐私投影的字节扫描；
- timer/request/DB/listener 幂等清理。

### 7.2 必须真实观察

- 少量真实 RSS/Atom 兼容性与网站变更；
- Electron Session 页面在常见登录网站的实际可读性；
- Windows 已打包身份下通知是否出现/点击是否正确；
- 真实 Provider 对 hostile Evidence 的解释表现；
- 应用长时运行的 CPU/内存/电池趋势。

真实观察失败不得通过放宽确定性契约伪造 PASS；应记录站点/平台限制、修复夹具或 REPLAN。

### 7.3 诚实限制

- robots 不是法律/ToS 授权；严格遵守也不保证网站允许自动访问；
- 主文档 PageSnapshot 不覆盖跨域 iframe；区域定位不能保证网站长期稳定；
- challenge/login 分类可能保守误判；安全拒绝优先于覆盖率；
- 模型解释可能语义遗漏或偏差；Evidence/事实层不因此变真；
- watch.db 和备份 v1 本地明文；
- v1 退出应用后不监控，Windows 系统通知可能因打包身份不可用；
- 跨两个 SQLite 文件没有原子事务，使用 durable intent + revalidation 达成 fail-closed，而非假称原子。

## 8. 与既有安全边界兼容

- 远程 WebContents 保持 `nodeIntegration=false/contextIsolation=true/sandbox=true/webSecurity=true`；
- 不给 Tab 加应用 preload，不放宽导航/权限/window.open；
- BrowserController 仍是浏览器入口，PageSnapshot 既有主文档边界不扩大；
- SourceService 仍是 Source 语义入口；Watch 不能执行 Source SQL；
- Research 六工具/17 工具/AgentLoop/Provider Key/Result Renderer 均不改变；
- API Key 不进入 watch.db、feed、PageProjection、Event、Digest facts、通知、日志、DOM 或导出；
- `node:sqlite`、prepared SQL、safeStorage/DPAPI 等既有永久红线保持。

## 9. 外部安全依据（核验于 2026-08-23）

- XML / DTD：<https://www.w3.org/TR/xml/>
- OWASP XXE：<https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html>
- Fetch redirect：<https://fetch.spec.whatwg.org/>
- IPv4 private：<https://www.rfc-editor.org/rfc/rfc1918/>
- IPv6 local：<https://www.rfc-editor.org/rfc/rfc4193/>
- Robots：<https://www.rfc-editor.org/rfc/rfc9309.html>
- Electron Session：<https://www.electronjs.org/docs/latest/api/session>
- Electron Notification：<https://www.electronjs.org/docs/latest/tutorial/notifications>
- 候选 XML parser：<https://github.com/federicocarboni/saxe>
- 候选 HTML SAX parser：<https://github.com/inikulin/parse5>
- 被否决归档候选：<https://github.com/lddubeau/saxes>
- 活跃替代包安全历史：<https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories>
