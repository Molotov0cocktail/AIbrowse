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
  | 'search-failed'; // 搜索降级（空结果/解析失败，warnings 携带，A4 起使用）

export interface ToolResult {
  toolCallId: string;
  ok: boolean;
  content: string; // ok=true：结构化结果文本（确定性截断 §8.4）；ok=false：中文错误说明
  errorCode?: ToolResultErrorCode; // ok=false 时
  warnings?: string[]; // 中文警告（截断/降级/启发式过滤）
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
