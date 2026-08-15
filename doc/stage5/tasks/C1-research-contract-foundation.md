# C1 — ResearchTask/Evidence/Result 核心契约、状态机纯函数、存储与服务基座

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §2/§3/§9；安全契约
> `doc/stage5/threat-model.md`（先于任何实现定稿——已满足）。

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

- §2 全部类型与 §6.8 全部常量落地且与本文一致（grep 核对导出）；
- §3.1 状态迁移表全行有单测覆盖（含非法事件安全返回/终态不可变/start
  前置矩阵）；
- repository/store 测试覆盖 §9.1 契约（真实 node:sqlite；注入串仅作数据；
  CASCADE；形状校验；字节预算；MAX_STORED_TASKS 清理）；
- Service 骨架：createTask/getTask/listTasks/deleteTask/start 前置校验/
  stop 状态迁移；非法输入安全返回不抛异常；错误码映射完整。

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
