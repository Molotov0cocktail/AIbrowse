# T6 操作可见性 UI + IPC/bridge 扩展 + 确认流 UI（可验证闭环）

- **目标**：用户可实时知道 AI 在做什么——Agent 状态栏、正在访问的网页、最近
  Tool 调用、等待确认的动作、停止按钮；确认对话框（确定性事实展示，文案不经
  模型/网页）；IPC 通道与 preload bridge 扩展；UI 端到端冒烟矩阵。
- **输入文档**：doc/stage3/detailed-design.md §11/§13.2；
  doc/stage3/threat-model.md §3.3（确认 UI 确定性事实）。
- **范围**：IPC 通道（conversation:agent-ask/agent-confirm/agent-step/
  agent-confirm-request/agent-run-done，sender 校验复用）；bridge 白名单
  （agentAsk/confirmTool/onAgentStep/onAgentConfirmRequest/onAgentRunDone，
  eventRelay 模式）；渲染层 Agent 模式切换 + AgentStatusBar + ToolCallList +
  ConfirmDialog（deny 默认高亮/作废自动关闭）+ 停止按钮 + ToolStep 消息渲染 +
  纯函数 agent-run-state（reducer 单测）；冒烟 UI 矩阵（React DOM 事件驱动：
  任务输入发送/step 事件渐进/确认 approve/deny 两路/停止/终止理由展示/共读
  回归 A-11）。
- **非目标**：**严禁**真实 Provider 验证（T7）、威胁模型红队专项（T7）、
  多窗口、面板拖拽动画；不改共读 UI 行为。

## 涉及文件

- 新增：`src/renderer/src/ai/AgentMode.tsx`（或并入 AiPanel）、`AgentStatusBar.tsx`、
  `ToolCallList.tsx`、`ConfirmDialog.tsx`、`agent-run-state.ts` + `.test.ts`、
  `useAgent.ts`（事件订阅 hook）。
- 修改：`src/shared/types/ipc.ts`（5 通道常量 + payload）、
  `src/shared/types/app.ts` + `src/preload/index.ts`（bridge 白名单）、
  `src/main/index.ts`（handler 装配：goal 校验/截断、confirm 转发）、
  `src/renderer/src/ai/AiPanel.tsx`（模式切换与布局）、`src/main/smoke.ts`
  （UI 矩阵）。

## 实施步骤

- [ ] 红：agent-run-state reducer 用例（step 追加/确认请求/run 终态收敛/竞态忽略）
- [ ] 实现 IPC/bridge（sender 校验 + 事件只发主窗口 + 退订）
- [ ] 实现渲染层组件与 hook（ConfirmDialog 只渲染确定性 summary）
- [ ] 冒烟 UI 矩阵（任务模式端到端/确认两路/停止/终止理由/共读回归）
- [ ] 全量回归 → 提交推送 → 更新 progress.md

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；单测见 detailed-design §13.1 T6 行；
  红线 grep：确认 UI 文案不来自模型/网页（summary 为程序组装）、bridge 无 Key 读回。

## 完成定义

- 单测全绿；全量回归通过；冒烟 UI 矩阵退出码 0；共读矩阵 1–12 回归通过；
  progress.md 标记 T6 ✅ 并推荐 T7。
