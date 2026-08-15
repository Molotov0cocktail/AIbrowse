# C1 — ResearchTask/Evidence/Result 核心契约、状态机纯函数、存储与服务基座

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §2/§3/§6.8/§9/§15
> （决议 #94–#100 设计期 + **#101–#111 C1 实施前契约裁决**，2026-08-16）；
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
