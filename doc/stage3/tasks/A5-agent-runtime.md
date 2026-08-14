# A5 Agent Runtime：Loop 状态机 / 上限 / 取消 / 防循环 / 上下文与持久化（可验证闭环）

- **目标**：最小可控 Agent Loop（用户目标 → 模型选工具 → 校验 → 权限 → 执行 →
  结构化结果 → 继续 → 最终回答）；最大步数 12 / 总超时 420s / 取消 / 防循环三触发；
  Agent 上下文构建（AGENT_SYSTEM_PROMPT + UNTRUSTED_TOOL_RESULT 块 + tool 历史
  摘要重放）；ConversationService agent-ask 扩展 + ToolStep 持久化（version 2）；
  主进程冒烟矩阵 A-01～A-09。
- **输入文档**：doc/stage3/detailed-design.md §2.2/§8/§9/§13.2（A-01～A-09）；
  doc/stage3/threat-model.md §3.1/§3.5。
- **范围**：agent-loop.ts（纯核心状态机，构造注入 browser/search/provider/confirm/
  audit/limits）；agent-safety.ts（签名规范化/连续 3/累计 5/无进展 2）；
  agent-context-builder.ts（tools 透传/tool 消息 UNTRUSTED_TOOL_RESULT 块/历史
  摘要重放）；agent-history.ts（ToolStep 组装与回注）；
  conversation-service.ts 扩展（agentAsk/confirmTool/在途互斥/事件出口）；
  conversation-store.ts version 2（读兼容 v1/ToolStep 形状校验/脱敏断言）；
  index.ts 装配（agent 事件回调主进程接线、before-quit 取消在途 run）；
  smoke.ts 主进程矩阵 A-01～A-09（FakeProvider 工具脚本离线）。
- **非目标**：**严禁 UI/IPC 通道改动(A6)**——事件出口经构造注入回调，本任务
  仅主进程验证；不实现真实 Provider 验证（A7）；不做多 Agent/并发 run。

## 涉及文件（实施后校准）

- 新增：`src/main/ai/agent/agent-loop.ts` + `.test.ts`、`agent-context-builder.ts`
  - `.test.ts`、`agent-history.ts` + `.test.ts`、`agent-safety.ts` + `.test.ts`。
- 修改：`src/main/ai/conversation-service.ts` + `.test.ts`、
  `src/main/ai/conversation-store.ts` + `.test.ts`、
  `src/shared/types/conversation.ts`（role='tool'/toolCallId/toolStep/toolCalls/
  agentRun）、`src/shared/types/agent.ts`（ToolStepDecision（决议 #33 单一事实源，
  增 invalid）/ToolStep/AgentRunStatus/AgentRunSummary/AgentConfirmRequest/
  AgentStepEvent/AgentRunDoneEvent）、`src/main/ai/audit-log.ts`（AuditDecision
  = ToolStepDecision 别名 + formatAgentRunAuditMessage）、
  `src/main/ai/confirm-manager.ts`（onPendingChange 可见性回调）、
  `src/main/ai/provider/fake-provider.ts`（多轮 rounds 脚本 + getRequests +
  中止感知睡眠）、`src/main/ai/context-builder.ts`（导出 serializeUntrustedBlock +
  共读重放过滤工具轮）、`src/main/index.ts`、`src/main/smoke.ts`。
  （校准：原任务文档列 tool-executor.ts 修改——实际 A3 已落地 getElementSemantics
  接线，A5 无需改动；ToolStep decision 捕获经审计包装实现，零管线改动。）

## 实施步骤

- [x] 红：agent-safety 防循环边界用例 / agent-loop 状态机全路径用例（FakeProvider
      工具脚本）/ agent-context-builder 块闭合与恒等用例 / store version 2 兼容用例
      （红态证据：8 files failed / 30 failed / 587 passed——4 个新测试文件模块缺失 +
      store/service/fake/confirm 扩展用例失败；既有用例零删除零削弱）
- [x] 实现 agent-safety + agent-loop（§8.1 时序即契约 + 决议 #33 六点校准）
- [x] 实现 agent-context-builder + agent-history（§9 + 决议 #33 分组/重放规则）
- [x] 实现 conversation-service agentAsk/confirmTool + ToolStep 持久化（§9.3）
- [x] 实现 store version 2（写入恒 v2、读取兼容 v1、孤立 tool 丢弃、组感知裁剪）
- [x] 冒烟矩阵 A-01～A-09（主进程驱动）→ 红→绿修复（3 处冒烟断言缺陷：A-04
      累计滚动值、A-07 异步导航 waitFor + 传递性证明、A-09 auditRun 接线）
- [x] 全量回归 → 提交推送 → 更新 progress.md

## 实施结果（2026-08-14）

**① 契约校准（决议 #33，先于编码，六点固定）**：a) 循环阻断时机——签名 =
工具名 + 规范化参数（键排序 + Unicode NFC；解析失败用 NFC 原始串，改键序不能
逃避）；判定在每次执行管线前，触发次零副作用；阻断调用计 stepsUsed + 恰好一条
审计（decision=invalid）+ 一个 ToolStep；步数上限同理（绝不执行第 13 步，
未执行零伪造）。b) 协议历史——每轮 assistant（完整按序 toolCalls + 轮次文本）+
同序 tool 消息；invalid-args/tool-not-found/forbidden/denied/execution-failed
均为结构化 tool result；空/重复/跨轮冲突 id fail-closed；同轮超剩余步数只执行
预算内。c) 上下文与持久化——首轮 goal+启动快照恰一次（后续轮不重复插入）；当轮
ToolResult 全文进块、持久化只留摘要；持久化结构 user(goal) → [assistant(脱敏
toolCalls)+tool(toolStep)]×N → 终态 assistant(finalText+agentRun)；每轮文本
恰好落盘一次；200 条裁剪组感知；孤立 tool 消息解析丢弃、不完整组重放过滤、共读
重放过滤工具轮。d) 文本与工具并存——有 toolCalls 时该轮文本为过程性输出；
仅「无工具且有文本」为 done；空轮进入 transcript（重试痕迹）连续 2 轮终止；
finalText = 最后一个模型轮的文本（与终态消息 content 恒等）。e) 终态竞争——
单一终态所有权（finish() 守卫 + 工具执行/Provider 解析与终态 Promise.race）；
终态时 abort 流 + cancelAll 作废 pending + 零后续执行 + 迟到事件忽略；timer/
监听器 finally 清理；终态映射 done→complete/cancelled→aborted/timeout→error
(timeout)/安全终止→error（权威理由在 AgentRunSummary.status）。f) decision
单一事实源——ToolStepDecision 六值定义于 shared/types/agent.ts，AuditDecision
为别名，execution-failed 保留实际权限决策。§2.2/§8.1/§8.3/§9.1/§9.3/§10.1/§15 +
high-level-design §4 数据流 + threat-model §3.4/§3.5 已同步。

**② 红→绿**：先写测试——红态 **8 files failed / 30 failed / 587 passed**
（4 个新测试文件模块不存在 + store/service/fake/confirm 扩展用例失败；既有用例
零删除零削弱）。实现后全量 **699/699**（新增 123：agent-safety 17 /
agent-context-builder 15 / agent-history 17 / agent-loop 32 / conversation-store
22 / conversation-service 14 / fake-provider 4 / confirm-manager 3；另有
conversation-store 既有 1 处版本断言随 v2 契约原位校准——version 2 为写入版本）。
期间修正的失败均为测试自身断言缺陷（计数时机/共享 metadata 污染/门闩模式/
快照正文误入夹具），实现侧真实缺陷 2 处：工具执行 await 未与终态竞争（cancel
挂起）、run 审计出口冒烟未接线——均修复并有断言固化。

**③ 实现**：agent-safety（签名规范化/连续 3/累计 5/无进展 2，阈值可注入）；
agent-loop（纯核心零 Electron import：逐条串行执行 ToolExecutor 管线、每 run
独立 InteractionSemanticsStore、审计捕获包装零重复审计、终态竞争、
fail-closed 协议校验、finalText/轮次记录统一语义）；agent-context-builder
（AGENT_SYSTEM_PROMPT 独立常量、goal 消息复用共读块序列化、UNTRUSTED_TOOL_
RESULT 块闭合转义、buildAgentRequest 恒等透传）；agent-history（ToolStep 组装
（内部能力参数零出现）、fill toolCalls 脱敏、完整交互组校验、跨 run 摘要重放 +
预算裁剪）；conversation-store v2（写入恒 v2/读兼容 v1/ToolStep 逐字段校验/
孤立 tool 丢弃/组感知裁剪/零持久化红线）；conversation-service（agentAsk 共享
单在途互斥、goal 截断、provider 未配置/不支持工具零执行、逐步 ToolStep 持久化、
终态映射、confirmTool、确认事件防串 run）；confirm-manager onPendingChange；
fake-provider 多轮 rounds/getRequests/中止感知睡眠；index.ts 主进程装配
（事件回调日志可见性，不新增 IPC/preload/UI）。

**④ 冒烟 A-01～A-09（8.4，主进程驱动，FakeProvider 多轮脚本离线确定性）**：
A-01 多步任务（open→read→find→search.web→scroll→click→read→最终回答 done，
7 步/16 条历史/13 工具请求/system 恒等/goal 恰一次/搜索临时 Tab 零泄漏/真实
导航落地页）；A-02 提交类确认（deny 零动作 → 模型重试 → approve 执行，页面
日志恰好一次点击，审计 denied/confirmed 各一）；A-03 取消（慢模型中停 cancelled

- 部分保留；pending 中 abort → pending 作废 + 零执行）；A-04 step-limit
  （maxSteps=3 注入，第 4 步零执行 scrollY=6）；A-05 loop-detected（连续第三次
  在执行前阻断 scrollY=20，阻断步骤 decision=invalid，审计恰好 3 条）；A-06
  invalid-args 回注后调整成功；A-07 elementId 世代（reload 后旧 id stale-element、
  新快照正常导航，传递性证明零误操作）；A-08 fill 隐私（普通输入成功 +
  input/change 事件真实触发、审计 len=N、password forbidden 零写入、会话文件与
  日志字节扫描零原文）；A-09 审计恰好一条（3 条 tool-call + 2 条 agent-run，
  无 fill 原文/Key 形态）。**dev 离线全矩阵 + 生产产物双场景退出码 0**；共读
  既有矩阵 1–12 与工具层/交互/搜索场景完整回归。

**⑤ 验证与终检**：test 699/699 · typecheck · lint · format:check · build 全绿；
红线 grep（新代码零 Electron import、无万能工具形态、package 零改动、UI/preload/
IPC 通道零改动、共读 SYSTEM_PROMPT 零改动、13 工具 schema 零改动、fill 原文/
快照正文/documentId 零持久化）；敏感信息扫描与 diff 终检零命中；根目录杂散
日志清理。**未调用任何付费 Provider、未输出/索取 API Key。**

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）：test 699/699（576 基线 + 123 新增）、
  typecheck / lint / format:check / build 全绿；Electron 冒烟 dev + 生产双场景
  退出码 0（含 8.4 A-01～A-09）。
- 红线 grep：fill 值不持久化断言（单测字节级 + 冒烟日志扫描）/ 审计脱敏 /
  无万能工具 / 新代码零 Electron import / 无新 IPC 通道。

## 完成定义

- 单测全绿；全量回归通过；冒烟离线矩阵（既有 + A-01～A-09）退出码 0；
  终止理由五种（step-limit/timeout/loop-detected/no-progress/cancelled）均有
  断言；progress.md 标记 A5 ✅ 并推荐 A6。

## 计划内限制登记

- 确认事件回调所有权为「最后构造的 ConversationService 实例」——A5 进程内
  仅一个生产 Service + 冒烟 Service 顺序构造（单 pending 设计本身已全局串行化
  L2）；多 Service 并行共享 ConfirmManager 的场景属 A6+ 扩展点。
- 取消竞态下被中断的工具调用计 stepsUsed 与审计但不产生 ToolStep（迟到结果
  被忽略——工具执行与终态竞争所致），toolStepCount ≤ stepsUsed 仅出现在该
  竞态路径（决议 #33⑤，有单测固化）。
- 运行时 transcript 保留当轮 ToolResult 全文（≤4000/8000 截断）——12 步上限
  × 结果预算 = 请求规模确定性有界（含启动快照 ≤ 约 100k 字符）；跨 run 重放
  仅摘要（决议 #26）。
