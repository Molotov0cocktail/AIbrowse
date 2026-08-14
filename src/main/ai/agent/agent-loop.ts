// AgentLoop 纯编排状态机（A5，零 Electron import；依赖全部构造注入）。契约源：
// doc/stage3/detailed-design.md §8.1/§8.2/§8.3 + threat-model §3.5 + 决议 #33：
// - 单步编排（时序即契约）：buildAgentRequest → provider.stream 累积（delta 转发/toolCalls
//   聚合）→ 无工具有文本 = done；无文本无工具 = no-progress（连续 2 轮）；有工具 → 逐条
//   串行执行（ToolExecutor：校验→权限→确认→执行→审计，每次调用恰好一条审计）→ 步数/防循环
//   检查 → 继续或终止；
// - 防循环在执行前阻断：签名计数在每次执行管线前判定（连续第 3/累计第 5 次该调用零副作用），
//   阻断调用计 stepsUsed + 恰好一条审计（decision=invalid）+ 一个 ToolStep；
// - 协议历史：每轮 assistant（完整按序 toolCalls + 轮次文本）→ 同序 tool 消息（UNTRUSTED_
//   TOOL_RESULT 块）；空/重复 toolCallId、跨轮冲突 → fail-closed error 终态；同轮调用数
//   超过剩余 MAX_STEPS → 只执行预算内（绝不执行第 13 步，未执行不伪造结果）；
// - 终态单一所有权：finish() 一次性守卫（done/abort/超时/取消/异常先到先得）；终态时
//   loopController.abort + cancelAll(runId) 作废 pending；终态后零工具执行；迟到 delta/
//   工具结果被忽略；timer/监听器/AbortController finally 清理；
// - 每 run 独立 InteractionSemanticsStore（read/find 实时登记，click/fill 世代随绑定）。
import type { BrowserController } from '../../browser/browser-controller';
import type {
  NormalizedProviderError,
  ProviderMessage,
  ProviderRequest,
  ProviderTool,
  ProviderToolCall,
} from '../../../shared/types/conversation';
import type { AgentRunStatus, ToolStep } from '../../../shared/types/agent';
import type { AuditEntry } from '../audit-log';
import { summarizeRawArgs } from '../audit-log';
import { ConfirmManager } from '../confirm-manager';
import { ToolExecutor } from '../tools/tool-executor';
import { InteractionSemanticsStore } from '../tools/interaction-semantics';
import type { SearchProvider } from '../search/search-provider';
import type { LLMProvider } from '../provider/llm-provider';
import { AgentSafety, buildToolSignature } from './agent-safety';
import { buildAgentRequest, buildToolResultMessage } from './agent-context-builder';
import { buildToolStep } from './agent-history';

export const AGENT_MAX_STEPS = 12;
export const AGENT_TOTAL_TIMEOUT_MS = 420_000; // 总超时含模型轮、工具执行与确认等待

export interface AgentLoopLimits {
  maxSteps: number;
  totalTimeoutMs: number;
}

export const AGENT_LOOP_LIMITS: AgentLoopLimits = {
  maxSteps: AGENT_MAX_STEPS,
  totalTimeoutMs: AGENT_TOTAL_TIMEOUT_MS,
};

export interface AgentRoundRecord {
  text: string; // 该轮模型文本（过程性输出；空轮为 ''）
  toolCalls: ProviderToolCall[]; // 该轮完整调用（模型产出顺序）
  steps: ToolStep[]; // 已处理步骤（执行/被拒/失败/安全阻断——与审计一一对应）
}

export interface AgentRunResult {
  requestId: string;
  status: AgentRunStatus; // 终态
  finalText: string; // 最后一个模型轮的文本（done=最终回答；其余=终止轮部分文本）
  finalToolCalls: ProviderToolCall[]; // 终止轮未进入完整轮记录的调用（step-limit 轮边界等）
  stepsUsed: number; // 已执行/试图执行的工具步数（含被拒/失败/安全阻断）
  maxSteps: number;
  toolStepCount: number;
  rounds: AgentRoundRecord[]; // 已完成的模型轮（含空轮与未执行完的工具轮）
  error: NormalizedProviderError | null;
}

export interface AgentLoopCallbacks {
  onStreamChunk?: (delta: string) => void; // 全部轮次 delta 逐块转发
  onAgentRound?: (e: { roundText: string; toolCalls: ProviderToolCall[] }) => void; // 轮完成（执行前）
  onAgentStep?: (e: { step: ToolStep }) => void; // 每步终态（含安全阻断）
}

export interface AgentLoopOptions {
  requestId: string;
  model: string;
  goalMessage: ProviderMessage; // 首轮 goal（启动快照块由 Service 构建一次）
  replayMessages: ProviderMessage[]; // 跨 run 重放（Service 经 agent-history 裁剪转换）
  tools: ProviderTool[]; // 注册表序列化（Provider 不支持 tool calling 时不发送）
  providerResolver: () => Promise<LLMProvider | null>; // null → not-configured 终态
  confirmManager: ConfirmManager;
  browser: BrowserController; // ToolExecutionContext.browser（工具唯一浏览器通道）
  searchProvider?: SearchProvider; // ctx.searchProvider 注入点（A4 决议 #32⑥）
  audit: (entry: AuditEntry) => void; // 工具审计出口（ToolExecutor 恰好一条）
  limits?: Partial<AgentLoopLimits>;
  now?: () => number; // 时钟注入（ToolStep.createdAt 主进程盖章；测试确定性）
  callbacks?: AgentLoopCallbacks;
}

interface Terminal {
  status: AgentRunStatus;
  error: NormalizedProviderError | null;
}

const LOOP_BLOCKED_PREVIEW = '检测到重复的工具调用，任务已终止（防循环）';

function internalError(message: string, context: { requestId: string }): NormalizedProviderError {
  return {
    code: 'internal',
    message,
    retryable: false,
    providerId: null,
    model: null,
    requestId: context.requestId,
  };
}

function abortedError(context: { requestId: string }): NormalizedProviderError {
  return {
    code: 'aborted',
    message: '任务已取消',
    retryable: false,
    providerId: null,
    model: null,
    requestId: context.requestId,
  };
}

export class AgentLoop {
  private readonly limits: AgentLoopLimits;
  private readonly now: () => number;
  private terminal: Terminal | null = null;
  private readonly loopController = new AbortController();
  private terminalReached: Promise<void> = Promise.resolve();
  private resolveTerminal: (() => void) | null = null;
  private readonly safety = new AgentSafety();
  private readonly executor: ToolExecutor;
  private readonly semantics = new InteractionSemanticsStore();
  private readonly usedToolCallIds = new Set<string>();
  private readonly transcript: ProviderMessage[] = [];
  private readonly rounds: AgentRoundRecord[] = [];
  private readonly toolSteps: ToolStep[] = [];
  private readonly capturedEntries = new Map<string, AuditEntry>();
  private stepsUsed = 0;
  private roundText = '';
  private roundCalls: ProviderToolCall[] = [];
  private roundCommitted = false;
  private roundSawDone = false;

  constructor(private readonly options: AgentLoopOptions) {
    this.limits = { ...AGENT_LOOP_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    // 审计捕获包装：ToolExecutor 每次调用恰好一条审计（单出口纪律保持）；本循环层由此
    // 读取 decision/duration 组装 ToolStep（不重复写审计）
    this.executor = new ToolExecutor(options.confirmManager, (entry) => {
      this.capturedEntries.set(entry.toolCallId, entry);
      options.audit(entry);
    });
    // 终态到达信号（Promise.race 保证 run() 不因不响应 abort 的 Provider 挂起）
    this.terminalReached = new Promise<void>((resolve) => {
      this.resolveTerminal = resolve;
    });
  }

  // 终态单一所有权（决议 #33⑤）：先到先得；作废全部 pending；中止模型流与工具等待；
  // 后续任何路径（迟到 delta/工具结果/二次 finish）被忽略。
  private finish(status: AgentRunStatus, error: NormalizedProviderError | null): void {
    if (this.terminal !== null) return;
    this.terminal = { status, error };
    this.loopController.abort();
    this.options.confirmManager.cancelAll(this.options.requestId);
    this.resolveTerminal?.();
  }

  async run(externalSignal: AbortSignal): Promise<AgentRunResult> {
    const context = { requestId: this.options.requestId };
    const onExternalAbort = (): void => {
      this.finish('cancelled', abortedError(context));
    };
    externalSignal.addEventListener('abort', onExternalAbort);
    const timeoutTimer = setTimeout(
      () =>
        this.finish('timeout', {
          code: 'timeout',
          message: '任务总超时（420 秒）',
          retryable: false,
          providerId: null,
          model: null,
          requestId: this.options.requestId,
        }),
      this.limits.totalTimeoutMs,
    );
    try {
      this.transcript.push(this.options.goalMessage); // goal 恰一次（首轮；后续轮不重复插入）
      if (externalSignal.aborted) {
        this.finish('cancelled', abortedError(context));
        return this.buildResult();
      }
      // Provider 解析与终态竞争（解析期间被中止 → run 不挂起）
      const provider = await Promise.race([
        this.options.providerResolver(),
        this.terminalReached.then(() => null),
      ]);
      if (this.terminal !== null) return this.buildResult(); // 解析期间被中止
      if (provider === null) {
        this.finish('error', {
          code: 'not-configured',
          message: '未配置可用的 AI 服务',
          retryable: false,
          providerId: null,
          model: null,
          requestId: this.options.requestId,
        });
        return this.buildResult();
      }

      const supportsTools = provider.metadata.supportsToolCalling;
      const toolsToSend = supportsTools ? this.options.tools : undefined;

      while (this.terminal === null) {
        const request: ProviderRequest = buildAgentRequest({
          replayMessages: this.options.replayMessages,
          transcriptMessages: this.transcript,
          tools: toolsToSend,
          requestId: this.options.requestId,
          model: this.options.model,
        });

        // 模型轮：与终态竞争（Provider 不响应 abort 时 run() 不挂起）
        this.roundText = '';
        this.roundCalls = [];
        this.roundCommitted = false;
        await Promise.race([
          this.streamRound(provider, request, supportsTools),
          this.terminalReached,
        ]);
        if (this.terminal !== null) break;
        const sawDone = this.roundSawDone;
        if (!sawDone) {
          this.finish('error', internalError('模型流未产出终态事件即结束', context));
          break;
        }

        const text = this.roundText;
        const calls = this.roundCalls;
        if (calls.length === 0) {
          if (text !== '') {
            this.finish('done', null); // 仅「无 toolCalls 且有文本」为最终回答
            break;
          }
          // 空轮：进入 transcript（模型可见自身空轮 = 重试痕迹）并计数
          this.transcript.push({ role: 'assistant', content: '' });
          this.rounds.push({ text: '', toolCalls: [], steps: [] });
          this.roundCommitted = true;
          this.safety.recordNoProgressRound();
          if (this.safety.isNoProgressTriggered()) {
            this.finish('no-progress', internalError('任务已终止：连续两轮无进展', context));
            break;
          }
          continue;
        }

        // 工具轮：轮边界步数检查（步数已用尽且仍需继续 → step-limit，未执行调用零伪造）
        if (this.stepsUsed >= this.limits.maxSteps) {
          this.finish(
            'step-limit',
            internalError(`任务已终止：超过最大步数（${this.limits.maxSteps}）`, context),
          );
          break;
        }
        this.transcript.push({ role: 'assistant', content: text, toolCalls: calls });
        const roundRecord: AgentRoundRecord = { text, toolCalls: calls, steps: [] };
        this.rounds.push(roundRecord);
        this.roundCommitted = true;
        this.options.callbacks?.onAgentRound?.({ roundText: text, toolCalls: calls });

        for (const call of calls) {
          if (this.terminal !== null) break; // 终态后不再执行后续工具
          if (this.stepsUsed >= this.limits.maxSteps) {
            this.finish(
              'step-limit',
              internalError(`任务已终止：超过最大步数（${this.limits.maxSteps}）`, context),
            );
            break;
          }
          // 防循环在执行前判定（决议 #33①：触发次零副作用）
          const signature = buildToolSignature(call.name, call.arguments);
          if (this.safety.wouldTriggerLoop(signature)) {
            this.safety.record(signature); // 阻断的调用同样计签
            this.stepsUsed += 1; // 触发次计入 stepsUsed（契约：被拒/失败/试图执行按契约计步）
            const blockedStep = buildToolStep(
              call,
              { toolCallId: call.id, ok: false, content: LOOP_BLOCKED_PREVIEW },
              'invalid',
              this.now(),
            );
            roundRecord.steps.push(blockedStep);
            this.toolSteps.push(blockedStep);
            this.options.audit({
              requestId: this.options.requestId,
              toolCallId: call.id,
              tool: call.name,
              argsSummary: summarizeRawArgs(call.arguments),
              decision: 'invalid',
              ok: false,
              errorCode: null,
              durationMs: 0,
            });
            this.options.callbacks?.onAgentStep?.({ step: blockedStep });
            this.finish(
              'loop-detected',
              internalError('任务已终止：检测到重复的工具调用（防循环）', context),
            );
            break;
          }
          this.safety.record(signature);
          this.stepsUsed += 1;
          // 工具执行与终态竞争（决议 #33⑤：cancel/超时时 executor 尚未返回 → run 不挂起；
          // 迟到结果被忽略——不记录步骤/事件/不继续执行后续工具；底层审计由 ToolExecutor
          // 单出口保证恰好一条）
          const result = await Promise.race([
            this.executor.execute(
              call,
              {
                browser: this.options.browser,
                runId: this.options.requestId,
                ...(this.options.searchProvider !== undefined
                  ? { searchProvider: this.options.searchProvider }
                  : {}),
                getElementSemantics: (tabId, elementId) => this.semantics.lookup(tabId, elementId),
                recordSnapshot: (tabId, snapshot) =>
                  this.semantics.updateFromSnapshot(tabId, snapshot),
              },
              this.loopController.signal,
            ),
            this.terminalReached.then(() => null),
          ]);
          if (this.terminal !== null || result === null) break; // 迟到工具结果被忽略
          const captured = this.capturedEntry(call.id);
          const step = buildToolStep(call, result, captured?.decision ?? 'auto', this.now());
          roundRecord.steps.push(step);
          this.toolSteps.push(step);
          this.options.callbacks?.onAgentStep?.({ step });
          this.transcript.push(buildToolResultMessage(call.id, call.name, result));
        }
        if (this.terminal !== null) break;
        // 本轮全部执行完：继续下一模型轮（步数用尽后若下一轮为最终回答 → done）
      }
      return this.buildResult();
    } finally {
      clearTimeout(timeoutTimer);
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  private capturedEntry(toolCallId: string): AuditEntry | null {
    return this.capturedEntries.get(toolCallId) ?? null;
  }

  // 单轮流累积：delta 转发；toolCalls 聚合（协议校验 fail-closed）；error/done 收尾。
  // 终态期间的迟到事件被忽略（先检查 terminal）。
  private async streamRound(
    provider: LLMProvider,
    request: ProviderRequest,
    supportsTools: boolean,
  ): Promise<void> {
    this.roundSawDone = false;
    try {
      for await (const event of provider.stream(request, this.loopController.signal)) {
        if (this.terminal !== null) return; // 迟到事件被忽略
        if (event.type === 'delta') {
          this.roundText += event.text;
          this.options.callbacks?.onStreamChunk?.(event.text);
        } else if (event.type === 'toolCalls') {
          if (!supportsTools) {
            this.finish(
              'error',
              internalError('Provider 不支持工具调用但返回了工具调用事件', {
                requestId: this.options.requestId,
              }),
            );
            return;
          }
          const problem = this.validateRoundToolCalls(event.toolCalls);
          if (problem !== null) {
            this.finish('error', internalError(problem, { requestId: this.options.requestId }));
            return;
          }
          this.roundCalls.push(...event.toolCalls);
        } else if (event.type === 'done') {
          this.roundSawDone = true;
        } else {
          // Provider 错误：aborted（我方中止回显）→ cancelled；其余 → error（错误直传）
          if (this.terminal === null) {
            this.finish(event.error.code === 'aborted' ? 'cancelled' : 'error', event.error);
          }
          return;
        }
      }
    } catch {
      if (this.terminal === null) {
        this.finish('error', internalError('模型流异常', { requestId: this.options.requestId }));
      }
    }
  }

  // 协议校验（决议 #33②）：空/重复 id、跨轮冲突 → fail-closed（不执行、不确认）
  private validateRoundToolCalls(toolCalls: ProviderToolCall[]): string | null {
    const seen = new Set<string>();
    for (const call of toolCalls) {
      if (call.id === '') return '工具调用 id 为空，协议非法';
      if (seen.has(call.id)) return '同一轮内工具调用 id 重复，协议非法';
      if (this.usedToolCallIds.has(call.id)) return '工具调用 id 与本轮之前的调用冲突，协议非法';
      seen.add(call.id);
    }
    for (const id of seen) this.usedToolCallIds.add(id);
    return null;
  }

  private buildResult(): AgentRunResult {
    const terminal = this.terminal ?? {
      status: 'error' as AgentRunStatus,
      error: internalError('内部错误', { requestId: this.options.requestId }),
    };
    const committed = this.roundCommitted;
    return {
      requestId: this.options.requestId,
      status: terminal.status,
      finalText: committed ? '' : this.roundText, // 完成轮文本在轮次消息中（无重复拼接）
      finalToolCalls: committed ? [] : [...this.roundCalls],
      stepsUsed: this.stepsUsed,
      maxSteps: this.limits.maxSteps,
      toolStepCount: this.toolSteps.length,
      rounds: this.rounds,
      error: terminal.error,
    };
  }
}
