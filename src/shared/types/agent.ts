// Third Stage Agent/Tool shared types (A2). Contract source: doc/stage3/detailed-design.md §2.2.
// A2 scope: ToolCall / ToolResult / permission level / element semantics (permission-policy 输入).
// A5/A6 类型（ToolStep/AgentRunStatus/AgentRunSummary/AgentConfirmRequest/AgentStepEvent/
// AgentRunDoneEvent）在对应任务实现时增补，不提前落地（§2.2 标 A2/A5）。
// 纯类型声明：main/preload/renderer 可复用（A6 UI 事件 payload 亦在此扩展）。

export type ToolPermissionLevel = 0 | 1 | 2 | 3;
// 0=auto；1=auto-visible（显著展示）；2=confirm；3=forbid（Third_stage.md §3.5 / §7.1 定稿矩阵）

export interface ToolCall {
  id: string; // 模型调用 id（ProviderToolCall.id）
  name: string;
  arguments: string; // 原始 JSON 字符串（审计记录原文；执行用解析结果）
}

export type ToolResultErrorCode =
  | 'invalid-args' // schema/参数校验失败
  | 'tool-not-found' // 未注册工具
  | 'element-not-found' // elementId 定位失败（含跨快照陈旧引用，A3 起使用）
  | 'stale-element' // 快照已过期（导航/刷新后，A3 起使用）
  | 'not-interactable' // 元素不可交互（不可见/禁用，A3 起使用）
  | 'forbidden' // L3 拒绝（如 fill password）
  | 'denied-by-user' // L2 确认被用户拒绝
  | 'execution-failed' // 执行层失败（含交互脚本拒绝）
  | 'search-failed' // 搜索降级（空结果/解析失败，warnings 携带，A4 起使用）
  // —— B4：Source 工具错误码（与 SourceErrorCode 8 值恒等映射，决议 #64 系列）——
  | 'source-invalid-change' // change set 结构/语义非法
  | 'source-version-conflict' // expectedVersion 与当前版本不符（乐观并发/TOCTOU）
  | 'source-duplicate' // 唯一约束命中（重复添加）
  | 'source-not-found' // 目标不存在（blocked 视同不存在）
  | 'source-forbidden' // blocked 猜测引用（决议 #66，不泄漏存在/内容）
  | 'source-limit' // 数量/分页/预算超限
  | 'source-unavailable' // 信源服务不可用（缺失装配/disposed/DB 异常）
  | 'source-conflict'; // 幂等重放指纹冲突等 fail-closed 冲突

export interface ToolResult {
  toolCallId: string;
  ok: boolean;
  content: string; // ok=true：结构化结果文本（确定性截断 §8.4）；ok=false：中文错误说明
  errorCode?: ToolResultErrorCode; // ok=false 时
  warnings?: string[]; // 中文警告（截断/降级/启发式过滤）
  // B4（决议 #67）：source_apply_changes 成功时主进程生成的幂等键——仅供 ToolExecutor
  // 审计出口读取（argsSummary 追加）；不进 UNTRUSTED_TOOL_RESULT 块、不进 ToolStep
  // 持久化、不进 UI（无消费通道）。
  idempotencyKey?: string;
}

// click/fill 权限判定的元素语义元数据（§7.1/§5.4）：来自 Agent 历史最近一次快照的
// 结构化条目（A5 由执行器从历史提取，模型不能伪造；A2 以纯函数级验证为主）。
// 字段语义：字段存在 = 采集脚本显式证明；缺失 = 无法证明（click/fill fail-closed L3）。
export interface ElementSemantics {
  href?: string; // links 条目：目标 URL（仅 http/https 允许）
  isSubmit?: boolean; // inputs/buttons 条目：提交类标志（升级 L2 的唯一依据）
  ariaExpanded?: boolean; // buttons 条目：显式声明 aria-expanded 状态——true/false
  // 均为展开/折叠控件的结构化证明；字段缺失不能证明（fail-closed）
  inputType?: string; // inputs 条目 type（click 切换=checkbox/radio；fill 禁 password/file）
  // A6：links/buttons 条目的可见文本（采集脚本显式采集；inputs 不采集——placeholder/value
  // 非可见文本证据，宁缺勿错）。确认对话框 elementText 的唯一来源——**页面提供的目标
  // 文本，视为不可信输入**（渲染层只作纯文本展示 + 控制字符清理 + 截断）。
  // 不影响权限判定：decide/classifyClickTarget 不消费本字段。
  text?: string;
}

// click 执行器内部允许类别（A3）：权限决策派生的执行器内部参数——不进入工具 schema、
// 模型与网页均不可见不可写（threat-model §3.3 执行器层不可达）。唯一派生源为
// permission-policy.classifyClickTarget（单一事实源，执行器不自行分类）。
export type ClickAllowedKind = 'submit' | 'nav' | 'expand' | 'toggle';

// 语义与可信文档世代绑定（A3 elementId 生命周期根因修复）：documentId 为快照时刻主进程
// 维护的导航世代计数（PageSnapshot.meta.documentId），模型/网页不可提供或修改；click/fill
// 执行前由 BrowserController 校验当前世代一致，导航/刷新后旧引用 → stale-element。
export interface ElementSemanticsBinding {
  semantics: ElementSemantics;
  documentId: number;
}

// —— A5 扩展：Agent Runtime 类型（doc/stage3/detailed-design.md §2.2 + 决议 #33） ——

// ToolStep/审计/可见性消费的决策枚举单一事实源（决议 #33，2026-08-14）：
// 校验前失败（tool-not-found/invalid-args/防循环安全阻断）→ invalid；L3 → forbidden；
// L2 确认 → confirmed/denied（作废按 denied 计）；L0/L1 自动 → auto/auto-visible。
// execution-failed 保留实际权限决策（如 L0 工具执行失败 → decision=auto）。
// audit-log.AuditDecision 为本类型别名，不另立枚举。
export type ToolStepDecision =
  'auto' | 'auto-visible' | 'confirmed' | 'denied' | 'forbidden' | 'invalid';

export interface ToolStep {
  // 会话内持久化精简版（§9.3；不含 fill 输入值、不含快照正文、不含内部能力参数）
  id: string; // ToolCall.id（与 toolCallId 恒等——协议关联键）
  toolCallId: string;
  name: string;
  ok: boolean;
  contentPreview: string; // 结果摘要 ≤ 200 字符（fill 值替换为「（已输入 N 字符）」）
  errorCode?: ToolResultErrorCode; // ok=false 时
  decision: ToolStepDecision;
  createdAt: number; // 主进程盖章
}

export type AgentRunStatus =
  | 'running'
  | 'waiting-confirm'
  | 'done'
  | 'cancelled'
  | 'step-limit'
  | 'timeout'
  | 'loop-detected'
  | 'no-progress'
  | 'error';

export interface AgentRunSummary {
  requestId: string;
  sessionId: string;
  status: AgentRunStatus; // 终态（running/waiting-confirm 为过程态，不出现在摘要）
  stepsUsed: number; // 已执行/试图执行的工具步数（含被拒/失败/安全阻断）
  maxSteps: number;
  finalText: string; // 最后一个模型轮的文本（done=最终回答；其余=终止轮部分文本）
  toolStepCount: number; // 已记录的 ToolStep 数
}

export interface AgentConfirmRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  summary: { url?: string; elementText?: string; detail: string }; // 确定性事实（程序组装）
  createdAt: number;
}

export interface AgentStepEvent {
  requestId: string;
  sessionId: string;
  step: ToolStep; // 每一步工具调用的可见性推送
  // A6：参数摘要（非持久化可见性字段）——与审计同源（audit-log.summarizeArgs 同一脱敏
  // 纯函数，主进程生成）：fill text 只记 len=N、URL/query 全量、其余 ≤200 确定性截断；
  // 不含请求头/响应体/内部参数/documentId/allowedKind。ToolStep 持久化结构不变。
  argsSummary: string;
}

// A6 确认决议结果（与 ConfirmManager.ConfirmOutcome 单一事实源——此处为共享定义，
// confirm-manager 以别名引用，renderer 事件 payload 直接复用）
export type AgentConfirmOutcome = 'approved' | 'denied' | 'cancelled';

// A6 实时状态相位（程序生成的确定性运行事实，不含思维过程/模型解释）：
// starting=run 已启动（在途注册后）／thinking=模型轮进行中（等待/累积 Provider 流）/
// executing=某个工具已通过防循环判定、即将进入执行管线（当前步已计入 stepsUsed）/
// waiting-confirm=L2 pending 已建立／confirm-resolved=pending 已决议或作废（携带 outcome）/
// finalizing=最终回答已生成，正在组装终态消息（done 终态前）。
export type AgentStatusPhase =
  'starting' | 'thinking' | 'executing' | 'waiting-confirm' | 'confirm-resolved' | 'finalizing';

export interface AgentStatusEvent {
  requestId: string;
  sessionId: string;
  phase: AgentStatusPhase;
  // executing 时当前工具名（程序事实，来自 ToolCall.name）；waiting-confirm 时同理
  toolName?: string;
  // 循环内相位携带 A5 实际计数（AgentLoop 内部计数器直出；starting 恒 0/maxSteps）。
  // confirm-resolved 相位不携带（决议时刻无新计数事实，UI 保留最近一次权威值）。
  stepsUsed?: number;
  maxSteps?: number;
  confirmOutcome?: AgentConfirmOutcome; // confirm-resolved 相位必带（approved/denied/cancelled）
}

// 复用共读 turn-done 形态（§2.2）：Agent 终态事件的权威终止理由在 run.status。
export type AgentRunDoneEvent = import('./conversation').TurnDoneEvent & {
  run: AgentRunSummary;
};
