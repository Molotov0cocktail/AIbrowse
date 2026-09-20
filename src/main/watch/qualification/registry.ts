import {
  QUALIFICATION_REGISTRIES,
  type QualificationCounters,
  type QualificationRegistry as RegistryKind,
  type QualificationRegistryEvent,
  type QualificationRegistryLive,
} from './native-contract';
import type { QualificationTimerObserver, QualificationTimerOwner } from './pausable-clock';
import { AsyncLocalStorage } from 'node:async_hooks';

type WithoutIdentity<T> = T extends { identity: string } ? Omit<T, 'identity'> : never;
export type QualificationRegistration = WithoutIdentity<QualificationRegistryEvent>;

export interface QualificationResourceOwner {
  register(event: QualificationRegistration): string;
  unregister(identity: string): void;
  assertMutable(): void;
  track<T>(create: () => Promise<T>, cleanupOf?: string): Promise<T>;
}

/** Actual owners call this synchronously at their acquire/release linearization points. */
export class QualificationRegistry
  implements QualificationResourceOwner, QualificationTimerObserver
{
  private readonly live = new Map<string, QualificationRegistryEvent>();
  private readonly serials = new Map<RegistryKind, bigint>();
  private readonly stopOwners = new Set<string>();
  private frozen = false;
  private stopped = false;
  private readonly cleanupContext = new AsyncLocalStorage<string>();
  private readonly totals: QualificationCounters = {
    duplicateTerminalAttemptTotal: 0,
    uncaughtExceptionTotal: 0,
    unhandledRejectionTotal: 0,
  };

  constructor(
    private readonly emit: (
      kind: 'register' | 'unregister',
      event: QualificationRegistryEvent,
    ) => void,
    private readonly fail: (code: string) => never,
  ) {}

  assertMutable(): void {
    if (this.frozen) this.fail('barrier-mutation');
  }

  register(input: QualificationRegistration | QualificationTimerOwner): string {
    this.assertMutable();
    const event = typeof input === 'string' ? this.timerRegistration(input) : input;
    if (
      this.stopped &&
      (event.registry !== 'watch-async-operation' ||
        event.detail === null ||
        !this.stopOwners.has(event.detail.cleanupOf))
    )
      this.fail('admission-after-stop');
    if (
      ['http-request', 'http-response', 'socket', 'provider-attempt', 'watch-temp-lease'].includes(
        event.registry,
      )
    ) {
      this.fail('unexpected-resource');
    }
    const next = (this.serials.get(event.registry) ?? 0n) + 1n;
    if (next > 0xffffffffffffffffn) this.fail('registry-overflow');
    this.serials.set(event.registry, next);
    const identity = `${event.registry}:${next}`;
    const registered = { ...event, identity } as QualificationRegistryEvent;
    this.live.set(identity, registered);
    if (this.stopped) this.stopOwners.add(identity);
    this.emit('register', registered);
    return identity;
  }

  unregister(identity: string): void {
    this.assertMutable();
    const event = this.live.get(identity);
    if (event === undefined) this.fail('registry-unpaired');
    this.live.delete(identity);
    this.emit('unregister', event);
  }

  track<T>(create: () => Promise<T>, cleanupOf?: string): Promise<T> {
    cleanupOf ??= this.stopped ? this.cleanupContext.getStore() : undefined;
    const identity = this.register({
      registry: 'watch-async-operation',
      detail: cleanupOf === undefined ? null : { cleanupOf },
    });
    try {
      const promise = this.cleanupContext.run(identity, create);
      return promise.finally(() => this.unregister(identity));
    } catch (error) {
      this.unregister(identity);
      throw error;
    }
  }

  freeze(): void {
    this.assertMutable();
    this.frozen = true;
  }
  thaw(): void {
    if (!this.frozen) this.fail('barrier-state');
    this.frozen = false;
  }

  closeAdmission(): void {
    this.assertMutable();
    if (this.stopped) return;
    this.stopped = true;
    for (const identity of this.live.keys()) this.stopOwners.add(identity);
  }

  increment(counter: keyof QualificationCounters): void {
    this.assertMutable();
    ++this.totals[counter];
  }

  counters(): QualificationCounters {
    return { ...this.totals };
  }

  snapshot(): QualificationRegistryLive[] {
    return QUALIFICATION_REGISTRIES.map((registry) => ({
      registry,
      identities: [...this.live.values()]
        .filter((event) => event.registry === registry)
        .map((event) => event.identity)
        .sort((a, b) => {
          const left = BigInt(a.slice(a.indexOf(':') + 1));
          const right = BigInt(b.slice(b.indexOf(':') + 1));
          return left < right ? -1 : left > right ? 1 : 0;
        }),
    }));
  }

  private timerRegistration(owner: QualificationTimerOwner): QualificationRegistration {
    if (owner === 'watch-scheduler') return { registry: 'watch-timer', detail: null };
    if (owner === 'digest-scheduler') return { registry: 'digest-timer', detail: null };
    return { registry: 'watch-owner-timer', detail: { ownerKind: owner } };
  }
}
