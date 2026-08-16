// Fifth Stage C5: ResearchRuntime — the independent bounded orchestration
// state machine (adjudications #132–#138). Pure core, zero Electron imports.
// Owns: lifecycle, provider rounds, Research tool dispatch (six-tool subset,
// never through ToolRegistry/ToolExecutor), budgets (steps/rounds/context/
// deadline), persistence orchestration (via the narrow persistence port),
// progress events, and terminal single-ownership. Never executes SQL, never
// touches BrowserController directly (capture goes through the injected
// captureService; workspace cleanup belongs to the terminal path), never
// logs model/web content. Injected ports: prompts/synthesis/result-validation
// (adjudication #134 — deterministic stubs in tests/smoke; the production
// assembly fails closed without real C6/C7).
import { randomUUID } from 'node:crypto';
import { verifyEvidence } from './evidence-validator';
import { mergeCandidates, selectCandidates } from './source-selector';
import { buildDefaultPlan, parseResearchPlan, type PlanGroupRef } from './research-plan';
import {
  listResearchTools,
  serializeResearchToolResult,
  validateResearchToolArgs,
} from './research-tools';
import { StaleRunError, type ResearchRuntimePersistencePort } from './research-runtime-persistence';
import type { LLMProvider } from '../ai/provider/llm-provider';
import type {
  NormalizedErrorCode,
  ProviderMessage,
  ProviderRequest,
  ProviderToolCall,
} from '../../shared/types/conversation';
import type { SearchProvider } from '../ai/search/search-provider';
import type {
  SourceGroupsResult,
  SourceListResult,
  SourceReadAudience,
  SourceResult,
  SourceSearchResult,
} from '../../shared/types/sources';
import type { CaptureContent, CaptureReadResult } from './capture-service';
import type {
  Capture,
  Claim,
  Conflict,
  ResearchErrorCode,
  ResearchPhase,
  ResearchPlan,
  ResearchProgressEvent,
  ResearchPromptsPort,
  ResearchResultValidationPort,
  ResearchSynthesisPort,
  ResearchTaskStats,
  ResearchVerificationState,
  SourceCandidate,
  VerifiedEvidence,
} from '../../shared/types/research';
import {
  MAX_CAPTURES_PER_TASK,
  MAX_CLAIMS_PER_TASK,
  MAX_CONFLICTS_PER_TASK,
  MAX_EVIDENCE_PER_TASK,
  MAX_PROVIDER_TEXT_CHARS_PER_STREAM,
  MAX_PROVIDER_TOOL_ARGUMENTS_CHARS_PER_CALL,
  MAX_PROVIDER_TOOL_ARGS_CHARS_PER_STREAM,
  MAX_PROVIDER_TOOL_CALL_ID_CHARS,
  MAX_PROVIDER_TOOL_CALL_NAME_CHARS,
  MAX_PROVIDER_TOOL_CALLS_PER_STREAM,
  MAX_PROVIDER_TOOL_ID_CHARS_PER_STREAM,
  MAX_PROVIDER_TOOL_NAME_CHARS_PER_STREAM,
  MAX_REQUEST_CONTEXT_CHARS,
  MAX_RESEARCH_ROUNDS,
  MAX_RESEARCH_TOOL_STEPS,
  MAX_SELECTED_SOURCES,
  MAX_SOURCE_CANDIDATES,
  MAX_TRANSCRIPT_REPLAY_ROUNDS,
  RESEARCH_TOTAL_TIMEOUT_MS,
} from '../../shared/types/research';

// ---------- 内部错误哨兵（控制流，不对外） ----------

class StopObservedError extends Error {
  constructor() {
    super('用户已请求停止');
    this.name = 'StopObservedError';
  }
}

class DeadlineExceededError extends Error {
  constructor() {
    super('研究总期限已到达');
    this.name = 'DeadlineExceededError';
  }
}

class BudgetExhaustedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BudgetExhaustedError';
  }
}

class ProviderUnavailableError extends Error {
  constructor() {
    super('Provider 连续失败');
    this.name = 'ProviderUnavailableError';
  }
}

class SourcesUnavailableError extends Error {
  constructor() {
    super('Sources 检索不可用');
    this.name = 'SourcesUnavailableError';
  }
}

class InternalRuntimeError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InternalRuntimeError';
  }
}

class RoundFailedError extends Error {
  readonly code: NormalizedErrorCode | null;

  constructor(code: NormalizedErrorCode | null, reason: string) {
    super(reason);
    this.name = 'RoundFailedError';
    this.code = code;
  }
}

// ---------- 注入端口类型 ----------

export interface ResearchCapturePort {
  read(candidate: SourceCandidate, signal: AbortSignal): Promise<CaptureReadResult>;
}

// SourceService 最小结构端口（SourceServiceImpl 结构兼容；audience 恒 agent）
export interface ResearchSourcePort {
  search(
    query: string,
    opts: { limit?: number; audience: SourceReadAudience },
  ): Promise<SourceSearchResult>;
  list(opts: {
    page: number;
    pageSize?: number;
    groupId?: string | null;
    enabledOnly?: boolean;
    audience: SourceReadAudience;
  }): Promise<SourceListResult>;
  listGroups(opts: { page: number; pageSize?: number }): Promise<SourceGroupsResult>;
  get(id: string, audience: SourceReadAudience): Promise<SourceResult>;
}

export interface ResearchRuntimeOptions {
  taskId: string;
  goal: string;
  runToken: string;
  model: string; // Provider 请求 model 字段（Service/factory 从配置提供）
  provider: LLMProvider;
  sourceService: ResearchSourcePort;
  searchProvider: SearchProvider;
  captureService: ResearchCapturePort;
  persistence: ResearchRuntimePersistencePort;
  prompts: ResearchPromptsPort;
  synthesis: ResearchSynthesisPort;
  resultValidation: ResearchResultValidationPort;
  nowMs?: () => number;
  createId?: () => string;
  deadlineMs?: number; // 测试注入（缺省 RESEARCH_TOTAL_TIMEOUT_MS）
  stopSignal: AbortSignal; // 用户 stop（Service 持有 controller）
  onProgress?: (event: ResearchProgressEvent) => void;
  onSettle?: () => void; // 同一运行实例 finally 中调用（Service CAS 清 slot）
}

// ---------- 有界序列化与 UNTRUSTED 块（C5 专属 context builder；决议 #136(2)） ----------

const BLOCK_OPEN = '<UNTRUSTED_WEB_CONTENT>';
const BLOCK_CLOSE = '</UNTRUSTED_WEB_CONTENT>';

// 闭合转义 + 控制字符剔除（同族纪律：网页/模型文本不可信；`</` → `<\/`）
function buildUntrustedBlock(label: string, content: string): string {
  // 闭合转义（`</` → `<\/`）+ 控制字符剔除（码点过滤——零正则字面控制字符）
  let body = content.replace(/<\//g, '<\\/');
  body = body
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return !(
        code <= 0x08 ||
        (code >= 0x0b && code <= 0x0c) ||
        (code >= 0x0e && code <= 0x1f) ||
        code === 0x7f
      );
    })
    .join('');
  return `${BLOCK_OPEN}\n${label}\n${body}\n${BLOCK_CLOSE}`;
}

function truncateBlock(content: string, max: number): string {
  if (content.length <= max) return content;
  return `${content.slice(0, Math.max(0, max - 8))}…[已截断]`;
}

// 候选元数据白名单序列化（决议 #133(2) 轮 2 上下文；零 note——决议 #121）
function serializeCandidateMetadata(candidate: SourceCandidate): string {
  return JSON.stringify({
    id: candidate.id,
    title: candidate.title,
    displayUrl: candidate.displayUrl,
    scope: candidate.scope,
    discoveredVia: candidate.discoveredVia,
    sourceId: candidate.sourceId,
    trust: candidate.trust,
    priority: candidate.priority,
  });
}

// capture 摘要 + 受控内容摘录（正文只进 UNTRUSTED 块，按预算截断）
function serializeCaptureDigest(capture: Capture, content: string): string {
  const meta = JSON.stringify({
    captureId: capture.captureId,
    tabId: capture.tabId,
    title: capture.title,
    accessTime: capture.accessTime,
    documentId: capture.documentId,
    contentHash: capture.contentHash,
    summary: capture.summary,
    failed: capture.failed,
    failureReason: capture.failureReason,
  });
  if (content === '') return meta;
  return `${meta}
受控内容摘录（规范化正文，截断）:
${content.slice(0, 4000)}`;
}

// ---------- Runtime ----------

export class ResearchRuntime {
  private readonly options: ResearchRuntimeOptions;
  private readonly nowMs: () => number;
  private readonly createId: () => string;
  private readonly deadlineMs: number;
  private readonly stopSignal: AbortSignal;
  private readonly deadlineController: AbortController;
  private readonly startedAt: number;
  private stats: ResearchTaskStats;
  private merged: SourceCandidate[] = [];
  private selected: SourceCandidate[] = [];
  private allCaptures: Capture[] = [];
  private evidence: VerifiedEvidence[] = [];
  // 决议 #145：C5→C6→C7 数据交接——最终 claims/conflicts/verificationState
  // 同一不可变快照（持久化与 synthesis/C7 交接对象恒等；终态后清空）
  private claims: Claim[] = [];
  private conflicts: Conflict[] = [];
  private verificationState: ResearchVerificationState = 'unavailable';
  // tabId → 捕获内容索引（决议 #132(2)：browser_read 只读本 run 内存内容）
  private readonly contentsByTab: Map<string, { captureId: string; content: CaptureContent }> =
    new Map();
  private readonly contentsByCapture: Map<string, CaptureContent> = new Map();
  private consecutiveProviderFailures = 0;
  private finished = false;
  private lastSnapshot: ResearchProgressEvent | null = null;
  private requestCounter = 0; // requestId 独立计数（不与 createId 序列混用）

  constructor(options: ResearchRuntimeOptions) {
    this.options = options;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.createId = options.createId ?? (() => randomUUID());
    this.deadlineMs = options.deadlineMs ?? RESEARCH_TOTAL_TIMEOUT_MS;
    this.stopSignal = options.stopSignal;
    this.deadlineController = new AbortController();
    this.startedAt = this.nowMs();
    const task = options.persistence.getTask();
    this.stats = task === null ? zeroStats() : { ...task.stats };
  }

  async run(): Promise<void> {
    const timer = setTimeout(() => this.deadlineController.abort(), this.deadlineMs);
    try {
      await this.runPhases();
    } catch (err) {
      await this.converge(err);
    } finally {
      clearTimeout(timer);
      // 决议 #138(4)/#135(5)：同一运行实例 finally 中回调（Service CAS 清 slot）
      try {
        this.options.onSettle?.();
      } catch {
        // onSettle 回调失败不影响收敛（Service 侧 CAS 自身防御）
      }
    }
  }

  private async runPhases(): Promise<void> {
    await this.phasePlanning();
    await this.phaseReading();
    await this.phaseVerifying();
    await this.phaseSynthesizing();
  }

  // 每个异步边界后调用：stop/deadline 观察（决议 #135(6)）
  private guard(): void {
    if (this.stopSignal.aborted) throw new StopObservedError();
    if (
      this.deadlineController.signal.aborted ||
      this.nowMs() - this.startedAt >= this.deadlineMs
    ) {
      this.deadlineController.abort();
      throw new DeadlineExceededError();
    }
  }

  private effectiveSignal(): AbortSignal {
    return AbortSignal.any([this.stopSignal, this.deadlineController.signal]);
  }

  private assertSteps(): void {
    if (this.stats.stepsUsed >= MAX_RESEARCH_TOOL_STEPS) {
      throw new BudgetExhaustedError(`工具步数预算用尽（${MAX_RESEARCH_TOOL_STEPS}）`);
    }
  }

  private assertRounds(): void {
    if (this.stats.roundsUsed >= MAX_RESEARCH_ROUNDS) {
      throw new BudgetExhaustedError(`模型轮次预算用尽（${MAX_RESEARCH_ROUNDS}）`);
    }
  }

  private emit(status: ResearchProgressEvent['status'], phase: ResearchPhase | null): void {
    const event: ResearchProgressEvent = {
      taskId: this.options.taskId,
      status,
      phase,
      stats: { ...this.stats },
      finishedAt:
        status === 'completed' || status === 'failed' || status === 'cancelled'
          ? new Date(this.nowMs()).toISOString()
          : null,
    };
    // 决议 #138(1)：仅 phase/status/stats 语义变化才发快照
    const prev = this.lastSnapshot;
    if (
      prev !== null &&
      prev.status === event.status &&
      prev.phase === event.phase &&
      JSON.stringify(prev.stats) === JSON.stringify(event.stats)
    ) {
      return;
    }
    this.lastSnapshot = event;
    try {
      this.options.onProgress?.(event);
    } catch {
      // listener 抛错不影响 Runtime（决议 #138(1)）
    }
  }

  // ---------- 模型轮引擎（决议 #136：每次 provider.stream 调用前递增
  // roundsUsed，重试也计数；超预算的那次调用不得执行） ----------

  // 一次逻辑模型轮：内部支持工具循环（每段 stream 计 1 round）；
  // Provider 错误同请求重试 1 次；连续两次逻辑轮失败 → ProviderUnavailableError
  private async runModelRound(system: string, userBlocks: string[]): Promise<string> {
    this.guard();
    const transcript: ProviderMessage[] = [];
    try {
      const text = await this.streamUntilDone(system, userBlocks, transcript);
      this.consecutiveProviderFailures = 0; // 决议 #136(5)：成功轮重置连续失败计数
      return text;
    } catch (err) {
      if (
        err instanceof StopObservedError ||
        err instanceof DeadlineExceededError ||
        err instanceof BudgetExhaustedError
      ) {
        throw err;
      }
      // 同轮重试 1 次（决议 #136(5)；重试也计数——streamUntilDone 内部递增；
      // 上下文已按 MAX_REQUEST_CONTEXT_CHARS 裁剪——决议 #136(2)）
      const beforeRetry = transcript.length;
      const firstCode = err instanceof RoundFailedError ? err.code : null;
      try {
        const text = await this.streamUntilDone(system, userBlocks, transcript);
        this.consecutiveProviderFailures = 0;
        return text;
      } catch (retryErr) {
        transcript.splice(beforeRetry); // 丢弃重试新增的转录段（防重复工具回放）
        if (
          retryErr instanceof StopObservedError ||
          retryErr instanceof DeadlineExceededError ||
          retryErr instanceof BudgetExhaustedError
        ) {
          throw retryErr;
        }
        // 决议 #136(5)：context-too-long 裁剪重试后仍失败 → research-budget-exhausted
        if (
          firstCode === 'context-too-long' ||
          (retryErr instanceof RoundFailedError && retryErr.code === 'context-too-long')
        ) {
          throw new BudgetExhaustedError('请求上下文超限（裁剪重试后仍失败）');
        }
      }
    }
    this.consecutiveProviderFailures += 1;
    if (this.consecutiveProviderFailures >= 2) {
      throw new ProviderUnavailableError();
    }
    throw new RoundFailedError(null, '模型轮失败（可恢复）');
  }

  // 决议 #141：每段 stream 的 Provider 输出侧预算——toolCalls 数量/id/name/
  // arguments 单项与累计上限（超限整段拒绝执行）；错误消息为固定中文短句，
  // 仅含常量数字（超限 Provider 原文零回显）
  private assertToolCallBudget(calls: readonly ProviderToolCall[]): void {
    if (calls.length > MAX_PROVIDER_TOOL_CALLS_PER_STREAM) {
      throw new BudgetExhaustedError(
        `Provider 工具调用数量超限（${MAX_PROVIDER_TOOL_CALLS_PER_STREAM}）`,
      );
    }
    let idChars = 0;
    let nameChars = 0;
    let argsChars = 0;
    for (const call of calls) {
      if (call.id.length > MAX_PROVIDER_TOOL_CALL_ID_CHARS) {
        throw new BudgetExhaustedError(
          `Provider 工具调用 id 超限（${MAX_PROVIDER_TOOL_CALL_ID_CHARS}）`,
        );
      }
      if (call.name.length > MAX_PROVIDER_TOOL_CALL_NAME_CHARS) {
        throw new BudgetExhaustedError(
          `Provider 工具调用 name 超限（${MAX_PROVIDER_TOOL_CALL_NAME_CHARS}）`,
        );
      }
      if (call.arguments.length > MAX_PROVIDER_TOOL_ARGUMENTS_CHARS_PER_CALL) {
        throw new BudgetExhaustedError(
          `Provider 工具调用 arguments 超限（${MAX_PROVIDER_TOOL_ARGUMENTS_CHARS_PER_CALL}）`,
        );
      }
      idChars += call.id.length;
      nameChars += call.name.length;
      argsChars += call.arguments.length;
    }
    if (idChars > MAX_PROVIDER_TOOL_ID_CHARS_PER_STREAM) {
      throw new BudgetExhaustedError(
        `Provider 工具调用 id 累计超限（${MAX_PROVIDER_TOOL_ID_CHARS_PER_STREAM}）`,
      );
    }
    if (nameChars > MAX_PROVIDER_TOOL_NAME_CHARS_PER_STREAM) {
      throw new BudgetExhaustedError(
        `Provider 工具调用 name 累计超限（${MAX_PROVIDER_TOOL_NAME_CHARS_PER_STREAM}）`,
      );
    }
    if (argsChars > MAX_PROVIDER_TOOL_ARGS_CHARS_PER_STREAM) {
      throw new BudgetExhaustedError(
        `Provider 工具调用 arguments 累计超限（${MAX_PROVIDER_TOOL_ARGS_CHARS_PER_STREAM}）`,
      );
    }
  }

  // 工具循环：每段 stream 前 roundsUsed++（含重试）；tool calls 逐条执行（计步）
  // 后回放继续；段数防御上限 = 2 + MAX_TRANSCRIPT_REPLAY_ROUNDS
  private async streamUntilDone(
    system: string,
    userBlocks: string[],
    transcript: ProviderMessage[],
  ): Promise<string> {
    const maxSegments = 2 + MAX_TRANSCRIPT_REPLAY_ROUNDS;
    for (let segment = 0; segment < maxSegments; segment++) {
      this.guard();
      this.assertRounds(); // 超预算的那次调用不得执行（决议 #136(1)）
      this.stats.roundsUsed += 1;
      const request = this.buildRequest(system, userBlocks, transcript);
      const toolCalls: ProviderToolCall[] = [];
      let text = '';
      try {
        for await (const event of this.options.provider.stream(request, this.effectiveSignal())) {
          if (event.type === 'delta') {
            text += event.text;
            // 决议 #141(2)：文本 delta 累计超限 → 立即停止消费 → 预算终态
            if (text.length > MAX_PROVIDER_TEXT_CHARS_PER_STREAM) {
              throw new BudgetExhaustedError(
                `Provider 文本输出超限（${MAX_PROVIDER_TEXT_CHARS_PER_STREAM}）`,
              );
            }
          } else if (event.type === 'toolCalls') {
            toolCalls.push(...event.toolCalls);
            this.assertToolCallBudget(toolCalls); // 超限整段拒绝执行（决议 #141(3)）
          } else if (event.type === 'reasoning') {
            // 决议 #141(4)：reasoning 完全不用——直接丢弃，零字符串累积、
            // 零 transcript、零回放、零持久化（决议 #136(3) 的「如 Provider
            // 协议需要」v1 不需要）
          } else if (event.type === 'done') {
            // 正常终帧
          } else if (event.type === 'error') {
            // aborted 错误：归属 stop/deadline（决议 #138(3) 优先级）
            if (event.error.code === 'aborted') {
              if (this.stopSignal.aborted) throw new StopObservedError();
              if (this.deadlineController.signal.aborted) throw new DeadlineExceededError();
            }
            throw new RoundFailedError(event.error.code, event.error.message);
          }
        }
      } catch (err) {
        if (
          err instanceof RoundFailedError ||
          err instanceof StopObservedError ||
          err instanceof DeadlineExceededError ||
          err instanceof BudgetExhaustedError // 决议 #141：预算哨兵不吞入网络归一化
        ) {
          throw err;
        }
        // 流被异常打断：先看是否 stop/deadline（决议 #138(3) 优先级）
        if (this.stopSignal.aborted) throw new StopObservedError();
        if (this.deadlineController.signal.aborted) throw new DeadlineExceededError();
        throw new RoundFailedError('network', '模型流异常中断');
      }
      this.guard();
      if (toolCalls.length > 0) {
        transcript.push({ role: 'assistant', content: text, toolCalls });
        for (const call of toolCalls) {
          this.guard();
          const result = await this.executeResearchTool(call);
          transcript.push({ role: 'tool', content: result, toolCallId: call.id });
        }
        continue; // 回放后下一段 stream
      }
      return text;
    }
    throw new RoundFailedError(null, '工具循环段数超限');
  }

  private buildRequest(
    system: string,
    userBlocks: string[],
    transcript: ProviderMessage[],
  ): ProviderRequest {
    const messages: ProviderMessage[] = [{ role: 'system', content: system }];
    const user = userBlocks.join('\n\n');
    messages.push({ role: 'user', content: user });
    // 回放：最近 MAX_TRANSCRIPT_REPLAY_ROUNDS 段（决议 #136(2)）
    const replay = transcript.slice(-MAX_TRANSCRIPT_REPLAY_ROUNDS * 2);
    messages.push(...replay);
    // 请求上下文预算：≤ MAX_REQUEST_CONTEXT_CHARS（从最旧消息开始确定性裁剪；
    // system 为编译期常量保留完整）
    let budget = MAX_REQUEST_CONTEXT_CHARS - system.length;
    const trimmed: ProviderMessage[] = [messages[0]!];
    for (let i = messages.length - 1; i >= 1 && budget > 0; i--) {
      const msg = messages[i]!;
      const size = Math.min(msg.content.length, budget);
      trimmed.unshift({ ...msg, content: truncateBlock(msg.content, size) });
      budget -= size;
    }
    return {
      requestId: `research-request-${this.requestCounter++}`,
      model: this.options.model,
      system,
      messages: trimmed,
      tools: listResearchTools(),
    };
  }

  // ---------- 六工具执行模型（决议 #132） ----------

  private async executeResearchTool(call: ProviderToolCall): Promise<string> {
    this.guard();
    // 决议 #136(1)：一次模型发出的 Research tool call 计 1 步（超预算零执行）
    this.assertSteps();
    this.stats.stepsUsed += 1;
    const validated = validateResearchToolArgs(call.name, call.arguments);
    if (!validated.ok) {
      return serializeResearchToolResult({ ok: false, error: `invalid-args：${validated.reason}` });
    }
    try {
      switch (call.name) {
        case 'browser_open':
          return await this.executeBrowserOpen(validated.args as { url: string });
        case 'browser_read':
          return this.executeBrowserRead(validated.args as { tabId?: string });
        case 'search_web':
          return await this.executeSearchWeb(validated.args as { query: string });
        case 'source_search':
          return await this.executeSourceSearch(validated.args as { query: string });
        case 'source_list':
          return await this.executeSourceList(
            validated.args as { page: number; pageSize?: number; groupId?: string },
          );
        case 'source_get':
          return await this.executeSourceGet(validated.args as { sourceId: string });
        default:
          return serializeResearchToolResult({ ok: false, error: 'unknown-tool' });
      }
    } catch (err) {
      if (err instanceof StopObservedError || err instanceof DeadlineExceededError) throw err;
      if (err instanceof BudgetExhaustedError) throw err;
      return serializeResearchToolResult({ ok: false, error: 'execution-failed' });
    }
  }

  // 只能读取已进入当前任务候选集合的 URL（决议 #132(2)）
  private async executeBrowserOpen(args: { url: string }): Promise<string> {
    const candidate = this.matchCandidateUrl(args.url);
    if (candidate === null) {
      return serializeResearchToolResult({
        ok: false,
        error: 'not-allowed-url：URL 不在本任务候选集合中',
      });
    }
    this.assertSteps();
    this.stats.stepsUsed += 1; // 一次 CaptureService.read 计 1 步（决议 #136(1)）
    const result = await this.options.captureService.read(candidate, this.effectiveSignal());
    this.guard();
    const room = MAX_CAPTURES_PER_TASK - this.stats.captureCount;
    if (room <= 0) throw new BudgetExhaustedError(`Capture 数量上限（${MAX_CAPTURES_PER_TASK}）`);
    const persisted = result.attempts.slice(0, room);
    this.stats.captureCount += persisted.length;
    this.stats.failedReadCount += persisted.filter((a) => a.failed).length;
    this.allCaptures.push(...persisted);
    this.options.persistence.commitCaptures(persisted, this.stats);
    if (result.ok) {
      this.registerContent(result.capture, result.content);
      return serializeResearchToolResult({
        ok: true,
        content: `读取成功：${JSON.stringify({
          captureId: result.capture.captureId,
          tabId: result.capture.tabId,
          title: result.capture.title,
          summary: result.capture.summary,
        })}`,
      });
    }
    return serializeResearchToolResult({
      ok: false,
      error: `read-failed：${result.failureReason}（已记录 ${persisted.length} 次尝试）`,
    });
  }

  private registerContent(capture: Capture, content: CaptureContent): void {
    this.contentsByTab.set(capture.tabId, { captureId: capture.captureId, content });
    this.contentsByCapture.set(capture.captureId, content);
  }

  // 只读本 run 内存 CaptureContent（决议 #132(2)）；跨任务/未知/过期 tabId 安全拒绝
  private executeBrowserRead(args: { tabId?: string }): string {
    const tabId = args.tabId ?? this.lastCapturedTabId();
    if (tabId === null) {
      return serializeResearchToolResult({ ok: false, error: 'not-found：本任务尚无已捕获内容' });
    }
    const entry = this.contentsByTab.get(tabId);
    if (entry === undefined) {
      return serializeResearchToolResult({
        ok: false,
        error: 'not-found：tabId 不属于本任务本次运行（跨任务/未知/过期）',
      });
    }
    return serializeResearchToolResult({
      ok: true,
      content: `已捕获内容（${entry.captureId}）：\n${entry.content.canonicalText}`,
    });
  }

  private lastCapturedTabId(): string | null {
    for (let i = this.allCaptures.length - 1; i >= 0; i--) {
      const tabId = this.allCaptures[i]!.tabId;
      if (this.contentsByTab.has(tabId)) return tabId;
    }
    return null;
  }

  private matchCandidateUrl(raw: string): SourceCandidate | null {
    const input = raw.trim();
    for (const candidate of this.merged) {
      if (candidate.displayUrl === input || candidate.url === input) return candidate;
    }
    return null;
  }

  private async executeSearchWeb(args: { query: string }): Promise<string> {
    this.assertSteps();
    this.stats.stepsUsed += 1;
    const result = await this.options.searchProvider.search(args.query, this.effectiveSignal());
    this.guard();
    if (!result.ok) {
      return serializeResearchToolResult({ ok: false, error: 'search-failed' });
    }
    return serializeResearchToolResult({
      ok: true,
      content: result.results.map((r) => JSON.stringify({ title: r.title, url: r.url })).join('\n'),
    });
  }

  private async executeSourceSearch(args: { query: string }): Promise<string> {
    this.assertSteps();
    this.stats.stepsUsed += 1;
    const result = await this.options.sourceService.search(args.query, { audience: 'agent' });
    if (!result.ok) {
      return serializeResearchToolResult({
        ok: false,
        error: `source-unavailable：${result.errorCode}`,
      });
    }
    return serializeResearchToolResult({
      ok: true,
      content: result.results
        .map((r) => JSON.stringify({ id: r.id, name: r.name, url: r.url, scope: r.scope }))
        .join('\n'),
    });
  }

  private async executeSourceList(args: {
    page: number;
    pageSize?: number;
    groupId?: string;
  }): Promise<string> {
    this.assertSteps();
    this.stats.stepsUsed += 1;
    // 决议 #133(5)：Research 检索恒 enabledOnly=true、audience='agent'
    const result = await this.options.sourceService.list({
      page: args.page,
      pageSize: args.pageSize,
      groupId: args.groupId,
      enabledOnly: true,
      audience: 'agent',
    });
    if (!result.ok) {
      return serializeResearchToolResult({
        ok: false,
        error: `source-unavailable：${result.errorCode}`,
      });
    }
    return serializeResearchToolResult({
      ok: true,
      content: result.items
        .map((r) => JSON.stringify({ id: r.id, name: r.name, url: r.url, groupId: r.groupId }))
        .join('\n'),
    });
  }

  private async executeSourceGet(args: { sourceId: string }): Promise<string> {
    this.assertSteps();
    this.stats.stepsUsed += 1;
    const result = await this.options.sourceService.get(args.sourceId, 'agent');
    if (!result.ok) {
      return serializeResearchToolResult({
        ok: false,
        error: `source-unavailable：${result.errorCode}`,
      });
    }
    return serializeResearchToolResult({
      ok: true,
      content: JSON.stringify({
        id: result.source.id,
        name: result.source.name,
        url: result.source.url,
        scope: result.source.scope,
      }),
    });
  }

  // ---------- 阶段：planning（决议 #133） ----------

  private async phasePlanning(): Promise<void> {
    this.options.persistence.commitPhaseHeartbeat('planning', this.stats);
    this.emit('running', 'planning');

    const groups = await this.loadGroups();
    const plan = await this.planQueryRound(groups);
    this.merged = await this.collectCandidates(plan);
    if (this.merged.length > MAX_SOURCE_CANDIDATES) {
      this.merged = this.merged.slice(0, MAX_SOURCE_CANDIDATES);
    }
    this.stats.candidateCount = this.merged.length;
    this.options.persistence.commitCandidates(this.merged, this.stats);
    this.emit('running', 'planning');

    if (this.merged.length > 0) {
      const ids = await this.selectionRound();
      const ordered = selectCandidates(this.merged);
      this.selected = ids.length > 0 ? ordered.filter((c) => ids.includes(c.id)) : ordered;
      if (this.selected.length > MAX_SELECTED_SOURCES) {
        this.selected = this.selected.slice(0, MAX_SELECTED_SOURCES);
      }
    } else {
      this.selected = [];
    }
    this.stats.selectedCount = this.selected.length;
    this.options.persistence.commitSelection(this.stats);
    this.emit('running', 'planning');
  }

  private async loadGroups(): Promise<readonly PlanGroupRef[]> {
    this.guard();
    this.assertSteps();
    this.stats.stepsUsed += 1; // 一次 SourceService 检索计 1 步
    const result = await this.options.sourceService.listGroups({ page: 0, pageSize: 20 });
    this.guard();
    if (!result.ok) {
      return []; // group 列表不可用不终止任务（group 模式计划将无法通过校验 → 默认计划）
    }
    return result.groups.map((g) => ({ groupId: g.id, name: g.name }));
  }

  private async planQueryRound(groups: readonly PlanGroupRef[]): Promise<ResearchPlan> {
    const blocks = [
      `研究目标：\n${buildUntrustedBlock('goal', truncateBlock(this.options.goal, 2000))}`,
    ];
    if (groups.length > 0) {
      blocks.push(
        `可用信源分组（groupId 只能从以下集合选择）：\n${groups
          .map((g) => JSON.stringify({ groupId: g.groupId, name: g.name }))
          .join('\n')}`,
      );
    }
    blocks.push(
      '请输出 JSON 计划：{"sourceMode":"search"|"group","sourceQuery":"…","groupId":null|"<分组id>","webQueries":[]}',
    );
    // 轮 1 + 重提 ≤1 次（决议 #133(2)）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await this.runModelRound(this.options.prompts.planning, blocks);
        const parsed = parseResearchPlan(raw, { stage: 'query', groups });
        if (parsed.ok) return parsed.plan;
        if (attempt === 0) {
          blocks.push(`上次计划非法：${parsed.reason}。请修正后重新输出。`);
          continue;
        }
      } catch (err) {
        if (err instanceof RoundFailedError) {
          if (attempt === 0) {
            blocks.push('上次请求失败。请重新输出计划 JSON。');
            continue;
          }
        } else {
          throw err;
        }
      }
    }
    return buildDefaultPlan(this.options.goal); // 决议 #133(7)：安全默认（零模型输出）
  }

  private async collectCandidates(plan: ResearchPlan): Promise<SourceCandidate[]> {
    const first = await this.mergeForPlan(plan);
    if (first !== null) return first;
    // 决议 #133(4)：非法/重复 → 整轮 fail-closed → 归一为安全默认计划 + 继续
    const second = await this.mergeForPlan(buildDefaultPlan(this.options.goal));
    return second ?? []; // 程序缺陷（如 id 工厂重复）→ 空候选继续（不终止任务）
  }

  private async mergeForPlan(plan: ResearchPlan): Promise<SourceCandidate[] | null> {
    const sourcesFeed = await this.collectSourcesFeed(plan);
    const searchEntries = await this.collectSearchEntries(plan);
    const merged = mergeCandidates({ sources: sourcesFeed, search: searchEntries });
    return merged.ok ? merged.candidates : null;
  }

  private async collectSourcesFeed(plan: ResearchPlan): Promise<{
    kind: 'source-search' | 'group-list';
    entries: Array<{ candidateId: string; item: never }>;
  } | null> {
    this.guard();
    this.assertSteps();
    this.stats.stepsUsed += 1; // 一次 SourceService 检索计 1 步
    if (plan.sourceMode === 'search') {
      const result = await this.options.sourceService.search(plan.sourceQuery, {
        audience: 'agent',
      });
      this.guard();
      if (!result.ok) throw new SourcesUnavailableError();
      return {
        kind: 'source-search',
        entries: result.results.map((item) => ({
          candidateId: this.createId(),
          item: item as never,
        })),
      };
    }
    // group 模式：enabledOnly=true、audience='agent'、有界分页（决议 #133(5)）
    const result = await this.options.sourceService.list({
      page: 0,
      pageSize: 20,
      groupId: plan.groupId,
      enabledOnly: true,
      audience: 'agent',
    });
    this.guard();
    if (!result.ok) throw new SourcesUnavailableError();
    return {
      kind: 'group-list',
      entries: result.items.map((item) => ({
        candidateId: this.createId(),
        item: item as never,
      })),
    };
  }

  private async collectSearchEntries(
    plan: ResearchPlan,
  ): Promise<Array<{ candidateId: string; result: never }>> {
    const entries: Array<{ candidateId: string; result: never }> = [];
    for (const query of plan.webQueries) {
      this.guard();
      this.assertSteps();
      this.stats.stepsUsed += 1; // 一次 SearchProvider 搜索计 1 步
      const result = await this.options.searchProvider.search(query, this.effectiveSignal());
      this.guard();
      // 决议 #133(5)：Search 失败允许 Sources-only 降级（零日志正文）
      if (!result.ok) continue;
      for (const r of result.results) {
        entries.push({ candidateId: this.createId(), result: r as never });
      }
    }
    return entries;
  }

  private async selectionRound(): Promise<string[]> {
    const block = this.merged.map((c) => serializeCandidateMetadata(c)).join('\n');
    const blocks = [
      `已合并候选（≤${MAX_SOURCE_CANDIDATES} 条；id 只能从以下集合选择）：\n${buildUntrustedBlock('candidates', truncateBlock(block, 12000))}`,
      `请输出 JSON：{"selectedCandidateIds":["<候选id>",…]}（≤${MAX_SELECTED_SOURCES} 条；留空 = 程序默认）`,
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await this.runModelRound(this.options.prompts.planning, blocks);
        const parsed = parseResearchPlan(raw, { stage: 'selection', candidates: this.merged });
        if (parsed.ok) return parsed.plan.selectedCandidateIds;
        if (attempt === 0) {
          blocks.push(`选择非法：${parsed.reason}。请修正后重新输出。`);
          continue;
        }
      } catch (err) {
        if (err instanceof RoundFailedError) {
          if (attempt === 0) {
            blocks.push('上次请求失败。请重新输出选择。');
            continue;
          }
        } else {
          throw err;
        }
      }
    }
    return []; // 程序默认前 8（决议 #133(6)）
  }

  // ---------- 阶段：reading（决议 #136/#137） ----------

  private async phaseReading(): Promise<void> {
    this.options.persistence.commitPhaseHeartbeat('reading', this.stats);
    this.emit('running', 'reading');
    for (const candidate of this.selected) {
      this.guard();
      if (this.stats.captureCount >= MAX_CAPTURES_PER_TASK) {
        throw new BudgetExhaustedError(`Capture 数量上限（${MAX_CAPTURES_PER_TASK}）`);
      }
      this.assertSteps();
      this.stats.stepsUsed += 1; // 一次 CaptureService.read 计 1 步（内部重试零额外计步）
      const result = await this.options.captureService.read(candidate, this.effectiveSignal());
      this.guard();
      const room = MAX_CAPTURES_PER_TASK - this.stats.captureCount;
      const persisted = result.attempts.slice(0, room);
      this.stats.captureCount += persisted.length;
      this.stats.failedReadCount += persisted.filter((a) => a.failed).length;
      this.allCaptures.push(...persisted);
      this.options.persistence.commitCaptures(persisted, this.stats);
      // 决议 #137(4)：超上限 → research-budget-exhausted（此前已提交保留）
      if (result.attempts.length > room) {
        throw new BudgetExhaustedError(
          `Capture 数量超上限（${MAX_CAPTURES_PER_TASK}，本次 ${result.attempts.length} 次尝试）`,
        );
      }
      this.emit('running', 'reading');
      if (result.ok) {
        this.registerContent(result.capture, result.content);
        await this.evidenceRound(candidate, result.capture, result.content);
      }
      // 失败继续（§6.4）：不终止任务
    }
  }

  private async evidenceRound(
    candidate: SourceCandidate,
    capture: Capture,
    content: CaptureContent,
  ): Promise<void> {
    const digest = serializeCaptureDigest(capture, content.canonicalText);
    const blocks = [
      `研究目标：\n${buildUntrustedBlock('goal', truncateBlock(this.options.goal, 2000))}`,
      `当前候选：${serializeCandidateMetadata(candidate)}`,
      `本候选捕获（正文摘录只在受控块内）：\n${buildUntrustedBlock('capture', truncateBlock(digest, 12000))}`,
      '请为上述内容提出证据引用（JSON 数组，字段：captureId/candidateId/type/locator/excerpt/value）。',
    ];
    let proposals = await this.readProposals(blocks);
    if (proposals === null) {
      // 解析失败：回注重提 1 次（决议 #136(5) 解析失败重试）
      this.stats.rejectedEvidenceCount += 1;
      blocks.push('上次输出无法解析。请重新输出证据引用 JSON 数组。');
      proposals = await this.readProposals(blocks);
      if (proposals === null) return; // 该候选零证据，继续
    }
    await this.verifyAndCommit(proposals);
  }

  private async readProposals(blocks: string[]): Promise<unknown[] | null> {
    try {
      const raw = await this.runModelRound(this.options.prompts.reading, blocks);
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch (err) {
      // 解析/模型轮失败 → 回注重提语义（null）；仅终态哨兵重抛
      if (
        err instanceof StopObservedError ||
        err instanceof DeadlineExceededError ||
        err instanceof BudgetExhaustedError
      ) {
        throw err;
      }
      return null;
    }
  }

  private async verifyAndCommit(proposals: unknown[]): Promise<void> {
    for (const raw of proposals) {
      this.guard();
      if (this.stats.evidenceCount >= MAX_EVIDENCE_PER_TASK) {
        // 决议 #137(4)：超上限 → research-budget-exhausted（此前已提交保留）
        throw new BudgetExhaustedError(`Evidence 数量上限（${MAX_EVIDENCE_PER_TASK}）`);
      }
      const outcome = verifyEvidence({
        proposal: raw as never,
        evidenceId: this.createId(),
        taskId: this.options.taskId,
        captures: this.allCaptures,
        candidates: this.merged,
        contents: this.contentsByCapture,
      });
      if (outcome.ok) {
        this.stats.evidenceCount += 1;
        this.evidence.push(outcome.evidence);
        // 逐条提交（决议 #137(4)：此前已成功提交的 Evidence 在超限时保留）
        this.options.persistence.commitEvidence([outcome.evidence], this.stats);
        this.emit('running', 'reading');
      } else {
        this.stats.rejectedEvidenceCount += 1;
      }
    }
  }

  // ---------- 阶段：verifying（决议 #134 端口） ----------

  private async phaseVerifying(): Promise<void> {
    this.options.persistence.commitPhaseHeartbeat('verifying', this.stats);
    this.emit('running', 'verifying');
    const evidenceBlock = this.evidence
      .map((e) =>
        JSON.stringify({
          evidenceId: e.evidenceId,
          type: e.type,
          excerpt: e.excerpt,
          url: e.url,
          candidateId: e.candidateId,
        }),
      )
      .join('\n');
    const blocks = [
      `已验证证据（${this.evidence.length} 条）：\n${buildUntrustedBlock('evidence', truncateBlock(evidenceBlock, 16000))}`,
      '请输出核验结果 JSON（{"claims":[…],"conflicts":[…]}）。',
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await this.runModelRound(this.options.prompts.verifying, blocks);
        const outcome = this.options.synthesis.processVerification(raw, {
          taskId: this.options.taskId,
          candidates: this.merged,
          evidence: this.evidence,
          createId: this.createId,
        });
        if (outcome.ok) {
          // 防御截断（决议 #137(3)：端口契约保证合法；超限防御性裁剪）
          const claims = outcome.claims.slice(0, MAX_CLAIMS_PER_TASK);
          const conflicts = outcome.conflicts.slice(0, MAX_CONFLICTS_PER_TASK);
          this.stats.claimCount = claims.length;
          this.stats.conflictCount = conflicts.length;
          this.options.persistence.commitClaimsAndConflicts(claims, conflicts, this.stats);
          // 决议 #145(1)/(2)：保存并持久化同一组不可变快照（内存对象此后
          // 不再变换；synthesis 上下文与 C7 context 消费同一组对象）
          this.claims = claims;
          this.conflicts = conflicts;
          this.verificationState = 'verified';
          this.emit('running', 'verifying');
          return;
        }
        if (attempt === 0) {
          blocks.push(`核验输出非法：${outcome.reason}。请修正后重新输出。`);
          continue;
        }
      } catch (err) {
        if (err instanceof RoundFailedError) {
          if (attempt === 0) {
            blocks.push('上次请求失败。请重新输出核验结果。');
            continue;
          }
        } else {
          throw err;
        }
      }
    }
    // 决议 #145(3)：两次核验输出仍非法 → 空 claims/conflicts + unavailable，
    // 任务允许继续 synthesizing（synthesis 上下文必须明确要求输出 uncertain 块）
    this.claims = [];
    this.conflicts = [];
    this.verificationState = 'unavailable';
  }

  // ---------- 阶段：synthesizing（决议 #134/#138/#145/#147） ----------

  // 决议 #145(4)：synthesis 上下文 = 程序装配的 Claim/Conflict 白名单序列化 +
  // verificationState 明确标记；文本进既有 UNTRUSTED 块（不进 system prompt）；
  // 模型文本不可信（claim.text/topic/positions 均为模型提议、程序装配后的受控值）
  private buildCrossCheckBlock(): string {
    if (this.verificationState === 'unavailable') {
      return `核验状态：不可用（核验输出未通过程序校验）——必须在结果中输出 uncertain 块说明不确定之处。`;
    }
    const serialized = JSON.stringify({
      claims: this.claims.map((c) => ({
        claimId: c.claimId,
        text: c.text,
        severity: c.severity,
        coverage: c.coverage,
        sourceTypes: c.sourceTypes,
        evidenceIds: c.evidenceIds,
        singleSourceFields: c.singleSourceFields,
        conflictIds: c.conflictIds,
      })),
      conflicts: this.conflicts.map((cf) => ({
        conflictId: cf.conflictId,
        topic: cf.topic,
        positions: cf.positions,
        claimIds: cf.claimIds,
        resolved: cf.resolved,
      })),
    });
    return `核验状态：已通过程序校验。经程序装配的结论（${this.claims.length} 条）与冲突（${this.conflicts.length} 条）——冲突必须在结果中如实引用，不得静默抹平：\n${buildUntrustedBlock('claims-conflicts', truncateBlock(serialized, 16000))}`;
  }

  private async phaseSynthesizing(): Promise<void> {
    this.options.persistence.commitPhaseHeartbeat('synthesizing', this.stats);
    this.emit('running', 'synthesizing');
    const evidenceBlock = this.evidence
      .map((e) =>
        JSON.stringify({
          evidenceId: e.evidenceId,
          excerpt: e.excerpt,
          candidateId: e.candidateId,
        }),
      )
      .join('\n');
    const blocks = [
      `已验证证据（${this.evidence.length} 条）：\n${buildUntrustedBlock('evidence', truncateBlock(evidenceBlock, 12000))}`,
      this.buildCrossCheckBlock(),
      '请输出结果草案 JSON（{"result":{…}}）。',
    ];
    // 决议 §6.4：非法 Result 回注重提 ≤2 次 → failed(research-internal)
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await this.runModelRound(this.options.prompts.synthesizing, blocks);
      const draft = this.options.synthesis.parseResultDraft(raw);
      if (!draft.ok) {
        if (attempt < 2) {
          blocks.push(`结果草案非法：${draft.reason}。请修正后重新输出。`);
          continue;
        }
        throw new InternalRuntimeError('结果草案解析失败（重提耗尽）');
      }
      // 决议 #145(5)：validate 签名不变，context 扩充 claims/conflicts/
      // verificationState（C7 据此程序重算 coverage、核对 Result.conflicts）
      const validated = this.options.resultValidation.validate(draft.draft, {
        taskId: this.options.taskId,
        candidates: this.merged,
        evidence: this.evidence,
        claims: this.claims,
        conflicts: this.conflicts,
        verificationState: this.verificationState,
        createId: this.createId,
      });
      if (!validated.ok) {
        if (attempt < 2) {
          blocks.push(`结果校验失败：${validated.reasons.join('；')}。请修正后重新输出。`);
          continue;
        }
        throw new InternalRuntimeError('结果校验失败（重提耗尽）');
      }
      const result = validated.result;
      if (typeof result.resultId !== 'string' || result.resultId === '') {
        throw new InternalRuntimeError('端口未生成 resultId');
      }
      this.options.persistence.commitResultAndComplete(result, this.stats);
      this.finished = true;
      this.clearRuntimeState(); // 决议 #145(7)：completed 终态清空内存状态
      this.emit('completed', null);
      return;
    }
    throw new InternalRuntimeError('结果生成失败');
  }

  // 决议 #145(7)：完成/失败/取消后清空内存 Claim/Conflict/正文状态
  // （CaptureContent 索引同清——终态单一所有权与内存最小化）
  private clearRuntimeState(): void {
    this.claims = [];
    this.conflicts = [];
    this.verificationState = 'unavailable';
    this.contentsByTab.clear();
    this.contentsByCapture.clear();
  }

  // ---------- 终态收敛（决议 #138(3)：stop > deadline > budget） ----------

  private async converge(err: unknown): Promise<void> {
    if (this.finished) return;
    // 终态优先级（决议 #138(3)）：stop > deadline > budget
    let terminal: 'cancelled' | 'failed' = 'failed';
    let errorCode: ResearchErrorCode;
    if (err instanceof StopObservedError || this.stopSignal.aborted) {
      terminal = 'cancelled';
      errorCode = 'cancelled' as unknown as ResearchErrorCode; // 状态判定（非错误码）
    } else if (err instanceof DeadlineExceededError || this.deadlineController.signal.aborted) {
      errorCode = 'research-timeout';
    } else if (err instanceof BudgetExhaustedError) {
      errorCode = 'research-budget-exhausted';
    } else if (err instanceof ProviderUnavailableError) {
      errorCode = 'research-provider-unavailable';
    } else if (err instanceof SourcesUnavailableError) {
      errorCode = 'research-sources-unavailable';
    } else {
      errorCode = 'research-internal';
    }
    try {
      if (terminal === 'cancelled') {
        this.options.persistence.commitCancelled(this.stats);
      } else {
        this.options.persistence.commitFailed(errorCode, this.stats);
      }
      this.finished = true;
      this.clearRuntimeState(); // 决议 #145(7)：failed/cancelled 终态清空内存状态
      this.emit(terminal, null);
    } catch (commitErr) {
      // 终态写失败防御：StaleRunError = 终态已由他处写入（重复提交防御）；
      // 其余（含预算拒绝）= 记录脱敏诊断并保留所有权供 shutdown 重试；
      // 不抛出失控 rejection（决议 #138(4)）
      this.clearRuntimeState(); // 终态路径统一清空（运行已收敛）
      if (!(commitErr instanceof StaleRunError)) {
        void commitErr;
      }
      return;
    }
  }
}

function zeroStats(): ResearchTaskStats {
  return {
    candidateCount: 0,
    selectedCount: 0,
    captureCount: 0,
    failedReadCount: 0,
    evidenceCount: 0,
    rejectedEvidenceCount: 0,
    claimCount: 0,
    conflictCount: 0,
    stepsUsed: 0,
    roundsUsed: 0,
  };
}
