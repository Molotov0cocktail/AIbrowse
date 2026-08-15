// A2 工具定义与执行函数类型。契约源：doc/stage3/detailed-design.md §4.1。
// 依赖方向（AGENTS.md §3 Agent 架构纪律）：工具实现只经构造注入的 BrowserController /
// SearchProvider 操作浏览器——工具模块不 import Electron、不直连 webContents。
import type { BrowserController } from '../../browser/browser-controller';
import type { PageSnapshot } from '../../../shared/types/browser';
import type {
  ClickAllowedKind,
  ElementSemanticsBinding,
  ToolPermissionLevel,
  ToolResult,
  ToolResultErrorCode,
} from '../../../shared/types/agent';
import type { ProviderToolParameter } from '../../../shared/types/conversation';
import type { SearchProvider } from '../search/search-provider';
import type { SourceService } from '../../../shared/types/sources';
import type { ConfirmSummary } from '../confirm-manager';

// A3：参数级校验规则（校验器按工具定义逐参数应用；不进模型可见 schema）
export interface ToolParamRule {
  maxLength?: number; // 字符串长度上限（优先于 VALIDATION_LIMITS 全局默认）
  nonEmpty?: boolean; // 字符串去空白后必须非空
  integer?: boolean; // 数字必须为整数
  min?: number; // 数字下界（含）
  max?: number; // 数字上界（含）
}

// B4 决议 #66：程序化确认摘要钩子结果——ok:true 携带摘要（由 ToolExecutor 直接用于
// ConfirmManager.requestConfirm）；ok:false = 预览失败（版本冲突/blocked 猜测/结构拒绝），
// ToolExecutor 以钩子错误码 fail-closed 终止调用（不进入确认、零写入、审计恰好一条）。
export type ConfirmSummaryHookResult =
  | { ok: true; summary: ConfirmSummary }
  | { ok: false; errorCode: ToolResultErrorCode; content: string };

export interface ToolDefinition {
  name: string; // 唯一；命名空间前缀 browser./search.（§4.1）
  description: string; // 模型可见说明（程序常量，描述能力与限制）
  parameters: {
    properties: Record<string, ProviderToolParameter>;
    required: string[];
  };
  paramRules?: Record<string, ToolParamRule>; // A3：确定性参数规则（如 dy ±50000 整数）
  baseRisk: ToolPermissionLevel; // 基础风险级（§7.1 矩阵，permission-policy.ts 为唯一事实源）
  riskLift?: {
    // 条件升级（确定性规则，§7.1）：元素语义驱动（A3 注册 click 时落地）
    submitClick?: ToolPermissionLevel; // click 目标为提交类元素的级别
  };
  executor: ToolExecutorFn; // 注入式执行函数（依赖由装配时提供，工具实现不 import Electron）
  // B4 决议 #66：可选程序化确认摘要钩子——L2 路径在 ConfirmManager.requestConfirm
  // 之前调用（source_apply_changes 借此经 SourceService.previewChangeSet 产出确定性
  // diff）；未设置的工具体走既有 buildConfirmSummary 兜底（行为零回归）。
  confirmSummary?: (
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ) => Promise<ConfirmSummaryHookResult>;
}

// A3：ToolExecutor 权限决策派生的执行参数（执行器内部参数，模型不可见不可写）——
// allowedKind 只由 classifyClickTarget 对同一语义 binding 派生；documentId 为语义绑定
// 的快照世代（elementId 生命周期校验用）。executor 不自行分类、无派生参数时拒绝执行。
export interface ToolExecutionDerived {
  allowedKind?: ClickAllowedKind;
  documentId?: number;
}

export type ToolExecutorFn = (
  call: { id: string; args: Record<string, unknown>; derived?: ToolExecutionDerived },
  ctx: ToolExecutionContext, // browser 能力 + 审计归属（装配注入）
  signal: AbortSignal,
) => Promise<ToolResult>;

export interface ToolExecutionContext {
  browser: BrowserController; // 唯一浏览器通道（构造注入；A2 工具只经它执行）
  runId: string; // 审计与确认归属（A5 传 requestId）
  // A4：search_web 的搜索通道注入点（设计 §4.1「browser 能力 + search」）——executor
  // 优先使用本注入（冒烟受控夹具离线驱动/A5 AgentLoop 装配），缺省回退注册注入。
  searchProvider?: SearchProvider;
  // B4：Source 工具唯一通道（设计 §9.1 注入点，类比 searchProvider）——executor 优先
  // 使用本注入（冒烟临时库/A5 AgentLoop 装配），缺省回退注册注入；两者皆缺 →
  // source-unavailable 安全失败（不拖垮浏览器）。
  sourceService?: SourceService;
  // A3：click/fill 元素语义来源（语义与文档世代绑定）。tabId 由管线解析后传入
  // （args.tabId 优先，缺省活动 Tab；A5 历史提取可忽略 tabId）——未接线时 click/fill
  // 因 null 语义 fail-closed L3；绑定 documentId 与当前世代不符 → 执行层 stale-element。
  getElementSemantics?: (tabId: string | null, elementId: string) => ElementSemanticsBinding | null;
  // A3：工具实时采集的快照语义登记（read/find 成功时调用；A5 可由历史提取替换）
  recordSnapshot?: (tabId: string, snapshot: PageSnapshot) => void;
}
