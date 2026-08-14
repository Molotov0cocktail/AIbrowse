// OpenAI-compatible adapter: native fetch + hand-rolled SSE parsing, zero vendor SDK and
// zero Electron imports (dependency-direction discipline: LLMProvider must never touch
// webContents / Electron APIs). Keys are fetched from SecureCredentialStore per request and
// never cached or logged. Contract source: doc/stage2/detailed-design.md §3.3/§5.1/§8.2;
// A1 tool-calling extension: doc/stage3/detailed-design.md §3.1（SSE delta.tool_calls
// 分片按 index 分槽累积，finish_reason=tool_calls 末帧后聚合校验产出 ProviderToolCall[]，
// 恰好在 done 之前；原始分片仅为适配器内部状态，对外不暴露半截 arguments——决议 #30）。
import { logDebug, logWarn } from '../../logger';
import type { SecureCredentialStore } from '../credential-store';
import type { ProviderConfig } from '../../../shared/types/conversation';
import type {
  NormalizedProviderError,
  ProviderEvent,
  ProviderMetadata,
  ProviderRequest,
  ProviderToolCall,
  ProviderUsage,
} from '../../../shared/types/conversation';
import { normalizeProviderError, type ErrorNormalizeContext } from './error-normalize';
import type { LLMProvider } from './llm-provider';

// Timeout constants (design Q10): connect 15s / idle chunk 60s / total 300s, in one place.
export const PROVIDER_TIMEOUTS = {
  connectMs: 15_000,
  idleMs: 60_000,
  totalMs: 300_000,
} as const;

export interface ProviderTimeouts {
  connectMs: number;
  idleMs: number;
  totalMs: number;
}

// Which timer (or the external signal) aborted the request — determines the error code.
type AbortPhase = 'external' | 'connect' | 'idle' | 'total' | null;

// —— Pure SSE helpers (unit-tested; the fetch wiring is smoke-verified at S3+) ——

// Parse one '\n\n'-delimited frame: join its data: lines (SSE spec: one optional leading
// space stripped). Frames without data lines (comments/keep-alives) return null.
export function parseSseFrame(frameText: string): string | null {
  const dataLines: string[] = [];
  for (const line of frameText.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  return dataLines.length === 0 ? null : dataLines.join('\n');
}

// —— A1：SSE tool_calls 原始分片（适配器内部类型，不进入共享契约，决议 #30） ——

export interface ToolCallFragment {
  index: number; // delta.tool_calls[].index：同 index 累积拼接
  id?: string; // 首个分片携带（空串不算）
  name?: string; // 首个分片携带（函数名分片中的空串不算）
  arguments: string; // 增量片段（字符串拼接，完成时整体 JSON.parse）
}

// 每个 index 的累积槽：聚合完成后经 finalizeToolCalls 校验产出 ProviderToolCall。
export interface ToolCallSlot {
  id: string;
  name: string;
  arguments: string;
}

export type SseChunkEvent =
  // choices[0].delta.content；同帧可再携带 tool_calls 分片与 finish_reason（先文本后工具）
  | {
      type: 'delta';
      text: string;
      usage?: ProviderUsage;
      toolFragments?: ToolCallFragment[];
      finishReason?: string;
    }
  // 纯 tool_calls 分片帧；末分片帧可同帧携带 finish_reason
  | {
      type: 'tool-delta';
      fragments: ToolCallFragment[];
      usage?: ProviderUsage;
      finishReason?: string;
    }
  // delta 为空对象、仅携带 finish_reason 的收尾帧
  | { type: 'finish'; reason: string; usage?: ProviderUsage }
  | { type: 'usage'; usage: ProviderUsage } // servers put the last delta + usage in one frame
  | { type: 'done-marker' } // [DONE]
  | { type: 'skip' } // Known empty frames (role-only first frame, empty choices)
  | { type: 'error' }; // Illegal JSON / unexpected structure → parse failure

// Interpret one SSE data payload. Deterministic; malformed input never throws.
export function interpretSsePayload(payload: string): SseChunkEvent {
  const trimmed = payload.trim();
  if (trimmed === '[DONE]') return { type: 'done-marker' };
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { type: 'error' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { type: 'error' };
  const record = json as Record<string, unknown>;
  const usage = extractUsage(record);
  const choices = record.choices;
  if (!Array.isArray(choices)) {
    // Usage-only final frames are a known variant even without a choices array.
    return usage === null ? { type: 'error' } : { type: 'usage', usage };
  }
  if (choices.length === 0) return usage === null ? { type: 'skip' } : { type: 'usage', usage };
  const first = choices[0];
  if (typeof first !== 'object' || first === null) {
    return usage === null ? { type: 'error' } : { type: 'usage', usage };
  }
  const firstRecord = first as Record<string, unknown>;
  const finishReason =
    typeof firstRecord.finish_reason === 'string' ? firstRecord.finish_reason : undefined;
  let text: string | undefined;
  let fragments: ToolCallFragment[] | undefined;
  const delta = firstRecord.delta;
  if (typeof delta === 'object' && delta !== null) {
    const deltaRecord = delta as Record<string, unknown>;
    if (typeof deltaRecord.content === 'string') text = deltaRecord.content;
    if (deltaRecord.tool_calls !== undefined) {
      const parsed = parseToolCallFragments(deltaRecord.tool_calls);
      if (parsed === 'error') return { type: 'error' };
      fragments = parsed;
    }
  }
  if (fragments !== undefined && text !== undefined) {
    const event: Extract<SseChunkEvent, { type: 'delta' }> = {
      type: 'delta',
      text,
      toolFragments: fragments,
    };
    if (usage !== null) event.usage = usage;
    if (finishReason !== undefined) event.finishReason = finishReason;
    return event;
  }
  if (fragments !== undefined) {
    const event: Extract<SseChunkEvent, { type: 'tool-delta' }> = { type: 'tool-delta', fragments };
    if (usage !== null) event.usage = usage;
    if (finishReason !== undefined) event.finishReason = finishReason;
    return event;
  }
  if (text !== undefined) {
    const event: Extract<SseChunkEvent, { type: 'delta' }> = { type: 'delta', text };
    if (usage !== null) event.usage = usage;
    if (finishReason !== undefined) event.finishReason = finishReason;
    return event;
  }
  if (finishReason !== undefined) {
    const event: Extract<SseChunkEvent, { type: 'finish' }> = {
      type: 'finish',
      reason: finishReason,
    };
    if (usage !== null) event.usage = usage;
    return event;
  }
  // Known variants without content (role frame / empty delta).
  return usage === null ? { type: 'skip' } : { type: 'usage', usage };
}

// delta.tool_calls 严格校验（§3.1 非法帧 → provider-error）：
// 非数组 / 条目非对象 / 缺 index 或非整数 / id・name・arguments 类型不符 /
// 条目既无 id 也无 function → 'error'。未知字段（如 type）忽略。
function parseToolCallFragments(raw: unknown): ToolCallFragment[] | 'error' {
  if (!Array.isArray(raw)) return 'error';
  const fragments: ToolCallFragment[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return 'error';
    const record = entry as Record<string, unknown>;
    if (typeof record.index !== 'number' || !Number.isInteger(record.index)) return 'error';
    const fragment: ToolCallFragment = { index: record.index, arguments: '' };
    if (record.id !== undefined) {
      if (typeof record.id !== 'string') return 'error';
      fragment.id = record.id;
    }
    let hasFunction = false;
    if (record.function !== undefined) {
      if (typeof record.function !== 'object' || record.function === null) return 'error';
      hasFunction = true;
      const fn = record.function as Record<string, unknown>;
      if (fn.name !== undefined) {
        if (typeof fn.name !== 'string') return 'error';
        fragment.name = fn.name;
      }
      if (fn.arguments !== undefined) {
        if (typeof fn.arguments !== 'string') return 'error';
        fragment.arguments = fn.arguments;
      }
    }
    if (fragment.id === undefined && !hasFunction) return 'error'; // 无任何可累积内容
    fragments.push(fragment);
  }
  return fragments;
}

// 分片按 index 累积进槽（同 index 拼接；id/name 仅首个非空分片生效）。
// 结构性防御校验（interpret 已校验，直接调用者同受保护）；失败返回 'illegal'。
export function applyToolCallFragments(
  slots: Map<number, ToolCallSlot>,
  fragments: ToolCallFragment[],
): 'ok' | 'illegal' {
  for (const fragment of fragments) {
    if (!Number.isInteger(fragment.index) || fragment.index < 0) return 'illegal';
    if (fragment.id !== undefined && typeof fragment.id !== 'string') return 'illegal';
    if (fragment.name !== undefined && typeof fragment.name !== 'string') return 'illegal';
    if (typeof fragment.arguments !== 'string') return 'illegal';
    const slot = slots.get(fragment.index) ?? { id: '', name: '', arguments: '' };
    if (fragment.id !== undefined && fragment.id !== '') slot.id = fragment.id;
    if (fragment.name !== undefined && fragment.name !== '') slot.name = fragment.name;
    slot.arguments += fragment.arguments;
    slots.set(fragment.index, slot);
  }
  return 'ok';
}

// 聚合校验（§3.1）：按 index 升序；id/name 非空；arguments 整体 JSON.parse 成功且
// 结果为对象（非法 → 失败，流以 provider-error 终结，不产出半截工具调用）。
export function finalizeToolCalls(
  slots: Map<number, ToolCallSlot>,
): { ok: true; calls: ProviderToolCall[] } | { ok: false } {
  const calls: ProviderToolCall[] = [];
  const sorted = [...slots.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, slot] of sorted) {
    if (slot.id === '' || slot.name === '') return { ok: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(slot.arguments);
    } catch {
      return { ok: false };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false };
    }
    calls.push({ id: slot.id, name: slot.name, arguments: slot.arguments });
  }
  return { ok: true, calls };
}

// —— SSE 管道：解码 → 分帧 → 帧判定 → 聚合 → ProviderEvent（fetch 之外的纯管道，可单测） ——
// body 为 fetch Response.body 原始字节流；abort/网络中断以异常向调用方传播
// （stream() 的 catch 归一化）。onChunk 供空闲计时器按块重置（由 stream() 注入）。
export async function* streamSseBody(
  body: AsyncIterable<Uint8Array>,
  context: ErrorNormalizeContext,
  onChunk?: () => void,
): AsyncIterable<ProviderEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  const state = {
    usage: undefined as ProviderUsage | undefined,
    toolSlots: new Map<number, ToolCallSlot>(),
    finishReason: null as string | null,
    toolCallsEmitted: false,
  };

  function* failParse(): Generator<ProviderEvent, 'error'> {
    logWarn(
      'provider',
      `流解析失败（${context.providerId}/${context.model ?? '-'}，req=${context.requestId}）`,
    );
    yield { type: 'error', error: normalizeProviderError({ kind: 'parse', context }) };
    return 'error';
  }

  // One frame → events + pipeline state. Returns 'error'/'done' to stop the outer loop.
  function* processFrame(
    event: SseChunkEvent,
  ): Generator<ProviderEvent, 'continue' | 'error' | 'done'> {
    if (event.type === 'error') return yield* failParse();
    if (event.type === 'usage') {
      state.usage = event.usage;
      return 'continue';
    }
    if (event.type === 'skip') return 'continue';
    if (event.type === 'done-marker') {
      yield { type: 'done', usage: state.usage };
      return 'done';
    }
    const carryUsage = (usage: ProviderUsage | undefined): void => {
      if (usage !== undefined) state.usage = usage;
    };
    if (event.type === 'delta') {
      carryUsage(event.usage);
      if (event.text !== '') yield { type: 'delta', text: event.text };
      if (event.toolFragments !== undefined) {
        if (applyToolCallFragments(state.toolSlots, event.toolFragments) !== 'ok') {
          return yield* failParse();
        }
      }
      if (event.finishReason !== undefined) state.finishReason = event.finishReason;
    } else if (event.type === 'tool-delta') {
      carryUsage(event.usage);
      if (applyToolCallFragments(state.toolSlots, event.fragments) !== 'ok') {
        return yield* failParse();
      }
      if (event.finishReason !== undefined) state.finishReason = event.finishReason;
    } else if (event.type === 'finish') {
      carryUsage(event.usage);
      state.finishReason = event.reason;
    }
    // finish_reason=tool_calls 末帧后：聚合校验 → toolCalls 事件（恰好在 done 之前，
    // 恰好产出一次）。finish 非 tool_calls 或零槽时静默丢弃累积（半成品不暴露）。
    if (state.finishReason === 'tool_calls' && !state.toolCallsEmitted) {
      state.toolCallsEmitted = true;
      const finalized = finalizeToolCalls(state.toolSlots);
      if (!finalized.ok) return yield* failParse();
      if (finalized.calls.length > 0) yield { type: 'toolCalls', toolCalls: finalized.calls };
    }
    return 'continue';
  }

  for await (const chunk of body) {
    onChunk?.();
    // Normalize CRLF line endings so '\n\n' framing holds for servers that emit \r\n.
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let separator: number;
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const frameText = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const payload = parseSseFrame(frameText);
      if (payload === null) continue; // Comment/keep-alive frame
      const outcome = yield* processFrame(interpretSsePayload(payload));
      if (outcome === 'done' || outcome === 'error') return;
    }
  }
  // Stream ended cleanly without [DONE]: tolerate and finish (usage from last frame).
  const tail = parseSseFrame(buffer);
  if (tail !== null) {
    const outcome = yield* processFrame(interpretSsePayload(tail));
    if (outcome === 'done' || outcome === 'error') return;
  }
  yield { type: 'done', usage: state.usage };
}

function extractUsage(record: Record<string, unknown>): ProviderUsage | null {
  const usage = record.usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const tokens = usage as Record<string, unknown>;
  const result: ProviderUsage = {};
  if (typeof tokens.prompt_tokens === 'number') result.inputTokens = tokens.prompt_tokens;
  if (typeof tokens.completion_tokens === 'number') result.outputTokens = tokens.completion_tokens;
  return result.inputTokens === undefined && result.outputTokens === undefined ? null : result;
}

// —— IR → wire 消息（适配器不做拼接） ——
// system 独立映射为首条消息；user/assistant 原样透传（UNTRUSTED_WEB_CONTENT 块已在
// user content 内，§3.3）。A1 扩展：role='tool' → 线格式 tool_call_id；assistant
// toolCalls → 线格式 tool_calls 数组（历史重放，doc/stage3/detailed-design.md §3.1）。
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string; // role='tool'：关联调用 id（IR toolCallId）
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>; // role='assistant' 且带 toolCalls 时重放
}

export function mapMessages(request: {
  system: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    toolCallId?: string;
    toolCalls?: ProviderToolCall[];
  }>;
}): WireMessage[] {
  const wire: WireMessage[] = [{ role: 'system', content: request.system }];
  for (const message of request.messages) {
    if (message.role === 'tool') {
      wire.push({
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId ?? '',
      });
    } else if (message.role === 'assistant' && message.toolCalls !== undefined) {
      wire.push({
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      });
    } else {
      wire.push({ role: message.role, content: message.content });
    }
  }
  return wire;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly metadata: ProviderMetadata;
  private readonly baseUrl: string;

  constructor(
    private readonly config: ProviderConfig,
    private readonly store: SecureCredentialStore,
    private readonly timeouts: ProviderTimeouts = PROVIDER_TIMEOUTS,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, ''); // Defensive; config-store also strips
    this.metadata = {
      id: config.providerId,
      label: config.providerId,
      streaming: true,
      supportsToolCalling: true, // A1 校准为真实端点能力（chat/completions 原生支持 tools）
      defaultContextLimitTokens: 128000, // Reference metadata only; real budget is char-based (§7.5)
    };
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const context: ErrorNormalizeContext = {
      requestId: request.requestId,
      providerId: this.config.providerId,
      model: request.model,
    };
    // Key fetched per request, never cached; nothing about the key is ever logged.
    const apiKey = await this.store.get(this.config.providerId);
    if (apiKey === null || apiKey === '') {
      logWarn(
        'provider',
        `未找到 API Key（${context.providerId}/${context.model ?? '-'}，req=${context.requestId}）`,
      );
      yield {
        type: 'error',
        error: normalizeProviderError({ kind: 'not-configured', requestId: context.requestId }),
      };
      return;
    }

    const controller = new AbortController();
    let phase: AbortPhase = null;
    const onExternalAbort = (): void => {
      phase = 'external';
      controller.abort();
    };
    signal.addEventListener('abort', onExternalAbort, { once: true });
    if (signal.aborted) onExternalAbort();
    const connectTimer = setTimeout(() => {
      phase = 'connect';
      controller.abort();
    }, this.timeouts.connectMs);
    const totalTimer = setTimeout(() => {
      phase = 'total';
      controller.abort();
    }, this.timeouts.totalMs);
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        phase = 'idle';
        controller.abort();
      }, this.timeouts.idleMs);
    };
    try {
      logDebug(
        'provider',
        `开始流式请求 provider=${context.providerId} model=${context.model ?? '-'} req=${context.requestId}`,
      );
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          // A1：tools 直接透传 IR（程序生成）；未传 tools 时不发送该字段（共读路径不变）。
          // v1 不发送 tool_choice（默认 auto，§3.1）。
          body: JSON.stringify({
            model: request.model,
            stream: true,
            messages: mapMessages(request),
            ...(request.tools === undefined ? {} : { tools: request.tools }),
          }),
          signal: controller.signal,
        });
      } catch {
        yield { type: 'error', error: this.mapFailure(phase, context) };
        return;
      }
      clearTimeout(connectTimer);

      if (!response.ok) {
        // Response body read ONLY for the 400/422 context-overflow sniff; never logged,
        // never included in the error (provider text never reaches the UI, §5.1).
        const responseText = await this.readErrorBody(response);
        logWarn(
          'provider',
          `HTTP ${response.status}（${context.providerId}/${context.model ?? '-'}，req=${context.requestId}）`,
        );
        yield {
          type: 'error',
          error: normalizeProviderError({
            kind: 'http',
            context,
            httpStatus: response.status,
            responseText,
          }),
        };
        return;
      }
      if (response.body === null) {
        yield { type: 'error', error: normalizeProviderError({ kind: 'parse', context }) };
        return;
      }
      yield* streamSseBody(response.body, context, resetIdle);
    } catch {
      yield { type: 'error', error: this.mapFailure(phase, context) };
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      if (idleTimer !== null) clearTimeout(idleTimer);
      signal.removeEventListener('abort', onExternalAbort);
    }
  }

  // Distinguish external abort / our timeouts / plain network failure → error code (§5.1).
  private mapFailure(phase: AbortPhase, context: ErrorNormalizeContext): NormalizedProviderError {
    if (phase === 'external') return normalizeProviderError({ kind: 'aborted', context });
    if (phase !== null) return normalizeProviderError({ kind: 'timeout', context });
    return normalizeProviderError({ kind: 'network', context });
  }

  private async readErrorBody(response: Response): Promise<string | null> {
    try {
      return (await response.text()).slice(0, 2000);
    } catch {
      return null;
    }
  }
}
