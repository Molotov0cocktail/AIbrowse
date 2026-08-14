// ToolExecutor：工具调用执行管线（A2）——注册表查找/参数校验 → 权限判定 → 确认状态机
// → executor → 结构化 ToolResult → 审计（每次调用恰好一条）。契约源：
// doc/stage3/detailed-design.md §4.1/§7.1/§7.2/§8.4/§10.1 + threat-model §3.3/§3.4。
// 错误永不以 ok:true 出现（Third_stage.md §8）；未预期异常归一化 execution-failed 并
// logWarn（详尽日志），审计条目本身不含堆栈/响应体/Key（audit-log 契约）。
import type {
  ElementSemanticsBinding,
  ToolCall,
  ToolResult,
  ToolResultErrorCode,
} from '../../../shared/types/agent';
import { TRUNCATION_MARK } from '../context-budget';
import type { AuditDecision, AuditEntry } from '../audit-log';
import { summarizeArgs, summarizeRawArgs } from '../audit-log';
import type { ConfirmManager } from '../confirm-manager';
import { classifyClickTarget, decide } from '../permission/permission-policy';
import { getTool, validateToolArgs } from './tool-registry';
import type { ToolExecutionContext, ToolDefinition, ToolExecutionDerived } from './tool-types';
import { logWarn } from '../../logger';

// §8.4 结果长度预算：read 独立 8000（快照章节化），其余工具 2000，search 4000（A4 接线）
export const TOOL_RESULT_CONTENT_MAX = 2000;
export const READ_TOOL_CONTENT_MAX = 8000;
export const SEARCH_TOOL_CONTENT_MAX = 4000;

const WARNING_TRUNCATED = '工具结果超过长度预算，已确定性截断';

// 确定性截断：总长 ≤ maxChars（含截断标记）
export function truncateToolContent(
  text: string,
  maxChars: number,
): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false };
  if (maxChars <= TRUNCATION_MARK.length) {
    return { content: text.slice(0, maxChars), truncated: true };
  }
  return {
    content: text.slice(0, maxChars - TRUNCATION_MARK.length) + TRUNCATION_MARK,
    truncated: true,
  };
}

function toolFailure(
  toolCallId: string,
  errorCode: ToolResultErrorCode,
  content: string,
): ToolResult {
  return { toolCallId, ok: false, content, errorCode };
}

function contentBudgetFor(toolName: string): number {
  if (toolName === 'browser.read') return READ_TOOL_CONTENT_MAX;
  if (toolName === 'search.web') return SEARCH_TOOL_CONTENT_MAX;
  return TOOL_RESULT_CONTENT_MAX;
}

export class ToolExecutor {
  constructor(
    private readonly confirmManager: ConfirmManager,
    private readonly audit: (entry: AuditEntry) => void,
  ) {}

  // 每次调用恰好一条审计（全部路径单出口）；任何失败路径均返回 ok:false + 结构化 errorCode
  async execute(
    call: ToolCall,
    ctx: ToolExecutionContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    let decision: AuditDecision;
    let argsSummary: string;
    let result: ToolResult;

    const def = getTool(call.name);
    if (def === null) {
      decision = 'invalid';
      argsSummary = summarizeRawArgs(call.arguments);
      result = toolFailure(call.id, 'tool-not-found', `未知工具「${call.name}」`);
    } else {
      const validated = validateToolArgs(call.name, call.arguments);
      if (!validated.ok) {
        decision = 'invalid';
        argsSummary = summarizeRawArgs(call.arguments);
        result = toolFailure(call.id, 'invalid-args', `参数校验失败：${validated.reason}`);
      } else {
        const binding = await this.extractSemantics(validated.args, ctx);
        const perm = decide(call.name, validated.args, binding?.semantics ?? null);
        if (perm.level === 3) {
          decision = 'forbidden';
          argsSummary = summarizeArgs(call.name, validated.args);
          result = toolFailure(call.id, 'forbidden', `操作被禁止：${perm.reason}`);
        } else if (perm.level === 2) {
          const outcome = await this.confirmManager.requestConfirm(
            ctx.runId,
            call.id,
            call.name,
            this.buildConfirmSummary(call.name, validated.args),
          );
          argsSummary = summarizeArgs(call.name, validated.args);
          if (outcome === 'approved') {
            decision = 'confirmed';
            result = await this.runTool(
              call,
              def,
              validated.args,
              ctx,
              signal,
              this.buildDerived(call.name, binding, 2),
            );
          } else {
            // denied / cancelled：fail-closed 不执行（无自动批准）
            decision = 'denied';
            result = toolFailure(call.id, 'denied-by-user', '用户未批准该操作');
          }
        } else {
          decision = perm.level === 0 ? 'auto' : 'auto-visible';
          argsSummary = summarizeArgs(call.name, validated.args);
          result = await this.runTool(
            call,
            def,
            validated.args,
            ctx,
            signal,
            this.buildDerived(call.name, binding, perm.level),
          );
        }
      }
    }

    this.audit({
      requestId: ctx.runId,
      toolCallId: call.id,
      tool: call.name,
      argsSummary,
      decision,
      ok: result.ok,
      errorCode: result.errorCode ?? null,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  // click/fill 的 elementId 语义提取（语义与文档世代绑定）：tabId 由管线解析后传入
  // （args.tabId 优先，缺省解析活动 Tab id；A5 历史提取可忽略 tabId）。未接线/无活动
  // Tab → null → 权限层 fail-closed L3——执行器层实时复核属 A3 纵深防御，不得替代权限层判定。
  private async extractSemantics(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ElementSemanticsBinding | null> {
    const elementId = typeof args.elementId === 'string' ? args.elementId : undefined;
    if (elementId === undefined || ctx.getElementSemantics === undefined) return null;
    let tabId: string | null = typeof args.tabId === 'string' ? args.tabId : null;
    if (tabId === null) {
      tabId = (await ctx.browser.getActiveTab())?.id ?? null;
    }
    return ctx.getElementSemantics(tabId, elementId);
  }

  // A3：allowedKind/documentId 由权限决策同源派生（执行器内部参数，模型不可见不可写）。
  // allowedKind 只由 classifyClickTarget 对同一语义 binding 派生（decide 同源）——
  // executor 与交互脚本均不自行分类；binding 缺失/分类为 null 时不产生任何执行参数
  // （权限层已 L3 拒绝，此处为纵深防御，防御性传递 undefined 由 executor fail-closed）。
  private buildDerived(
    toolName: string,
    binding: ElementSemanticsBinding | null,
    level: 0 | 1 | 2,
  ): ToolExecutionDerived | undefined {
    if (binding === null) return undefined;
    if (toolName === 'browser.click') {
      const allowedKind = level <= 2 ? classifyClickTarget(binding.semantics) : null;
      return { allowedKind: allowedKind ?? undefined, documentId: binding.documentId };
    }
    if (toolName === 'browser.fill') {
      return { documentId: binding.documentId };
    }
    return undefined;
  }

  // L2 确认展示摘要：程序组装确定性事实（A3/A6 起含元素文本摘要；文案不经模型/网页）
  private buildConfirmSummary(toolName: string, args: Record<string, unknown>) {
    const url = typeof args.url === 'string' ? args.url : undefined;
    return { url, detail: `工具「${toolName}」需要用户确认后执行` };
  }

  private async runTool(
    call: ToolCall,
    def: ToolDefinition,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
    signal: AbortSignal,
    derived?: ToolExecutionDerived,
  ): Promise<ToolResult> {
    if (signal.aborted) {
      return toolFailure(call.id, 'execution-failed', '任务已取消，未执行工具');
    }
    try {
      const raw = await def.executor({ id: call.id, args, derived }, ctx, signal);
      const content = typeof raw.content === 'string' ? raw.content : '';
      const { content: cut, truncated } = truncateToolContent(content, contentBudgetFor(def.name));
      const warnings = [...(raw.warnings ?? [])];
      if (truncated) warnings.push(WARNING_TRUNCATED);
      return {
        toolCallId: call.id,
        ok: raw.ok,
        content: cut,
        // 最小形状：errorCode 仅失败时携带；warnings 仅非空时携带（§2.2 可选字段语义）
        ...(raw.ok ? {} : { errorCode: raw.errorCode }),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (err) {
      logWarn('tool-executor', `工具「${def.name}」执行异常（toolCallId=${call.id}）`, err);
      return toolFailure(call.id, 'execution-failed', '工具执行失败');
    }
  }
}
