# AIbrowse 第六阶段 Proposal — RSS、网页 Diff、Watch 与持续信息更新

- **状态**：正式设计候选（2026-08-23）；零产品代码、零依赖安装。
- **上位需求**：`Sixth_stage.md`。
- **唯一产品契约源**：设计通过后以 `doc/stage6/detailed-design.md` 为准。
- **安全契约源**：`doc/stage6/threat-model.md`，必须先于任何第六阶段产品实现定稿。
- **设计基线**：`a5361ecacd917c33db4a4b043fdbfbf270292134`。

## 1. 目标

把 Sources 从静态收藏升级为本地、有界、可解释的持续信息网络：

1. 发现、校验并读取公开 RSS 2.0 / Atom feed；
2. 对无可用 feed 的页面建立用户确认的区域投影并做确定性 Diff；
3. 以应用内调度运行明确 WatchRule，失败、无变化和真实变化严格区分；
4. 每个正式变化事件持久化可解释的 old/new Evidence，而不是只有哈希；
5. 用确定性结构化条件决定是否触发事件/通知；
6. 把多个变化组织成有证据的 Digest，AI 只能做可选解释；
7. 提供 Watch 工作区、应用内通知，以及经过打包身份验证后才启用的 Windows 通知；
8. 对网络、XML、调度、持久化、日志、模型和通知设置可机器验证的安全与资源上限。

## 2. 非目标

- 应用进程退出后的后台调度、Windows Task Scheduler、独立服务或云端 24/7 crawler；
- 秒级监控、大规模商业爬取、分布式调度、绕 captcha/challenge/反爬；
- 自动复用登录 Session、自动从 feed 失败回退浏览器或自动迁移变化基线；
- 动态 Group Watch：分组变化不能静默扩大后台网络访问范围；
- AI-evaluated rule、自然语言规则、正则表达式、脚本或任意表达式树；
- 由模型决定字符串是否相等、事件是否存在、证据真实性或通知事实；
- 原始 HTML、完整响应、整页正文、无界 Diff 历史、模型 transcript 或思维过程落盘；
- Watch 数据进入 `sources.db`、`research.db` 或 ConversationStore；
- 内网/localhost/link-local Watch、危险 scheme、任意重定向或通用 HTTP 工具；
- Seventh Stage 的产品化、云同步、多用户或跨设备能力。

## 3. 用户与场景

### 3.1 Feed 优先

用户从 Source 详情或公开页面发现 feed，预览最终 URL、类型、标题和健康检查后创建规则。系统优先使用发布者提供的 RSS/Atom，不因解析失败静默改读网页。

### 3.2 页面区域 Watch

用户在浏览器页选择一个或多个命名区域，预览规范化投影后建立基线。区域失效进入 `parse_changed`，旧基线保留，用户确认后才能重新建立。

### 3.3 登录态页面

用户逐规则明确授权共享 Chromium Session 读取受保护页面。授权仅用于该页面 Watch；Cookie、表单值和凭据不会进入 Watch 数据、日志、通知或模型。

### 3.4 条件变化

用户从 Evidence 字段选择文本或数值条件，例如价格下穿阈值、排名进入前三、新增 release。条件只引用已验证投影字段，由确定性程序求值。

### 3.5 Digest 与通知

用户创建明确的 Digest Schedule，选择固定 Source 集合或创建时冻结的 Group 成员集合。仅有新事件时生成 Digest；AI 解释按计划显式启用且失败时降级为确定性摘要。

## 4. 输入 / 输出

| 边界             | 输入                                                    | 输出                                        |
| ---------------- | ------------------------------------------------------- | ------------------------------------------- |
| Feed discovery   | 已验证公开 http/https 页面 URL                          | 有界 feed 候选及验证结果                    |
| Feed acquisition | 明确公开 feed URL、条件请求元数据                       | 有界字节流、最终 URL、HTTP 元数据、获取时间 |
| Page acquisition | WatchRule、用户确认 RegionDescriptor、可选 Session 授权 | 主进程盖章的有界 PageProjection             |
| Diff             | last-known-good Baseline + 新 Projection                | `unchanged` 或类型化 ChangeSet              |
| Condition        | ChangeSet + 闭合 Condition                              | 确定性 match/no-match                       |
| Event            | 验证后的 ChangeSet                                      | 不可变 Event + old/new Evidence             |
| Digest           | 明确事件集合与分享投影                                  | 确定性 Digest + 可选已验证 AI 解释          |
| Notification     | Event/Digest 的安全通知投影                             | 应用内通知；条件式 Windows 通知             |

## 5. 外部依赖与平台能力

1. **XML 候选依赖**：暂定精确版本 `@federicocarboni/saxe@0.8.0`，本设计任务不安装。D3 必须先完成许可证、供应链、Node 24/Electron 构建、真实 feed 兼容和敌手语料资格门；失败即 REPLAN，禁止静默换库。
2. **HTML 候选依赖**：公开页面暂定精确版本 `parse5-sax-parser@8.0.0` + `parse5@8.0.1`，同样先经 D3 资格门。只使用流式解析事件生成有界 DocumentChannels，不执行 JavaScript、不加载子资源、不构建持久 DOM；失败即 REPLAN。
3. **网络**：使用 Node 核心 `http`/`https`/`dns` 实现项目自有 `PublicWatchHttpClient`。对外是有界 fetch 语义；不用厂商 SDK。采用连接时受控 `lookup`，以满足 DNS/重定向逐跳校验，不能只做 fetch 前预解析。
4. **登录页面**：继续通过 BrowserController 及 `persist:aibrowse` Chromium Session，不增加 Cookie 读取 IPC。需要 JavaScript 渲染的公开页面必须由用户显式切换到 Session 模式，不自动回退。
5. **SQLite**：继续使用 `node:sqlite`，新增独立 `watch.db`。
6. **Windows 通知**：只有打包环境证明 AppUserModelID/Start Menu 身份有效时启用；否则应用内通知是完整降级。
7. **模型**：复用现有 LLMProvider；无 Key、分享受限、预算超限或失败时保留确定性 Digest。

外部事实核验日期为 2026-08-23：

- RSS 2.0：<https://www.rssboard.org/rss-specification>
- Atom：<https://www.rfc-editor.org/rfc/rfc4287>
- XML / XXE：<https://www.w3.org/TR/xml/>、<https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html>
- WHATWG HTML / parse5：<https://html.spec.whatwg.org/>、<https://github.com/inikulin/parse5>
- Robots：<https://www.rfc-editor.org/rfc/rfc9309.html>
- Electron 生命周期/通知：<https://www.electronjs.org/docs/latest/api/app>、<https://www.electronjs.org/docs/latest/tutorial/notifications>
- Windows 后台边界：<https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/applifecycle/background-tasks>

## 6. 约束与假设

- v1 仅在 AIbrowse 应用进程运行时调度；关闭最后窗口即停止。
- 调度支持固定间隔预设和每日本地时间，不开放 cron；错过执行最多合并补跑一次。
- 公开网络只允许 http/https 公网地址且端口闭合为 HTTP 80/HTTPS 443；拒绝 userinfo、localhost、私网、link-local、保留/组播地址，并对连接地址和每跳重定向复验。
- 公开页面严格遵守 robots，不提供覆盖；登录态页面不以 robots 代替用户授权，但仍限速。
- captcha/challenge/login_required 停止或暂停，不做绕过。
- Diff equality、条件、事件键、Evidence、Digest 事件集合、通知事实均由程序决定。
- `shareMode` 只控制模型分享：full 可给模型有界 Evidence，metadata 仅元数据/计数，blocked 零 Watch 内容进模型。
- 静音只抑制即时通知；暂停才停止网络。
- 所有时间逻辑使用可注入 Clock；所有预算为编译期常量。
- 业务 SQL 只在 Repository/migration，所有不可信文本参数绑定。
- 远程 feed、页面、Projection、Diff、Source note 和模型输出均不可信。

## 7. Entry Gate 核验表

| 要求                           | 事实证据                                                                                      | 结论                    | 缺口                                                                   | 处理阶段                      |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------- | ----------------------------- |
| Sources 数据结构稳定           | `sources.db` v1、UUID/version、启停/软删/硬删/恢复、备份恢复及 SourceService 已通过 Fifth C10 | PASS                    | Watch 关联与跨库清理尚无实现                                           | D4                            |
| Research 可可靠读取和归纳来源  | 独立 ResearchRuntime、Capture/Evidence/Result 验证、C10 真实 Provider/真实主题证据            | PASS                    | Digest 不得复用 Research 持久化或运行时                                | D8                            |
| Evidence 有可信获取时间        | BrowserController 主进程盖章 `capturedAt/documentId`，Research `fetchedAt` 程序生成           | PASS                    | Watch Evidence 类型尚无实现                                            | D7                            |
| 浏览器读取失败闭合分类         | 既有六类读取失败 fail-closed                                                                  | PASS WITH GAP           | Watch 需 login_required/captcha/parse_changed/robots/security 等健康态 | D2/D5/D6                      |
| 持久化、日志、隐私可承载 Watch | SQLite 与脱敏基础稳定                                                                         | HOLD FOR IMPLEMENTATION | 日志无保留/大小上限；Watch 无独立存储和预算                            | D1/D4；完成前禁止周期实现上线 |
| Fifth 遗留风险已重分级         | Phase A 独立代码/文档/机器验证                                                                | PASS                    | 见 §8                                                                  | 对应任务吸收或延期            |
| Stage 5 结论仍适用             | 当前产品代码仍为已审计 HEAD，设计基线全量 test/typecheck/lint/format/build 通过               | PASS                    | 本轮未重跑高成本 Electron/真实 Provider，零产品改动所以 N/A            | D10/D11 重跑第六阶段矩阵      |

**入口结论**：允许第六阶段正式设计；产品实现须从 D1 开始，且 D1 日志硬化与 D3 XML 资格门未通过前不得启用周期网络路径。

## 8. 遗留风险重新分级

### 8.1 阻塞第六阶段实现

- 日志无大小/保留/单行预算；由 D1 首先修复。
- SSRF、DNS rebinding、重定向和危险 scheme；由 D3 定稿并红队。
- XML 依赖资格与 DTD/entity 资源耗尽；由 D3 通过前零 feed 产品接线。
- `watch.db`、Evidence 保留预算和 Source 生命周期一致性；Source 行 version 与 locator fingerprint 分离，跨库 prepare/commit/abort 由 D4 落地。
- 应用退出行为、错过执行、Run reservation 与计划推进原子性、5秒同主机请求间隔；契约已冻结，由 D5 实现。

### 8.2 第六阶段必须吸收

- Watch 数据 UTF-8 字节预算、分级保留、全库清理和本地明文披露；
- login_required/captcha/parse_changed/unavailable 等健康状态；
- PageSnapshot 主文档与跨域 iframe 降级的诚实 UI；
- Digest Prompt Injection：程序事实、分享投影、引用完整性和确定性降级；
- Watch 独立 dev/production/跨进程门控与隐私扫描；
- 打包身份未验证时 Windows 通知 fail-closed 为应用内通知。

### 8.3 可延期至 Seventh Stage

- ConversationStore 字节上限（Watch/Digest 禁止写入）；
- Vitest 默认 worker 固化（任务命令继续显式 `--maxWorkers=1`）；
- 既有全冒烟耗时优化和通用 CI；
- Watch 数据静态加密、密钥轮换、跨域 iframe 深度采集；
- 系统级后台服务、完整后台安装器和云端调度；
- AI-evaluated rule 与语义层完全冲突/遗漏检测。

## 9. 用户裁决表（U01–U31，2026-08-23）

| 决议 | 冻结选择                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------ |
| U01  | 仅应用进程运行时调度                                                                                   |
| U02  | 公开请求与逐规则授权的登录态页面双模式；不自动回退                                                     |
| U03  | 仅公网 http/https，逐 DNS/重定向复验                                                                   |
| U04  | 允许经资格门的 XML 依赖                                                                                |
| U05  | 独立 `watch.db`                                                                                        |
| U06  | 最小投影但正式事件必须保留可解释 old/new Evidence；哈希不能单独成证                                    |
| U07  | 固定间隔预设 + 每日本地时间；不支持 cron                                                               |
| U08  | missed run 合并补跑一次，退避/Retry-After/主机抖动                                                     |
| U09  | 用户选择命名区域；整主文档也必须显式选择                                                               |
| U10  | Feed/Page 类型专属确定性 Diff；AI 不决定 equality                                                      |
| U11  | 稳定指纹去重与有界合并；反转为新事件                                                                   |
| U12  | 程序事实 + 可选 AI Digest 解释，失败确定性降级                                                         |
| U13  | 公开页面严格 robots；登录态页面仍限速                                                                  |
| U14  | 失败保留旧基线；关键健康态暂停并由用户确认 rebaseline                                                  |
| U15  | Source 启停/删除联动；URL 更新暂停且不迁移基线                                                         |
| U16  | 公开 90 天/200 事件，登录态 30 天/100 事件，全库 100 MiB                                               |
| U17  | 应用内通知必达；Windows 通知以打包身份验证为条件                                                       |
| U18  | 通知默认隐私安全；逐规则显式允许详情                                                                   |
| U19  | Rule 绑定明确 Source/URL；Group 只筛选、展示和 Digest 聚合                                             |
| U20  | 顶层 Watch 工作区 + Sources/浏览器快捷创建入口                                                         |
| U21  | baseline audit 可见但不是变化事件/通知/Digest                                                          |
| U22  | 手动运行不改变计划且无安全旁路                                                                         |
| U23  | 事件只读/未读 + 永久删除；事实不可编辑                                                                 |
| U24  | 明确 Digest Schedule；有新事件才生成；AI 逐计划显式启用                                                |
| U25  | 当前事件表 CSV + 单 Digest 安全 Markdown 导出                                                          |
| U26  | 保守固定规则、并发、响应、队列和 Digest 预算                                                           |
| U27  | 暂定 `@federicocarboni/saxe@0.8.0`，先资格门，失败 REPLAN                                              |
| U28  | v1 仅确定性结构化条件；零 AI rule/regex/script                                                         |
| U29  | sharing mode 控制模型投影，不控制本地 Watch 网络                                                       |
| U30  | muted 只抑制即时通知；paused 才停止调度                                                                |
| U31  | 公开页面用 Node 核心 HTTP + 资格化 parse5 SAX 流式解析；零脚本/子资源；不改 BrowserController 公共边界 |

## 10. `Sixth_stage.md` §9 验收映射

| 上位验收                        | 设计落点        | 实现任务 | 客观证据                                       |
| ------------------------------- | --------------- | -------- | ---------------------------------------------- |
| RSS/Atom 发现、添加、读取       | detailed §6     | D3       | 规范语料 + 真实公开 feed 冒烟                  |
| feed 去重和 health              | detailed §7/§9  | D3/D7    | GUID/link fallback、重复/错误矩阵              |
| 无 RSS 页面定期检查             | detailed §4/§8  | D5/D6    | 区域投影 + 可控 clock/恢复测试                 |
| Diff 识别真实变化               | detailed §8/§9  | D6/D7    | normalization/equality/old-new Evidence oracle |
| 失败不制造假变化                | detailed §7/§9  | D3/D6/D7 | 失败保持 last-known-good baseline              |
| 至少一类结构化条件              | detailed §5     | D2       | 文本/数值/事件条件矩阵                         |
| 规则触发有 Evidence             | detailed §9     | D7       | EventValidator 要求双侧 Evidence               |
| 按分组 Digest                   | detailed §11    | D8       | 创建时冻结成员 + 独立游标                      |
| changed/unchanged/failed 可区分 | detailed §7/§11 | D5/D8    | RunOutcome + Digest 状态/计数                  |
| 并发/频率/退避                  | detailed §4/§10 | D5       | 假时钟、主机队列、Retry-After                  |
| scheduler/diff/feed 全测        | detailed §15    | D10/D11  | 全量单测、冒烟、红队与独立 Auditor             |
| 重启和真实网络冒烟              | detailed §15    | D10/D11  | 临时 userData 跨进程 gate + 受控公网场景       |

## 11. 里程碑与任务

| 任务 | 闭环                                                                        |
| ---- | --------------------------------------------------------------------------- |
| D1   | 长期运行前置：日志大小/保留/单行预算与可控 Clock 基座                       |
| D2   | Watch 域类型、预算、状态机与确定性条件引擎                                  |
| D3   | XML/HTML 依赖资格门、公开网络策略、Feed discovery/parser 与公开页面流式通道 |
| D4   | `watch.db`、Repository、恢复、保留清理与 Source 生命周期协调                |
| D5   | Scheduler、运行协调、错过补跑、退避与资源控制                               |
| D6   | 页面区域选择、登录授权和有界 PageProjection                                 |
| D7   | 确定性 Diff、Baseline、Event/Evidence、health 与去重                        |
| D8   | Digest、shareMode 投影、可选 AI 解释与确定性降级                            |
| D9   | Watch UI、IPC/bridge、通知隐私和安全导出                                    |
| D10  | 端到端、红队、跨进程、真实网络/Provider 与打包通知资格矩阵                  |
| D11  | 新独立 Stage Auditor、Exit Gate 判定与文档闭环                              |

## 12. 待定问题

产品级待定问题：**无**。U27/U31 的 XML/HTML 依赖资格是已冻结的工程 Gate，不授权自动选择替代库；任一资格失败必须回到 Planner/用户重新裁决。
