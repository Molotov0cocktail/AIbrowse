# AIbrowse — AI 信息浏览器

> 当前阶段（第四阶段）：**Sources 长期信源系统**——SQLite 持久化与 migration/
> recovery、Source（origin/page 双作用域）/Group/Tag/备注/优先级/启用状态/
> provenance（信任与来源）、用户手工管理与当前网页快速收藏、AI 自然语言添加/修改/
> 整理/禁用/恢复（结构化 change set + L2 确认 + 单事务 + durable Undo）、有界
> Source Retrieval（FTS5 trigram 多语言 + 分享模式 full/metadata/blocked）、
> Browser Agent 复用既有 browser_open/browser_read 打开读取检索结果。
> **阶段状态（2026-08-15）：B1 完成（node:sqlite 决策门实测通过并冻结）、
> B2 已完成（Source 域模型 + Repository + SourceService + journal + Undo）、
> B3 已完成（多语言 Source Search + 有界 Retrieval + 分享模式）、
> B4 已完成（Source Tools 四工具 + 权限矩阵 + L2 change set 确认/审计 +
> Agent 上下文隔离）、B5 已完成（Sources UI + 手工管理 + 当前页快速添加 +
> IPC/bridge）、B6 已完成（AI 自然语言管理端到端 + Browser Agent 复用 +
> usage 接线）**——Fourth Stage 已正式进入（用户切换指令）；详细设计与
> B1–B9 任务拆分已完成；**B1：node:sqlite 在 Electron 43.4.0 dev+生产构建
> 11 项逐项实测通过（基础能力项全过 + FTS5/trigram 可用），驱动冻结决议 #48 +
> sqlite-driver/migrations 基座落地；B2：九项契约缺口实施前裁决（决议
> #49–#57）+ schema v1（Sources/Groups/Tags/links/change journal/usage/FTS5）+
> canonicalization + Repository（唯一 SQL 执行点）+ SourceService + durable
> Undo 已落地（全量 test 947/947，B-02 双进程冒烟通过）；**B3：六项契约裁决
> （决议 #58–#63）+ 多语言检索（FTS5/trigram 主路径 + 短查询安全降级）+ 有界
> Retrieval（硬上限 10/每页 20）+ 分享模式（audience 必填）+ 确定性排序 +
> note 摘录 ≤200 + rebuild 一致性已落地（全量 test 1007/1007，B-04 B3 子集
> dev+生产双场景冒烟通过）；**B4：实施前裁决（决议 #64–#67：结构化递归
> schema/expectedVersion 并发令牌/previewChangeSet 只读预览 + 确认摘要钩子 +
> TOCTOU 版本复验 + blocked 猜测防护/审计隐私收紧）+ Source 四工具注册
> （13 → 17 工具，L0×3 + L2×1，audience 硬编码 agent）+ change set 确认全链路
>
> - 审计脱敏 + UNTRUSTED_TOOL_RESULT 块隔离已落地（全量 test 1071/1071，
>   B-03/B-04 冒烟 dev+生产双场景通过）；**B5 已落地（决议 #68–#78 + Sources
>   面板 + 14 通道 + source-ipc 适配器 + 8.11 默认矩阵 + AIBROWSE_SOURCES_UI_SMOKE
>   set|check 双进程门控，全量 test 1125/1125）——Sources 功能对用户已可用**；
>   **B6 已落地（决议 #79–#85 + usage-tracker + 序列化 allowlist 补齐 +
>   冒烟 8.12/8.13，全量 test 1160/1160）——usage 接线闭环**；
>   **B7 已落地（决议 #86–#91 + `db/backup.ts` 存储运维 + `sources-store.ts`
>   启动装配 + 只读恢复态 + FTS rebuild 诊断 + usage 双投影与「上次使用结果」
>   展示，冒烟 8.14 B-06 B7 部分 + B-02 usage 跨进程扩展；2026-08-15 事故
>   恢复与安全加固后全量 test **1219/1219**）——存储运维面闭环**；
>   **独立审计 + B7 审计后定向修复已完成（2026-08-15，HOLD 解除）**——审计
>   发现备份发布/失败清理 P2 竞态已修复（决议 #92：两阶段 staging + 硬链接
>   no-clobber 原子发布 + 所有权证明精确清理 + 任意路径公共导出移除），红→绿
>   5 failed/32 passed → 37/37，全量 test **1226/1226**，dev/生产冒烟与 B-02
>   双进程退出码 0**；
>   下一个推荐动作 = **B8 红队矩阵 SRT-01～SRT-12**（独立审计唯一 HOLD 已
>   解除；审计其余发现 P2-2/P2-3/P2-4/P3 登记于 progress.md 开放风险）。
>   契约源
>   `doc/stage4/detailed-design.md`；安全契约源
>   `doc/stage4/threat-model.md`（ST-01～ST-12 / SRT-01～SRT-12，先于任何
>   Source 实现定稿）；需求源 `Fourth_stage.md`；任务 `doc/stage4/tasks/B1–B9`。
>   历史阶段（已完成）：第三阶段 Browser Agent 契约源 `doc/stage3/detailed-design.md`；
>   安全契约源 `doc/stage3/threat-model.md`（Prompt Injection 威胁模型已重建定稿，
>   先于任何 Browser Tool 实现）。
>   **A1 tool-calling 兼容层、A2 Tool Registry/权限分级与确认状态机/审计日志、
>   A3 浏览器交互能力（find/scroll/click/fill + elementId 文档世代绑定）、
>   A4 SearchProvider 与 search_web、A5 Agent Runtime、A6 操作可见性 UI 与通道、
>   A7 红队矩阵与安全审计（RT-01～RT-08 + RT-11 + RT-10 真实模型证据）、
>   A8 收尾验收已实施（2026-08-14）；**第三阶段总 Exit 决策 = GO/PASS**——
>   完整真实 Provider 验收通过（deepseek-v4-pro，§7 场景 1–6 全部真实完成，
>   LIVE_SMOKE_PASS 退出码 0；此前首轮 400 根因 = wire 名称契约，修复见决议
>   #35）+ 定向补验通过（场景 2 三类工具真实调用链 + 场景 3 两个不同 origin
>   公开来源，12 次 HTTP 全部 200）**
>   （任务编号 2026-08-14 实施前校正：T1–T8 改为 A1–A8 避免与第一阶段任务
>   T1–T5 重名、红队编号改 RT-01～RT-11、权限契约收紧为 click 确定性允许列表，
>   见 `doc/stage3/proposal.md` §11）。
>   核心原则：AI 决定「需要做什么」；确定性程序决定「是否允许、如何执行、执行结果是什么」。
>   需求源：`Fourth_stage.md`（当前）；开发手册：`AGENTS.md`；进度：`doc/tasks/progress.md`。

## 当前状态（2026-08-15）

- 🔨 **第四阶段（Sources）进行中（2026-08-15，用户切换指令）：设计完成、
  B1 已完成、B2 已完成、B3 已完成、B4 已完成、B5 已完成、B6 已完成、B7 已完成**——设计闭环（proposal/高层设计/详细设计/
  威胁模型/B1–B9 任务拆分）后，**B1 node:sqlite 决策门已实测通过并冻结**：
  Electron 43.4.0 dev+生产构建 11 项逐项实测（import/文件库/prepared
  statements/事务/外键/busy timeout/FTS5/trigram/userData 路径/句柄清理）
  基础能力项全过、FTS5 与 trigram 均可用（中文 ≥3 字符子串命中；1–2 字符查询
  不命中为 trigram 语义，B3 短查询降级路径依据）；驱动冻结决议 #48 +
  `src/main/sources/db/` 基座（sqlite-driver 薄封装 + migrations 骨架）+ 冒烟
  B-01（自动包含于默认 AIBROWSE_SMOKE=1 矩阵）；**B2 已落地**：九项契约缺口
  实施前用户裁决（决议 #49–#57）+ schema v1 + Source 域模型 + canonicalization
  - Repository（唯一 SQL 执行点，唯一约束兜底）+ SourceService（UI 与 Agent
    共用唯一入口）+ change journal（100 条/30 天有界）+ durable Undo（重启后
    可用、版本冲突拒绝、消费幂等）+ hard delete 私人 payload 清理 + 冒烟 B-02
    （`AIBROWSE_SOURCES_SMOKE=set|check` 双进程跨进程读回与 Undo，生产退出码 0）；
    **B3 已落地**：六项契约裁决（决议 #58–#63：audience 必填 user|agent /
    SourceSearchItem 独立类型 / 1 精确·2 精确+前缀+子串·≥3 FTS·URL 判定集合 /
    档位不可跨档全序 / FTS 不可用仅指建库后 MATCH/构造失败 / B-04 分段记录）+
    source-search-query 纯函数（归一化/分流/FTS 短语构造/档位/排序/note 摘录）+
    source-search-index（四条编译期候选 SQL + 参数绑定 + 有界 200 + rebuild/
    一致性探针）+ SourceService.search/list/get 完整实现（硬上限 10/每页 20/
    分享模式矩阵/note ≤200 + provenance/bidi 补齐 U+061C/U+2066–U+2069）+
    冒烟 8.9 B-04 B3 子集（默认矩阵 dev+生产双场景真实 node:sqlite）；
    **B4 已落地（2026-08-15）**：实施前契约裁决（决议 #64–#67：ProviderToolParameter
    最小递归 object/array schema（数组上限 20/未知字段拒绝/深度有界，既有 13 工具零
    回归）/source_get allowlist 返回 expectedVersion 并发令牌（search/list 恒不返回，
    决议 #38 校准）/previewChangeSet 只读预览 + buildChangeDiff 纯函数（≤2000 中文
    diff，零 journal 零幂等键）+ ToolDefinition.confirmSummary 钩子（ToolExecutor 在
    requestConfirm 前调用）+ 批准后版本复验（TOCTOU 关闭）+ blocked 猜测引用
    source-forbidden 零泄漏/审计隐私收紧（note 正文零出现、URL query 值脱敏））+
    source-tools.ts 四工具（search/list/get L0 + apply_changes L2，audience 硬编码
    agent，executor 零 Electron import）+ 权限矩阵 17 工具 + ToolResult 预算 4000 +
    UNTRUSTED_TOOL_RESULT 块隔离 + 冒烟 8.10 B-03/B-04（默认矩阵 dev+生产双场景；
    注册表 17 工具断言校准）+ 主进程 <userData>/sources/sources.db 装配（初始化失败
    Source 工具安全返回 source-unavailable）。
    **B5 已落地（2026-08-15）**：实施前契约裁决（决议 #68–#78：面板互斥切换
    sidePanel 'ai'|'sources' 不遮断 App 级确认框 / sources:* 14 通道白名单 +
    audience 硬编码 user / 有界 listGroups / quick-add 主进程读活动 Tab / 两阶段
    永久删除 / 三态 UI 状态中文诊断 / provenance 两形态 + aiNote 只读 / 独立
    manual 审计 / UI 异步序号守卫与冲突刷新 / 纯文本渲染）+
    `src/renderer/src/ai/sources/` 面板（分组浏览/搜索/详情编辑/手工添加/快速
    添加/禁用恢复/手工 Undo/永久删除二次确认/恢复态诊断/明文边界说明）+
    `src/main/sources/source-ipc.ts` 适配器（零 Electron import）+ preload
    bridge 白名单 + 冒烟 8.11 B-05 默认矩阵（dev+生产双场景退出码 0）+
    `AIBROWSE_SOURCES_UI_SMOKE=set|check` 双进程门控（退出码 0）；
    **B6 已落地（2026-08-15）**：实施前契约裁决（决议 #79–#85：usage 接线归属
    B6 / 序列化 allowlist 引用链路缺口 / ToolExecutionContext 最小 usage 桥 /
    provenance 表述校准 / description 校准 / B-07 冒烟探针 /
    AIBROWSE_LIVE_AGENT_SOURCES 互斥门控与离线可测路由）+
    `src/main/sources/usage/usage-tracker.ts`（SourceSearchHintStore 每 run
    独立/有界 120/按 sourceId 去重/跨 run 隔离/终态清空 + browser_open 比对写
    usage：成功 reachable/失败 unreachable/写失败安全 no-op 不影响工具结果）+
    search/list/get 序列化补齐 ID/规范键/作用域/分组 ID（模型引用链路）+ 四
    工具自然语言管理 description（「不再优先」= 降 priority ≠ disable）+
    冒烟 8.12 B-06/B-07（usage 全链路 + 自然语言管理五场景 + deny 零写入）与
    8.13 B-06 UI DOM 端到端（真实任务模式/ConfirmDialog/Sources UI/Undo/
    usage 探针，dev+生产双场景退出码 0）+ B-02/B-05 双进程复跑退出码 0；
    **Sources 功能对用户已可用，usage 接线已闭环**（全量 test 1160/1160）。
    **B7 存储运维面已落地（2026-08-15）**：实施前契约裁决（决议 #86–#91）+
    `db/backup.ts`（只读探测/VACUUM INTO 一致性备份（决议 #87 冻结）/
    integrity·外键检查/严格命名保留清理（最新 5 + 30 天，决议 #89））+
    `sources-store.ts` 启动装配（probe → 备份 → 逐级迁移 → 检查 →
    normal|readonly-recovery|unavailable——恢复态为真实生产装配能力）+ 恢复态
    全拒（读写/Undo/usage/rebuild/四 Agent Source 工具零写入，浏览器其余能力
    正常）+ FTS rebuild 诊断入口（sources:rebuild-index 无 payload，仅 UI +
    normal 状态，零 Undo 零 changed）+ usage 两处投影同事务一致（决议 #90）+
    详情「上次使用结果」展示（可达/不可达/其余「暂无可靠信号」）+
    冒烟 8.14 B-06 B7 部分（dev+生产双场景退出码 0）+ B-02 usage 跨进程扩展
    （set/check 退出码 0）+ B-05/SESSION 双进程复跑退出码 0。
    真实 Provider 自然语言管理验证待用户授权（门控就绪，未授权不发起付费请求）。
    **B7 事故恢复与安全加固（2026-08-15）**：环境事故已止损（根目录 46 个
    零字节文档碎片 + 1 个 npm Unknown command 错误输出文件 + 事故日志经四项
    标准核验后精确清理，工作区恢复干净形态）；B7 实现安全审查发现并修复 5 项
    数据安全问题（头部固定 16 字节读取/目标已存在 fail-closed/碰撞换新名/
    backups 目录 symlink-junction 真实路径校验/prune 参数边界验证 + 备份源
    连接只读，红→绿 11 failed → 41/41）；全量验证稳定复跑 test
    **1219/1219**（52 文件，单 worker）。
    **独立审计 + B7 审计后定向修复（2026-08-15，HOLD 解除）**：独立审计
    （不采信 B1–B7 报告）发现 backup.ts 备份发布/失败清理 **P2 竞态**并判
    HOLD；本闭环修复（决议 #92：两阶段私有 staging + 硬链接 no-clobber 原子
    发布 + 所有权证明精确清理 + `createConsistentBackupAt` 任意路径公共导出
    移除），红→绿 5 failed/32 passed → 37/37，全量 test **1226/1226**，
    dev/生产冒烟（B-06 全矩阵）与 B-02 双进程退出码 0。**下一个推荐动作 =
    B8 红队矩阵 SRT-01～SRT-12**（审计其余发现 P2-2/P2-3/P2-4/P3 登记于
    progress.md 开放风险，不阻塞 B8）。
    契约 `doc/stage4/detailed-design.md` + 安全契约
    `doc/stage4/threat-model.md`。

- ✅ **第一阶段完成（Exit Gate 通过，2026-08-13）**：T0 项目基线 → T1 详细设计定稿 →
  T2 浏览器核心（BrowserController/TabManager/SessionManager + WebContentsView）→
  T3 浏览器 UI → T4 PageSnapshot（PageReader/采集脚本/normalize/调试面板）→
  T5 收尾（安全审计 + R-02 will-redirect 加固 + 验收清单逐项核对 + 文档同步）。
  验收证据见 `First_stage.md` §十四。
- ✅ **第二阶段（AI 共读）完成并通过验收（2026-08-13/14）**：S1 Provider 抽象与凭据
  安全基座 → S2 ContextBuilder 纯核心 → S3 ConversationService 与会话持久化 →
  S4 AI 侧栏 UI 与 IPC/bridge 扩展 → S5 安全审计与 Prompt Injection 验证 →
  S6 收尾验收（§9 四组 16 项逐项通过 + §10 Exit Gate 判定通过，含真实 Provider
  多网站共读验证）。用户独立复验（2026-08-14）发现的 4 项非阻塞测试基础设施/
  文档缺陷已修复并全量回归（红态退出码 1 → 绿态 0）。证据见 `Second_stage.md`
  §9/§10 与 `doc/tasks/progress.md`。
- ✅ **第三阶段（Browser Agent）已完成并通过验收（2026-08-14 总 Exit 决策 =
  GO/PASS；2026-08-15 已按用户指令切换 Fourth Stage）**：Entry Gate 逐项核验通过
  （「tool calling」项经循环式门槛判定记录校正——该能力属第三阶段自身交付物，校正为
  A1 硬前置，判定证据见 `doc/stage3/proposal.md` §8）；Prompt Injection 威胁模型
  重建定稿（`doc/stage3/threat-model.md`）；契约定稿 `doc/stage3/detailed-design.md`。
  **A1 tool-calling 兼容层已完成**（Provider 类型扩展 + SSE tool_calls 聚合解析 +
  FakeProvider 工具脚本 + ContextBuilder tools 透传，全量验证通过，硬前置解除）；
  **A2 Tool Registry + 权限分级与确认状态机 + 审计日志已完成**（注册表确定性校验/
  listTools、13 工具权限矩阵纯函数（click 确定性允许列表 + fail-closed）、
  ConfirmManager 单 pending 状态机、审计参数脱敏（fill 只记长度）、ToolExecutor
  管线（校验→权限→确认→执行→审计，每次调用恰好一条）、首批 8 个只读/导航工具
  接线 BrowserController——冒烟工具层探针通过，审计日志实证）；
  **A3 浏览器交互能力已完成**（interaction-script 固定模板 + click 确定性允许
  列表单一事实源 classifyClickTarget + BrowserController 扩展（clickElement/
  fillElement/scrollTab）+ elementId 文档世代绑定（决议 #31：导航世代计数 +
  快照 meta.documentId 主进程盖章 + 执行前校验，旧 id 不因新文档复用相同 el-N
  而命中新元素）+ find/scroll/click/fill 四工具经既有 ToolExecutor 链路接线——
  冒烟 A-12 与 elementId 生命周期真实 DOM 探针通过，dev/生产双场景）；
  **A4 SearchProvider 与 search_web 已完成**（接口 + Bing 搜索页实现——临时 Tab
  精确 tabId 所有权与恢复语义（决议 #32）+ 确定性解析（ck/a 包装链接还原/过滤/
  去重/snippet 空串容忍设计）+ 错误诚实映射（合法空结果 vs 结构无法识别/L2/L3）
  - search_web 注册（L0，注册表 13 工具，查询串全量审计）——受控搜索页冒烟
    全链路 + 公网 Bing 探针 10 条真实结果通过，dev/生产双场景）；
    **A5 Agent Runtime 已完成**（AgentLoop 纯编排状态机（MAX_STEPS=12/总超时
    420s/取消/防循环执行前阻断/终态单一所有权，决议 #33 六点校准）+
    AgentContextBuilder（AGENT_SYSTEM_PROMPT 独立常量 + UNTRUSTED_TOOL_RESULT
    块）+ agent-history（ToolStep/脱敏 toolCalls/完整交互组）+ ConversationStore
    version 2 + ConversationService agentAsk/confirmTool + 主进程冒烟 A-01～A-09
    ——dev/生产双场景退出码 0）；
    **A6 操作可见性 UI 与通道已完成**（6 IPC 通道（agent-ask/agent-confirm
    invoke + agent-step/agent-confirm-request/agent-run-done/agent-status 事件
    ——决议 #34 新增实时状态通道）+ preload bridge 白名单 + 任务模式/
    AgentStatusBar/ToolCallList/ConfirmDialog（deny 默认焦点、elementText
    页面提供不可信纯文本渲染）/停止按钮/ToolStep 历史渲染 + agent-run-state
    纯 reducer + UI 端到端冒烟 A6-UI-01～A6-UI-12——dev/生产双场景退出码 0）；
    **A7 红队矩阵与安全审计已完成（2026-08-14）**——冒烟 8.6
    RT-01～RT-08 + RT-11（dev/生产双场景退出码 0）+ RT-09 全仓库 grep +
    logger 日志行伪造防御修复；**A7 补验真实验收已完成（2026-08-14）**——
    wire 兼容性修复（决议 #35）+ 最小预检 + 完整真实 Provider 验收
    （deepseek-v4-pro，§7 场景 1–6 全部真实完成 + RT-10 真实模型证据 +
    停止收敛 + 零泄漏终检，`LIVE_SMOKE_PASS` 退出码 0）；
    **A7 补验补证已完成（2026-08-14 定向补验）**——场景 2 修订（真实长页面
    read/find/scroll 三类工具真实调用链）+ 场景 3 修订（真实搜索后两个不同
    origin 公开来源各自读取比较）+ A3 确认门状态机补齐，`LIVE_SMOKE_PASS`
    退出码 0（12 次 HTTP 全部 200）；
    **A8 第三阶段收尾已完成（2026-08-14）**——§9 五组验收全部 PASS +
    §10 五项技术条件逐项判定 PASS，**第三阶段总 Exit 决策 = GO/PASS**
    （2026-08-15 已切换 Fourth Stage：设计完成、B1 已完成，见上）。

## 技术栈（实际落地版本）

Electron 43.4.0（WebContentsView 承载网页）· electron-vite 5 · Vite 7.3.6 · React 19.2.8 ·
TypeScript 6.0.3 · Vitest 4 · ESLint 10（flat config）· Prettier 3.9 · Node.js 24.x（engines `>=24 <25`）

## 快速开始

```bash
npm install      # 首次安装 Electron 二进制见下方「本机环境注意」第 2 条
npm run dev      # 开发模式启动（真实启动 Electron 应用）
```

冒烟自检（启动 → 窗口 → React 挂载 → preload bridge 链路 → 浏览器核心场景 →
T3 UI 导航保护/bounds → T4 PageSnapshot 真实采集 → T5 敌对页/302 拦截/UI 端到端/远程隔离 →
S3/S4 AI 共读场景：FakeProvider 离线矩阵流式端到端/selection 独占/防串页/L3 降级/薄快照/
中止/错误归一化/会话持久化/UI 端到端/bounds 协调/Key 不可达/注入结构断言 →
A2/A3 工具层探针与交互场景 → A4 搜索生命周期场景（受控搜索页夹具三形态 + 临时 Tab
精确所有权与恢复 + 审计恰好一条；可选公网 Bing 探针 `AIBROWSE_SMOKE_LIVE_SEARCH=1`）→
A5 Agent Runtime 场景 8.4（A-01～A-09 主进程驱动）→ A6 操作可见性 UI 场景 8.5
（A6-UI-01～A6-UI-12 React DOM 事件驱动：任务模式多步任务/确认 deny・approve/
pending 停止/慢模型停止/四种终止理由中文/invalid 条目/切换不串 run/ToolStep v2
磁盘重读/fill 零原文/敌对确认文本/共读回归）→ A7 红队矩阵 8.6（RT-01～RT-08 +
RT-11：诱导文案结构隔离/URL 白名单 + 日志行伪造防御/提交确认门/搜索结果注入
块隔离/密码・文件零写入/陈旧 elementId/system・Key 探测/确认疲劳/通用 click
越权 L3 零 DOM）→ B1 起再验证 node:sqlite 决策门 B-01 探针（8.7：11 项逐项
独立断言——import（dev/生产产物）/文件库重开/prepared statements 注入仅作数据/
事务回滚/外键拦截/busy_timeout 锁竞争/FTS5/trigram 中文子串/userData 派生路径/
句柄清理；基础能力项任一失败即冒烟失败；⑩ 的 userData 路径实测用官方验证命令
`AIBROWSE_USER_DATA_DIR=<系统 TEMP 下临时目录>`，默认矩阵运行 userData 非临时时
如实跳过并注明）→ B3 起再验证 8.9 B-04 B3 子集（有界检索/分享模式矩阵/
中·日·英命中/短查询降级/硬上限 10/URL 查询/注入串/rebuild 一致性——真实
Electron 内置 node:sqlite/FTS5/trigram）→ B4 起再验证 8.10 B-03/B-04 B4 部分
（change set 确认全链路：deny 零写入/approve 单事务/迟到与未知 id 无效/blocked
猜测 source-forbidden/TOCTOU 版本复验/20-21 项边界/durable Undo；4000 预算截断/
allowlist 序列化（expectedVersion 令牌）/UNTRUSTED_TOOL_RESULT 块隔离（注入 note
夹具）/审计脱敏（note 与敏感 URL query 值零出现））→ B5 起再验证 8.11 B-05
Sources UI 端到端矩阵（真实 DOM → preload → IPC → SourceService 全链路：明文
说明/快速添加与重复・可能相关/分组分页/搜索 user 视角 blocked 可见/手工添加/
详情编辑与 provenance・aiNote 只读・敌手 note 纯文本/版本冲突提示刷新/禁用恢复/
手工 Undo/两阶段永久删除取消与确认 + token 零 DOM/恢复态・不可用态中文诊断与零
写入/面板互斥 + App 级确认框不遮断）→ B6 起再验证 8.12 B-06/B-07（usage 全
链路：source_search 命中 → browser_open（fragment 变体规范化命中）→ read →
回答 usage=reachable/无关・先开后搜・跨 run 零记录/执行失败 unreachable/写入
失败不影响工具结果；自然语言管理五场景：deny 零写入 + denied-by-user 停止/
收藏 approve → 保存 → durable Undo/搜索 → get → 改组备注/标 official 恒
ai+unverified/降 priority ≠ disable → 明确 disable → restore）与 8.13 B-06
UI DOM 端到端（真实任务模式 → ConfirmDialog approve/deny → Sources UI 可见 +
AI 推断 provenance → UI Undo + usage 探针）→
自动退出，退出码 0 即通过；矩阵见 `doc/stage2/detailed-design.md` §13.2 +
`doc/stage3/detailed-design.md` §13.2 + `doc/stage4/detailed-design.md` §13.2）。
**B-02 Sources 跨进程持久化冒烟（B2 专属门控，决议 #57，两进程均需
AIBROWSE_SMOKE=1 + 已核验系统 TEMP 子目录；与 SESSION_SMOKE 互斥）**：
进程 A 写 CRUD + journal、进程 B 新进程读回并执行 Undo（生产产物需先 `npm run build`）：

```bash
env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 AIBROWSE_SOURCES_SMOKE=set AIBROWSE_USER_DATA_DIR=<临时目录> npm run start
env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 AIBROWSE_SOURCES_SMOKE=check AIBROWSE_USER_DATA_DIR=<临时目录> npm run start
```

**B-05 Sources UI 跨进程持久化冒烟（B5 专属门控，与 SESSION_SMOKE/SOURCES_SMOKE
互斥；两独立生产进程共用同一系统 TEMP 临时 userData，测试后清理）**：
进程 A 经真实 UI 快速添加 + 编辑、进程 B 新进程读回 → Undo → 两阶段永久删除：

```bash
env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 AIBROWSE_SOURCES_UI_SMOKE=set AIBROWSE_USER_DATA_DIR=<临时目录> npm run start
env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 AIBROWSE_SOURCES_UI_SMOKE=check AIBROWSE_USER_DATA_DIR=<临时目录> npm run start
```

```bash
env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 npm run dev
```

真实 Provider 可选验证（开发者流程，需用户已提供 Key——未经提供不联网调用付费 API；
Key 永不写进命令行或项目文件）：

1. 先读取仓库外本地说明 `%LOCALAPPDATA%\AIbrowse\S5\live-provider-test.md`（记录测试用
   base URL / model / DPAPI 密钥文件路径与注入规则——凭据与机器专属配置不进本仓库）。
2. API Key 以 Windows DPAPI 密文保存在仓库外 `%LOCALAPPDATA%\AIbrowse\S5\provider-key.dpapi`，
   测试时由仓库外启动脚本在受控子进程中解密并经环境变量短暂注入（测试结束清零内存、
   清除环境变量与临时目录，不打印 Key）：

```powershell
# S5 固定问题一问一答 / S6 多网站共读验证（§10 Exit Gate）
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AIbrowse\S5\run-live-smoke.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AIbrowse\S5\run-live-smoke.ps1" -Sites
```

3. 不设固定调用次数：每次真实调用必须对应明确的验收项或缺陷复验；完成报告列出调用
   次数与用途，不包含凭据。

Session 跨进程持久化验证（两个独立进程 + 同一临时目录，验证 Cookie 重启后保留；
以生产产物验收，先执行 `npm run build`）：

```bash
# 进程 A：写入 Cookie 后完整退出；进程 B：新进程读回 Cookie
env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 AIBROWSE_SESSION_SMOKE=set AIBROWSE_USER_DATA_DIR=C:\Temp\aibrowse-session-smoke npm run start
env -u ELECTRON_RUN_AS_NODE AIBROWSE_SMOKE=1 AIBROWSE_SESSION_SMOKE=check AIBROWSE_USER_DATA_DIR=C:\Temp\aibrowse-session-smoke npm run start
```

| 命令                              | 作用                                                |
| --------------------------------- | --------------------------------------------------- |
| `npm run dev`                     | Electron 开发模式（渲染进程 HMR）                   |
| `npm run build`                   | 构建产物 `out/`（main / preload / renderer 三目标） |
| `npm run start`                   | 以构建产物启动（preview）                           |
| `npm test`                        | Vitest 全量测试（当前 1226 用例）                   |
| `npm run typecheck`               | 严格类型检查（node + web 两套 tsconfig）            |
| `npm run lint`                    | ESLint 检查                                         |
| `npm run format` / `format:check` | Prettier 格式化 / 检查                              |

## 本机环境注意（重要）

1. **本机全局环境变量 `ELECTRON_RUN_AS_NODE=1`**：会让 Electron 以纯 Node 模式启动而崩溃。
   该全局变量可能被你的 Node 配置依赖，本项目不改动它，启动 Electron 时命令级排除：
   `env -u ELECTRON_RUN_AS_NODE npm run dev`（PowerShell：`$env:ELECTRON_RUN_AS_NODE=$null; npm run dev`）。
2. **安装依赖走代理**（Electron 二进制从 GitHub 下载；Node 24 原生 fetch 需显式开启代理支持）：
   `NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm install`

## 架构简述

三层依赖方向固定，不可反向或跳跃：

```
React UI（渲染进程）→ BrowserController（主进程，浏览器能力统一入口）
                    → TabManager / PageReader / SessionManager
                    → Electron APIs（WebContentsView 承载远程网页）
```

- 每个 Tab 一个 WebContentsView（`persist:aibrowse` 持久分区），React UI 是独立的主窗口
  webContents；两者处于明确安全边界（UI 有 preload bridge，Tab 无 preload）。
- 远程网页：`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`，`webSecurity` 不关闭。
- React UI 仅经最小 preload bridge（`window.aibrowse` 白名单）通信，绝不直接调用 Electron
  webContents API；主进程每个 IPC handler 校验 sender 为主窗口主帧。
- PageSnapshot 采集（PageReader）：`executeJavaScript` 注入观察性采集脚本（不注册事件、
  不执行 Node API），唯一写操作是为交互元素做唯一、命名空间受控（`data-aibrowse-el`）、
  幂等的 elementId 属性烙印；页面输出视为敌手，经 normalize 逐字段校验后返回；
  降级阶梯 L0（完整）/ L1（iframe 跳过/未加载完，partial）/ L2（采集失败，仅主进程侧
  url/title）/ L3（tab 不可用，null）。type=password 不采集 value。
- 纯逻辑（地址栏输入判断 `src/shared/url.ts`、Tab 状态机、权限策略、UI 导航保护、
  快照 normalize）零环境依赖、可单测；UI/IO 副作用在外层胶水。
- AI 子系统（第二阶段，已实现并通过验收）：依赖方向 `UI(AI 面板) → ConversationService →
ContextBuilder / LLMProvider → SecureCredentialStore`；网页上下文经 `ConversationService →
BrowserController.getPageSnapshot`（**提问时刻实时采集**，禁止复用缓存快照——防串页）。
  LLM 请求仅在主进程发起（API Key 不出主进程，渲染层只写不读）；网页内容只进 user 消息的
  `UNTRUSTED_WEB_CONTENT` 块（system 恒为应用常量）；Key 落盘仅 safeStorage（Windows DPAPI）
  密文；会话持久化为 userData 下 JSON（不存快照正文，支持「不保存」会话）。
- Browser Agent（第三阶段，A1–A8 已实现——**总 Exit 决策 GO/PASS**，完整真实 Provider
  验收通过）：`UI → ConversationService(agent 模式) →
AgentLoop → ToolRegistry → PermissionPolicy / ConfirmManager / ToolExecutor →
BrowserController / SearchProvider`；工具实现只经 BrowserController/SearchProvider 操作
  浏览器；权限判定为确定性纯函数（模型只是提议者）；**click 走确定性允许列表
  （链接/展开/切换 L1、提交类 L2、非允许列表目标 fail-closed L3），L3 敏感动作
  在权限层与执行器层双重封死无执行通道**；Tool Result 与网页内容同等视为不可信；
  禁止万能工具（shell/eval/任意 JS/文件系统/HTTP POST/任意 IPC/SQL 永久红线）；
  Element 交互经固定模板注入脚本（click/fill/scroll，参数只进 JSON 字面量），
  elementId 执行时刻重新定位；威胁模型见 `doc/stage3/threat-model.md`。

## 目录结构

```
src/
├── main/          # 主进程：入口（生命周期/窗口/安全默认值/IPC 装配/导航保护）、logger、
│   │              #   （A7 ✅ normalizeLogMessage 日志行伪造防御）、
│   │              #   smoke（冒烟自检：多 Tab/导航保护/真实采集/敌对页/302/UI 端到端/Session/
│   │              #             AI 共读矩阵 + 8.4/8.5/8.6 Agent/可见性/红队矩阵 +
│   │              #             A7 ✅ LIVE_AGENT/LIVE_AGENT_SUPPLEMENT 门控
│   │              #             runLiveAgentScenarios（完整验收 + 定向补验））
│   ├── sources/   # （Fourth Stage）db/（✅ B1：sqlite-driver 薄封装——node:sqlite 冻结
│   │              #   （决议 #48）：openDb/closeDb/withTransaction，仅连接级运维 SQL；
│   │              #   migrations 骨架——user_version 单调逐级 + 单事务 + 回滚；B2+ 扩展）；
│   │              #   ✅ B5：source-ipc.ts（sources:* 适配器：白名单校验/audience 硬编码
│   │              #   user/状态门控/独立 manual 审计/changed 事件，零 Electron import）
│   ├── browser/   # BrowserController / TabManager（A3 ✅ 导航世代计数）/ SessionManager /
│   │              #   PageReader（A3 ✅ 交互编排）/ snapshot-script + snapshot-normalize /
│   │              #   interaction-script + interaction-normalize（A3 ✅ 固定模板交互注入与
│   │              #   结果形状校验）/ tab-state / permission-policy
│   └── ai/        # （第二阶段已实现）ConversationService / ConversationStore /
│                  #   ContextBuilder + budget / CredentialStore / ConfigStore /
│                  #   provider（LLMProvider/OpenAI-compatible/FakeProvider/error-normalize；
│                  #   A1 ✅ tool-calling 兼容层：tools/SSE tool_calls 聚合/工具脚本）
│                  # （第三阶段）tools/（A2 ✅ tool-types/tool-registry 校验/tool-executor
│                  #   管线/browser-tools 首批 8 只读导航工具 + A3 ✅ interaction-tools
│                  #   find/scroll/click/fill、interaction-semantics 语义存储+世代绑定 +
│                  #   A4 ✅ search-tool search_web 注册与序列化）+
│                  #   permission/（A2 ✅ permission-policy + A3 ✅ classifyClickTarget）+
│                  #   confirm-manager（A2 ✅ 确认状态机 + A5 ✅ onPendingChange 可见性回调 +
│                  #   A6 ✅ 判别联合 PendingChange + 多监听者 Set 分发）+
│                  #   audit-log（A2 ✅ 审计参数脱敏 + A4 ✅ search_web 查询串全量记录 +
│                  #   A5 ✅ decision 单一事实源（ToolStepDecision 别名）+ agent-run 条目）；
│                  #   agent/（A5 ✅ agent-loop 纯编排状态机 + agent-context-builder +
│                  #   agent-history + agent-safety 防循环纯函数，零 Electron import；
│                  #   A6 ✅ onStatus 相位 + onAgentStep argsSummary）+
│                  #   search/（A4 ✅ search-provider：接口 + Bing 页面实现 + 确定性解析，
│                  #   临时 Tab 精确所有权零 Electron import）
├── preload/       # UI bridge（contextBridge，白名单 IPC：tabs/nav/page/ui + conversation/config；
│                  #   A6 ✅ agent 可见性：agentAsk/confirmTool + 4 事件订阅；
│                  #   B5 ✅ sources：14 通道 + sources:changed 事件订阅）
├── renderer/      # React UI：chrome（Toolbar/TabBar/AddressBar/DebugPanel）+ ai/（AI 侧栏；
│                  #   A6 ✅ 对话/任务模式 + AgentStatusBar/ToolCallList/ConfirmDialog +
│                  #   agent-run-state/agent-display 纯函数）+ ai/sources/（B5 ✅ Sources
│                  #   面板：分组浏览/搜索/详情编辑/手工添加/快速添加/Undo/两阶段永久删除/
│                  #   恢复态诊断 + sources-display 纯函数；与 AI 面板互斥切换）
└── shared/        # 共享类型（app/browser/ipc/conversation + agent——A2 ✅ ToolCall/ToolResult/
                   #   权限级别/ElementSemantics（A6 ✅ 增 text）+ A5/A6 ✅ 事件 payload）+
                   #   纯逻辑（url.ts）
```

完整结构与职责见 `AGENTS.md` §4；第二阶段契约与任务见 `doc/stage2/`（定稿）；
第三阶段契约与任务见 `doc/stage3/`。

## 日志

每次运行生成详尽日志（启动/退出、关键路径、错误堆栈、环境信息）：项目根目录 `log/`（按日轮转，已 gitignore）。
打包后写入用户数据目录下 `log/`。

## 测试

Vitest（node 环境）测核心纯逻辑（当前 1226 用例）：地址栏输入判断（15）、Tab 状态机（14）、
网页权限策略（4 组）、UI 导航保护（10）、PageSnapshot 数据规范化（51，页面视为敌手；A3 扩展 click 语义元数据）；
第二阶段（S1–S4）新增：错误归一化状态码矩阵与脱敏、FakeProvider 确定性行为、
credential/config 校验（81）、上下文预算确定性裁剪、ContextBuilder 角色隔离与注入夹具
（system 恒等/块闭合转义/selection 独占）（72）、会话消息校验与编排（57）、
UI 纯 reducer 与徽标文案（22）、logger 脱敏密钥专项用例；
第三阶段 A1 新增（35）：SSE tool_calls 聚合解析（分槽累积/收尾顺序/非法帧与非法
arguments → provider-error）、mapMessages tool 与 tool_calls 重放、FakeProvider
工具脚本、ContextBuilder tools 恒等透传。
第三阶段 A2 新增（91）：工具注册表（重复注册拒绝/listTools 恒等/校验矩阵——JSON 解析/
必填/类型/enum/未知键/长度/tabId UUID/elementId el-N；B4 递归 object/array schema）、权限矩阵全表（17 工具 ×
条件判定：click 确定性允许列表各分支与特征冲突/isSubmit 优先升级 L2/ariaExpanded
true 与 false 均为展开控件/语义缺失 fail-closed/fill password・file 恒 L3/URL
scheme L3）、ConfirmManager 状态机（单 pending/approve/deny/作废/幂等/无自动批准）、
审计脱敏（fill len=N 原文零出现/URL 全量/截断确定性/Key 形态零暴露链）、ToolExecutor
管线（成功/校验失败/L3/deny/执行失败/审计恰好一条/结果截断）、8 个只读导航工具的
BrowserController 注入调用与失败安全返回、logger 审计形态脱敏回归。
第三阶段 A3 新增（81）：交互脚本模板（node:vm 假 DOM 真实执行——模板编译期固定/
JSON 字面量往返恒等/敌手参数引号・反斜杠・闭合片段・脚本字符串不能逃逸/click
allowedKind 四类复核与拒绝路径/fill 原生 setter + input/change 事件与禁填目标/
scroll 整数边界）、交互结果形状校验（页面视为敌手逐字段验证）、快照语义映射与
存储（世代绑定）、find 确定性匹配（多章节/无命中空结果）、scroll/click/fill
executor（派生参数透传/无派生 fail-closed/fill 内容零原文）、classifyClickTarget
与 decide 同源双表对照、paramRules（dy ±50000 整数/text 长度差异化）、
ToolExecutor derived 派生（allowedKind+documentId）、快照 click 语义元数据
（isSubmit/ariaExpanded 严格布尔）、meta.documentId 主进程盖章。
第三阶段 A5 新增（123）：agent-safety 签名规范化（键排序/Unicode NFC/非法 JSON
原始串）与循环判定（连续 3 与累计 5 在执行前阻断/触发次计步/read 无白名单例外/
被拒与失败同样计签/no-progress 连续 2，阈值可注入）、agent-loop 状态机全路径
（多步任务/协议历史合法序（assistant toolCalls → tool 消息同序精确关联）/文本+
工具同轮为过程性输出/goal 恰一次/四种工具错误结构化回注后继续/execution-failed
保留实际权限决策/L2 deny・approve・取消・超时/step-limit 边界（13 调用只执行
12，未执行零伪造）/防循环执行前阻断（触发次零副作用，阻断步骤 decision=invalid

- 恰好一条审计）/no-progress 两轮/Provider 错误直传/用户取消部分保留/终态竞态
  （先到先得、迟到 abort 与工具结果忽略、工具挂起不阻塞 run）/重复与空 toolCallId
  fail-closed）、agent-context-builder（AGENT_SYSTEM_PROMPT 恒等且与共读互不
  混用/goal + 启动快照块闭合转义/UNTRUSTED_TOOL_RESULT 块属性与敌手闭合转义/
  tools 恒等透传）、agent-history（ToolStep 组装内部能力参数零出现/contentPreview
  ≤200/decision 六值单一事实源/FILL_MASK 脱敏/完整交互组校验——孤立 tool 丢弃・
  不完整组整组丢弃/跨 run 只回摘要 + 完整组预算裁剪）、conversation-store v2
  （写入恒 v2/读兼容 v1/ToolStep 逐字段 fail-closed/孤立与重复 tool 消息解析丢弃/
  组感知 200 条裁剪/真实文件字节断言 fill 原文・快照正文・Key 形态・documentId
  零落盘）、conversation-service agentAsk（goal 校验与截断/共读与 Agent 双向在途
  互斥/Provider 未配置与不支持工具零执行/多步 ToolStep 持久化协议序/事件恰好一次/
  ephemeral 不落盘/重启恢复/abort 部分保留/deleteSession 不复活/confirmTool 转发
  与防串 run 事件映射）、FakeProvider 多轮 rounds 脚本与中止感知睡眠、
  ConfirmManager onPendingChange 回调。
  第三阶段 A4 新增（43）：搜索解析矩阵（正常组装/去重保持首现/非 http・https 与畸形
  URL 丢弃/bing 自身域与非结果标签过滤/ck/a 包装链接 base64url 还原/前 10/title 200
  截断/snippet 空串容忍设计/空与 null 安全降级）、临时搜索 Tab 所有权与恢复语义
  （精确 tabId 独占/只关本调用创建的确切 id/提前关闭安全无操作/活动 Tab 恢复与
  不抢焦点/并发隔离/超时・取消・异常全路径零泄漏——注入时钟确定性）、search_web
  工具（常量 schema/L0 管线决策/序列化纯文本零特权/4000 截断/空结果明确提示/
  结构无法识别 search-failed/取消归一/每次调用恰好一条审计/查询串全量审计）。
  第三阶段 A6 新增（67）：agent-run-state 纯 reducer（按 sessionId/requestId 键控：starting 收养/相位合并/step 去重/错误会话与旧 run 事件忽略/run-done 幂等/终态后迟到事件忽略/新 run 不继承/stop-requested stopping 与幂等/会话隔离/全局 pending 选择器）、agent-display 展示纯函数（sanitizeConfirmText 控制字符与双向控制符剔除 + 截断/决策六值・错误码・run 状态九值中文文案/状态栏全相位与五种终止理由描述——run.status 权威）、history-events turn-done 消息 id 去重（历史刷新与终态事件竞态防御）、confirm-manager 判别联合（pending/settled 携带 outcome）+ 多监听者 Set 分发、interaction-semantics text 映射（inputs 不采集宁缺勿错）、tool-executor 确认摘要（elementText 页面提供目标文本/目标站点 URL 主进程可信）、agent-loop onStatus 相位（thinking/executing 计数一致/finalizing 仅 done/终态后零迟到/防循环阻断零 executing）+ onAgentStep argsSummary（审计同源一致/fill 只记长度）、conversation-service onAgentStatus（starting/waiting-confirm/confirm-resolved 三态/abort 作废/非在途防串）+ 共享 ConfirmManager 双 Service 互不串扰与 dispose 退订。
  第三阶段 A7 新增（5，logger.test）：normalizeLogMessage 日志行伪造防御（CR/LF
  折叠为空格条目恒单行/ANSI CSI・OSC 整体剔除/C0・DEL・NEL・双向・零宽・BOM・
  行段分隔符按码点剔除/\t 保留/sanitize 凭据脱敏行为零改动）；红队矩阵由冒烟
  8.6（RT-01～RT-08 + RT-11）+ RT-09 grep 断言覆盖。
  第四阶段 B1 新增（31）：sqlite-driver（17——真实 node:sqlite：文件库创建/重开
  读回/prepared statement 注入串仅作数据/withTransaction 提交与回调・语句异常
  整体回滚且连接可诊断/外键开启拦截与关闭放行双证/WAL・busy_timeout 回读/两连接
  锁竞争（worker 正证等待至释放成功 + 零超时负证 + 等待下界证据）/重复关闭幂等/
  关闭后重命名删除/无效路径中文安全失败/关闭后使用拒绝）、migrations（14——
  迁移列表空/重复/乱序/缺级/非正整数、当前版本/未知更高版本判定、成功逐级迁移、
  第 N 步失败该步整体回滚零部分状态、部分迁移续跑）。
  Electron 行为由冒烟自检真实启动验证（见上）。 约定见 `AGENTS.md` §7。

## 已知限制

- PageSnapshot v1 仅采集主文档，跨域 iframe 内容 L1 降级跳过（设计决议，点时刻尽力采样）。
- 地址栏不支持中文/国际化域名（IDN，走搜索兜底）；搜索引擎暂硬编码 Bing（SearchProvider
  接口隔离已落地，v1 为 Bing 搜索页实现，未来 API 供应商实现同接口即可替换）。
- 无 CI / 打包配置（第一阶段验收不要求；打包属 Seventh Stage）。
- 冒烟中的搜索验证在离线环境断言「发起 Bing 搜索导航」而非页面加载完成（联网冒烟变体可验证）。
- Prompt Injection 边界：第二阶段结构性隔离保证网页内容不能取得权限、读取密钥、调用写
  操作或改变消息角色（机器可验证）；第三阶段引入 Browser Tool 前**威胁模型已重建定稿**
  （`doc/stage3/threat-model.md`：五层防线 + 红队矩阵 RT-01～RT-11）。仍**不承诺**模型在
  语义层完全不受网页文本诱导——第三阶段四类残余风险（诱导式工具参数/确认疲劳/低风险
  动作累积/click 允许列表目标的页内 JS 副作用）如实登记，不宣称免疫。
- 详细清单见 `doc/tasks/progress.md`「计划内限制与延期项」。
- **第三阶段验收结论（2026-08-14，最终状态）**：§9 五组验收全部 PASS +
  §10 五项技术条件逐项判定 PASS + §7 真实场景 1–6 与 RT-10 真实模型证据取得——
  **第三阶段总 Exit 决策 = GO/PASS**。过程回顾（如实登记）：首轮 400 根因 =
  **wire 名称契约**（13 工具名携带点号违反 `function.name` 约束，非「模型不支持
  tools」）→ 决议 #35 修复（wire-safe 下划线名 + 注册/序列化双闸门 +
  reasoning_content 不透明回传 + 程序内内容相等校验）→ 最小预检 → 完整真实
  Provider 验收（deepseek-v4-pro，`LIVE_SMOKE_PASS` 退出码 0，最终执行 20 次
  HTTP 请求全部 200）→ **定向补验（证据缺口裁决后：场景 2 三类工具真实调用链
  - 场景 3 两个不同 origin 公开来源各自读取比较 + A3 状态机补齐，12 次 HTTP
    全部 200）**——当日累计 10 次执行 145 次零 400。真实验证过程中发现的缺陷均为
    测试基础设施类（冒烟断言/驱动校准），权限面/工具清单/验收标准零放宽。
    受控本地页面 FakeProvider 冒烟不替代真实验证的规则不变（今后真实 Provider
    变更时沿用 `-Pre` 最小预检 → `-Agent` 完整验收流程；定向缺口补证可用
    `-Supplement`）。
