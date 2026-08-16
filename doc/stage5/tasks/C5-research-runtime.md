# C5 — 独立有界 ResearchRuntime、进度、停止、失败继续、预算与终态

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §6（已按决议
> #132–#139 重写）；安全契约 `doc/stage5/threat-model.md` §3.2/§3.4/§3.6
> （FT-09/FT-10/FT-15/FT-16/FT-17）。**实施前契约裁决 #132–#139 已完成
> （2026-08-16）**——本文档已按裁决同步。

## 目标

落地 ResearchRuntime 独立有界编排状态机（纯核心零 Electron import）：
阶段循环（planning→reading→verifying→synthesizing）、Research 六工具
专属执行模型、ResearchPlan 判别联合、C6/C7 稳定端口（fail-closed 装配）、
进度事件、停止、失败继续、预算硬约束、原子持久化与终态预留、终态单一
所有权与 shutdown 契约——**不复用、不修改 AgentLoop**（12 步/420s 契约
零改动，回归断言）。

## 范围与非目标

- **做**（决议 #132–#139 精确语义见 detailed-design §6/§15）：
  - Runtime 类（构造注入 provider/sourceService/searchProvider/
    browser/workspace/captureService/repository/时钟/预算/prompts/
    synthesis/result-validation 三端口——全部可注入）；
  - 六工具专属执行模型（RESEARCH_TOOL_NAMES/Research 专属工具定义/
    browser_open 候选 URL 白名单/browser_read 内存内容索引/未知工具安全
    结果，不经 ToolRegistry/ToolExecutor——#132）；
  - ResearchPlan 判别联合与两轮计划（候选查询计划 → 收集/合并/持久化 →
    选择意图）+ 安全默认计划 + candidateId 预分配（#133）；
  - C6/C7 端口（ResearchPromptsPort/ResearchSynthesisPort/
    ResearchResultValidationPort）+ research-runtime-unavailable 第 12 码
    （#134）；
  - Service 异步装配（startTask 立即返回/RuntimeFactory 注入/active
    slot/runToken/restart 屏障/终态单一写入者/shutdown）（#135）；
  - 步数/轮次/上下文预算与 Provider 失败映射（#136）；
  - RuntimePersistencePort + 500k 终态预留 + stats 精确语义 + 终态原子性
    （#137）；
  - ProgressEvent/heartbeat/终态优先级/cleanupAll（#138）；
  - index.ts 最小生产装配 + SMOKE 注入点 + 退出 shutdown（#139）；
  - Service 接线（start/stop 编排 + 事件回调）；冒烟 8.17；
    `AIBROWSE_RESEARCH_SMOKE=set|check` 双进程门控。
- **不做**：综合层提示词与 claims 真实实现（C6——经端口消费，本任务以
  确定性 stub 推进阶段）；ResultValidator（C7——端口 stub）；UI/IPC（C8）；
  真实 Provider（C9——本任务零调用）；修改 AgentLoop/ConversationService/
  确认管线；migration v1 改写；C4 的 release 契约变更（不长期保留 Tab）。

## 涉及模块和输入文档

- 新增 `src/main/research/research-runtime.ts` +
  `research-runtime-persistence.ts`（或并入 runtime 模块的端口实现）+
  `research-runtime.test.ts`；`research-service.ts` 扩展（C1 骨架 →
  异步装配接线）；smoke.ts 新场景 8.17 + RESEARCH_SMOKE set/check 门控；
  index.ts 最小装配。
- 输入：detailed-design §6/§15（决议 #94/#95/#96/#132–#139）；threat-model
  §3.2/§3.4/§3.6；A5 AgentLoop 模式（agent-loop.ts，模式复用不修改）；
  FakeProvider 多轮脚本（测试设施复用）；shared/types/research.ts（
  新增 MAX_PLAN_WEB_QUERIES/RESEARCH_TOOL_RESULT_CONTENT_MAX/
  RESEARCH_TOOL_NAMES/research-runtime-unavailable/ResearchPlan/
  ResearchProgressEvent/端口类型）。

## 预计修改文件

- 新增：`src/main/research/research-runtime.ts` +
  `research-runtime-persistence.ts` + `research-runtime.test.ts`。
- 修改：`src/shared/types/research.ts`（#132–#138 新增常量/类型/错误码）、
  `src/main/research/research-service.ts`（异步装配/active slot/shutdown/
  runtimeFactory 注入）、`src/main/research/repository/research-repository.ts`
  （终态预留方法，决议 #137(2)——仅新增编译期常量与纯计算，零 SQL 新语句
  或仅 Repository 编译期常量）、`src/main/research/domain/research-errors.ts`
  （第 12 码文案）、`src/main/smoke.ts`（仅新增 8.17 场景入口 + set/check
  门控路由，既有场景零改动）、`src/main/index.ts`（最小装配——仅新注册/
  新接线/shutdown，既有路径零改动）。
- 若 C5 需冒烟注入点（smokeAgentLimits 同模式），仅 SMOKE_MODE 门控。

## 依赖

C1–C4（综合层与 Result 校验以注入端口消费，C6/C7 完成后替换为真实实现——
端口形状已由决议 #134 冻结）。

## 红→绿步骤

1. **红**：先写测试（模块缺失红）——覆盖清单见 detailed-design §13.1
   research-runtime.test.ts 行（四阶段顺序与每 phase 心跳/六工具子集/
   未知工具/非法参数/跨任务与未知 candidate·tab/UUID 冲突 fail-closed/
   计划白名单矩阵/24·8·16·60 上限/capture attempts 与 stats 精确对应/
   降级矩阵/模型轮重试与连续失败/context-too-long/step·round 边界零执行/
   stop 竞态/restart 屏障/late 全 no-op/progress 语义/listener throw/
   每终态 cleanupAll/用户 Tab 恒等/shutdown 幂等/原子回滚/Result+completed
   同事务/500k 终态预留/正文·transcript·reasoning 零持久化/终态优先级/
   runToken 守卫）。旧结构（无模块）全部失败。
2. **绿**：实现 Runtime + persistence 端口 + Service 接线；逐用例转绿。
3. **冒烟 8.17**（smoke.ts 新场景，dev+生产双场景）：FakeProvider 多轮
   脚本驱动全阶段（planning→reading→verifying→synthesizing）→
   completed + 候选/Capture/VerifiedEvidence/Result 落库读回 +
   CaptureContent 正文零落盘 + 用户 Tab 集合前后恒等；stop 中途 →
   cancelled + 本任务 Tab 清理 + 用户 Tab 保留；预算注入用尽 → failed
   （research-budget-exhausted）+ 此前 Evidence 保留；终态后迟到事件
   零影响。
4. **双进程门控** `AIBROWSE_RESEARCH_SMOKE=set|check`（与既有
   SESSION/SOURCES/SOURCES_UI 门控确定性互斥，互斥先于一切）：两独立
   生产进程共用受控共享临时 userData——set 经**产品 Service/Runtime
   路径**（SMOKE 注入确定性 stub 端口 + FakeProvider）创建并完成一个任务
   （completed + Result 落库），再启动一个任务、在其**真实 phase
   heartbeat 落库后**直接退出（遗留 running）；check 新进程启动时验证
   前者可读（task/evidence/result 读回恒等）、后者自动变为 interrupted；
   **不允许用测试 SQL 直接伪造核心产品状态**；结束后零 Electron 进程、
   零临时数据库与根目录日志残留。
5. 全量回归 + 红线扫描（AgentLoop 12/420s/17 工具/权限矩阵零改动断言；
   Runtime 零 SQL；renderer/preload 零 SQL 零 Research IPC；migration v1
   零改写；零新依赖；零 shell/child_process/eval/网络能力）。

## 验收标准

- §6 全部规则单测覆盖（决议 #132–#139）+ 8.17 双场景 + 双进程门控通过；
- AgentLoop 契约零改动（diff 断言）；Research 请求 tools 恒为六工具子集
  （恒等断言）；心跳/预算/终态预留/竞态断言全绿；
- 生产装配 fail-closed（无 C6/C7 端口 → research-runtime-unavailable）；
  未验证模型输出零写入 ResearchResult。

## 具体验证命令和期望结果

- `npm test -- --maxWorkers=1` → 全量绿；
- `npm run typecheck` / `npm run lint` / `npm run format:check` /
  `npm run build` / `git diff --check` → 全部退出码 0；
- dev + 生产冒烟默认矩阵（含 8.17）退出码 0；
- `AIBROWSE_RESEARCH_SMOKE=set|check` 双进程退出码 0（生产产物）。

## 完成定义

红→绿证据回填 + 8.17/双进程通过 + 全量验证全绿 + diff 终检 + progress.md
更新 + 逻辑提交（docs: 裁决 C5 ResearchRuntime 契约 +
feat: 完成 C5 ResearchRuntime）+ 双远程推送。

## 风险与停止条件

- Runtime 与 AgentLoop 出现耦合需求 → 停止并报告（独立 Runtime 为
  决策 D2 红线；不得改 AgentLoop 契约）；
- 六工具 wire 形状与注册表同名工具无法一致 → 停止并报告（决议 #132
  交叉断言红线）；
- 综合层/Result 端口形状与 C6/C7 设计冲突 → 校准本文与桩形状（先改文档
  再改码——端口形状已被决议 #134 冻结，C6/C7 按此实现）。

## 提交边界

逻辑提交；不夹带 C6 真实综合实现与 C7 ResultValidator；不夹带 C8 IPC/UI。

## 红→绿证据

- **红态**（2026-08-16，模块不存在/旧结构）：
  - 5 个测试文件（research-tools/research-plan/research-runtime-
    persistence/research-runtime/research-service-async）整体失败
    （导入错误——模块尚不存在）；
  - 红态 5 files failed / 14 failed（vitest 输出实证）。
- **转绿**：实现 6 个新模块（research-tools/research-plan/
  research-runtime-persistence/research-runtime + research-service
  异步装配 + research-store 工厂注入 + Repository 终态预留）后——
  C5 聚焦 **113/113**（5 文件）；全量 **1804/1804**（基线 1691 + 113
  新增；既有用例零删除零削弱——#113 投影检查用例按决议 #137(2) 语义
  校准为探针 SQL 直插填充（终态预留使 Repository 写入路径恒放行，
  投影检查作为独立防线可测）；错误码表 11→12 码（#134(3) 扩展）；
  C1 service 测试注入 immediate-settle stub factory（#135 装配语义）。
  实现期修复均为契约落地与测试夹具校准（候选 id 预分配/requestId 独立
  计数/abort 错误事件归属/上下文预算裁剪等），无迁就实现。
- **冒烟 8.17**（默认矩阵自动包含；dev+生产双场景退出码 0）：真实
  ResearchWorkspace + CaptureService + FakeProvider 多轮脚本全阶段
  （planning→reading→verifying→synthesizing）→ completed + 候选/
  Capture/VerifiedEvidence/Result 落库读回 + capture 正文零落盘 +
  用户 Tab 集合恒等 + 进度初始/终态各恰好一次；stop 中途 → cancelled
  - 迟到写入零生效；预算注入（61 条 proposal）→
    research-budget-exhausted + 此前 60 条 Evidence 保留。
- **双进程门控** `AIBROWSE_RESEARCH_SMOKE=set|check`（与 SESSION/
  SOURCES/SOURCES_UI 确定性互斥；生产产物）退出码 0/0：set 经产品
  Service/Runtime 路径（openResearchStore + SMOKE RuntimeFactory）
  创建完成一个任务 + 遗留 running 直接退出（app.exit 不经 shutdown）；
  check 新进程读回 completed 任务与 Result + 遗留 running 自动标
  interrupted（interruptedAt 落库、phase 置空）；零测试 SQL 伪造核心
  状态；结束后零 Electron 进程、零临时数据库、根目录日志零残留。
- **红线扫描台账**：migration v1 零改写；Runtime 零 SQL（SQL 仅
  Repository 编译期常量 + migrations/driver；persistence 端口零 SQL）；
  renderer/preload 零 SQL 零 Research IPC；零 shell/child_process/eval；
  capture 正文/transcript/reasoning/Key 零持久化；工具注册表仍 17；
  AgentLoop 12/420s 零 diff；package.json/lockfile 零 diff；用户 Tab
  集合不变；真实 Provider 调用 **0 次**（C5 无真实 Provider 产品链路；
  决议 #117 长期授权不等于强制无关调用）。
- 验证命令：`npm test -- --maxWorkers=1` **1804/1804** 绿；typecheck/
  lint/format:check/build/diff-check 绿；dev + 生产默认冒烟（含 8.17）
  退出码 0；set/check 双进程退出码 0/0。
