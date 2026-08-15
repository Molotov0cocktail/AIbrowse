# Fourth_stage.md — Sources 信源库与 AI 自然语言管理

> 前置阶段：`Third_stage.md`（第三阶段总 Exit 决策 = `GO/PASS`，2026-08-14）。
> 核心目标：把传统浏览器“收藏夹”升级为可被 AI 理解、检索、自动维护的长期信息源系统。
> **阶段状态（2026-08-15）**：Fourth Stage 已正式进入（用户切换指令）；详细设计与
> B1–B9 任务拆分已完成（纯文档设计闭环）；**B1 已完成**（node:sqlite 决策门
> dev+生产双场景实测通过并冻结，决议 #48 + sqlite-driver/migrations 基座 + 冒烟
> B-01）；**B2 已完成**（Source 域模型 + canonicalization + schema v1 +
> Repository + SourceService + change journal + durable Undo + 冒烟 B-02 双进程）；
> **B3 已完成**（多语言 Source Search：FTS5/trigram 主路径 + 短查询安全降级 +
> 有界 Retrieval 硬上限 10/每页 20 + 分享模式 full/metadata/blocked + 确定性排序
> 全序 + note 摘录 ≤200 + provenance + bidi 补齐，决议 #58–#63，全量 test
> 1007/1007）；**B4 已完成**（Source Tools 四工具 + 权限矩阵 + L2 change set
> 确认/审计 + Agent 上下文隔离，决议 #64–#67，全量 test 1071/1071）；
> **B5 已完成**（Sources UI + 手工管理 + 当前页快速添加 + IPC/bridge，决议
> #68–#78，全量 test 1125/1125，B-05 默认矩阵与双进程门控通过——Sources 功能
> 对用户已可用）；**B6 已完成**（AI 自然语言管理端到端 + Browser Agent 复用 +
> usage 接线，决议 #79–#85，全量 test 1160/1160，冒烟 8.12/8.13 dev+生产双
> 场景、B-02/B-05 双进程复跑、LIVE_AGENT_SOURCES 互斥与离线回退门控全部退出
> 码 0——usage 接线闭环，真实 Provider 场景待用户授权）；
> **B7 已完成**（跨进程持久化 + migration/backup/recovery 全矩阵 + FTS
> rebuild 诊断 + usage/health 展示边界——决议 #86–#91：backup.ts 存储运维
> SQL 窄契约/备份冻结 VACUUM INTO/「迁移失败原库完好」逻辑恒等校准/保留策略
> 冻结（最新 5 + 30 天）/usage 双投影同事务一致/rebuild 受控入口；`db/backup.ts`
> + `sources-store.ts` 启动装配 + 只读恢复态真实生产装配 + 冒烟 8.14 B-06
> B7 部分 + B-02 usage 跨进程扩展；**2026-08-15 事故恢复与安全加固**——环境
> 事故止损（46 个零字节文档碎片 + npm 错误输出文件 + 事故日志精确清理）+ 5 项
> 数据安全修复（头部固定 16 字节读取/目标 fail-closed/碰撞换新名/目录链接
> 真实路径校验/prune 参数边界 + 备份源连接只读，红→绿 11→41/41）+ 受控串行
> 重验，全量 test 1219/1219，dev/生产冒烟与 B-02/B-05/SESSION 双进程退出码 0）；
> **独立审计 + B7 审计后定向修复已完成（2026-08-15，HOLD 解除）**——独立
> 审计发现 backup.ts 备份发布/失败清理 P2 竞态，本闭环修复（决议 #92：两阶段
> staging + 硬链接 no-clobber 原子发布 + 所有权证明精确清理 + 任意路径公共
> 导出移除），红→绿 5 failed/32 passed → 37/37，全量 test 1226/1226，dev/
> 生产冒烟（B-06 全矩阵）与 B-02 双进程退出码 0）；
> **B8 已完成（2026-08-15）**——红队矩阵 SRT-01～SRT-12 + 增量安全审计 +
> 隐私扫描（决议 #93 校准：冒烟场景编号 8.15——8.7 已被 B1 决策门占用；
> SRT-12 边界 = RT-01～08、RT-11 本轮 dev/production 重跑 + RT-09 扩展
> 静态审计 + RT-10 未授权 NOT RUN）：8.6/8.14 结构化证据核验 + 12 项
> 独立机器断言（threat-model §4.1 证据表，全部「机器可证明」分类）+
> SRT-08 发现并修复产品缺陷 1 处（持久化 toolCalls URL query 值脱敏）+
> B-02 SRT-10 跨进程扩展；全量 test 1229/1229，dev+生产冒烟与 B-02/B-05/
> SESSION 双进程全部退出码 0；RT-10 与真实 SRT-01/02 NOT RUN（待用户
> 授权）；
> **B9 已完成（2026-08-15）**——独立最终验收（不采信 B1–B8 报告，当前
> HEAD c8e4122 独立复验）：§9 逐项勾选证据 + §10 八项判定已回填；全量
> test 1229/1229（单 worker）· typecheck · lint · format:check · build
> 全绿；dev/生产冒烟全矩阵（B-01 11 项/8.6 RT/8.14 recovery/8.15
> SRT-01～SRT-12）与 B-02/B-05/SESSION 双进程退出码 0；红线独立复核
> 零回退；**总 Exit 判定 = HOLD/PENDING——唯一缺口 = 真实 Provider
> 验收（本轮用户未授权，RT-10 与真实 SRT-01/02 = NOT RUN）**；
> 下一个推荐动作 = **真实 Provider 补验**（B6/B8 补验任务：仓库外
> harness 补 -Sources 开关 + 用户授权后最小真实 Sources 验收——离线
> 矩阵不替代真实验证）；补验通过前不宣称第四阶段验收通过。
> **第四阶段最终真实 Provider 验收通过（2026-08-16，第五轮运行）**——
> 场景 6/7 导航夹具修复（SMOKE 辅助逻辑 `activateThenNavigate`：激活先于
> 导航/激活失败零导航，红→绿 11 用例，全量 test 1255/1255）后一次完整
> `-Sources` 复验：场景 1a–8 **全部真实通过**（34 次 HTTP 全部 200、
> 8 次 L2 确认全部按纪律决议——1a deny、其余 7 次 approve；durable
> Undo/restore/usage=reachable 实测；真实 SRT-01/02 与 RT-10 观察场景
> 实际到达、结构断言全部通过；真 Key 零暴露扫描 18 文件零命中 + 进程外
> sk-/Bearer 零命中）；**总 Exit 判定 = `GO/PASS`**（§10）。
> **契约与安全契约源**：本文保留阶段需求源职责（目标/验收标准/Exit Gate），
> 具体接口、schema、权限矩阵、预算与决议以 `doc/stage4/detailed-design.md` 为
> **唯一契约源**；威胁与红队以 `doc/stage4/threat-model.md` 为**安全契约源**。
> 任务里程碑 B1–B9 见 `doc/stage4/tasks/`。
> **（2026-08-16 冻结为已完成历史阶段）**：本阶段总 Exit 判定 = `GO/PASS`
> （2026-08-16 第五轮真实 Provider 验收通过，§10 八项全部 PASS）。用户已正式
> 下达 Fifth Stage 切换指令（2026-08-16），当前阶段指针移至 `Fifth_stage.md`，
> 设计文档指针移至 `doc/stage5/`；本文既有验收过程**原位保留、不改写**，
> 此后不再作为当前阶段需求源（历史查证仍以本文与 `doc/stage4/` 为准）。

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

> （2026-08-15 设计闭环校准；2026-08-15 B1 实施前裁决校准，决议 #46）driver 首选
> `node:sqlite`（零依赖、无 native addon ABI/rebuild），但**必须经 B1 决策门在
> Electron dev+生产构建逐项实测 11 项能力（import/文件库/prepared statements/事务/
> 外键/busy timeout/FTS5/trigram/userData 路径/句柄清理）并全部报告；基础能力项
> 全部通过后才冻结**；FTS5/trigram（⑧⑨）失败不构成 B1 失败（B3 以降级路径为主
> 并如实登记）；任一基础能力项失败则 B1 停止并提交证据，再评估 better-sqlite3
> 等备选。官方声明不替代本项目实跑（详细设计 §3.2）。

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

> （2026-08-15 设计闭环校准；2026-08-15 B6 决议 #82 表述校准）trust 三元组：
> `trust_value + trust_asserted_by（user|ai）+ trust_verification（asserted|
> unverified）`。用户经**手工 Sources UI** 标定 → `official + user-asserted`；
> 经 AI 任务口头说“标成官方”（change set 通道——用户确认对话不等于用户通道
> 断言）恒落 `official + ai + unverified`；AI 自行推断同样只能是 `official +
> ai + unverified`；模型不能经 change set 写入 asserted_by=user（仅用户手工 UI
> 通道）。**不把 AI 推断的 official/primary 当成已核验事实**，UI 必须展示来源。

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
> §13.2 冒烟矩阵 + §14 验收清单）；**B6 已落地离线确定性全链路**（冒烟 8.12
> B-06/B-07 + 8.13 UI DOM：收藏当前页 → L2 确认 → 保存 → Sources UI 可见 →
> Undo；搜索已有 Source → source_get → 改组和备注；标 official → provenance
> AI 推断·未核验；降 priority/明确 disable/restore；deny 零写入；
> source_search → browser_open → browser_read → 回答 usage=reachable，dev+
> 生产双场景退出码 0）；**真实 Provider 维度待用户授权**（门控
> `AIBROWSE_LIVE_AGENT_SOURCES=1` 就绪），B9 做最终独立验收。
> 场景 6 另加恶意诱导变体（诱导收藏并标为官方）由 SRT-01/02 红队覆盖（B8）。
> **（2026-08-15 补验基础设施闭环）**：真实场景已扩展为 1a L2 deny 零写入 /
> 1b approve 恰一次 + durable Undo / 1c 数据供应 / 场景 2–5 / 场景 6 真实
> SRT-01 敌对页观察 / 场景 7 真实 SRT-02 敌对 note 观察 / **场景 8 真实
> RT-10 敌对页观察（独立 `rt-10-observe` 场景，复用第三阶段敌对夹具与
> 结构强断言——伪造工具零执行/密码零写入/禁止动作零副作用/零外发/L2 全
> deny/库零新增）**；仓库外 harness `-Sources` 开关就绪；真实执行待用户授权。

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
- [x] SQLite 与 migration 稳定（B1 决策门 11 项逐项实测 + 驱动冻结决议 + 单调逐级迁移 + 一致性备份）
      → **B9 独立复验 PASS**：B-01 11 项本轮 dev+生产双场景实测通过（①–⑦、⑩、⑪ 基础能力项全过，⑧ FTS5/⑨ trigram 可用）；决议 #48 冻结记录在 detailed-design §15；migrations 14 用例 + backup 20 用例 + sources-store 9 用例全绿
- [x] Source CRUD 走 Service/Repository（UI 与 Agent 共用 SourceService；SQL 封闭）
      → **B9 独立复验 PASS**：SQL 执行点 grep 分类——业务 SQL 仅 `sources/repository/`（source-repository/change-journal/source-search-index 编译期常量 + 参数绑定）+ `db/`（driver 连接级 PRAGMA/事务、backup PRAGMA/VACUUM INTO 窄契约、migrations 编译期语句）；source-service/source-ipc/renderer/preload 零 SQL
- [x] 重启后数据保留（跨进程双进程验证，含 change journal/Undo 数据）
      → **B9 独立复验 PASS**：B-02 set/check 本轮生产产物双进程退出码 0（跨进程读回一致 + 重启后 Undo + 重复 Undo 幂等 + 版本冲突拒绝 + usage 投影一致 + SRT-10 hard delete 清理）

### Sources
- [x] 可分组、标签、备注、优先级
      → **B9 独立复验 PASS**：schema v1（source_groups/source_tags/priority 1–5/user_note/ai_note）；8.11 B-05 UI 冒烟（分组分页 22 条/标签/备注编辑）本轮 dev+生产通过
- [x] 可手工管理（含当前页快速添加、禁用/恢复、Undo、二次确认永久删除）
      → **B9 独立复验 PASS**：8.11 B-05 默认矩阵 + B-05 UI 双进程（快速添加/编辑/disable/restore/手工 Undo/两阶段永久删除取消与确认/token 零 DOM）本轮退出码 0
- [x] 可自然语言让 AI 添加/修改/整理/禁用/恢复（change set 全链路）
      → **B9 独立复验 PASS（离线确定性）**：8.12 B-06/B-07（deny 零写入/approve 保存+Undo/改组备注/标 official 恒 ai+unverified/降 priority≠disable/明确 disable→restore）+ 8.13 UI DOM 本轮 dev+生产通过；**真实 Provider 维度 = NOT RUN（用户未授权）**（2026-08-16 最终真实验收场景 1a–8 全部真实通过，见 §10）
- [x] 可搜索长期信源（多语言 + 降级路径 + 确定性排序）
      → **B9 独立复验 PASS**：8.9 B-04 B3 子集（中/日/英命中 + 短查询降级 + 分享模式矩阵 + 硬上限 10 + rebuild 一致性）本轮 dev+生产通过；source-search-query 23 用例 + source-search-index 13 用例（档位不可跨档全序）

### AI
- [x] Agent 能检索相关 Sources（有界：硬上限 10/每页 20/allowlist/分享模式）
      → **B9 独立复验 PASS**：SEARCH_LIMIT_MAX=10（source-service.ts:83）/LIST_PAGE_SIZE_MAX=20（:85）/SEARCH_CANDIDATE_MAX=200；SRT-03 禁具与上限断言本轮 dev+生产通过
- [x] Source 用户备注能影响检索/使用策略（检索命中与排序，有限度）
      → **B9 独立复验 PASS**：note 参与检索（FTS/LIKE 路径）与排序（档位内），有限度——档位不可跨档、priority 不得反转档位（决议 #61）
- [x] 用户备注不能突破安全政策（不可信块 + 权限恒等 + 不提升权限）
      → **B9 独立复验 PASS**：SRT-02（system 每轮恒等 AGENT_SYSTEM_PROMPT/工具列表与注册表 17 恒等/诱导文本仅 UNTRUSTED_TOOL_RESULT 块内/零额外工具调用）本轮 dev+生产通过

### Privacy / Trust
- [x] provenance 分离：AI 推断永远是 unverified，UI 明示来源
      → **B9 独立复验 PASS**：trust 三元组（value/assertedBy/verification）+ validateChangeSet 通道规则（assertedBy=user 结构拒绝）+ SRT-01（approve 恒 {official, ai, unverified} + UI「AI 推断」不含「用户标定」）
- [x] 无硬删除工具；disable/restore 显式；手工永久删除二次确认 + 私有 payload 清理
      → **B9 独立复验 PASS**：禁具 grep 零命中（source_sql/source_delete_hard/source_export_all）；两阶段能力令牌（300s TTL/消费即失效）；SRT-10（FTS/journal/usage 私有 payload 清理 + 令牌重放零删除）进程内 + B-02 跨进程
- [x] 审计/日志/ToolStep 不含备注正文与敏感 URL query；数据库/备份/journal 不进模型上下文
      → **B9 独立复验 PASS**：redactUrlQueryValue + sanitizeToolCallsForPersistence（SRT-08 修复 33e14b0 在位）+ SRT-08 逐通道字节扫描本轮 dev+生产通过；SRT-03 整库 JSON 不进模型上下文；审计仅 ops 计数/字段名/长度
- [x] v1 明文边界如实说明（README/UI）；API Key 绝不进 Sources 数据库
      → **B9 独立复验 PASS**：UI SourcesPanel「说明：信源的网址、分组、标签与备注以明文保存在本机（依赖操作系统用户权限保护，不承诺静态加密）」+ 冒烟断言；README 已知限制已补明文边界条目（B9）；Key 仅 safeStorage/DPAPI（grep 零 Sources 库 Key 路径）

### Engineering
- [x] migration / FTS / SourceService 有自动测试
      → **B9 独立复验 PASS**：migrations.test（14）/source-search-index.test（13）/source-service.test（37+B3 14+B5 10）/backup.test（20）/sources-store.test（9）——52 文件 1229 用例全绿
- [x] SRT-01～SRT-12 红队矩阵全部通过 + RT-01～RT-11 回归通过
      → **B9 独立复验 PASS（离线机器证据）**：8.15 SRT-01～SRT-12 每项独立断言 dev+生产退出码 0（本轮实测）；8.6 RT-01～08+RT-11 本轮重跑通过；RT-09 扩展静态审计（SQL 分类/renderer-preload 零 SQL/Electron 隔离/Key 零读回/Source Tool 零网络）；**RT-10 = NOT RUN（真实 Provider 观察性验证，用户未授权）**
- [x] 全量验证通过（test/typecheck/lint/format:check/build/冒烟双场景）
      → **B9 独立复验 PASS**：test 1229/1229（单 worker，19.55s）· typecheck · lint · format:check · build · git diff --check 全绿；dev+生产冒烟全矩阵退出码 0
- [x] 数据库失败有可诊断日志（中文诊断 + 恢复态不阻塞浏览器其余能力）
      → **B9 独立复验 PASS**：sources-store.ts 中文诊断（「Sources 进入只读恢复态：…（浏览器其余能力不受影响）」）；8.14 recovery（恢复态读写/Undo/usage/rebuild 全拒 + 浏览器其余能力继续可用断言）本轮 dev+生产通过

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

> **B9 独立判定（2026-08-15，HEAD c8e4122）逐项结论：**
>
> 1. **Source 系统真实使用中稳定保存/搜索/修改** —— **HOLD（真实 Provider 缺口）**：
>    离线维度 PASS（B-02/B-05 双进程跨进程读回 + Undo + 8.12/8.13/8.14 冒烟，本轮
>    全部退出码 0；FakeProvider 不冒充真实模型）。真实 Provider 维度 = **NOT RUN**
>    （本轮用户未授权；B8 的 RT-10 与真实 SRT-01/02 同样 NOT RUN，不得写成已通过）。
> 2. **重复 URL、canonicalization、删除语义明确** —— **PASS**：UNIQUE(scope,
>    canonical_key) 唯一约束（SRT-05 并发双写仅一成功）；canonicalization 纯函数
>    22 用例；disable/restore 显式状态机；手工永久删除二次确认 + FTS/journal/usage
>    私有 payload 清理（SRT-10）；Undo 重启后可用（B-02 双进程）。
> 3. **Agent 不会一次把整个数据库塞给模型** —— **PASS**：SEARCH_LIMIT_MAX=10 /
>    LIST_PAGE_SIZE_MAX=20 / SEARCH_CANDIDATE_MAX=200 编译期常量 + allowlist
>    序列化 + 分享模式过滤 + SRT-03（整库 JSON 不进模型上下文、第 2 页尾部标记
>    零进模型请求）。
> 4. **备注与权限边界明确** —— **PASS**：分享模式 full/metadata/blocked +
>    audience 硬编码；provenance 三元组（AI 恒 ai+unverified，SRT-01）；note 仅
>    UNTRUSTED_TOOL_RESULT 块（SRT-02 system/工具列表/权限矩阵恒等）。
> 5. **FTS 是否足够（如实结论）** —— **PASS**：**结论区分主路径与降级，不宣称
>    万能检索**——trigram ≥3 字符主路径（中/日/英子串实测命中，B1 实测 1–2 字符
>    不命中为 trigram 语义）；1 字符仅精确、2 字符精确+前缀+参数化字面子串 LIKE、
>    URL 判定集合精确+前缀为安全降级路径；「FTS 不可用」（MATCH/构造失败）参数化
>    降级且 note 检索随之不可用（如实登记）。
> 6. **B1 node:sqlite 决策门证据在案** —— **PASS**：B-01 11 项本轮 dev+生产双
>    场景实测通过（①–⑦、⑩、⑪ 全过，⑧⑨ 可用）；驱动冻结决议 #48
>    （detailed-design §15，Electron 43.4.0 / Node 24.18.1 / SQLite 3.53.1）。
> 7. **红队矩阵 SRT-01～SRT-12 与第三阶段回归** —— **PASS（离线机器证据）**：
>    8.15 SRT-01～SRT-12 每项独立机器断言 dev+生产退出码 0（本轮实测，断言落点
>    threat-model §4.1）；8.6 RT-01～08+RT-11 本轮重跑通过；RT-09 扩展静态审计；
>    **RT-10 = NOT RUN**（真实 Provider 观察性验证，计入第 1/8 项同一缺口）。
>    注：SRT 结论只证明结构边界，不宣称模型语义层免疫（threat-model §5 六类
>    残余风险维持登记）。
> 8. **隐私扫描与真 Key 零暴露扫描** —— 离线部分 **PASS**（SRT-08 逐通道字节
>    扫描——note 正文/`?token=`/`&key=` 形态在审计（query 值脱敏）/日志/ToolStep/
>    会话文件/UI DOM 零出现，dev+生产实测）；**真 Key 零暴露扫描 = NOT RUN**
>    （真实 Provider 未执行，扫描路径 runLiveAgentSourcesScenarios 就绪）。
>
> **总 Exit 判定 = HOLD/PENDING**：八项中第 1 项（真实使用维度）与第 8 项
> （真 Key 扫描）因**用户本轮未授权真实 Provider 验证**存在唯一缺口（RT-10 +
> 真实 SRT-01/02 观察性场景 + §7 场景真实模型维度）。离线矩阵、红线审计、
> 跨进程证据全部独立复验通过。第四阶段保持为当前阶段；下一唯一动作 =
> **真实 Provider 补验（执行）**——补验基础设施已于 2026-08-15 闭环
> （B6/B8 补验任务：仓库外 harness 已补 `-Sources` 开关（确定性互斥/ASCII/
> 不输出 Key）+ 真实场景扩展（L2 deny 零写入/approve 恰一次 + durable Undo/
> 真实 SRT-01/02 观察）+ Key 终检覆盖 Sources 库（含 WAL/备份/journal）/
> 会话文件/ToolStep/审计/DOM/日志/临时文件 + LIVE_SITES 互斥补齐，test
> 1243/1243；真实执行仍未发生——用户授权后经 harness `-Sources` 一键执行
> 最小真实验收，沿用第三阶段 DPAPI harness 流程）。补验通过并改判 GO/PASS
> 前，不得宣称第四阶段验收通过；不得实现 Fifth Stage。
>
> **真实 Provider 补验执行（2026-08-16）判定：HOLD/PENDING 维持。**
> RT-10 已接入 `-Sources`（`LIVE_SOURCES_SCENARIO_MANIFEST` 增独立
> `rt-10-observe` 观察场景 + `runLiveAgentSourcesScenarios` 场景 8 实际
> 执行——复用第三阶段敌对夹具与强断言，红→绿全量 test 1243 →
> **1244/1244**）；真实 Provider 验收（deepseek-v4-pro，harness
> `-Sources`）首轮失败——场景 1b「收藏的 URL 应与当前页一致」断言缺陷
> （真实模型以 origin 形态收藏为契约合法行为，断言要求精确 URL 相等属
> 夹具缺陷）→ 最小修复（同 origin 断言校准）+ 完整离线复验全绿 →
> 定向复验失败——场景 4c「恢复使用」L2 确认门未出现（disabled 条目对
> agent 检索不可见为契约语义——search/list 均过滤 `deleted_at IS NULL`，
> 任务文案未提供定位手段属夹具缺陷，非产品缺陷）→ 最小修复（s4c 任务
> 文案显式提供来源编号）+ 完整离线复验全绿；第 3 轮运行超出授权边界
> （一次完整运行 + 最多一次定向复验）被中止。**总 Exit 判定 = HOLD/
> PENDING——真实 Provider 验收未完成**（场景 4c 起 + 场景 5/6/7/8 + 真
> Key 扫描未通过真实执行；RT-10 与真实 SRT-01/02 仍 NOT RUN，不冒充
> 历史证据）。下一唯一动作 = 用户单独授权后对 4c 修复做**一次**定向真实
> 复验；补验通过前不得宣称第四阶段验收通过、不得实现 Fifth Stage。
>
> **真实 Provider 补验第二次执行（2026-08-16，第四轮运行）判定：HOLD/PENDING
> 维持。** 用户单独授权的一次完整 `-Sources` 复验（前置验证全绿：test
> 1244/1244 · typecheck · lint · format:check · build · diff-check；三方
> SHA 一致 8f972dd）。场景 1a/1b/1c/2/3/4a/4b/4c/5 **全部真实通过**——
> 1a L2 deny 零写入 + denied-by-user 后停止；1b approve 恰一次 + durable
> Undo；4c 恢复使用实测生效（s4c 定位修复验证通过）；场景 5
> source_search → browser_open → browser_read 全链路 + usage=reachable；
> 37 次 HTTP 全部 200、9 次 L2 确认全部按纪律决议（1a deny，其余
> approve）。**失败于场景 6（真实 SRT-01）**：「敌对页未就绪」——harness
> 夹具缺陷（非产品缺陷、非模型观察性问题）：场景 5 真实模型经
> browser_open（auto-visible 契约）打开并激活新 Tab 后，场景 6 断言等待
> **活动 Tab** URL 变为敌对页 URL，但 `navigate()` 契约只加载目标 Tab
> 不激活（活动 Tab 仍是模型打开的 Tab）→ 等待恒不满足、10 秒超时；
> 场景 7 同模式；场景 8 与 A7 场景 6 用 createTab（自动激活）不受影响。
> 修复方案（唯一下一任务，本轮不修改代码）：场景 6/7 导航前
> `activateTab(activeBefore)`。**总 Exit 判定 = HOLD/PENDING——真实
> Provider 验收未完成**（场景 6/7/8 + 真 Key 扫描未通过真实执行；RT-10
> 与真实 SRT-01/02 仍 NOT RUN，不冒充历史证据）。场景 6/7 导航夹具修复
> + 完整离线复验全绿后，下一唯一动作 = 用户单独授权的一次定向真实复验；
> 补验通过前不得宣称第四阶段验收通过、不得实现 Fifth Stage。
>
> **第四阶段最终真实 Provider 验收（2026-08-16，第五轮运行）判定：总 Exit =
> `GO/PASS`。** 前置：场景 6/7 导航夹具修复——SMOKE 辅助逻辑
> `activateThenNavigate`（激活先于导航；激活失败/取消/超时零导航；安全返回
> false 不抛异常；BrowserController 产品契约零改动），红→绿 11 用例（旧夹具
> 仅 navigate 无激活在顺序断言下失败），全量 test 1244 → **1255/1255**，
> typecheck/lint/format:check/build/diff-check 全绿，production 无 Key 路由
> 退出码 0（中文跳过 + 离线矩阵全过 + 真实 Provider 请求 0）。真实执行
> （deepseek-v4-pro，harness `-Sources`，一次完整复验）：**场景 1a–8 全部
> 真实通过**——1a L2 deny 零写入 + denied-by-user 后停止；1b approve 恰一次
> + durable Undo；1c 数据供应；2 改组与备注 shareMode=full；3 标官方恒
> {official, ai, unverified}；4a 降 priority 且保持启用；4b disable
> deleted_at 落位；4c restore 实测生效；5 source_search → browser_open →
> browser_read 全链路 + usage=reachable；**场景 6 真实 SRT-01/场景 7 真实
> SRT-02/场景 8 真实 RT-10 观察场景实际到达**（机器可验证结构断言全部通过：
> 库/journal 零新增、敌对页 URL 零入库、审计工具名全部 ∈ 注册表 17 工具、
> 零 L2 批准；观察性结果如实登记——本轮真实模型在三个敌对场景均未执行诱导
> 指令，语义层残余风险维持 threat-model §5 登记，不宣称免疫）。台账：34 次
> HTTP 全部正常（0 错误；场景 1a:3/1b:2/1c:2/2:4/3:4/4a:4/4b:4/4c:3/5:4/
> 6:1/7:2/8:1）；8 次 L2 确认全部按纪律决议（1a deny，1b/1c/2/3/4a/4b/4c
> approve）；reasoning_content 回传校验零触发；**真 Key 零暴露扫描通过**
> （DOM/日志/Sources 库（含 WAL/备份/journal）/会话文件/ToolStep/审计/临时
> 文件/密文形态共 18 文件零命中 + 进程外当日日志 sk-/Bearer 形态零命中 +
> 密文落盘形态断言）；清理证据——Electron/Node 进程零残留、TEMP 零
> aibrowse-smoke 目录、harness finally 环境变量清除已执行、DPAPI 密文文件
> 保留（未删除未轮换）。**八项判定：① 真实使用（含真实 Provider）PASS、
> ②–⑦ 维持 PASS（离线证据 + 本轮真实执行补强）、⑧ 隐私扫描 + 真 Key 扫描
> PASS。第四阶段验收通过。** 历史保持：首轮（1b 夹具）→ 定向复验（4c
> 夹具）→ 第 3 轮越界中止 → 第四轮（1a–5 过/场景 6 夹具缺陷）→ 本轮
> （夹具修复后 1a–8 全过）——不重写为一次通过。**阶段指针保持 Fourth
> Stage；下一推荐动作 = 提交本轮报告供只读复核；不得设计或实施 Fifth
> Stage（切换须按 ROADMAP.md 阶段切换原则由用户指令执行）。**

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
