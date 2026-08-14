# Fourth_stage.md — Sources 信源库与 AI 自然语言管理

> 前置阶段：`Third_stage.md`（第三阶段总 Exit 决策 = `GO/PASS`，2026-08-14）。
> 核心目标：把传统浏览器“收藏夹”升级为可被 AI 理解、检索、自动维护的长期信息源系统。
> **阶段状态（2026-08-15）**：Fourth Stage 已正式进入（用户切换指令）；详细设计与
> B1–B9 任务拆分已完成（纯文档设计闭环）；**尚未实现任何 Sources 功能**；
> 下一个推荐任务 = **B1**（node:sqlite 决策门 spike，硬前置）。
> **契约与安全契约源**：本文保留阶段需求源职责（目标/验收标准/Exit Gate），
> 具体接口、schema、权限矩阵、预算与决议以 `doc/stage4/detailed-design.md` 为
> **唯一契约源**；威胁与红队以 `doc/stage4/threat-model.md` 为**安全契约源**。
> 任务里程碑 B1–B9 见 `doc/stage4/tasks/`。

## 1. 阶段定位

本阶段建立：

**Sources = URL + 分类（分组）+ 标签 + 优先级 + 用户自然语言备注 + AI 备注 + provenance（信任与来源）+ 启用状态 + 使用状态**

用户不应被迫逐项填写表单。

核心体验：

> “这个网站以后查大模型 benchmark 时优先看。”

AI 应理解为长期信源指令，并在安全规则允许时创建/更新 Source。

> （2026-08-15 设计闭环校准）写入统一为**结构化 change set + L2 确认 + 单事务 +
> durable Undo**（详细设计 §7）；Agent **无硬删除工具**（disable/restore 为显式
> 操作；永久删除仅为用户手工 UI 通道，二次确认、不可 Undo）。

---

## 2. Entry Gate

要求：

- Browser Agent 已有稳定 `open/read/search` 工具；
- Tool Registry 与权限系统稳定；
- 当前项目已明确哪些本地数据需要持久化；
- 第一至三阶段无阻塞级安全问题。

> （2026-08-15）Entry Gate 核验记录见 `doc/stage4/proposal.md` §8（逐项通过；
> node:sqlite/FTS5 能力属第四阶段自身交付物，由 B1 决策门实测冻结——通过前禁止
> 任何 Source 实现，与第三阶段 A1 硬前置同模式）。

## 3. 本阶段目标

### 3.1 SQLite 持久化层

引入 SQLite 及 migration 机制。

> （2026-08-15 设计闭环校准）driver 首选 `node:sqlite`（零依赖、无 native addon
> ABI/rebuild），但**必须经 B1 决策门在 Electron dev+生产构建实测 11 项能力全部
> 通过后才冻结**（import/文件库/prepared statements/事务/外键/busy timeout/FTS5/
> trigram/userData 路径/句柄清理）；失败则 B1 停止并提交证据，再评估
> better-sqlite3 等备选。官方声明不替代本项目实跑（详细设计 §3.2）。

需要建立 Repository / Service 边界，禁止 UI 或 Agent 直接执行 SQL：

- 依赖方向固定：`Sources UI / Agent Source Tools → SourceService →
  SourceRepository / SourceSearchIndex / SourceChangeJournal → SQLite driver
  （主进程）`；
- renderer、preload、AgentLoop、Tool 实现不得直接执行 SQL；
- UI 与 Agent 共用同一个 SourceService；
- SQL 只能是 Repository 内的编译期常量或 migration；所有用户/网页/模型文本只能
  作为 prepared statement 参数；禁止 `exec(sql)` 动态串、动态表名/列名/排序
  表达式、SQLite 扩展加载；
- Source Tool 不得新增网络能力，打开网页继续复用既有 Browser Tools。

概念实体：

- Source（origin/page 双作用域，canonical key 唯一）
- SourceGroup
- Tag（SourceTag relation）
- change journal（持久 Undo 数据，有界）
- usage（每 Source 最近一次使用结果，不保存网页正文）

### 3.2 Source 基本字段

- id / scope（origin|page）/ canonical key / url / name / group / tags /
  priority / enabled / share_mode（full|metadata|blocked）/
  trust（value + asserted_by + verification）/ user_note / ai_note /
  created_by / version（乐观并发）/ created_at / updated_at / deleted_at /
  last_used_at / last_usage_outcome

> （2026-08-15 设计闭环校准）字段契约以 `doc/stage4/detailed-design.md` §2/§5
> 为准；provenance 五元组分离保证 **AI 推断的 official/primary 永远是
> unverified，不能伪装成用户断言**。

### 3.3 用户自然语言备注

用户可添加：

- “关注 XX 行业时优先看这里。”
- “这个网站适合看 benchmark，但厂商声明仍要回官方核验。”
- “只用来查看日本中古市场价格。”
- “这是我的学校教务相关网站。”

备注属于长期 AI 指令的一部分，但：

- 不能覆盖系统安全规则；
- 不能自动提升 Tool 权限；
- 应明确标记来源是用户备注还是 AI 推断。

> （2026-08-15 设计闭环校准）**AI 分享模式**：用户明确写下供 AI 长期使用的备注
> 默认 `full`（检索时可有界返回 + provenance）；无备注快速收藏默认 `metadata`
> （无 note 正文）；`blocked` 在工具视角完全不可见（仅用户 UI 可设）。备注经
> `UNTRUSTED_TOOL_RESULT` 块回注模型（不可信纯文本），不能改变 system、工具
> 列表或权限。普通日志/审计/ToolStep 不记录备注正文（详细设计 §8.2/§7.6）。

### 3.4 AI 自动添加/修改信源

支持自然语言意图，例如：

- “收藏这个网站。”
- “这个站以后查 AI 模型价格时优先。”
- “把这三个网站放进‘AI Benchmark’。”
- “以后不要再优先用这个站。”
- “把这个来源标成官方来源。”

Agent 使用受限 Source Tools。**v1 固定为最小 4 工具**（wire-safe 命名）：

- `source_search`（L0，硬上限 10，本地检索）
- `source_list`（L0，每页 ≤20）
- `source_get`（L0，单条）
- `source_apply_changes`（L2：add/update/disable/restore 统一走受控 change set）

不得提供：`source_sql`、`source_delete_hard`、`source_export_all`、任意路径导入、
任意网络抓取、任意通用数据库工具。

> （2026-08-15 设计闭环校准）所有 Agent 发起的持久化变更统一为：
> 模型提出结构化 change set（≤20 项）→ 主进程读取当前状态 → 生成确定性
> before/after diff → **L2 用户确认** → **单事务提交（全部成功或全部回滚）** →
> durable Undo。固定要求：确认前数据库零变化；主进程生成的 idempotency key
> （重放不重复写）；expectedVersion 乐观并发；deny/timeout/cancel/迟到/未知
> toolCallId 均零写入；ConfirmDialog 展示程序生成的确定性 diff（网页/模型文本
> 只能以不可信纯文本呈现）。手工 UI 仍经 SourceService 并提供 Undo
> （详细设计 §7）。

### 3.5 Source Retrieval

建立信源检索能力。

- FTS5 trigram 多语言检索（中文/日文/英文/一般子串，B1 实测冻结后启用）+
  1–2 字符短查询/特殊 URL/FTS 不可用时的参数化精确匹配/LIKE 安全降级；
- name/domain/group/tag/user_note/ai_note 检索（note 受分享模式约束）；
- 排序确定性：精确/前缀 > tag/group > name/domain > note；priority 只有限加分；
  recency 仅作次级 tie-break（详细设计 §8.3）；
- **有界 Retrieval**：`source_search` 默认/硬上限 10；`source_list` 每页 ≤20；
  统一 ToolResult 总字符预算；本地完成检索/过滤/排序，**禁止把整库发给模型**；
  返回字段使用 allowlist；查询中的引号/通配符/FTS 操作符/SQL 片段只作为数据。

**本阶段默认不引入向量数据库。**

### 3.6 Sources UI

至少支持：

- 分组浏览；搜索；查看备注和标签；手工添加/编辑；
- 查看最近使用/健康状态（**最近一次使用结果**，不宣称长期健康）；
- 从当前网页快速添加 Source（无备注默认 metadata，UI 明示可改）；
- 冲突与「可能相关」提示（不自动覆盖同 origin）；
- Undo 与恢复态中文诊断；
- provenance 展示（「官方来源（用户标定）/ 官方来源（AI 推断·未核验）」）；
- 本地明文如实说明（v1 不承诺静态加密）。

AI 自动操作和手工操作应落入同一 SourceService。

---

## 4. Source Trust 与类型

可扩展元数据：

- official / primary / secondary / community / unknown（trust_value）
- 用途标签（news / benchmark / docs / academic / price / forum / blog）以普通
  tag 承载，不设无法扩展的大枚举

> （2026-08-15 设计闭环校准）trust 三元组：`trust_value + trust_asserted_by
> （user|ai）+ trust_verification（asserted|unverified）`。用户明确说“标成官方
> 来源”可记为 `official + user-asserted`；AI 自行推断只能是 `official + ai +
> unverified`；模型不能经 change set 写入 asserted_by=user（仅用户手工 UI 通道）。
> **不把 AI 推断的 official/primary 当成已核验事实**，UI 必须展示来源。

---

## 5. 非目标

本阶段不做：

- 完整 Research 报告流水线；自动多源交叉核验；引用渲染；图表系统；
- RSS；Watch；Diff；后台定时请求；
- 云同步；多设备；账号系统；
- 大规模 embedding/vector DB；
- 任意 SQL、任意文件系统、任意 HTTP POST、后台抓取（永久红线）；
- **Agent 硬删除**（无 source_delete_hard 工具）；
- **把 AI 推断的 official/primary 当成已核验事实**；
- **Fifth Stage 代码**。

---

## 6. 数据安全与隐私

- Source URL、备注可能包含敏感信息，应视为用户数据；
- 不把整个 Sources 数据库默认发给模型（有界检索 + 分享模式 + allowlist）；
- 只检索和发送当前任务相关的少量 Sources；
- 日志不得记录完整私人备注与完整敏感 URL query（普通日志只记 sourceId、
  字段名、数量、长度和结果数）；
- ToolStep/会话不得复制完整私人备注；
- migration 必须可回滚或至少有明确恢复方案（迁移前一致性备份 + 单事务迁移 +
  异常 rollback；integrity/foreign-key 检查失败不得覆盖原库）；
- 未知更高版本进入 Sources 只读恢复态（浏览器其余能力继续可用）；
- 删除/禁用语义必须明确（disable/restore 显式；手工永久删除二次确认、不可
  Undo，并清理 FTS、usage 和 journal 中相关私人 payload）；
- change journal 有界（默认最近 100 个 change set 且最长 30 天，任一上限到达
  即清理旧 payload）；
- 数据库、备份和 change journal 不进入模型上下文；
- **v1 本地明文**：URL/分组/标签/备注按明文保存（本地检索所需），依赖操作系统
  用户权限保护；本阶段不承诺数据库静态加密（README/UI 如实说明）；**API Key
  仍只走既有 safeStorage/DPAPI，绝不进入 Sources 数据库**。

---

## 7. 关键体验验收

阶段结束时至少应通过：

1. 当前网页中说：“以后查 AI benchmark 优先看这个站。”
2. AI 自动生成合理 name/group/tag/note，用户可立即撤销。
3. 新对话问：“我有哪些 AI benchmark 来源？”
4. Source Search 能找到之前的站点。
5. 用户说：“把它改到日本购物组，并备注只用于中古价格。”
6. 变更正确持久化（重启后仍在，可审计、可 Undo）。
7. Browser Agent 可以打开 Source Search 返回的网站（复用既有
   `browser_open/browser_read`）。

> 状态（2026-08-15）：场景 1–7 的设计落点已映射（proposal §3 / detailed-design
> §13.2 冒烟矩阵 + §14 验收清单）；**真实执行待 B1–B6 实现后由 B6/B9 验收**。
> 场景 6 另加恶意诱导变体（诱导收藏并标为官方）由 SRT-01/02 红队覆盖。

---

## 8. 测试重点

- B1 node:sqlite 决策门 11 项实测（dev+生产构建）；
- migration（单调逐级/事务/异常回滚/未知高版本/一致性备份/损坏库）；
- canonical URL / duplicate detection（唯一约束，不靠先查后写）；
- FTS5/trigram 多语言 + 短查询安全降级 + 确定性排序 + 索引一致性/rebuild；
- group/tag relation；
- change set（≤20 项/字段白名单/幂等键/expectedVersion/单事务/中途失败整体
  rollback）；
- 确认门（deny 零写入/approve 一次/迟到/未知/重放/跨 run）；
- 用户备注与 AI 备注来源分离（provenance 三元组）；
- 删除/撤销（Undo 重启后可用/版本冲突拒绝/硬删除清理）；
- DB 异常与恢复态（浏览器其余能力可用）；
- Source Tool 权限（L0 有界/L2 确认）与禁具 grep；
- 不把全部数据库泄漏进 prompt（有界检索/allowlist/分享模式）。

---

## 9. 验收标准

> （2026-08-15 设计闭环校准：以下清单用最终权限/隐私/撤销/检索/migration/Exit
> Gate 边界校准原草案；逐项核对与证据回填由 B9 实施，映射见 detailed-design §14。）

### Storage
- [ ] SQLite 与 migration 稳定（B1 决策门 11 项实测通过 + 单调逐级迁移 + 一致性备份）
- [ ] Source CRUD 走 Service/Repository（UI 与 Agent 共用 SourceService；SQL 封闭）
- [ ] 重启后数据保留（跨进程双进程验证，含 change journal/Undo 数据）

### Sources
- [ ] 可分组、标签、备注、优先级
- [ ] 可手工管理（含当前页快速添加、禁用/恢复、Undo、二次确认永久删除）
- [ ] 可自然语言让 AI 添加/修改/整理/禁用/恢复（change set 全链路）
- [ ] 可搜索长期信源（多语言 + 降级路径 + 确定性排序）

### AI
- [ ] Agent 能检索相关 Sources（有界：硬上限 10/每页 20/allowlist/分享模式）
- [ ] Source 用户备注能影响检索/使用策略（检索命中与排序，有限度）
- [ ] 用户备注不能突破安全政策（不可信块 + 权限恒等 + 不提升权限）

### Privacy / Trust
- [ ] provenance 分离：AI 推断永远是 unverified，UI 明示来源
- [ ] 无硬删除工具；disable/restore 显式；手工永久删除二次确认 + 私有 payload 清理
- [ ] 审计/日志/ToolStep 不含备注正文与敏感 URL query；数据库/备份/journal 不进模型上下文
- [ ] v1 明文边界如实说明（README/UI）；API Key 绝不进 Sources 数据库

### Engineering
- [ ] migration / FTS / SourceService 有自动测试
- [ ] SRT-01～SRT-12 红队矩阵全部通过 + RT-01～RT-11 回归通过
- [ ] 全量验证通过（test/typecheck/lint/format:check/build/冒烟双场景）
- [ ] 数据库失败有可诊断日志（中文诊断 + 恢复态不阻塞浏览器其余能力）

---

## 10. Exit Gate

进入 Fifth Stage 前：

- Source 系统在真实使用中可稳定保存、搜索和修改（含真实 Provider 验证，用户
  授权时执行；离线矩阵不替代真实验证的规则不变）；
- 重复 URL、canonicalization、删除语义已明确（唯一约束 + 显式 disable/restore
  + 手工永久删除语义 + Undo 重启后可用）；
- Agent 使用 Sources 时不会一次把整个数据库塞给模型（有界检索断言）；
- 备注与权限边界明确（分享模式 + provenance + 不可信块）；
- FTS 是否足够已由实际使用验证（多语言矩阵 + 降级路径，如实结论）；
- B1 node:sqlite 决策门证据在案（11 项实测 + 驱动冻结决议）；
- 红队矩阵 SRT-01～SRT-12 与第三阶段回归全部通过；
- 隐私扫描与真 Key 零暴露扫描通过（真实验证时）。

**B9 不采信 B1–B8 完成报告**：在当前 HEAD 上重新独立复验全部清单与 Gate。
完成后停止，不直接实现 Research（Fifth Stage）。

---

## 11. 设计文档指针

- 契约源：`doc/stage4/detailed-design.md`（§1 文件布局 / §2 类型 / §3 数据访问
  边界与 driver 决策门 / §4 canonicalization / §5 schema / §6 SourceService /
  §7 写入安全 / §8 有界检索与分享模式 / §9 工具与权限 / §10 migration·backup·
  恢复 / §11 明文边界与 usage / §12 安全契约 / §13 测试规格 / §14 验收核对 /
  §15 决议记录）
- 安全契约源：`doc/stage4/threat-model.md`（ST-01～ST-12 / SRT-01～SRT-12 /
  诚实边界声明）
- 提案与 Entry Gate 核验：`doc/stage4/proposal.md`
- 高层设计：`doc/stage4/high-level-design.md`
- 任务：`doc/stage4/tasks/B1–B9`（每任务 = 一个可验证开发闭环）
