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
import type { ConfirmManager, ConfirmSummary } from '../confirm-manager';
import { classifyClickTarget, decide } from '../permission/permission-policy';
import { getTool, validateToolArgs } from './tool-registry';
import type { ToolExecutionContext, ToolDefinition, ToolExecutionDerived } from './tool-types';
import { logWarn } from '../../logger';

// §8.4 结果长度预算：read 独立 8000（快照章节化），其余工具 2000，search 4000（A4 接线）；
// B4（§8.1）：Source 工具统一 4000（与 search_web 同级）
export const TOOL_RESULT_CONTENT_MAX = 2000;
export const READ_TOOL_CONTENT_MAX = 8000;
export const SEARCH_TOOL_CONTENT_MAX = 4000;
export const SOURCE_TOOL_CONTENT_MAX = 4000;

const WARNING_TRUNCATED = '工具结果超过长度预算，已确定性截断';

const SOURCE_TOOL_NAMES: readonly string[] = [
  'source_search',
  'source_list',
  'source_get',
  'source_apply_changes',
];

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
  if (toolName === 'browser_read') return READ_TOOL_CONTENT_MAX;
  if (toolName === 'search_web') return SEARCH_TOOL_CONTENT_MAX;
  if (SOURCE_TOOL_NAMES.includes(toolName)) return SOURCE_TOOL_CONTENT_MAX;
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
          // B4 决议 #66：程序化确认摘要钩子（source_apply_changes 的只读 preview diff）
          // 在 ConfirmManager.requestConfirm 之前调用；预览失败 → 以钩子错误码
          // fail-closed 终止（不进入确认、零写入、审计恰好一条 decision=invalid）。
          const hookResult =
            def.confirmSummary !== undefined ? await def.confirmSummary(validated.args, ctx) : null;
          if (hookResult !== null && !hookResult.ok) {
            decision = 'invalid';
            argsSummary = summarizeArgs(call.name, validated.args);
            result = toolFailure(call.id, hookResult.errorCode, hookResult.content);
          } else {
            const summary =
              hookResult !== null
                ? hookResult.summary
                : await this.buildConfirmSummary(
                    call.name,
                    validated.args,
                    binding?.semantics.text,
                    ctx,
                  );
            const outcome = await this.confirmManager.requestConfirm(
              ctx.runId,
              call.id,
              call.name,
              summary,
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

    // B4 决议 #67：source_apply_changes 成功后幂等键入审计（ToolExecutor 单出口的
    // 恰好一条纪律不变——仅追加，不新增条目）；幂等键不进 UNTRUSTED_TOOL_RESULT 块/
    // ToolStep/UI（ToolResult.idempotencyKey 仅供本审计出口读取）。
    if (call.name === 'source_apply_changes' && result.ok && result.idempotencyKey !== undefined) {
      argsSummary = `${argsSummary};idempotencyKey=${result.idempotencyKey}`;
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
    if (toolName === 'browser_click') {
      const allowedKind = level <= 2 ? classifyClickTarget(binding.semantics) : null;
      return { allowedKind: allowedKind ?? undefined, documentId: binding.documentId };
    }
    if (toolName === 'browser_fill') {
      return { documentId: binding.documentId };
    }
    return undefined;
  }

  // L2 确认展示摘要：程序组装确定性事实（工具名/URL/权限原因为程序常量；文案不经模型）。
  // elementText 来自语义 binding（快照采集的 links/buttons 可见文本）——**页面提供的目标
  // 文本，不可信输入**（A6 确认 UI 只作纯文本渲染 + 控制字符清理 + 截断，见
  // renderer/src/ai/agent-display.ts）；缺失时不含该字段（宁缺勿错，不伪造）。
  // 目标站点：参数无 url 的工具（click/fill 提交类）取目标 Tab 的 URL——主进程可信
  // TabInfo（程序事实，非页面提供）；目标 Tab 不可用时不含该字段（宁缺勿错）。
  private async buildConfirmSummary(
    toolName: string,
    args: Record<string, unknown>,
    elementText: string | undefined,
    ctx: ToolExecutionContext,
  ): Promise<ConfirmSummary> {
    let url = typeof args.url === 'string' ? args.url : undefined;
    if (url === undefined) {
      const tabId =
        typeof args.tabId === 'string' ? args.tabId : (await ctx.browser.getActiveTab())?.id;
      if (tabId !== undefined) {
        const tab = (await ctx.browser.getTabs()).find((t) => t.id === tabId);
        if (tab !== undefined && tab.url !== '') url = tab.url;
      }
    }
    return {
      ...(url !== undefined ? { url } : {}),
      ...(elementText !== undefined && elementText !== '' ? { elementText } : {}),
      detail: `工具「${toolName}」需要用户确认后执行`,
    };
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
        // B4 决议 #67：审计出口专用幂等键透传（见 execute() 追加逻辑）
        ...(raw.idempotencyKey !== undefined ? { idempotencyKey: raw.idempotencyKey } : {}),
      };
    } catch (err) {
      logWarn('tool-executor', `工具「${def.name}」执行异常（toolCallId=${call.id}）`, err);
      return toolFailure(call.id, 'execution-failed', '工具执行失败');
    }
  }
}
