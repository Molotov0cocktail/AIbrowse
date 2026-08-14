// FakeProvider: deterministic offline stand-in implementing the same LLMProvider interface.
// Used by unit tests and (from S3) the smoke matrix — scripted chunks with optional delays
// (abort/timeout scenarios), injected errors (code/httpStatus), and getLastRequest() capture.
// Contract source: doc/stage2/detailed-design.md §3.3; A1 工具脚本扩展：
// doc/stage3/detailed-design.md §3.2（整组 toolCalls 一步产出，arguments 为已拼接
// 完成的合法 JSON；supportsToolCalling 校准为 true）。
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  NormalizedErrorCode,
  NormalizedProviderError,
  ProviderEvent,
  ProviderMetadata,
  ProviderRequest,
  ProviderToolCall,
  ProviderUsage,
} from '../../../shared/types/conversation';
import { normalizeProviderError, type ErrorNormalizeContext } from './error-normalize';
import type { LLMProvider } from './llm-provider';

export const FAKE_PROVIDER_METADATA: ProviderMetadata = {
  id: 'fake',
  label: 'Fake（离线测试）',
  streaming: true,
  supportsToolCalling: true, // A1：FakeProvider 具备确定性工具脚本能力
  defaultContextLimitTokens: 128000,
};

export interface FakeTextChunk {
  text: string;
  delayMs?: number; // Wait before emitting this chunk (default 0), for abort/timeout scenarios
}

// A1：整组工具调用一步产出（与真实适配器聚合后的事件形态一致；arguments 为
// 已拼接完成的合法 JSON 字符串，由脚本作者保证确定性）。
export interface FakeToolCallsChunk {
  kind: 'toolCalls';
  toolCalls: ProviderToolCall[];
  delayMs?: number;
}

export type FakeChunk = FakeTextChunk | FakeToolCallsChunk;

export interface FakeProviderScript {
  chunks?: Array<string | FakeChunk>; // Default: fixed default script
  // A5：多轮 agent 脚本——每次 stream() 调用消费下一轮（AgentLoop 多轮确定性驱动）；
  // 耗尽后回退 chunks（缺省行为不变）。单轮 = 该轮的事件序列（含文本+整组 toolCalls）。
  rounds?: Array<Array<string | FakeChunk>>;
  error?: { code?: NormalizedErrorCode; httpStatus?: number }; // Injected error (httpStatus wins → status matrix)
  usage?: ProviderUsage; // Attached to the done event
}

const DEFAULT_CHUNKS: FakeChunk[] = [
  { text: '你好，' },
  { text: '这是来自 FakeProvider 的' },
  { text: '确定性回答。' },
];

// A5：中止感知睡眠辅助（等待中 abort 即停；监听器 once 自动清理）
function abortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export class FakeProvider implements LLMProvider {
  readonly metadata: ProviderMetadata = FAKE_PROVIDER_METADATA;
  private lastRequest: ProviderRequest | null = null;
  private readonly requests: ProviderRequest[] = []; // A5：全量请求（多轮断言）
  private roundIndex = 0;

  constructor(private readonly script: FakeProviderScript = {}) {}

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.lastRequest = request;
    this.requests.push(request);
    const context: ErrorNormalizeContext = {
      requestId: request.requestId,
      providerId: this.metadata.id,
      model: request.model,
    };
    if (this.script.error !== undefined) {
      yield { type: 'error', error: this.buildInjectedError(this.script.error, context) };
      return;
    }
    // A5 多轮脚本：rounds 存在时按调用序消费；耗尽回退 chunks（缺省行为不变）
    const round =
      this.script.rounds !== undefined && this.roundIndex < this.script.rounds.length
        ? this.script.rounds[this.roundIndex]
        : undefined;
    if (this.script.rounds !== undefined) this.roundIndex += 1;
    const chunks: FakeChunk[] = (round ?? this.script.chunks ?? DEFAULT_CHUNKS).map((chunk) =>
      typeof chunk === 'string' ? { text: chunk } : chunk,
    );
    for (const chunk of chunks) {
      if (signal.aborted) {
        yield { type: 'error', error: normalizeProviderError({ kind: 'aborted', context }) };
        return;
      }
      if (chunk.delayMs !== undefined && chunk.delayMs > 0) {
        // A5：中止感知睡眠（与真实适配器一致——等待中 abort 即停，无泄漏悬挂）
        await Promise.race([sleep(chunk.delayMs), abortSignal(signal)]);
      }
      if (signal.aborted) {
        yield { type: 'error', error: normalizeProviderError({ kind: 'aborted', context }) };
        return;
      }
      if ('toolCalls' in chunk) {
        yield { type: 'toolCalls', toolCalls: chunk.toolCalls };
      } else {
        yield { type: 'delta', text: chunk.text };
      }
    }
    yield { type: 'done', usage: this.script.usage };
  }

  // Smoke assertions inspect what the provider actually received (requestId/messages/system).
  getLastRequest(): ProviderRequest | null {
    return this.lastRequest;
  }

  // A5：全量请求列表（多轮 agent run 的 transcript 断言）
  getRequests(): ProviderRequest[] {
    return [...this.requests];
  }

  // Injected errors go through the same normalization the real adapter uses, so consumers
  // see the exact production error shapes (httpStatus wins → status-code matrix, §5.1).
  private buildInjectedError(
    error: { code?: NormalizedErrorCode; httpStatus?: number },
    context: ErrorNormalizeContext,
  ): NormalizedProviderError {
    if (error.httpStatus !== undefined) {
      return normalizeProviderError({ kind: 'http', context, httpStatus: error.httpStatus });
    }
    switch (error.code) {
      case 'timeout':
        return normalizeProviderError({ kind: 'timeout', context });
      case 'network':
        return normalizeProviderError({ kind: 'network', context });
      case 'aborted':
        return normalizeProviderError({ kind: 'aborted', context });
      case 'not-configured':
        return normalizeProviderError({ kind: 'not-configured', requestId: context.requestId });
      case 'rate-limit':
        return normalizeProviderError({ kind: 'http', context, httpStatus: 429 });
      case 'invalid-key':
        return normalizeProviderError({ kind: 'http', context, httpStatus: 401 });
      case 'context-too-long':
        return normalizeProviderError({
          kind: 'http',
          context,
          httpStatus: 400,
          responseText: 'maximum context length exceeded tokens',
        });
      case 'provider-error':
        return normalizeProviderError({ kind: 'http', context, httpStatus: 500 });
      case 'internal':
        return normalizeProviderError({ kind: 'internal', context });
      case 'busy':
      case 'not-found':
        return {
          code: error.code,
          message: error.code === 'busy' ? '上一条回答还在生成中' : '会话不存在或已删除',
          retryable: false,
          providerId: context.providerId,
          model: context.model,
          requestId: context.requestId,
        };
      default:
        // No code/status given: generic provider failure.
        return normalizeProviderError({ kind: 'http', context, httpStatus: 500 });
    }
  }
}
