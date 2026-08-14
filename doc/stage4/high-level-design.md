# AIbrowse 第四阶段 高层设计（Sources 长期信源系统）

> 本文件是第四阶段高层设计：架构/决策/模块/数据流/安全模型/存储/测试/风险。
> **接口契约唯一来源是 `doc/stage4/detailed-design.md`**（本文件不复制签名细节）；
> 安全契约源 `doc/stage4/threat-model.md`（ST-01～ST-12 / SRT-01～SRT-12）。
> 需求源 `Fourth_stage.md`（根目录，已按本设计闭环校准）；任务 B1–B9 见
> `doc/stage4/tasks/`。

## 1. 架构总览

第四阶段新增一条**主进程专属**的数据链，与既有 Agent 工具管线正交复用：

```
（新增）Sources UI（渲染进程，B5）
   └─ IPC（sender+主帧校验）→ 主进程 SourceService  ←──────┐
（新增）Agent Source Tools（source_search/list/get/apply_changes，B4）   │
   └─ ToolRegistry → PermissionPolicy → ConfirmManager → ToolExecutor    │
        └─ ToolExecutionContext.sourceService ───────────────┘
                                                              ↓
                                            SourceService（UI 与 Agent 共用唯一入口）
                                              ├── SourceRepository（唯一 SQL 执行点，编译期常量 + prepared statements）
                                              ├── SourceSearchIndex（FTS5/trigram 索引维护 + 查询纯函数）
                                              ├── SourceChangeJournal（持久 Undo 数据，有界）
                                              └── UsageTracker（仅 Agent 打开/读取后记录最近一次）
                                                              ↓
                                            SQLite driver（主进程，node:sqlite 候选，B1 决策门冻结）
```

- **依赖方向固定不可反向**：`Sources UI / Agent Source Tools → SourceService →
SourceRepository / SourceSearchIndex / SourceChangeJournal → SQLite driver`。
- renderer、preload、AgentLoop、Tool 实现**不得直接执行 SQL**；UI 与 Agent 共用
  同一 SourceService（同一事务/审计/Undo 语义）。
- 打开网页复用既有 `browser_open/browser_read → BrowserController`——Source Tool
  **不新增任何网络能力**。
- 纯核心（canonicalization、change set 解析/diff、检索查询构造、迁移定义、
  排序器）零 Electron 依赖可单测；SQLite 打开/关闭/备份为薄胶水层。

## 2. 关键技术决策

| #   | 决策                                                      | 理由                                                                                                                                                                    |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SQLite driver：node:sqlite 首选 + B1 决策门               | 零新依赖、无 native addon ABI/rebuild；官方资料不足以放行（Electron 曾有缺失缺陷、FTS5 编译项无官方确认）→ 11 项逐项实测，基础能力项（①–⑦、⑩、⑪）全过才冻结（决议 #46） |
| 2   | Source 身份：origin/page 双作用域 + 保守 canonicalization | 域模型最小表达「整个站点」与「具体页面」；保守规则不丢用户数据；duplicate 由唯一约束保证                                                                                |
| 3   | 写入统一为 change set（≤20 项）+ L2 确认 + 单事务         | 权限面最小（1 个写工具 vs 8 个细粒度）；确认一次看全 diff；事务化保证一致性与可 Undo                                                                                    |
| 4   | provenance 五元组（trust_value/asserted_by/verification） | AI 推断永远不能伪装成用户断言；UI 明示来源                                                                                                                              |
| 5   | 分享模式三态（full/metadata/blocked）+ 有界检索           | 私人备注默认不外发；blocked 工具视角不可见；本地过滤排序禁止整库进模型                                                                                                  |
| 6   | FTS5 trigram 为主 + 参数化降级                            | 中文/日文子串检索零外部依赖；短查询/特殊串/FTS 不可用安全降级；查询串只作数据                                                                                           |
| 7   | 幂等键（主进程生成）+ expectedVersion 乐观并发            | 重放不重复写；确认前状态变化被确定性拒绝                                                                                                                                |
| 8   | durable Undo（journal 有界 100 条/30 天）                 | 重启后可用；版本冲突拒绝不覆盖；有界控制暴露面                                                                                                                          |
| 9   | migration 单调逐级 + 迁移前一致性备份 + 只读恢复态        | 迁移中断可恢复；损坏/未来版本不静默读写；浏览器其余能力继续可用                                                                                                         |
| 10  | usage/health 仅 Agent 实际打开/读取后记录最近一次         | 无后台巡检；不保存正文；不宣称长期健康                                                                                                                                  |
| 11  | v1 本地明文 + 不承诺静态加密                              | 本地检索需要明文；README/UI 如实说明；Key 仍只走 safeStorage/DPAPI                                                                                                      |

## 3. 模块职责

| 模块（新）               | 文件（规划）                                       | 职责 / 边界                                                                                                                                                 | 任务     |
| ------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| SQLite driver            | src/main/sources/db/sqlite-driver.ts               | node:sqlite 薄封装：打开（userData 路径）/busy timeout/外键/WAL/关闭句柄清理；仅连接级运维 SQL 编译期常量（PRAGMA/事务控制，决议 #47），无业务 SQL 语句定义 | B1       |
| migration 引擎           | src/main/sources/db/migrations.ts                  | schema 版本（PRAGMA user_version）单调逐级；每级单事务；异常 rollback；迁移前触发备份                                                                       | B1/B2/B7 |
| 备份模块                 | src/main/sources/db/backup.ts                      | 一致性备份（方案 B1 实测冻结）；integrity/foreign_key 检查；只读恢复态判定                                                                                  | B1/B7    |
| Source 域类型            | src/shared/types/sources.ts                        | Source/SourceGroup/SourceTag/change set/provenance/share mode 共享类型（单一事实源）                                                                        | B2       |
| canonicalization 纯函数  | src/main/sources/domain/source-canonical.ts        | 规范化 origin/page key；纯函数零依赖                                                                                                                        | B2       |
| change set / diff 纯函数 | src/main/sources/domain/source-change-set.ts       | change set 结构校验（字段白名单/长度/枚举/≤20）；确定性 before/after diff 生成                                                                              | B2/B4    |
| Repository               | src/main/sources/repository/source-repository.ts   | **唯一 SQL 执行点**：编译期常量语句 + prepared statement 参数绑定；唯一约束落地                                                                             | B2       |
| FTS 索引维护             | src/main/sources/repository/source-search-index.ts | FTS5 表与主表事务内同步；查询串纯函数构造；诊断性 rebuild                                                                                                   | B3       |
| Change Journal           | src/main/sources/repository/change-journal.ts      | 持久 Undo 数据（before/after payload）；有界清理（可注入时间）                                                                                              | B2       |
| SourceService            | src/main/sources/source-service.ts                 | UI 与 Agent 共用唯一入口：CRUD/search/applyChangeset/undo/hardDelete/usage/recovery 态                                                                      | B2       |
| UsageTracker             | src/main/sources/usage/usage-tracker.ts            | 仅记录 Agent 实际打开/读取后的最近一次 usage（五态）                                                                                                        | B7       |
| Source Tools             | src/main/sources/tools/source-tools.ts             | 四工具定义与 executor（只经 ctx.sourceService，零 Electron import）                                                                                         | B4       |
| Sources UI               | src/renderer/src/ai/sources/                       | 面板/列表/详情/快速添加/冲突与恢复态提示/Undo（纯文本渲染 note）                                                                                            | B5       |
| IPC/bridge 扩展          | shared/types/ipc.ts + preload                      | sources 通道白名单（sender+主帧校验、逐参数验证、事件只发主窗口）                                                                                           | B5       |

既有模块扩展点（本会话代码核对确认）：`ToolExecutionContext` 增 `sourceService?`
（类比 `searchProvider?`）；`TOOL_BASE_RISK` 增 4 条目；`contentBudgetFor` 增
source 预算分支；`ToolResultErrorCode` 增 source 相关错误码（同步
conversation-store TOOL_RESULT_ERROR_CODES 与 agent-display 文案）；index.ts
注册区增 4 工具；冒烟「注册表恰好 13 工具」断言校准为 17。

## 4. 数据流（关键路径）

### 4.1 AI 写（change set 全链路，B4/B6）

```
模型提议 source_apply_changes(changeset≤20项)
→ ToolRegistry 校验（schema/字段白名单/长度/枚举）
→ PermissionPolicy decide → L2
→ ConfirmManager.requestConfirm（pending，确认前数据库零变化）
→ [UI ConfirmDialog 展示主进程生成的确定性 before/after diff；deny 默认焦点]
→ approve(toolCallId) 精确一次
→ SourceService.applyChangeset：
   读当前状态 → 逐项 expectedVersion 校验（不符 → 整体拒绝零写入）
   → 单事务：全部变更 + FTS 同步 + journal 写入（idempotency key UNIQUE）
   → 全部成功提交 / 任一失败 rollback
→ ToolResult（结构化 ok/error + 每项结果）
→ 审计恰好一条（项数/字段名/长度/版本/幂等键，note 正文零出现）
```

deny/timeout/cancel/迟到/未知 toolCallId → 零写入（复用 A6 状态机契约）；
重放同幂等键 → 幂等返回不重复写；跨 run 旧引用 → 版本校验拒绝。

### 4.2 AI 读（有界 Retrieval，B3/B4）

```
模型调用 source_search(query≤500) / source_list / source_get
→ 本地 FTS5 trigram 查询（查询串纯函数转义；短查询/特殊串 → 参数化精确匹配/LIKE）
→ 分享模式过滤（blocked 不可见）+ 返回 allowlist
→ 确定性排序（精确>前缀>tag/group>name/domain>note；priority 有限加分；recency 次级；canonical_key 定序）
→ 命中 ≤10（search）/每页 ≤20（list）；note 仅 full 模式 + 有界截断 + provenance + 控制字符清理
→ ToolResult 预算截断 → UNTRUSTED_TOOL_RESULT 块回注模型
→ 审计（查询串全量 ≤500 / 分页参数与条数）
```

### 4.3 手工操作（B5）

```
UI（Sources 面板/快速添加按钮）
→ IPC sources:*（sender+主帧校验 + 逐参数验证）
→ SourceService（与 Agent 同一事务/审计/Undo 语义）
→ sources:changed 事件 → UI 更新
→ 手工永久删除：UI 二次确认 → hardDelete（不可 Undo，清理 FTS/usage/journal 私人 payload）
```

### 4.4 usage/health（B7，仅事后记录）

```
run 内 source_search 命中 → 主进程按 runId 登记 canonical key（SourceSearchHintStore）
→ 同 run 内 browser_open(url) 执行成功 → 规范化 URL 与命中 key 比对
→ 命中 → SourceService.recordUsage(sourceId, reachable/unreachable/…)
（unknown/auth-required/blocked 为枚举占位——v1 无可靠触发信号者如实登记宁缺勿错）
```

### 4.5 启动/迁移/恢复（B1/B7）

```
app ready → userData 路径（主进程唯一确定）
→ 打开库（busy timeout/外键/WAL）→ 读 user_version
→ = 程序版本：正常
→ < 程序版本：备份（B1 冻结方案）→ 单事务逐级迁移 → integrity_check → 失败不覆盖原库
→ > 程序版本：Sources 只读恢复态（中文诊断；浏览器其余能力继续可用）
→ 损坏：只读恢复态 + 恢复流程保留原库
```

## 5. 安全模型（概要，契约源 doc/stage4/threat-model.md）

- **继承**：第三阶段五层防线（结构/能力/决策/审计/运行时）与四类残余风险全部
  保持；Source 数据与网页内容同等视为不可信输入（UNTRUSTED_TOOL_RESULT 块）。
- **新增四条主线**：
  1. 写入安全：change set ≤20 项 → L2 确认 → 幂等键 + expectedVersion → 单事务 →
     durable Undo；确认前零变化；无硬删除工具；
  2. 检索隐私：本地过滤排序 + 硬上限 + allowlist + 分享模式 + note 有界返回；
  3. 数据完整：单调迁移 + 一致性备份 + 只读恢复态 + 不覆盖原库 + 中文诊断；
  4. provenance 诚实：trust_value/asserted_by/verification 分离，AI 推断永远
     是 unverified，UI 明示。
- **威胁与红队**：ST-01～ST-12 威胁枚举 + SRT-01～SRT-12 红队矩阵（B8 实施）；
  安全结论分「机器可证明」「观察性结果」「不承诺」三类。

## 6. 存储

| 存储           | 位置（主进程 userData 下）      | 内容 / 边界                                                                  |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| Sources 数据库 | `sources/sources.db`（B1 冻结） | 明文 v1：sources/groups/tags/links/change_journal/usage/FTS5；不承诺静态加密 |
| 备份           | `sources/backups/`（B1 冻结）   | 迁移前一致性备份（有界保留数量，B7 定稿）                                    |
| 会话/凭据/配置 | 既有路径（不变）                | conversations/、credentials.json（safeStorage 密文）、provider-config.json   |
| 审计           | 既有 logger（不变）             | 结构化条目脱敏；Source 变更记摘要（note 正文/敏感 query 零出现）             |

- 数据库、备份、change journal **不进入模型上下文**（无任何读取通道）。
- API Key 绝不进入 Sources 数据库（红线 grep 断言）。

## 7. 测试策略

- **单测（Vitest，node 环境）**：canonicalization 矩阵、change set 校验/diff、
  检索查询构造与排序器、FTS 降级、journal 清理（可注入时间）、迁移定义逐级、
  备份决策逻辑——纯核心零环境依赖；node:sqlite 的真实行为由 B1 冒烟实测 +
  单测中 DatabaseSync 仅作为明确豁免的薄胶水（或注入驱动接口）。
- **冒烟（Electron 真实启动，临时 userData）**：B1 决策门 11 项探针（dev+生产
  双场景）；B2–B7 各任务矩阵（CRUD 持久化/唯一约束/change set 确认 deny・approve/
  Undo 重启后可用/只读恢复态/usage 记录/快速添加 UI 端到端）；B8 红队 SRT-01～
  SRT-12 + RT 全矩阵回归。
- **真实 Provider 可选验证（B6/B8）**：AI 自然语言管理端到端 + 真实网页诱导场景
  （沿用第三阶段凭据流程，门控 `AIBROWSE_LIVE_AGENT_SOURCES=1` + harness
  `-Sources`，与既有门控互斥）。
- **跨进程持久化**：沿用 `AIBROWSE_SESSION_SMOKE` 同模式双进程验证（进程 A 写入
  → 进程 B 读回；含 Undo 数据）。

## 8. 风险与不确定性

- **B1 决策门失败**（最大不确定性）：node:sqlite 在 Electron 43.4.0 dev/生产构建
  的**基础能力项（①–⑦、⑩、⑪）任一失败** → B1 停止提交证据 → 评估 better-sqlite3
  （native addon：ABI 对齐/rebuild/electron-vite 外部化成本）；⑧⑨ 失败不构成
  B1 失败（决议 #46）。设计已按「Repository 独占 SQL + 驱动薄封装」隔离，替换
  driver 不影响上层契约。
- **FTS5/trigram 不可用**：Node 官方构建是否启用 SQLITE_ENABLE_FTS5 无官方确认
  → B3 降级路径（参数化精确匹配/LIKE）为完整可交付实现，FTS 仅为增强；如实登记
  （⑧⑨ 实测结论由 B1 报告，不构成 B1 失败）。
- **node:sqlite Stability 1.1（实验性）**：API 可能变动——Repository 内语句与
  驱动调用集中在薄层，升级 Node/Electron 时按基线升级流程回归；ExperimentalWarning
  如实记录不压制。
- **语义层残余风险**：长期资料污染与垃圾写入噪声（threat-model §5 第六类新增）
  ——结构性缓解 + 如实登记，不宣称免疫。
- 依赖与风险逐项落点见 detailed-design §13/§14 与各任务文档「风险与停止条件」。
