import { performance } from 'node:perf_hooks';
import type { LLMProvider } from '../../../src/main/ai/provider/llm-provider';
import { normalizeProviderError } from '../../../src/main/ai/provider/error-normalize';
import type { ProviderEvent, ProviderRequest } from '../../../src/shared/types/conversation';
import { assertFact } from './contract';

export const PROVIDER_KIND = 'drain-qualification-synthetic';
export type Trace = (
  name: string,
  facts?: Record<string, number | string | boolean | null>,
) => void;

export class Latch {
  private releasePromise!: () => void;
  readonly promise = new Promise<void>((resolve) => {
    this.releasePromise = resolve;
  });

  release(): void {
    this.releasePromise();
  }
}

export async function waitForProviderEntry(
  entered: Promise<void>,
  runtimeDone: Promise<unknown>,
): Promise<void> {
  const first = await Promise.race([
    entered.then(() => 'entered' as const),
    runtimeDone.then(
      () => 'settled' as const,
      () => 'rejected' as const,
    ),
  ]);
  if (first === 'settled') throw new Error('Research runtime 在 Provider 入口前已结束');
  if (first === 'rejected') throw new Error('Research runtime 在 Provider 入口前拒绝');
}

export class PromiseObservation {
  readonly entered = new Latch();
  promise: Promise<unknown> | null = null;
  settledAt: number | null = null;
  rejected = false;

  get pending(): number {
    return this.promise !== null && this.settledAt === null ? 1 : 0;
  }

  track<T>(promise: Promise<T>): Promise<T> {
    assertFact(this.promise === null, '固定操作重复启动');
    this.promise = promise;
    this.entered.release();
    void promise.then(
      () => {
        this.settledAt = performance.now();
      },
      () => {
        this.settledAt = performance.now();
        this.rejected = true;
      },
    );
    return promise;
  }
}

// Observe the original background promise without changing its return value or lifecycle.
// The fixed method name is a diagnostic seam, not a callable external command surface.
export function observeConversationRun(service: object, observation: PromiseObservation): void {
  const original: unknown = Reflect.get(service, 'runAsk');
  assertFact(typeof original === 'function', 'Conversation 诊断接缝已改变，停止资格');
  Object.defineProperty(service, 'runAsk', {
    configurable: false,
    value: function (this: object, ...args: unknown[]): Promise<unknown> {
      const returned: unknown = Reflect.apply(original, this, args);
      assertFact(returned instanceof Promise, 'runAsk 未返回真实 Promise');
      return observation.track(returned);
    },
  });
}

export class DelayedProvider implements LLMProvider {
  readonly metadata = {
    id: PROVIDER_KIND,
    label: '排水资格合成端口',
    streaming: true as const,
    supportsToolCalling: true,
    defaultContextLimitTokens: 4096,
  };
  readonly entered = new Latch();
  readonly release = new Latch();
  readonly ended = new Latch();
  aborted = false;
  endedAt: number | null = null;
  private calls = 0;

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    assertFact(++this.calls === 1, '固定合成 Provider 被重复调用');
    const onAbort = () => {
      this.aborted = true;
    };
    signal.addEventListener('abort', onAbort, { once: true });
    this.aborted = signal.aborted;
    try {
      this.entered.release();
      // Deliberately retain the real async operation after cancellation until the fixture releases it.
      await this.release.promise;
      assertFact(signal.aborted, '合成 Provider 释放前未收到取消');
      yield {
        type: 'error',
        error: normalizeProviderError({
          kind: 'aborted',
          context: { requestId: request.requestId, providerId: PROVIDER_KIND, model: 'synthetic' },
        }),
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.endedAt = performance.now();
      this.ended.release();
    }
  }
}
