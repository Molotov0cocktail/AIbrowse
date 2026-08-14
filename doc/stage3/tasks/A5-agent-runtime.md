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
  index.ts 装配（agent 事件转发主窗口、before-quit 取消在途 run）；
  smoke.ts 主进程矩阵 A-01～A-09（FakeProvider 工具脚本离线）。
- **非目标**：**严禁 UI/IPC 通道改动(A6)**——事件出口经构造注入回调，本任务
  仅主进程验证；不实现真实 Provider 验证（A7）；不做多 Agent/并发 run。

## 涉及文件

- 新增：`src/main/ai/agent/agent-loop.ts` + `.test.ts`、`agent-context-builder.ts`
  - `.test.ts`、`agent-history.ts`、`agent-safety.ts` + `.test.ts`。
- 修改：`src/main/ai/conversation-service.ts` + `.test.ts`、
  `src/main/ai/conversation-store.ts` + `.test.ts`、
  `src/shared/types/conversation.ts`（Agent 类型）、`src/shared/types/agent.ts`
  （run 状态/事件 payload）、`src/main/ai/tools/tool-executor.ts`（历史快照元素
  语义提取接线）、`src/main/index.ts`、`src/main/smoke.ts`。

## 实施步骤

- [ ] 红：agent-safety 防循环边界用例 / agent-loop 状态机全路径用例（FakeProvider
      工具脚本）/ agent-context-builder 块闭合与恒等用例 / store version 2 兼容用例
- [ ] 实现 agent-safety + agent-loop（§8.1 时序即契约）
- [ ] 实现 agent-context-builder + agent-history（§9）
- [ ] 实现 conversation-service agentAsk/confirmTool + ToolStep 持久化（§9.3）
- [ ] 实现 store version 2（读兼容 v1、写入恒 v2）
- [ ] 冒烟矩阵 A-01～A-09（主进程驱动）→ 红→绿修复
- [ ] 全量回归 → 提交推送 → 更新 progress.md

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；单测见 detailed-design §13.1 A5 行；
  红线 grep：fill 值不持久化断言 / 审计脱敏 / 无万能工具。

## 完成定义

- 单测全绿；全量回归通过；冒烟离线矩阵（既有 + A-01～A-09）退出码 0；
  终止理由四种（step-limit/timeout/loop-detected/no-progress/cancelled）均有
  断言；progress.md 标记 A5 ✅ 并推荐 A6。
