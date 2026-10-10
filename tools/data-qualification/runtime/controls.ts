import type { LLMProvider } from '../../../src/main/ai/provider/llm-provider';
import { normalizeProviderError } from '../../../src/main/ai/provider/error-normalize';
import type { ProviderEvent, ProviderRequest } from '../../../src/shared/types/conversation';
import { assertFact } from './contract';

export const KIND = 'runtime-qualification-synthetic';
export class Latch {
  private resolve!: () => void;
  private released = false;
  constructor(private readonly onRelease: () => void = () => {}) {}
  readonly promise = new Promise<void>((resolve) => {
    this.resolve = resolve;
  });
  release(): void {
    if (this.released) return;
    this.released = true;
    this.onRelease();
    this.resolve();
  }
}
export class Hold {
  readonly entered = new Latch();
  readonly release = new Latch(() => {
    this.releasedAt = performance.now();
  });
  private enteredAt: number | null = null;
  private settledAt: number | null = null;
  private releasedAt: number | null = null;
  aborted = false;
  pending(): boolean {
    return this.enteredAt !== null && this.settledAt === null && this.releasedAt === null;
  }
  snapshot() {
    return {
      enteredAt: this.enteredAt,
      settledAt: this.settledAt,
      releasedAt: this.releasedAt,
      pending: this.pending(),
      aborted: this.aborted,
    };
  }
  async wait(signal?: AbortSignal): Promise<void> {
    assertFact(this.enteredAt === null, '固定叶保持端口被重复调用');
    this.enteredAt = performance.now();
    const abort = () => {
      this.aborted = true;
    };
    signal?.addEventListener('abort', abort, { once: true });
    this.aborted = signal?.aborted ?? false;
    this.entered.release();
    try {
      await this.release.promise;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.settledAt = performance.now();
    }
  }
}
export class ControlledProvider implements LLMProvider {
  readonly metadata = {
    id: KIND,
    label: '维护资格合成端口',
    streaming: true as const,
    supportsToolCalling: true,
    defaultContextLimitTokens: 4096,
  };
  readonly hold = new Hold();
  private calls = 0;
  constructor(private readonly agent: boolean = false) {}
  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.calls++;
    if (this.agent && this.calls === 1) {
      yield {
        type: 'toolCalls',
        toolCalls: [
          {
            id: 'qualification-source-list',
            name: 'source_list',
            arguments: '{"page":0,"pageSize":1}',
          },
        ],
      };
      yield { type: 'done' };
      return;
    }
    assertFact(this.calls === (this.agent ? 2 : 1), '合成 Provider 调用集合改变');
    await this.hold.wait(signal);
    assertFact(signal.aborted, '原 Provider 尚未收到取消');
    yield {
      type: 'error',
      error: normalizeProviderError({
        kind: 'aborted',
        context: { requestId: request.requestId, providerId: KIND, model: 'synthetic' },
      }),
    };
  }
}
export class ObservedPromise {
  readonly entered = new Latch();
  promise: Promise<unknown> | null = null;
  settledAt: number | null = null;
  rejected = false;
  track<T>(promise: Promise<T>): Promise<T> {
    assertFact(this.promise === null, '固定原操作被重复认领');
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
  pending(): boolean {
    return this.promise !== null && this.settledAt === null;
  }
}
export function observeMethod(
  owner: object,
  name: 'runAsk' | 'runAgentRun' | 'executeRun',
  observation: ObservedPromise,
): void {
  const original: unknown = Reflect.get(owner, name);
  assertFact(typeof original === 'function', '原操作诊断接缝已改变');
  Object.defineProperty(owner, name, {
    value: function (this: object, ...args: unknown[]) {
      const promise: unknown = Reflect.apply(original, this, args);
      assertFact(promise instanceof Promise, '产品后台操作未返回原 Promise');
      return observation.track(promise);
    },
  });
}
export async function enteredBeforeDone(
  entered: Promise<void>,
  observation: ObservedPromise,
): Promise<void> {
  await observation.entered.promise;
  assertFact(observation.promise !== null, '原 Promise 未发布');
  const first = await Promise.race([
    entered.then(() => true),
    observation.promise.then(
      () => false,
      () => false,
    ),
  ]);
  assertFact(first, '实际操作在合成端口进入前已经终结');
}
