export interface ShutdownRoot {
  beginShutdown(): void;
  drain(): Promise<void>;
}

export interface ShutdownProducer {
  beginShutdown(): void;
  drainBeforeClose(): Promise<void>;
}

export interface RuntimeShutdownOptions {
  roots: readonly ShutdownRoot[];
  producers: readonly ShutdownProducer[];
  waitForUsage(): Promise<void>;
  cleanupWorkspace(): Promise<{ ok: boolean; retainedCount: number }>;
  closeResources(): void | Promise<void>;
}

export type RuntimeShutdownPhase = 'idle' | 'draining' | 'failed' | 'closed';
export type ShutdownFailureStage = 'admission' | 'drain' | 'usage' | 'workspace' | 'close';

export class RuntimeShutdownError extends Error {
  constructor(readonly stage: ShutdownFailureStage) {
    super('退出未完成，剩余数据句柄已保留');
    this.name = 'RuntimeShutdownError';
  }
}

// Cancellation callbacks may run synchronously. Publish the owned promise and
// close every root/producer before invoking any of those callbacks.
export class RuntimeShutdown {
  private operation: Promise<void> | null = null;
  private phase: RuntimeShutdownPhase = 'idle';
  private readonly pendingRoots = new Set<number>();
  private readonly pendingProducers = new Set<number>();

  constructor(private readonly options: RuntimeShutdownOptions) {}

  getPhase(): RuntimeShutdownPhase {
    return this.phase;
  }

  /** Fixed assembly indices only; no user data, paths or error text. */
  getPending(): { roots: number[]; producers: number[] } {
    return { roots: [...this.pendingRoots], producers: [...this.pendingProducers] };
  }

  shutdown(): Promise<void> {
    if (this.operation !== null) return this.operation;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.operation = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.phase = 'draining';
    let admissionFailed = false;
    for (const participant of [...this.options.roots, ...this.options.producers]) {
      try {
        participant.beginShutdown();
      } catch {
        admissionFailed = true;
      }
    }
    void this.finish(admissionFailed).then(
      () => {
        this.phase = 'closed';
        resolve();
      },
      (error: unknown) => {
        this.phase = 'failed';
        reject(error);
      },
    );
    return this.operation;
  }

  private invoke(work: () => void | Promise<void>): Promise<void> {
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async finish(admissionFailed: boolean): Promise<void> {
    // Invoke all drains immediately, including after a synchronous throw. Roots
    // are awaited alongside their cancellable producers, never before them.
    const tracked = (pending: Set<number>, index: number, task: () => Promise<void>) => {
      pending.add(index);
      return this.invoke(task).finally(() => pending.delete(index));
    };
    const work = [
      ...this.options.roots.map((root, index) =>
        tracked(this.pendingRoots, index, () => root.drain()),
      ),
      ...this.options.producers.map((producer, index) =>
        tracked(this.pendingProducers, index, () => producer.drainBeforeClose()),
      ),
    ];
    const settled = await Promise.allSettled(work);
    let failure: ShutdownFailureStage | null = admissionFailed
      ? 'admission'
      : settled.some((result) => result.status === 'rejected')
        ? 'drain'
        : null;
    // Producers can enqueue usage in their final continuations. Only an idle
    // observation after their original promises settle covers those writes.
    try {
      await this.options.waitForUsage();
    } catch {
      failure ??= 'usage';
    }
    try {
      const cleanup = await this.options.cleanupWorkspace();
      if (!cleanup.ok || cleanup.retainedCount !== 0) failure ??= 'workspace';
    } catch {
      failure ??= 'workspace';
    }
    if (failure !== null) throw new RuntimeShutdownError(failure);
    try {
      await this.options.closeResources();
    } catch {
      // A close failure is also sticky; never report a successful quit. Some
      // handles may already be closed, so callers must retain the remaining ones.
      throw new RuntimeShutdownError('close');
    }
  }
}
