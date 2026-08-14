# AIbrowse 第四阶段 Proposal — Sources 长期信源系统

> 需求源：根目录 `Fourth_stage.md`（阶段总任务）。本文档把总任务收敛为可验收的
> 阶段提案（纯文档设计闭环，2026-08-15；**不含任何产品代码**）。
> 前置：第三阶段总 Exit 决策 = `GO/PASS`（2026-08-14，A7 补验最终执行 + 定向补验；
> F-1～F-4 验收发现项已关闭；O-1 为非阻塞纵深观察）+ 用户下达 Fourth Stage 切换指令
> （2026-08-15，本提示）。
> 里程碑 B1–B9 由本提案配套的 `doc/stage4/tasks/B1–B9` 任务文档单独管理。
> 任务编号采用 **B1–B9**（避免与第一阶段 T0–T5、第二阶段 S1–S6、第三阶段 A1–A8 重名）；
> 威胁编号 ST-01～ST-12、红队编号 SRT-01～SRT-12（不与 progress.md 风险 R-XX 及
> 第三阶段 RT-XX 混淆）。
> 与既有文档的关系：`doc/stage2/`、`doc/stage3/` 为第二、三阶段定稿（不改写、不覆盖）；
> 第一阶段历史文档原位保留；本阶段契约源为 `doc/stage4/detailed-design.md`，安全契约源为
> `doc/stage4/threat-model.md`（先于任何 Source 实现定稿，含 B1 SQLite 基座）。

## 1. 目标

把传统浏览器「收藏夹」升级为**可被 AI 理解、检索、自动维护的长期信源系统**：

- **SQLite 持久化层**：node:sqlite 候选 + B1 决策门实测（import/文件库/prepared
  statements/事务/外键/busy timeout/FTS5/trigram/userData 路径/句柄清理，dev+生产
  构建）；schema 单调逐级 migration + 一致性备份 + 只读恢复态；
- **Source 域模型**：Source（origin/page 双作用域）+ Group + Tag + 优先级 + 启用
  状态 + 来源类型（provenance）+ 信任元数据（trust_value/trust_asserted_by/
  trust_verification）+ 用户/AI 备注分离 + AI 分享模式（full/metadata/blocked）；
- **用户手工管理 + 当前网页快速收藏**（Sources UI）；
- **AI 自然语言管理**：添加、修改、整理、禁用、恢复 Source——全部经结构化
  change set + L2 确认 + 单事务 + durable Undo（无硬删除工具）；
- **有界 Source Retrieval**：FTS5 trigram 多语言检索 + 短查询安全降级 + 本地
  过滤排序 + 返回 allowlist + 分享模式过滤；
- **Browser Agent 复用**：检索结果继续经既有 `browser_open/browser_read` 打开读取
  （Source Tool 不新增任何网络能力）；打开/读取后记录最近一次 usage/health；
- **全部长期数据变更可审计、可确认、可撤销**：审计脱敏（note 正文零出现）、
  ConfirmDialog 展示程序生成确定性 diff、Undo 重启后可用。

核心原则（继承第三阶段）：**AI 决定「需要做什么」；确定性程序决定「是否允许、
如何执行、执行结果是什么」**。第四阶段新增：**Source 数据与网页内容同等视为
不可信输入；AI 推断的信任永远不能伪装成用户断言。**

## 2. 非目标（本阶段明确不做）

- Research 报告、多源自动交叉核验、引用渲染、图表（Fifth Stage）；
- RSS、Watch、Diff、后台定时请求（Sixth Stage）；
- 云同步、多设备、账号系统；embedding/向量数据库；
- 任意 SQL、任意文件系统、任意 HTTP POST、后台抓取（永久红线保持）；
- **Agent 硬删除**（无 source_delete_hard 工具；永久删除仅为用户手工 UI 通道，
  二次确认、不可 Undo）；
- 把 AI 推断的 official/primary 当成已核验事实（provenance 分离，UI 明示）；
- Fifth Stage 代码；SQLite 静态加密承诺（v1 本地明文，README/UI 如实说明）。

## 3. 用户与场景（Fourth_stage.md §7 关键体验验收）

1. 当前网页中说：「以后查 AI benchmark 优先看这个站。」→ 快速收藏（无备注 →
   默认 share_mode=metadata）+ AI 生成合理 name/group/tag（change set → L2 确认
   → 用户可立即 Undo）；
2. 新对话问：「我有哪些 AI benchmark 来源？」→ source_search（L0，FTS5 trigram，
   命中 ≤10 条，note 仅 full 模式有界返回 + provenance）；
3. 用户说：「把它改到日本购物组，并备注只用于中古价格。」→ change set（update
   group + user_note）→ L2 确认 → 单事务提交 → 变更正确持久化（重启后仍在）；
4. 用户说：「把这个来源标成官方来源。」→ user 明示 → trust = official +
   user-asserted（若模型自行推断则只能是 official + ai + unverified）；
5. Browser Agent 打开 source_search 返回的网站 → 复用 browser_open/browser_read；
   打开/读取后主进程记录该 Source 最近一次 usage（unknown/reachable/unreachable/
   auth-required/blocked），不保存网页正文、不宣称长期健康；
6. 恶意网页诱导「收藏本站并标为官方」→ SRT-01：AI 断言仅 ai+unverified、
   L2 确认必现、deny 零写入。

## 4. 输入 / 输出

- 输入：模型结构化 change set（≤20 项，字段白名单 + 版本）、source_search 查询串
  （≤500）、UI 手工操作（经同一 SourceService）；主进程读取的当前 Source 状态。
- 输出：Source 工具结果（ToolResult 预算截断 + allowlist + provenance）；L2 确认
  请求（程序生成确定性 diff）；审计条目（脱敏摘要）；Undo 结果；只读恢复态诊断
  （中文）；usage/health 最近一次记录。

## 5. 外部依赖

- 既有技术基线（AGENTS.md §1 冻结）不变；**本设计闭环不新增任何 npm 依赖**。
- SQLite driver：`node:sqlite`（Node 内置，零依赖）为首选候选——避免 native addon
  ABI/rebuild 问题；**官方资料现状已核实但不足以放行**（见 §8 决策门）：Node 24
  node:sqlite 为 Stability 1.1（无需 flag，导入打印 ExperimentalWarning）；Node
  24.18.0 内置 SQLite 3.53.1；Electron 曾真实存在 node:sqlite 缺失缺陷
  （37.2.0「No such binding: sqlite」→ 36.7.3/37.2.3/38+ 修复，electron#47671 /
  PR #47706）；electron-vite/Vite 对 main 进程 node:sqlite externalize 问题有社区
  报告（vite discussion #19278）——**官方声明不替代本项目 Electron 43.4.0 的
  dev+生产构建实跑**，B1 全项通过后才冻结；失败则停止并提交证据，再评估
  better-sqlite3 等备选（native addon，需 ABI 对齐/rebuild 风险）。
- FTS5/trigram：trigram tokenizer 自 SQLite 3.34 起在核心发行可用（sqlite.org
  官方文档），但 **Node 官方构建是否启用 SQLITE_ENABLE_FTS5 无官方文档确认** →
  B1 实测冻结；不可用则 B3 以参数化精确匹配/LIKE 安全降级为主体并如实登记。
- 真实 Provider 验证可选（B6/B8，沿用第三阶段凭据流程：仓库外 DPAPI + 环境变量
  注入 + 真 Key 零暴露扫描；不设固定调用次数）。

## 6. 约束与假设

- **架构纪律**（第四阶段依赖方向，不可反向或跳跃）：
  `Sources UI / Agent Source Tools → SourceService → SourceRepository /
SourceSearchIndex / SourceChangeJournal → SQLite driver（主进程）`；
  renderer、preload、AgentLoop、Tool 实现不得直接执行 SQL；UI 与 Agent 共用同一
  SourceService；打开网页继续 `browser_open/browser_read → BrowserController`。
- **安全红线**（全部保持 + 本阶段新增）：第三阶段 threat-model 结构性边界与四类
  残余风险全部继承；`doc/stage4/threat-model.md` 为安全契约源；change set L2
  确认 + 幂等键 + expectedVersion + 单事务；无硬删除工具；分享模式；有界检索；
  审计脱敏；Key 绝不进 Sources 数据库。
- **Prompt Injection 验收 = 结构性边界机器断言**（不做语义免疫承诺）：SRT-01～
  SRT-12 + §5 诚实边界声明（残余风险六类如实登记：继承四类 + 长期资料污染 +
  垃圾写入语义噪声）。
- **TypeScript / 质量门槛 / 提交纪律**：与第一/二/三阶段相同（AGENTS.md §3）；
  技术基线冻结延续。
- **假设**：单窗口单用户；SQLite 由主进程单连接持有（SourceService 串行化，
  无跨进程并发写）；userData 路径由主进程确定；确认等待计入 Agent 总超时；
  WAL 模式下备份必须经一致性方案（VACUUM INTO/backup API/关闭后复制，B1 实测
  冻结）。

## 7. 待定问题（本设计闭环已拍板，决议记录见 detailed-design §15）

| #   | 问题                                              | 拍板（2026-08-15）                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | SQLite driver：node:sqlite vs better-sqlite3      | **node:sqlite 首选 + B1 决策门实测**（11 项逐项实测报告，基础能力项全过才冻结——⑧⑨ 失败不构成 B1 失败，B3 降级为主；决议 #46）；任一基础能力项失败 → B1 停止提交证据 → 评估 better-sqlite3（不得在纯文档任务新增依赖）                                                   |
| Q2  | Source 身份模型：单作用域 vs origin/page 双作用域 | **origin/page 双作用域**；origin 唯一键 = 规范化 origin；page 唯一键 = 去 fragment 规范化完整 URL；duplicate 由数据库唯一约束保证（不靠先查后写）                                                                                                                       |
| Q3  | canonicalization 规则强度                         | **保守规则集**：仅 http/https、拒 userinfo、scheme/host 小写、IDN 用标准 URL 解析后稳定 host、去默认端口与 fragment、保留路径大小写/非默认端口/普通 query；不自动删 query、不自动合并同域；utm_* 默认保留                                                               |
| Q4  | Source Tool 集合：8 个细粒度 vs 最小 4 工具       | **最小 4 工具**：source_search/source_list/source_get/source_apply_changes（add/update/move/tag/disable/restore 全部走受控 change set，权限面最小）                                                                                                                     |
| Q5  | Source 工具权限分级                               | search/list/get = L0（有界 + 分享模式过滤）；apply_changes = L2（数量/字段/版本/diff/事务/确认全部受控）                                                                                                                                                                |
| Q6  | AI 分享模式与默认值                               | 三态 full/metadata/blocked；用户明确写备注默认 full、无备注快速收藏默认 metadata（UI 明示可改）；blocked 在工具视角完全不可见                                                                                                                                           |
| Q7  | 多语言检索实现                                    | FTS5 trigram 为主（B3 实测中文/日文/英文/一般子串）；分流与排序语义经 B3 实施前裁决细化（决议 #60/#61/#62：1 字符仅精确、2 字符精确+前缀+子串 LIKE、≥3 字符 FTS、URL 判定集合；档位严格不可跨档 + scope+canonicalKey+id 收尾全序；FTS 不可用仅指建库后 MATCH/构造失败） |
| Q8  | change journal 边界                               | 默认最近 100 个 change set 且最长 30 天，任一上限到达清理旧 payload；清理时机由 B2 以可注入时间测试定稿                                                                                                                                                                 |
| Q9  | 迁移前一致性备份方案                              | B1 实测冻结三候选：VACUUM INTO（SQLite ≥3.27 官方）/node:sqlite backup API（若存在）/关闭连接后复制文件；WAL 活跃时不得只复制主文件；integrity/foreign-key 检查失败不覆盖原库                                                                                           |
| Q10 | usage/health 关联方式                             | 每 run 独立 SourceSearchHintStore（类比 InteractionSemanticsStore）：source_search 命中登记 canonical key → 同 run 内 browser_open 成功后主进程比对 → 命中则记录 usage；无后台巡检                                                                                      |
| Q11 | Sources UI 形态                                   | AI 侧栏新增 Sources 面板（与 AiPanel 并列切换，沿用 380px 侧栏模式）；手工操作与快速添加走既有 IPC/bridge 模式扩展                                                                                                                                                      |
| Q12 | 编号体系                                          | 任务 B1–B9、威胁 ST-01～ST-12、红队 SRT-01～SRT-12；历史 T/S/A/RT/R 编号不变不复用                                                                                                                                                                                      |

## 8. Entry Gate 核验记录（2026-08-15，本会话独立核验）

按 Fourth_stage.md §2 五项逐项核验（证据：Git HEAD `82f7838` = Gitee/GitHub 双远程
HEAD（ls-remote 实测）、工作区干净、基线 test 785/785 待本闭环验证矩阵复跑确认）：

1. **Browser Agent 已有稳定 open/read/search 工具** ✅：13 工具注册表
   （8 只读导航 + 4 交互 + search_web）A1–A6 已实现并经 `grep -n "^export"`
   代码核对（本会话 Explore 核查：AGENTS.md §5 契约与代码一致，4 处文档滞后性
   遗漏与契约无冲突）；第三阶段 §9 五组 PASS + 真实 Provider 验收 GO/PASS。
2. **Tool Registry 与权限系统稳定** ✅：ToolDefinition 注册表 + 确定性权限纯函数
   - L2 确认状态机 + 审计管线（ToolExecutor 单出口），A6 后契约零变更；扩展点
     已确认（ToolExecutionContext 可增注入点、TOOL_BASE_RISK 可增条目、
     contentBudgetFor 可增预算分支——本会话代码核对）。
3. **当前项目已明确哪些本地数据需要持久化** ✅：第三阶段持久化为会话 JSON（含
   ToolStep 精简版）与凭据/配置；本阶段 Sources 为唯一新增长期数据面（详见
   detailed-design §1 文件布局与 §7 存储契约）；usage/health 仅最近一次记录。
4. **第一至三阶段无阻塞级安全问题** ✅：第三阶段 GO/PASS + F-1～F-4 已关闭
   （F-1 测试设施墙钟断言已确定性化；F-2～F-4 文档矛盾/陈旧已校正）；
   O-1（会话文件名 UUID 形状校验）为非阻塞纵深观察，与 Sources 无信任边界交叉，
   维持计划内观察不升级；第三阶段四类语义层残余风险已登记为已接受的剩余设计
   风险（Fourth Stage 前按 ROADMAP 重新评估——本闭环已在 threat-model §5 完成
   评估并继承，新增两类登记）。

**结论：Entry Gate 通过，无阻塞项**。SQLite 相关能力（node:sqlite/FTS5/trigram）
属第四阶段自身交付物（B1 决策门实测），不构成前置阻塞——与第三阶段 A1
「tool-calling 兼容层」的循环式门槛校正同模式：**B1 实测全部通过前，禁止引入
任何 Source 域模型/Repository/Tool/UI 实现**。

## 9. 验收标准映射（Fourth_stage.md §9 → 本阶段测试落点）

完整清单见 Fourth_stage.md §9（已按本设计闭环校准）；映射见
`doc/stage4/detailed-design.md` §13 测试规格与 §14 验收核对清单（B9 实施）：

- **Storage**：SQLite 与 migration 稳定 → B1/B7；Source CRUD 走 Service/Repository
  → B2；重启后数据保留 → B2/B7（跨进程持久化冒烟，沿用 AIBROWSE_SESSION_SMOKE
  同模式）；
- **Sources**：可分组/标签/备注/优先级 → B2；可手工管理 → B5；可自然语言让 AI
  添加/修改 → B4/B6；可搜索长期信源 → B3；
- **AI**：Agent 能优先检索相关 Sources → B3/B4；Source 用户备注能影响检索/使用
  策略（有限度：命中排序与返回）→ B3；用户备注不能突破安全政策 → B4/B8；
- **Engineering**：migration/FTS/SourceService 自动测试 → 各任务；全量验证通过 →
  每个任务；数据库失败有可诊断日志（中文）→ B1/B7。

## 10. 里程碑划分（每任务 = 一个可验证开发闭环，任务文档见 doc/stage4/tasks/）

| 任务 | 内容                                                                                                                       | 依赖   |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| B1   | **node:sqlite 决策门 spike（硬前置）** + SQLite/migration 基座：11 项实测（dev+生产构建）→ 冻结 driver                     | 无     |
| B2   | Source 域模型 + canonicalization + Repository（唯一约束）+ SourceService + 事务 + change journal + Undo                    | B1     |
| B3   | 多语言 Source Search：FTS5/trigram + 短查询降级 + 有界 Retrieval + 分享模式 + 确定性排序                                   | B2     |
| B4   | Source Tools 四工具 + 权限矩阵 + L2 change set（幂等键/expectedVersion/diff/确认/审计）+ Agent 上下文隔离                  | B2、B3 |
| B5   | Sources UI + 手工管理 + 当前页快速添加 + 冲突/恢复态/Undo 展示 + IPC/bridge 扩展                                           | B2、B3 |
| B6   | AI 自然语言管理端到端（change set 全链路 + Undo）+ Browser Agent 复用（source_search → browser_open/read）+ usage 记录接线 | B4、B5 |
| B7   | 跨进程持久化 + migration/backup/recovery 全矩阵 + FTS rebuild 诊断 + usage/health 边界                                     | B2、B6 |
| B8   | SRT-01～SRT-12 红队矩阵 + 安全审计 + 隐私扫描 + 真实 Provider/真实网页可选验证                                             | B1–B7  |
| B9   | Fourth Stage 独立最终验收：**在当前 HEAD 重新复验（不采信 B1–B8 完成报告）** + Exit Gate 判定 + 文档同步                   | B1–B8  |

**红线（每个任务文档重申）**：B1 决策门实测基础能力项全部通过前禁止任何 Source 域模型/
Repository/Tool/UI 实现；无万能工具（source_sql/source_delete_hard/
source_export_all/任意导入/任意抓取/任意通用数据库工具不存在，grep 断言）；
业务 SQL 仅为 Repository 编译期常量与 migration（prepared statement 参数绑定，无
exec 动态串、无扩展加载）；driver 仅连接级运维 SQL 编译期常量（PRAGMA/事务
控制）；测试专用 SQL 仅限冒烟 B-01 与单测（决议 #47）；不得放宽第一阶段
Electron 安全边界、第二阶段 Key
零暴露红线与第三阶段权限/确认/审计契约；威胁模型（doc/stage4/threat-model.md）
先于任何 Source 实现定稿（已满足）。

## 11. 相对 Fourth_stage.md 草案的收紧记录（2026-08-15）

1. **任务编号与威胁编号**：B1–B9 / ST-01～ST-12 / SRT-01～SRT-12（草案无编号
   要求，此处固定避免与历史编号重名）。
2. **工具集从 8 个细粒度收敛为 4 个**：草案概念工具 source.search/list/get/add/
   update/move/tag/disable 收敛为 source_search/source_list/source_get/
   source_apply_changes——写入统一走受控 change set（权限面最小、确认一次、
   事务化、可 Undo）；**明确无 source_delete_hard**（草案「删除应采用可撤销/
   软删除策略」升级为：Agent 无硬删除工具；永久删除仅为用户手工 UI 通道）。
3. **新增 SQLite driver 决策门**：草案直接假设「引入 SQLite」；本闭环要求 B1 在
   Electron dev+生产构建实测 11 项后才冻结 node:sqlite，失败停止并提交证据。
4. **新增 provenance 五元组**：草案 §4 只有 trust 类型列表；本闭环固定
   trust_value + trust_asserted_by（user|ai）+ trust_verification（asserted|
   unverified）分离——AI 推断永远不能伪装成用户断言，UI 必须展示来源。
5. **新增 change set 安全模型**：幂等键（主进程生成）、expectedVersion 乐观并发、
   ≤20 项、确认前数据库零变化、deny/timeout/cancel/迟到/未知 toolCallId 零写入、
   单事务全提交或全回滚、durable Undo（重启后可用、版本冲突拒绝）。
6. **新增分享模式与有界检索**：full/metadata/blocked 三态 + 默认规则；source_search
   硬上限 10、source_list 每页 20、返回 allowlist、note 仅命中少量返回 + 控制字符
   清理 + 截断；本地过滤排序禁止整库发模型。
7. **新增 change journal 边界**：最近 100 个 change set 且最长 30 天，任一上限到达
   清理旧 payload。
8. **新增 migration/backup/recovery 契约**：user_version 单调迁移、迁移前一致性
   备份（WAL 约束）、未知更高版本/损坏库 → Sources 只读恢复态（浏览器其余能力
   可用）、integrity 失败不覆盖原库、中文诊断、恢复保留原库。
9. **新增 usage/health 范围约束**：无后台巡检；仅 Agent 实际经 Source 打开/读取后
   记录最近一次（五态枚举）；不保存网页正文、不宣称长期健康。
10. **新增本地明文边界声明**：v1 明文保存 URL/分组/标签/备注，依赖 OS 用户权限，
    不承诺静态加密；API Key 仍只走 safeStorage/DPAPI，绝不进 Sources 数据库。
11. **Fourth_stage.md §9/§10 用最终权限/隐私/撤销/检索/migration/Exit Gate 边界
    校准**（本闭环已同步）；§5 非目标补充「不把 AI 推断 official 当已核验事实」。
