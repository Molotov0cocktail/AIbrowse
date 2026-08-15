# C1 — ResearchTask/Evidence/Result 核心契约、状态机纯函数、存储与服务基座

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §2/§3/§6.8/§9/§15
> （决议 #94–#100 设计期 + **#101–#111 C1 实施前契约裁决** +
> **#112–#116 C1 定向修复与契约边界复核裁决** + **#116 二次补修实现说明**
> （ISO 8601 偏移日期回滚校验，2026-08-16）；决议范围以 §15 当前记录为准）；
> 安全契约 `doc/stage5/threat-model.md`（先于任何实现定稿——已满足）。

## 实施前契约裁决（决议 #101–#111，先改契约与测试、再改实现）

C1 动工前核实的七项契约缺口均已按 Fifth_stage.md 上位需求/threat-model 安全
契约/detailed-design 既有条款唯一裁决（裁决全文见 detailed-design §15
#101–#111，本文件只列摘要）：

1. **schema v1 补全候选与捕获表**（#101）：新增 `research_candidates`/
   `research_captures` 两张独立表（Fifth §3.1 需求）；capture 正文零落盘
   （仅元数据行）。migration v1 全表集 = **7 张表**。
2. **rejected Evidence 三重一致**（#102）：Repository 写入仅接受
   verification='verified' 窄类型 + schema CHECK 收窄（rejected 永不落库）。
3. **持久化预算 = UTF-8 字节**（#103）：MAX_TASK_PERSISTED_CHARS=500000
   = Buffer.byteLength（实际持久化大小有界）；覆盖任务全部持久化行。
4. **MAX_STORED_TASKS 总数硬上限**（#104）：created 计入总数永不清除；
   触发/排序键/无可清理时新建拒绝 research-task-limit。
5. **状态机矩阵定稿**（#105）：completed 不可 start；delete 矩阵；全部事件
   携带 now（注入时钟，纯函数确定性）。
6. **restart 原子清理**（#106）：单事务删除旧 run 全部行 + stats/时间字段
   重置。
7. **goal 语义**（#107）：空/非串拒绝；超长确定性截断 + warn。
8. **总超时独立错误码 research-timeout**（#108）；错误码共 11 码。
9. **接口契约补齐**（#109）：Repository/Store/Service 精确签名与返回判别
   联合（detailed-design §9.1 校准段落）。
10. **常量单一事实源**（#110）：§2 字段数值上限全部进 shared/types/
    research.ts；禁止魔法数字。
11. **模式复用边界**（#111）：import 复用 sources 驱动连接级原语与只读
    探测原语（零修改）；research 无 backup/恢复态（unavailable 两态）。

## 目标

落地 Research 域模型单一事实源（shared/types/research.ts）、任务状态机纯函数、
全部确定性预算常量、research.db 存储基座（migration v1 + Repository +
research-store 装配）与 ResearchService 生命周期骨架——**纯契约与存储闭环，
不实现任何运行逻辑**（Runtime/Workspace/选择器/读取均归后续任务）。

## 范围与非目标

- **做**：域类型/预算常量/错误码（§2/§6.8 全表）；状态迁移纯函数（§3.1/§3.2
  全表 + 测试）；research.db migration v1（§9.1 全表集）+ research-driver
  薄封装（复用 node:sqlite 冻结模式，独立库独立句柄）；ResearchRepository
  （唯一 SQL 执行点）；research-store 启动装配（probe→迁移→检查→normal|
  unavailable + 遗留 running 标 interrupted）；ResearchService 骨架
  （createTask/getTask/listTasks/deleteTask/start 前置校验/stop 桩——运行
  编排归 C5，本任务 start/stop 仅状态迁移与校验）。
- **不做**：ResearchRuntime/Workspace/SourceSelector/CaptureService/
  EvidenceValidator/ResultValidator/Renderer/UI/IPC 通道（后续任务）；
  backup 模块（research.db 无历史迁移需求，§9.2）；修改 sources.db 或
  任何既有模块行为（AgentLoop/17 工具/Sources 契约零改动）。

## 涉及模块和输入文档

- 新增 `src/main/research/`（domain/repository/db/store/service 骨架）+
  `src/shared/types/research.ts`。
- 输入：detailed-design §2/§3/§6.8/§9/§15（决议 #94/#95/#97）；threat-model
  §3.2（SQL 封闭）/§3.4（持久化最小化）；Fourth Stage B1/B2/B7 模式
  （sqlite-driver/migrations/sources-store，复用不修改）。

## 预计修改文件

- 新增：`src/shared/types/research.ts`、`src/main/research/db/
research-driver.ts`、`src/main/research/db/research-migrations.ts`、
  `src/main/research/research-store.ts`、`src/main/research/domain/
research-task-state.ts`、`src/main/research/domain/research-budget.ts`、
  `src/main/research/domain/research-errors.ts`、`src/main/research/
repository/research-repository.ts`、`src/main/research/
research-service.ts` + 同名 `*.test.ts`。
- 既有文件**零改动**（index.ts 装配推迟至 C5 接线；若 store 装配需 index.ts
  接入点，仅加「未接线不影响产品行为」的最小钩子并在本任务文档记录）。

## 依赖

无（Entry Gate 已通过；威胁模型已定稿）。

## 红→绿步骤（测试必须甄别新旧结构）

1. **红**：先写 `research-task-state.test.ts`（模块缺失红）、
   `research-budget.test.ts`（常量与裁剪边界）、`research-repository.test.ts`
   （migration v1 契约断言 + CRUD + 注入串仅作数据 + JSON 形状 fail-closed +
   字节预算拒绝 + 任务数清理）、`research-store.test.ts`（装配矩阵 +
   interrupted 标记 + unavailable 全拒）——旧结构（无模块）全部失败。
2. **绿**：实现域类型/预算/错误码 → 状态机纯函数 → migration v1 + driver →
   Repository → store 装配 → Service 骨架；逐文件转绿。
3. 全量回归 + 红线扫描（本任务新增 SQL 仅 Repository/migrations 编译期常量
   - 参数绑定；renderer/preload 零 SQL；零新依赖；17 工具注册表零变化）。

## 验收标准

- §2 全部类型与 §6.8 全部常量（含决议 #110 新增 §2 字段常量）落地且与本文
  一致（grep 核对导出）；
- §3.1 状态迁移表全行有单测覆盖（含非法事件安全返回/终态不可变/start
  前置矩阵/delete 矩阵/restart 语义——决议 #105/#106）；
- repository/store 测试覆盖 §9.1 契约（真实 node:sqlite；7 张表 migration
  v1；注入串仅作数据；CASCADE；JSON 形状校验 fail-closed；UTF-8 字节预算；
  MAX_STORED_TASKS 清理；verified-only Evidence 落库——决议 #101/#102/
  #103/#104）；
- Service 骨架：createTask/getTask/listTasks/deleteTask/start 前置校验/
  stop 状态迁移；非法输入安全返回不抛异常；错误码映射完整（11 码，
  决议 #108/#109）；
- Store 装配：normal|unavailable 两态 + 遗留 running 原子标 interrupted +
  dispose 幂等关闭（决议 #109/#111）。

## 前置复核登记（本任务不修，仅登记）

- **proposal §10 决策表 D9 行与 detailed-design §15 决议 #99 存在 Markdown
  表格漂移**（表格单元格内容溢出/断行不一致，纯文档格式问题）——登记为
  **C7 前置复核项**（C7 涉及 ResultValidator/Renderer 契约核对时一并处理），
  本任务不顺手修复。

## 具体验证命令和期望结果

- `npm test -- --maxWorkers=1` → 全量绿（既有 1255 + 本任务新增用例）；
- `npm run typecheck` / `npm run lint` / `npm run format:check` → 退出码 0；
- `npm run build` → out/ 三目标成功；
- `git diff --check` → 零命中；红线 grep：`exec(` 动态 SQL 零命中、
  research 相关零 shell/child_process、renderer/preload 零 SQL、
  sk-/apiKey 零命中；
- 既有 17 工具注册表冒烟断言零回归（8.1 探针不因本任务变化）。

## 完成定义

红→绿证据回填本文件 + 全量验证全绿 + diff 终检 + progress.md 更新 +
一个逻辑提交（feat: C1 …）+ 双远程推送。

## 风险与停止条件

- node:sqlite 在第二库上的任何新行为异常 → 停止并提交证据（不得换库绕过；
  评估仍按决议 #48 冻结模式）；
- 契约冲突（类型/预算与本文不一致）→ 停止，按 §15 决议流程先改本文与测试；
- 发现需要修改既有模块才能落地 → 停止并报告（本任务零既有改动承诺）。

## 提交边界

单一逻辑提交（C1 全部新文件 + 测试）；不夹带后续任务代码；临时目录/日志
清理后提交。

## 红→绿证据（2026-08-16 实施回填）

### 红态证据（先测后改，可甄别模块不存在/旧结构）

- 实施前先写全部 9 个测试文件（shared/types/research.test.ts +
  domain 3 件套 + driver/migrations/repository/store/service 共 131 用例），
  运行 `npx vitest run src/shared/types/research.test.ts src/main/research/`：
  **9/9 测试文件全部失败于模块缺失**（`Cannot find module`——旧结构零
  Research 实现，测试可甄别）；基线（既有 54 文件 1255 用例）保持全绿。
- 修复过程中发现的测试夹具缺陷（非实现缺陷，测试自身与契约校准）：
  排序键测试期望误标（全序键 = COALESCE(finished_at, interrupted_at)
  DESC, created_at DESC, id ASC——期望改为最旧 2 个 [id2, id1]）；
  capture 主键重复插入（夹具硬编码 cp1）；stats_json 夹具用完整形状；
  分页断言改 total（pageSize 上限 20 为契约语义）；时钟递增保证排序键
  确定性（randomUUID id 收尾在同时刻下随机）。

### 绿态证据

- 实现 10 个文件 + 9 个测试全部落地；C1 聚焦测试 **131/131 全绿**。
- 全量验证（smoke.ts SRT-12 白名单契约同步后重跑）：
  - `npm test -- --maxWorkers=1` → **1386/1386 全绿**（既有 1255 + 新增
    131；63 测试文件）；
  - `npm run typecheck` / `npm run lint` / `npm run format:check` /
    `npm run build`（三目标）/ `git diff --check` → 全部退出码 0；
  - dev 冒烟（`AIBROWSE_SMOKE=1 npm run dev`）与生产冒烟（`npm run
start`）→ 退出码 0 + 「冒烟自检通过」+ **8.1 探针 17 工具注册表
    恒等** + SRT-01～SRT-12 全过（SRT-12 SQL 执行点分类证据含 C1 允许点）。
- 红线扫描（全过）：research 产品代码零动态 SQL（业务 SQL 仅
  research-repository.ts 编译期常量 + research-migrations.ts 冻结列表；
  测试探测 SQL 仅测试文件内）；research 零 shell/child_process/网络/
  任意文件；renderer/preload 零 SQL；真 Key 形态（sk- 前缀）零命中；
  禁具（research_sql/research_export/research_file）零命中；
  package.json/package-lock.json 零 diff；AgentLoop 12/420s 契约零变化
  （agent-loop.ts:37-38 未动）；sources/ai/browser/renderer/preload/
  index.ts 零 diff（sources.db schema 零变化）。

### 既有文件改动登记（仅 1 处，最小契约同步）

- `src/main/smoke.ts`（+5 行）：SRT-12 SQL 执行点静态审计允许点表新增
  `research-repository.ts` 分类键——第五阶段契约（detailed-design §1/§9.1）
  新增的合法业务 SQL 执行点；**契约同步而非审计放宽**（renderer/preload
  零 SQL 断言不变）。该改动为 C1 冒烟零回归的必要落地（SRT-12 为默认
  矩阵自动包含的全仓库静态审计）。dev/生产冒烟重跑验证。
- 本任务文档「既有文件零改动」承诺因此修正为「仅 smoke.ts SRT-12 白名单
  契约同步 1 处 + 全部新文件」——其余既有文件零改动。

### 交付物清单

- 新增：`src/shared/types/research.ts`（§2 全类型 + §6.8/决议 #110 全常量
  - 11 错误码 + ResearchService 接口与判别联合）、`src/shared/types/
research.test.ts`、`src/main/research/domain/research-task-state.ts`
    （+ 测试）、`research-budget.ts`（+ 测试）、`research-errors.ts`
    （+ 测试）、`db/research-driver.ts`（+ 测试）、`db/research-migrations.ts`
    （migration v1 七表集 + 测试）、`repository/research-repository.ts`
    （唯一 SQL 执行点 + 测试）、`research-store.ts`（装配两态 + 测试）、
    `research-service.ts`（生命周期骨架 + 测试）。
- 契约文档：detailed-design.md（§2/§3/§6.6/§6.8/§9/§15 决议 #101–#111
  校准）+ 本任务文档。

## 定向修复与契约边界复核（2026-08-16，决议 #112–#116）

> 本任务第二闭环：对 C1 产物做定向复核，发现五个契约边界缺口。纪律：
> 先写可甄别当前实现的红态测试 → 改契约（detailed-design §15 连续编号
> #112–#116）与错误测试期望 → 再改实现；不改写 #101–#111 历史；migration
> v1 冻结不动；零既有产品模块改动（sources/ai/browser/renderer/preload/
> index.ts/AgentLoop/17 工具零 diff）；零新依赖。

### 缺口与红态证据（先测后改）

1. **goal 截断总长度越界（#114）**：truncateWithMark 保留 maxChars 字符后
   再追加标记，返回 2006 > MAX_GOAL_CHARS(2000)；research-budget 测试与
   ResearchService 测试还固化了该错误期望。红态：`expected 2006 to be 2000`
   （budget 边界 ±1/多档 maxChars/中文多字节 4 例 + service 1 例失败）。
   修复：标记计入 maxChars（前缀 = maxChars − 标记长；标记放不下时仅按
   maxChars 截断原文、绝不输出半截标记）；单位保持 JavaScript 字符数
   （#103 CHARS 不改为 UTF-8 字节）；边界/中文/多字节/确定性/非法 maxChars
   均有单测。
2. **EvidenceLocator.table.header fail-open（#115）**：非 null/undefined/
   string 的 header 被静默转换为 null。红态：header=42/true/数组/对象 →
   parseLocatorJson 静默转 null 而测试要求整体拒绝（4 例）+ 写入路径
   fail-closed + 读取侧跳过（2 例）失败。修复：header 仅允许 string|null|
   缺省；object/array/number/boolean 使整个 locator 返回 null（读取跳过、
   写入整体拒绝零落库）。
3. **持久化预算未覆盖任务状态更新路径（#113）**：setTaskRunning/
   setTaskCompleted/setTaskFailed/setTaskCancelled/setTaskInterrupted/
   updateTaskPhase/markAllRunningInterrupted 全部无预算检查。红态：用真实
   node:sqlite 构造「距 500000 UTF-8 字节上限仅剩 3 字节」的任务（任务行 +
   1 条大 Evidence，ASCII 字节精确核算），六条单任务更新路径与
   markAllRunningInterrupted 全部静默写入并把持久化投影推过 500k
   （7 例失败 + service 映射 1 例失败）。修复：更新路径按**更新后的任务
   投影**检查（子行字节 + 更新后任务行字节 ≤ 上限——替换写不得误算为完整
   新增，控制用例证明离上限 300 字节时更新成功且不把任务行双重计入）；
   检查与写入处于调用方已有事务内（超限整体回滚零残留，单测固化）；
   markAllRunningInterrupted 任一受影响任务投影超限 → 整体拒绝零写入
   （store 装配归一化 unavailable）；错误继续映射
   research-budget-exhausted（service 层集成用例固化：近上限任务
   startTask → research-budget-exhausted 且状态不变）；任何成功写入后的
   持久化投影 ≤ 上限。
4. **MAX_STORED_TASKS 启动溢出（#112）**：31 个 created + 零可清理终态的
   合法 v1 库，启动装配静默忽略 cleanupOldestFinishedOverflow().
   overflowRemaining → normal（31 行，总数硬上限被突破）。红态：
   `expected 'normal' to be 'unavailable'`。裁决（依据 #104 总数硬上限 +
   normal|unavailable 两态，§9.2「检查失败 → unavailable」语义）：标记
   interrupted 与清理同单事务，清理后仍超限（无可清理终态——created 永不
   清除）→ 事务回滚（含标记）+ unavailable + 中文诊断（created 零删除、
   零业务写入、不引入第三种模式）；可清理形态不受影响（31 含 1 终态 →
   清理后 normal 30 行；31 全 running → 标记后清理 → normal 30 行，单测
   固化）。
5. **now 的 ISO 8601 契约漂移（#116）**：注释声称 ISO、实现只检查非空。
   裁决：决议 #105 的「ISO 8601」为**输入有效性约束** → 修复纯状态机
   校验（`isIso8601Timestamp`：形状 + 可解析 + 日历回滚拒绝——Z 形态字符串
   级往返、偏移形态值级往返；导出单测固化）。红态：14 例非法 now
   （垃圾串/非法日期 2026-13-45/日历回滚 2026-02-30/无时区/紧凑/RFC 形态）
   全部被旧实现静默接受而失败；合法 ISO（毫秒 Z/无毫秒 Z/偏移形态）正常
   迁移。调用方责任边界：now 仅由受控调用方产生（Service.nowIso/store
   装配恒 `new Date(ms).toISOString()`，既有测试断言精确输出）。
   既有 store 夹具 makeSeededDb 校准为产品 migration 全表集（决议 #113
   投影检查需读全部子表——真实 v1 库恒为 7 表集，夹具校准非产品迁就）。

### 验证证据

- 红→绿：新用例 **43 例**（budget +3、task-state +18、repository +18、
  store +3、service +1；既有错误期望修正 2 处——budget 边界 ±1 与
  service 超长 goal）——红态 **34 failed**（断言落点：2006>2000 长度
  断言、header 静默转 null 6 例、更新路径无预算检查 7 例、store 溢出
  静默忽略 1 例、now 仅查非空 14 例、service 截断/映射 2 例）；修复后
  聚焦 **174/174**（9 文件）；全量 **1429/1429**（63 文件，单 worker）。
  绿态期间发现并校准既有 store 夹具缺陷 1 处（makeSeededDb 仅建
  research_tasks 单表——决议 #113 投影检查需读全部子表，真实 v1 库恒为
  7 表集；夹具改用产品 migration 全表集，非产品迁就）。
- `npm run typecheck` / `npm run lint` / `npm run format:check` /
  `npm run build` / `git diff --check` 全绿；dev 冒烟一次通过（17 工具注册表
  恒等 + SRT-01～SRT-12 全过 + SRT-12 SQL 分类审计含 research-repository
  允许点、research 零 shell/child_process/网络）；生产冒烟**首轮瞬时失败于
  8.13 B-06 UI DOM 探针**（渲染进程脚本执行错误、无 renderer 控制台上下文、
  本闭环零 renderer/装配改动）→ 重跑一次**全矩阵通过**（8.13 全过 + SRT-12
  分类证据 + 「冒烟自检通过」，退出码 0）——如实登记：首轮失败为一次性
  瞬时现象，未复现（dev 同场景同轮通过）；冒烟日志已按清理纪律移除。
- 红线扫描：product 零动态 SQL（新增 SQL_LIST_RUNNING_TASKS 为
  research-repository 编译期常量 + 参数绑定零变化）；research 零 shell/
  child_process/网络；renderer/preload 零 SQL；package.json/lock 零 diff；
  AgentLoop 12/420s 零变化；migration v1 零改写。
- 既有文件改动仅限 C1 自身文件（budget/repository/store/task-state +
  各自测试 + service 测试）与契约文档——sources/ai/browser/renderer/
  preload/index.ts 零 diff（smoke.ts SRT-12 白名单为 C1 首闭环既有改动，
  本闭环零新增）。

## 第二次定向补修（2026-08-16）：ISO 8601 偏移日期回滚校验

> 本任务第三闭环：对 #116 落地实现做独立复核，发现偏移形态校验缺陷。
> 纪律：先写可甄别当前实现的红态测试 → 补充 #116 实现说明（detailed-design
> §15，不改写既有结论）→ 再改实现；migration v1/Repository/Store/Service
> 零改动；零既有产品模块改动；零新依赖；不新增决议编号（#116 语义不变，
> 仅补实现说明）。

### 缺口与红态证据（先测后改）

- **缺陷**：`isIso8601Timestamp` 对偏移形态仅执行
  `Date.parse(new Date(parsed).toISOString()) === parsed`——对已成功解析
  的时间近似恒真，无法甄别 JS 日期回滚（只读 Node 证据：
  `2026-02-30T00:00:00+08:00` → `2026-03-01T16:00:00.000Z`、
  `2026-04-31T12:00:00-05:00` → `2026-05-01T17:00:00.000Z`）；Z 形态
  字符串级日历往返无此问题。这违反决议 #116「形状 + 可解析 + 日历回滚
  拒绝」——偏移形态的日历回滚被静默放行。
- **红态**：research-task-state.test.ts 新增 41 例（23 非法偏移日期/边界
  形态 + 16 合法形态 + 2 迁移断言，两层断言：isIso8601Timestamp=false +
  transitionTask 全部事件零变化）→ 红态 **6 failed / 80 passed**——
  恰好 6 个偏移形态回滚用例失败（断言落点
  `expected true to be false`：2026-02-30+08:00 / 2026-04-31-05:00 /
  2025-02-29+08:00 / 2026-06-31+08:00 / 2026-09-31-05:00 /
  2026-08-16T24:00:00+08:00）；其余新增用例（Z 形态日历非法/月日时分秒
  边界/偏移越界——旧实现已正确拒绝）与全部合法形态（闰年 2024-02-29/
  月末 04-30·12-31/毫秒 1–3 位/正负偏移 ±23:59 既有边界/toISOString 形态）
  旧实现下即通过，作为回归固化。

### 修复与验证证据

- **修复**（仅 `domain/research-task-state.ts`）：先做确定性日历字段校验
  （月份 1–12/闰年判定/各月最大天数/时≤23/分≤59/秒≤59 + 偏移 ±HH:MM 且
  HH≤23、MM≤59——实测与 Date.parse 既有接受范围一致，不收缩不扩张），
  纯字段范围判定、不参与本地时区；Z 形态保留字符串级日历往返，偏移形态
  保留值级往返（纵深）。24:00 与闰秒 60 不属既有语法范围（拒绝）。
  契约文档仅补充 #116 实现说明（「Z 与偏移形态均进行日历字段校验」），
  结论未改写。
- **绿态**：聚焦 **215/215**（9 文件，+41）；全量
  **1470/1470**（63 文件，单 worker，退出码 0）。
- **红线零回归**：migration v1/Repository/Store/Service 零改动（本次仅
  task-state 纯函数 + 其测试）；sources/ai/browser/renderer/preload/
  index.ts 零 diff；零新依赖（package.json/lock 零 diff）；AgentLoop
  12/420s 零变化；17 工具注册表零变化。
- 验证矩阵：typecheck · lint · format:check · build · git diff --check 全绿；
  dev/生产默认冒烟 + SRT-01～SRT-12 + 8.1 探针 17 工具恒等见 progress.md
  第十六闭环记录。
