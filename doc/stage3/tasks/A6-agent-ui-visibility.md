# A6 操作可见性 UI + IPC/bridge 扩展 + 确认流 UI（可验证闭环）

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
- **非目标**：**严禁**真实 Provider 验证（A7）、威胁模型红队专项（A7）、
  多窗口、面板拖拽动画；不改共读 UI 行为。

## 涉及文件（实施后校准）

- 新增：`src/renderer/src/ai/agent-run-state.ts` + `.test.ts`（reducer）、
  `agent-display.ts` + `.test.ts`（脱敏/文案纯函数）、`useAgent.ts`、
  `AgentStatusBar.tsx`、`ToolCallList.tsx`、`ConfirmDialog.tsx`。
- 修改：`src/shared/types/agent.ts`（ElementSemantics.text/AgentStepEvent.
  argsSummary/AgentStatusPhase/AgentStatusEvent/AgentConfirmOutcome）、
  `src/shared/types/ipc.ts`（6 通道 + payload——含决议 #34 新增 agent-status）、
  `src/shared/types/app.ts` + `src/preload/index.ts`（bridge 白名单 + 4 事件
  订阅）、`src/main/ai/confirm-manager.ts`（onPendingChange 判别联合 +
  多监听者 Set）、`src/main/ai/agent/agent-loop.ts`（onStatus 相位 +
  onAgentStep argsSummary）、`src/main/ai/conversation-service.ts`
  （onAgentStatus 装配）、`src/main/ai/tools/tool-executor.ts`（确认摘要
  elementText/目标站点 URL）、`src/main/ai/tools/interaction-semantics.ts`
  （text 映射）、`src/main/index.ts`（handler 装配 + 事件发送 + 冒烟注入点）、
  `src/renderer/src/ai/AiPanel.tsx`（模式切换）/`Composer.tsx`/`ChatView.tsx`
  （ToolStep 条目 + agentRun 徽标）/`useConversation.ts`（refreshHistory）/
  `history-events.ts`（消息 id 去重）/`App.tsx`（useAgent + 全局 ConfirmDialog）/
  `index.css`、`src/main/smoke.ts`（8.5 A6-UI-01～A6-UI-12 + 夹具与注入点）。

## 实施步骤

- [x] 红：agent-run-state reducer 用例 + agent-display 脱敏/文案用例 + 既有文件
      扩展用例（红态证据：**8 files failed / 21 failed / 697 passed**——2 个新
      测试文件模块缺失 + confirm-manager 3（判别联合契约校准原位更新）/
      interaction-semantics 3（text 字段契约校准原位更新）/tool-executor 2/
      agent-loop 7/conversation-service 5/history-events 1；既有用例零删除零削弱）
- [x] 实现 IPC/bridge（6 通道：2 invoke + 4 事件含 agent-status；sender 校验 +
      事件只发主窗口 + eventRelay 退订）
- [x] 实现渲染层组件与 hook（ConfirmDialog 全局挂载/deny 默认焦点/纯文本渲染；
      agent-run-state 按 sessionId/requestId 键控）
- [x] 冒烟 UI 矩阵 A6-UI-01～A6-UI-12（任务模式端到端/确认两路/停止/终止理由/
      共读回归）→ 红→绿修复（4 处冒烟断言自身缺陷 + 1 处实现侧缺陷，见下）
- [x] 全量回归 → 提交推送 → 更新 progress.md

## 实施结果（2026-08-14）

**① 契约校准（决议 #34，先于编码，五点固定）**：a) 事件充分性——新增
AgentStatusEvent（starting/thinking/executing/waiting-confirm/confirm-resolved/
finalizing）+ conversation:agent-status 通道；ConfirmManager.onPendingChange
载荷扩展为判别联合（settled 携带 outcome）并改为多监听者 Set 分发（关闭 A5
计划内限制「回调所有权为最后构造的 Service 实例」——冒烟红态实证触发：A5
冒烟 Service 覆盖生产 Service 回调致确认事件丢失）；b) 参数摘要——AgentStepEvent
增非持久化 argsSummary（审计同源 summarizeArgs，主进程生成，渲染层不解析
arguments）；c) 确认信任边界——ElementSemantics.text（links/buttons 采集脚本
显式采集；inputs 不采集）+ buildConfirmSummary 填充 elementText/目标站点
URL（主进程可信 TabInfo）+ 渲染层 sanitizeConfirmText（控制字符/bidi 剔除 +
截断）+ deny 默认高亮/焦点；d) 任务模式与状态纪律——模式不持久化、busy 互斥、
切换/折叠不静默取消、停止按钮真实 requestId + 「正在停止」非终态、历史刷新
与 run-done 竞态按消息 id 去重；e) 冒烟注入点（仅 SMOKE_MODE）——
smokeAgentLimits/smokeAgentSearchProvider（委托 Provider 调用时读取）。
同步：detailed-design §2.2/§11.1/§11.2/§15 决议 #34 + high-level-design §4 +
threat-model §3.3。

**② 红→绿**：红态 8 files failed / 21 failed / 697 passed（2 新测试文件模块
缺失 + 既有文件扩展用例；既有用例零删除零削弱——confirm-manager 3 与
interaction-semantics 3 为契约校准原位更新）。实现后全量 **766/766**（新增
67：agent-run-state 23 / agent-display 23 / history-events 1 / confirm-manager
2 / interaction-semantics 1 / tool-executor 3 / agent-loop 7 / conversation-
service 7）。期间修正：实现侧真实缺陷 1 处（onPendingChange 判别联合的 pending
变体无顶层 runId——事件映射静默失败，测试抓出）+ 测试自身缺陷若干（fixture
消息 id 复用、慢工具夹具、vi.waitFor 超时窗口、转义文本）；实现后偶发 1 例
未捕获测试名的失败复跑 3 次全绿（判定为并行负载下 1s 超时窗口边缘抖动）——
新用例 vi.waitFor 统一 5s 窗口固化，不放宽断言。

**③ 实现**：shared 类型（AgentStatusPhase/Event/AgentConfirmOutcome/
argsSummary/ElementSemantics.text）；confirm-manager 多监听者；
agent-loop onStatus 相位 + onAgentStep argsSummary（审计同源）；
conversation-service onAgentStatus（starting/waiting-confirm/confirm-resolved
映射 + 防串 run）；tool-executor buildConfirmSummary（elementText + 目标站点
URL）；interaction-semantics text 映射；IPC 6 通道 + preload bridge（agentAsk/
confirmTool/4 事件订阅）；main handler（goal 校验/截断、confirm 逐字段校验）；
renderer：agent-run-state reducer（sessionId/requestId 键控/去重/终态收敛/
迟到忽略）+ agent-display 纯函数 + useAgent + AgentStatusBar + ToolCallList +
ConfirmDialog（App 级全局）+ 任务模式 AiPanel/Composer + ChatView ToolStep
条目 + history-events 去重；index.ts 事件发送 + 冒烟注入点；smoke.ts 8.5
A6-UI-01～A6-UI-12。

**④ 冒烟 8.5 A6-UI-01～A6-UI-12（React DOM 事件驱动，真实 preload/IPC/
服务链路）**：A6-UI-01 多步任务状态渐进（7 步顺序/参数摘要含搜索查询串/
7-12 徽标/搜索临时 Tab 零泄漏）/A6-UI-03 确认框 deny 默认焦点（document.
activeElement 断言）+ 拒绝零 DOM 动作 + approve 一次执行 + 审计 denied/
confirmed 各一/A6-UI-04 pending 停止作废关闭 + 迟到 approve 无效/A6-UI-05
慢模型中途停止 cancelled + 部分保留/A6-UI-06 step-limit/loop-detected/
no-progress/timeout 中文理由 + invalid 条目失败样式/A6-UI-07 invalid-args
回注修正/A6-UI-08 模式/会话/面板切换不串 run + 共读互斥/A6-UI-09 历史刷新
无重复回答 + ToolStep v2 磁盘重读 7 条目/A6-UI-10 fill 页面真实写入 + DOM/
日志/会话文件零原文/A6-UI-11 敌对 elementText 纯文本截断 + 无富文本注入 +
无自动批准/A6-UI-12 共读回归 + 日志敏感扫描零命中。**dev 离线 + 生产产物
双场景退出码 0**；共读既有矩阵 1–12 与 A5 8.4 A-01～A-09 完整回归。
红→绿期间修正 4 处冒烟断言自身缺陷（面板标题文案回归既有矩阵断言、瞬态
相位窗口竞态、会话列表索引与重挂载选中语义、发送禁用断言形态）。

**⑤ 验证与终检**：test 766/766 · typecheck · lint · format:check · build 全绿；
红线 grep（renderer 零 dangerouslySetInnerHTML/Markdown 库/Key 读回/万能工具；
共读 SYSTEM_PROMPT/13 工具 schema/permission-policy/interaction-script 零改动；
新代码零 Electron import；package 零改动）；敏感信息扫描与 diff 终检零命中；
根目录杂散日志与失败冒烟残留临时目录清理。**未调用任何付费 Provider、未输出/
索取 API Key。**

## 测试与检查

- 全量验证矩阵（AGENTS.md 附 A）；单测见 detailed-design §13.1 A6 行；
  红线 grep：确认 UI 文案不来自模型/网页（summary 为程序组装）、bridge 无 Key 读回。

## 完成定义

- 单测全绿；全量回归通过；冒烟 UI 矩阵退出码 0；共读矩阵 1–12 回归通过；
  progress.md 标记 A6 ✅ 并推荐 A7。
