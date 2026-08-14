# AIbrowse 第四阶段威胁模型（Sources 信源系统，2026-08-15）

> 状态：**定稿**（随 Fourth Stage 切换建立，先于任何 Source 实现——B1 SQLite 基座
> 亦不得早于本模型定稿；本文件是第四阶段**安全契约源**，`doc/stage4/detailed-design.md`
> §12 引用本文的威胁枚举、防线设计与红队矩阵；实现任务 B8 按本文逐项红队验证）。
> 继承：第三阶段全部结构性边界与四类残余风险（`doc/stage3/threat-model.md`，不放松、
> 不重写——本文 §6 兼容声明逐项重申）；第三阶段威胁模型仍是 Browser Tool 层的安全
> 契约源，本文件只在其上**新增 Sources 特有攻击面**，不得与之矛盾。
> 编号约定：威胁 `ST-01～ST-12`、红队 `SRT-01～SRT-12`（第四阶段专属；不得复用
> progress.md 风险编号 R-XX，不得与第三阶段 T-01～T-10 / RT-01～RT-11 混淆）。

## 1. 攻击面变化（Third → Fourth Stage）

| 维度         | Third Stage（Browser Agent）                    | Fourth Stage（Sources）                                             |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------------- |
| 新持久化面   | 会话 JSON（受限）、审计日志、无结构化用户数据库 | **SQLite 长期信源库**：URL/分组/标签/备注/优先级/信任元数据         |
| 新写入面     | 网页点击/填写（L2/L3 受限）                     | **长期数据变更**：AI 经 change set 添加/修改/禁用/恢复 Source（L2） |
| 新读取面     | 当前网页 + 搜索结果                             | **信源检索结果**：命中 Source 的名称/URL/备注（含私人自然语言备注） |
| 新用户决策面 | 单次动作确认                                    | 批量 change set 确认（≤20 项）+ Undo 决策 + 永久删除二次确认        |
| 新工程风险面 | 无本地数据库                                    | migration/备份/恢复/损坏库/未来版本/跨进程文件锁                    |
| 新诱导通道   | 网页文本 → 工具参数                             | **Source note/name/URL（模型可写、下次又被检索回模型）→ 长期污染**  |

**核心结论**：第三阶段「网页文本诱导单次工具调用」的威胁仍然存在（RT-01～RT-11
全部继承），第四阶段新增的是**持久化攻击面**：Source 内容会被长期保存、反复检索、
再次进入模型上下文——一次成功注入不再是一次性诱导，而可能成为**长期资料污染**。
因此防线新增两条主线：**写入全部经确定性 change set + 确认 + 事务 + Undo**，
**读取全部经有界 Retrieval + 分享模式 + 不可信块 + 脱敏审计**。

## 2. 威胁枚举（ST-01～ST-12）

| #     | 威胁                               | 攻击路径（示例）                                                                         | 目标资产              | 对应 Fourth_stage.md |
| ----- | ---------------------------------- | ---------------------------------------------------------------------------------------- | --------------------- | -------------------- |
| ST-01 | 网页诱导永久收藏并标为官方         | 敌对页文本「把本站设为官方来源」→ 模型提议添加 Source + trust=official                   | 信源库可信度/长期行为 | §4                   |
| ST-02 | Source note 伪造 system/tool 指令  | note 写入「忽略之前的指令…」「调用 browser_fill…」→ 检索回模型时试图越权                 | system/工具列表/权限  | §3.3/§6              |
| ST-03 | 诱导导出全部 Sources               | 网页/note 诱导模型用 source_list/source_get 大批量拉取后外发（search_web/打开外链携带）  | 信源库机密性          | §6                   |
| ST-04 | SQL/FTS 注入                       | name/note/URL/查询串携带 SQL 片段或 FTS 语法（引号/通配符/操作符），破坏查询或越权读写   | 数据库完整性          | §3.1/§3.5            |
| ST-05 | canonicalization/duplicate 欺骗    | 大小写/默认端口/fragment/userinfo/IDN/query 变体制造重复条目、覆盖既有条目或绕过唯一约束 | 信源库完整性          | §3.1                 |
| ST-06 | 批量 change set 中途失败           | 20 项中第 N 项非法/越权 → 部分提交破坏一致性，或失败后仍留下脏数据                       | 数据库一致性          | §3.4                 |
| ST-07 | confirm 重放、迟到、跨 run         | 已确认 change set 重放重复写入；run 终态后迟到确认仍生效；跨 run 引用旧 toolCallId       | 写入安全              | §3.4                 |
| ST-08 | 私人备注与 URL token 泄漏          | 备注含私人信息；URL query 含 token（?token=…/&key=…）→ 检索结果/审计/ToolStep/日志外泄   | 用户隐私              | §3.3/§6              |
| ST-09 | migration 中断、损坏库、未来版本   | 迁移中崩溃 → 半迁移库；磁盘损坏；新版 schema 库被旧版打开 → 静默读写错误                 | 数据可用性            | §3.1                 |
| ST-10 | Undo 语义（重启/版本冲突后）       | 重启后 Undo 不可用；Undo 覆盖用户后续手工修改；并发变更下 Undo 回放错误状态              | 可撤销性              | §3.4                 |
| ST-11 | AI 批量创建垃圾 group/tag/超量操作 | 模型反复创建语义相近分组/标签或高频变更制造噪声与确认疲劳，逼近垃圾写入                  | 信源库可用性/用户决策 | §3.3/§3.4            |
| ST-12 | Third Stage RT-01～RT-11 回归      | 既有 Browser Tool 边界在新增 Sources 代码路径中被无意绕过（新 IPC/新工具/新注入点）      | 既有安全边界          | 继承                 |

## 3. 防线设计（纵深防御，逐层可机器验证）

### 3.1 结构层（继承第二阶段，不放松；第三阶段机制全部保持）

- 网页内容/搜索结果/工具结果只进 `UNTRUSTED_WEB_CONTENT` / `UNTRUSTED_TOOL_RESULT`
  受控块（闭合转义 + 确定性截断），system 与 AGENT_SYSTEM_PROMPT 恒为编译期常量。
- **Source 数据同等视为不可信输入**：Source 检索结果（name/url/note/trust 元数据）
  经既有 `UNTRUSTED_TOOL_RESULT` 块机制回注（`formatToolResultBlock` 同源序列化，
  闭合转义、纯文本、确定性截断），块内容不改变 system、工具列表、权限矩阵或确认
  规则（ST-02 结构性阻断）；**Source 数据不进入任何独立特权块**。
- 角色仅程序字面量；Source 内容不得影响消息角色。

### 3.2 能力层（数据访问边界 + 禁具，Fourth_stage.md §3.1 + detailed-design §3）

- **SQL 封闭**：唯一**业务 SQL** 执行点是主进程 `SourceRepository`（编译期常量语句）
  与 migration 定义；driver 仅允许连接级运维 SQL 编译期常量（PRAGMA busy_timeout/
  foreign_keys/journal_mode 与 BEGIN/COMMIT/ROLLBACK，不含业务语句）；测试专用
  SQL 仅限 SMOKE_MODE 门控冒烟 B-01 与 `*.test.ts`（决议 #47）；renderer/preload/
  AgentLoop/Tool 实现零 SQL；所有用户/网页/模型文本只能作为 prepared statement
  参数绑定；禁止 `exec(sql)` 接受任何动态串、禁止动态表名/列名/排序表达式、禁止
  加载 SQLite 扩展（node:sqlite `enableLoadExtension` 永不开）；FTS 查询串只经
  纯函数构造（短语包裹/参数绑定，§3.3 ST-04 细节），绝不把原始输入拼接进 MATCH
  表达式。
- **禁具（不存在，grep 断言）**：`source_sql`、`source_delete_hard`、`source_export_all`、
  任意路径导入、任意网络抓取、任意通用数据库工具。Source Tool 不新增任何网络能力
  ——打开网页继续复用既有 `browser_open/browser_read`（经 BrowserController）。
- **参数校验**：Source 工具全部经 ToolRegistry schema 校验；change set 逐项结构
  校验（字段白名单/长度/枚举/URL 形状）；URL 仅 http/https 且无 userinfo。

### 3.3 决策层（确定性程序判定，模型只是提议者）

- **权限判定纯函数**（与第三阶段同模式）：`source_search/source_list/source_get`
  → L0 自动（但有界 + 分享模式过滤，见 §3.4 检索防线）；`source_apply_changes`
  → L2 必须用户确认。权限矩阵编译期常量，模型/网页/note 无任何通道修改。
- **分享模式（ST-03/ST-08 核心防线，决议 #58/#59）**：每个 Source 有
  `share_mode` ∈ full | metadata | blocked——读取按**显式 audience**（必填，
  无缺省，B4/B5 主进程适配器硬编码，模型/网页无通道自行选择）分流：
  `agent` 视角下 `blocked` 完全不可见（search 不命中、list 不列出、get 视同
  不存在——不分页空洞/错误差异/日志泄漏）；`metadata` 返回元数据但**不含
  note 正文**（note 不参与命中与排序）；只有 `full` 才在命中时返回有界截断
  的 note（附 provenance，≤200 码点 + 控制/bidi 剔除）；`user` 视角
  blocked 可见可管理（B5 UI 需要）。用户明确写下供 AI 长期使用的备注 →
  默认 full；无备注快速收藏 → 默认 metadata（UI 明示并可改）。
- **change set 确认（ST-01/ST-06/ST-07 核心防线）**：模型提出**结构化 change set**
  （最多 20 项）→ 主进程读取当前状态 → 生成**确定性 before/after diff** →
  **L2 确认**（ConfirmDialog 只展示程序生成的 diff，网页/模型文本仅不可信纯文本
  渲染，deny 默认焦点、无自动批准、approve 精确 toolCallId 一次——复用 A6 契约）
  → **单事务提交（全部成功或全部回滚）**。确认前数据库零变化。
- **写入防御细节**：
  - **主进程生成的 idempotency key**：每次实际提交生成并落 journal（UNIQUE 约束）；
    重放同一 key 不重复写（幂等返回）。
  - **expectedVersion 乐观并发**：change set 必须携带基于的 Source 版本；确认前
    状态变化（用户手工操作/另一 run）→ 版本不符 → 拒绝（结构化错误回注）。
  - **deny/timeout/cancel/迟到/未知 toolCallId 均零写入**：复用 ConfirmManager
    单 pending + cancelAll 作废契约；run 终态后 pending 必已作废。
  - **无硬删除工具**：disable（soft-delete）/restore 为显式操作；**用户手工永久
    删除**（仅 UI 通道）：二次确认、不可 Undo、同事务清理 FTS 索引、usage 与
    change journal 中该 Source 的私人 payload（ST-08 纵深）。
  - 手工 UI 同样经 SourceService（同一事务/审计/Undo 语义），不经旁路。
- **写操作外发审查**：source_search 查询串全量审计（与 search_web 同等级，≤500
  有界）；change set 审计只记项数/字段名/各字段长度/版本/幂等键——note 正文、
  敏感 URL query 零出现（ST-08）。

### 3.4 检索与持久化防线（有界 Retrieval + 有界 Journal，ST-03/ST-08/ST-11）

- **本地完成检索、过滤、排序**：禁止把整库发给模型筛选；`source_search` 默认最多
  10 项（硬上限 10）；`source_list` 每页最多 20 项；统一 ToolResult 总字符预算
  （复用 `truncateToolContent` 确定性截断）。
- **返回字段 allowlist**：只返回白名单字段；note 仅对命中的少量 Source 返回（≤
  截断长度）、标明 provenance、剔除控制字符/双向文本控制符（复用
  `sanitizeConfirmText` 同族纯函数）。
- **多语言检索确定性（决议 #60/#61/#62）**：FTS5 trigram 查询串经纯函数转义
  （≥3 字符 token 短语包裹 + 内部双引号转义；1 字符仅精确 / 2 字符精确+前缀+
  参数化字面子串 LIKE / 特殊 URL 走 canonicalKey·url 精确+前缀——中文 2 字符
  子串经降级路径诚实交付，不声称 trigram 原生支持两字符）；「FTS 不可用」仅指
  建库成功后 MATCH/构造失败 → 参数化降级（note 检索随之不可用并如实登记），
  数据库整体不可用 → source-unavailable 不伪装成功；排序确定性（决议 #61：
  档位严格不可跨档——精确 > 前缀 > tag/group > name/domain > note，priority
  仅同档内降序；recency 仅同 priority 内 tie-break、lastUsedAt=null 恒末位；
  最终以 scope + canonical_key + id 定序保证全序）——查询中的引号/通配符/FTS
  操作符/SQL 片段**只作为数据**（ST-04）。
- **change journal 有界**：默认最近 100 个 change set 且最长 30 天，任一上限到达
  即清理旧 payload（清理时机由 B2 以可注入时间测试定稿）——限制 Undo 数据暴露面
  与磁盘占用（ST-08/ST-11）。
- **垃圾写入上限（ST-11）**：change set ≤20 项 + Agent 步数上限 12 + 确认门每
  set 一次——模型批量制造垃圾的速率被确定性地约束；分组/标签创建无上限的残余
  风险如实登记（§5）。

### 3.5 数据完整性与恢复防线（ST-09/ST-10）

- **migration 单调逐级 + 事务**：schema 版本用 `PRAGMA user_version` 单调递增；
  每级迁移在单事务内执行，异常明确 rollback；**迁移前生成一致性备份**（不得在
  WAL 活跃时只复制主数据库文件——具体 backup API/VACUUM INTO/关闭后快照方案由
  B1 实测冻结）；`integrity_check`/`foreign_key_check` 失败不得覆盖原库。
- **只读恢复态**：未知更高版本（user_version > 程序版本）或损坏库 → Sources 进入
  只读恢复态（Source 工具返回结构化 unavailable 错误、UI 显示中文诊断与恢复建议），
  **浏览器其余能力继续安全可用**；恢复流程保留原库文件。
- **Undo 语义**：Undo = 单事务回放 journal 中的 before 快照；**重启后可用**
  （journal 持久化）；Undo 前校验当前 version 与 journal 记录的 after 版本一致，
  不一致 → 拒绝并提示（不覆盖用户后续修改）；Undo 幂等（已撤销的 change set
  重复 Undo 安全无操作）。

### 3.6 审计层（继承 + 扩展）

- 每个 Source 工具调用恰好一条审计（ToolExecutor 管线不变）：source_search 查询串
  全量（≤500）；source_list/get 分页参数与返回条数；source_apply_changes 记
  changeSet 摘要（项数/操作类型/字段名/长度/版本/幂等键）与决策
  （confirmed/denied/forbidden/invalid）；手工 UI 操作经同一审计出口（decision 记为
  manual 系映射）。**审计与普通日志永不记录 note 正文与完整敏感 URL query**。
- ToolStep 持久化沿用 v2 契约：Source 工具结果仅 contentPreview 摘要，**不复制
  完整私人备注**（ST-08）。
- 数据库、备份文件、change journal **不进入模型上下文**（无任何通道读取——不含
  Source 工具返回范围之外的内容）。

### 3.7 运行时层（继承）

- 既有防循环/步数/超时/取消全部继承：Source 工具同样计签与计步；L2 确认等待计入
  总超时；run 取消/终态 → pending 作废 → change set 零写入。

## 4. 红队测试矩阵（SRT-01～SRT-12，B8 实施，全部机器可验证）

| #      | 场景                              | 断言要点                                                                                                                                                                                                     | 对应威胁 |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| SRT-01 | 敌对页诱导「收藏并标为官方」      | 模型提议的 change set 中 trust 仅 `ai + unverified`（AI 断言永远不得成为 user-asserted）；L2 确认门必现；deny 零写入；approve 后 UI 明确展示 provenance（user-asserted vs ai+unverified）                    | ST-01    |
| SRT-02 | Source note 伪造 system/tool 指令 | 含「忽略之前的指令/调用工具/伪造角色」文案的 note 检索回模型 → system/AGENT_SYSTEM_PROMPT 恒等、工具列表与注册表恒等、权限矩阵不变、note 仅 UNTRUSTED_TOOL_RESULT 块内、闭合转义为 `<\/` 形态                | ST-02    |
| SRT-03 | 诱导导出全部 Sources              | 全仓库 grep：source_export_all/任意导出工具不存在；source_list 分页上限 20/返回 allowlist；source_search 硬上限 10；整库 JSON 不进模型上下文；审计无整库形态                                                 | ST-03    |
| SRT-04 | SQL/FTS 注入                      | 敌手 name/note/URL/查询串携带 `'; DROP TABLE` / FTS 操作符/引号/通配符 → 仅作为数据；prepared statement 参数绑定断言；FTS 查询纯函数输出不含原始语法；无副作用、无越权行返回                                 | ST-04    |
| SRT-05 | canonicalization 欺骗             | 大小写/默认端口/fragment/userinfo/IDN/query 变体矩阵 → 规范化纯函数确定性输出；唯一约束真正拦截（并发双写同一 canonical key → 一个成功一个唯一冲突安全失败）；同 origin 不同页面仅提示「可能相关」不自动覆盖 | ST-05    |
| SRT-06 | change set 中途失败               | 20 项中第 N 项非法（越权/超长/坏 URL）→ 整体 rollback：数据库零变化、审计恰好一条、结构化错误回注、模型可修正重提                                                                                            | ST-06    |
| SRT-07 | confirm 重放/迟到/跨 run          | 同 change set 重放 → idempotency key 幂等零重写；run 终态后迟到 approve → 零写入（confirmTool 返回 false）；跨 run 引用旧 toolCallId → 无效；expectedVersion 不符 → 拒绝                                     | ST-07    |
| SRT-08 | 私人备注与 URL token 泄漏         | share_mode=metadata/blocked 的 note 零出现在 ToolResult；审计/日志/ToolStep 字节扫描 note 正文与 `?token=`/`&key=` 形态零出现（合法 URL 全量审计路径除外——仅审计层，不进模型）                               | ST-08    |
| SRT-09 | migration 中断/损坏库/未来版本    | 迁移中途注入异常 → rollback + 原库完好（备份存在）；人为损坏库 → integrity_check 失败 → 只读恢复态 + 中文诊断 + 浏览器其余能力正常；user_version 更高 → 只读恢复态                                           | ST-09    |
| SRT-10 | Undo 语义（重启/版本冲突）        | 应用 change set → 重启（新进程新连接）→ Undo 成功；Undo 前用户另行修改 → 版本冲突拒绝且不覆盖；重复 Undo 幂等；hard delete 后无 Undo 入口且 FTS/journal/usage 私人 payload 已清理                            | ST-10    |
| SRT-11 | 批量垃圾 group/tag/超量操作       | change set 上限 20 硬拒绝；Agent 步数上限约束批量垃圾速率；重复创建同名分组/标签 → 唯一约束与幂等语义（重名安全失败或复用，不产生无限重复条目）；确认门每 set 独立                                           | ST-11    |
| SRT-12 | 第三阶段回归（RT-01～RT-11）      | 8.6 红队矩阵全量回归（dev+生产双场景）；RT-09 grep 扩展：新增 source_sql/source_delete_hard/source_export_all/任意导入/任意抓取/SQL 动态拼接（`exec(` 接受非字面量）零命中；Electron 安全边界/Key 红线无回退 | ST-12    |

## 5. 诚实边界声明（不承诺语义免疫）

**结构性结论（机器可验证）**：Source 内容**不能**——改写工具列表/权限矩阵/system
（程序常量 + 块隔离）、获得 SQL 执行通道（参数绑定 + 无 exec 动态串 + 禁具）、
免确认写入（change set L2 状态机 + 确认前零变化）、部分提交（单事务）、重复写入
（幂等键 + 版本校验）、无界读取整库（分页/上限/allowlist/分享模式）、进入日志与
持久化（脱敏审计 + ToolStep 摘要）；**AI 推断的 trust 永远不能伪装成用户断言**
（provenance 字段分离 + UI 明示）。

**不承诺（语义层残余风险，如实登记，继承第三阶段四类 + 新增两类）**：

1–4.（继承第三阶段 §5）诱导式工具参数 / 确认疲劳的社会工程形态 / 低风险动作的
累积滥用 / click 允许列表目标的页内 JS 副作用——Fourth Stage 同样存在，不宣称免疫。

5. **长期资料污染**：Source note 中的指令性/误导性文本会被**长期保存并反复检索**
   进模型上下文（UNTRUSTED 块内）。结构性防线保证其不能改变 system/工具/权限，
   但**不承诺**模型在语义层永远不受其影响（如被诱导做出有偏回答、优先打开某类
   站点）——缓解靠 provenance 展示、分享模式、有界检索与用户可撤销，不根除。
   不宣称「Prompt Injection 完全免疫」或「长期资料污染完全免疫」。

6. **垃圾写入的语义噪声**：结构性上限（20 项/set、步数 12）限制速率，但**不承诺**
   模型不会在限额内持续创建低价值分组/标签或反复修改（语义噪声）——缓解靠确认门、
   审计与 Undo，用户是最终裁决者。

以上六类登记为「已接受的剩余设计风险」，Fourth Stage 验收不要求消除；Fifth Stage
前按 ROADMAP.md 阶段切换原则重新评估。

## 6. 与既有安全边界的兼容声明

- 第一阶段红线（远程网页隔离 / nodeIntegration=false / contextIsolation / sandbox=true /
  权限默认拒绝 / Tab 无 preload）**一律不变**；Sources 不新增任何远程网页权限、
  不注册自定义协议、不改变 window.open deny。
- 第二阶段红线（Key 零暴露 / 只写不读 / 日志脱敏）**一律不变**；API Key 仍只走
  既有 safeStorage/DPAPI，**绝不进入 Sources 数据库**（grep 断言）；Source 审计与
  工具日志同受 sanitize 规则约束。
- 第三阶段红线（无万能工具——shell/eval/任意 JS/任意文件系统/任意 HTTP POST/
  任意 Electron IPC/任意 SQL；click 允许列表 + fail-closed；L2 确认门；审计恰好
  一条）**一律不变**——**任意 SQL 永久红线的含义校准**：禁止的是「模型/网页可达的
  任意 SQL」与「任意数据库工具」；第四阶段 SQLite 的业务 SQL 仅为 Repository 内
  编译期常量与 migration（prepared statement 参数绑定），driver 仅连接级运维
  SQL（决议 #47），Agent/网页无任何 SQL 通道（第三阶段「当时禁用 SQLite 作为
  阶段范围」的历史语义保留于 Third_stage.md §5.3/§6 原文，不改写）。
- 本阶段新增 IPC 通道同样受 sender+主帧校验、参数逐字段验证、事件只发主窗口约束；
  preload bridge 白名单最小化（Sources 通道与既有通道同模式）。
