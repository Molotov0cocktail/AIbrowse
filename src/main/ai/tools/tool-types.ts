// A2 工具定义与执行函数类型。契约源：doc/stage3/detailed-design.md §4.1。
// 依赖方向（AGENTS.md §3 Agent 架构纪律）：工具实现只经构造注入的 BrowserController /
// SearchProvider 操作浏览器——工具模块不 import Electron、不直连 webContents。
import type { BrowserController } from '../../browser/browser-controller';
import type {
  ElementSemantics,
  ToolPermissionLevel,
  ToolResult,
} from '../../../shared/types/agent';
import type { ProviderToolParameter } from '../../../shared/types/conversation';

export interface ToolDefinition {
  name: string; // 唯一；命名空间前缀 browser./search.（§4.1）
  description: string; // 模型可见说明（程序常量，描述能力与限制）
  parameters: {
    properties: Record<string, ProviderToolParameter>;
    required: string[];
  };
  baseRisk: ToolPermissionLevel; // 基础风险级（§7.1 矩阵，permission-policy.ts 为唯一事实源）
  riskLift?: {
    // 条件升级（确定性规则，§7.1）：元素语义驱动（A3 注册 click 时落地）
    submitClick?: ToolPermissionLevel; // click 目标为提交类元素时的级别
  };
  executor: ToolExecutorFn; // 注入式执行函数（依赖由装配时提供，工具实现不 import Electron）
}

export type ToolExecutorFn = (
  call: { id: string; args: Record<string, unknown> },
  ctx: ToolExecutionContext, // browser 能力 + 审计归属（装配注入）
  signal: AbortSignal,
) => Promise<ToolResult>;

export interface ToolExecutionContext {
  browser: BrowserController; // 唯一浏览器通道（构造注入；A2 工具只经它执行）
  runId: string; // 审计与确认归属（A5 传 requestId）
  // click/fill 元素语义来源：A5 接线为「Agent 历史最近一次快照」提取（模型不能伪造）；
  // A2 只读/导航工具不触发（未接线时 click/fill 的 decide 因 null 语义 fail-closed L3）
  getElementSemantics?: (elementId: string) => ElementSemantics | null;
}
