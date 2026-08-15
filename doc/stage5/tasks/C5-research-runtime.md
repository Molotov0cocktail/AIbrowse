# C5 — 独立有界 ResearchRuntime、进度、停止、失败继续、预算与终态

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §6；安全契约
> `doc/stage5/threat-model.md` §3.4/§3.6（FT-10/FT-15）。

## 目标

落地 ResearchRuntime 独立有界编排状态机（纯核心零 Electron import）：
阶段循环（planning→reading→verifying→synthesizing）、进度事件、停止、
失败继续、预算硬约束与终态单一所有权——**不复用、不修改 AgentLoop**
（12 步/420s 契约零改动，回归断言）。

## 范围与非目标

- **做**：Runtime 类（构造注入 provider/sourceService/searchProvider/
  browser/workspace/captureService/repository/时钟/预算——全部可注入）；
  阶段循环（§6.2）；Research 模型轮工具子集（决议 #96 六工具编译期常量）；
  进度事件（§6.5 节流）；stop（§6.3）；失败继续矩阵（§6.4）；超时
  （§6.6）；预算用尽正式终态（§6.8）；心跳持久化（interrupted 支撑）；
  Service 接线（start/stop 编排 + 事件回调）；冒烟 8.17。
- **不做**：综合层提示词与 claims（C6 提供合成模块，Runtime 以注入接口
  消费——本任务以桩接口推进阶段）；UI/IPC（C8）；真实 Provider（C9）；
  修改 AgentLoop/ConversationService/确认管线。

## 涉及模块和输入文档

- 新增 `src/main/research/research-runtime.ts` + 测试；`research-service.ts`
  扩展（C1 骨架接线）；smoke.ts 新场景 8.17。
- 输入：detailed-design §6/§15（决议 #94/#95/#96）；threat-model §3.4/
  §3.6；A5 AgentLoop 模式（agent-loop.ts，模式复用不修改）；FakeProvider
  多轮脚本（测试设施复用）。

## 预计修改文件

- 新增：`src/main/research/research-runtime.ts` + `research-runtime.test.ts`。
- 修改：`src/main/research/research-service.ts`（接线 start/stop/事件；
  C1 骨架扩展）、`src/main/smoke.ts`（仅新增 8.17 场景入口，既有场景零
  改动）、`src/main/index.ts`（最小装配——仅新注册/新接线，既有路径零
  改动）。
- 若 C5 需冒烟注入点（smokeAgentLimits 同模式），仅 SMOKE_MODE 门控。

## 依赖

C1–C4（其中综合层以桩接口注入，C6 完成后替换为真实实现——桩接口形状
按 §7 设计预留）。

## 红→绿步骤

1. **红**：先写测试（模块缺失红）——阶段循环全路径（FakeProvider 脚本：
   planning 候选 → reading 逐来源 → verifying → synthesizing →
   completed + Result 落库）；终态单一所有权（finish 后迟到事件/写入零
   生效）；stop 幂等（abort 流 + 清理 + cancelled）；超时（注入时钟）→
   failed + Evidence 保留；预算用尽（轮次/步数/来源数注入极限）→ 正式
   终态 + 不自动扩预算；失败继续（单候选读失败/单轮 Provider 失败重试 1
   次/连续 2 轮 → failed）；非法 Result 重提 ≤2 次 → failed；心跳落库与
   interrupted 标记路径；工具子集恒等（请求 tools 恰为六工具）。
2. **绿**：实现 Runtime + Service 接线；逐用例转绿。
3. **冒烟 8.17**（dev+生产双场景）：FakeProvider 多轮脚本驱动全阶段
   completed + Result 落库；stop 中途 cancelled + 本任务 Tab 清理 +
   用户 Tab 保留；预算注入用尽 failed + Evidence 保留；迟到事件零生效。
4. **双进程门控** `AIBROWSE_RESEARCH_SMOKE=set|check`（与既有门控互斥）：
   set 完成任务退出 → check 新进程读回 task/evidence/result +
   interrupted 标记路径。
5. 全量回归 + 红线扫描（AgentLoop/17 工具/权限矩阵零改动断言）。

## 验收标准

- §6 全部规则单测覆盖 + 8.17 双场景 + 双进程门控通过；
- AgentLoop 契约零改动（diff 断言）；Research 请求 tools 恒为六工具子集
  （恒等断言）；心跳/预算/终态断言全绿。

## 具体验证命令和期望结果

- `npm test -- --maxWorkers=1` → 全量绿；
- `npm run typecheck` / `npm run lint` / `npm run format:check` /
  `npm run build` / `git diff --check` → 全部退出码 0；
- dev + 生产冒烟默认矩阵（含 8.17）退出码 0；
- `AIBROWSE_RESEARCH_SMOKE=set|check` 双进程退出码 0（生产产物）。

## 完成定义

红→绿证据回填 + 8.17/双进程通过 + 全量验证全绿 + diff 终检 + progress.md
更新 + 逻辑提交（feat: C5 …）+ 双远程推送。

## 风险与停止条件

- Runtime 与 AgentLoop 出现耦合需求 → 停止并报告（独立 Runtime 为
  决策 D2 红线；不得改 AgentLoop 契约）；
- 综合层桩接口与 C6 设计冲突 → 校准本文 §7 与桩形状（先改文档再改码）。

## 提交边界

逻辑提交；不夹带 C6 真实综合实现。
