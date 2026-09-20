import type { Clock, TimerHandle } from '../../../shared/types/watch';

export type QualificationTimerOwner =
  'host-gate' | 'watch-scheduler' | 'digest-scheduler' | 'coordinator' | 'qualification-fixture';

const OWNERS: readonly QualificationTimerOwner[] = [
  'host-gate',
  'watch-scheduler',
  'digest-scheduler',
  'coordinator',
  'qualification-fixture',
];

export interface QualificationTimerObserver {
  register(owner: QualificationTimerOwner): string;
  unregister(identity: string): void;
  assertMutable?(): void;
}

interface OwnedTimer {
  id: number;
  owner: QualificationTimerOwner;
  callback: () => void;
  deadline: number;
  generation: number;
  handle: TimerHandle | null;
  identity: string | null;
}

/** One shared pause state; each facade only supplies the actual timer's owner. */
export class QualificationPausableClock {
  private readonly timers = new Map<number, OwnedTimer>();
  private nextId = 1;
  private paused = false;
  private stopped = false;

  constructor(
    private readonly base: Clock,
    private readonly observer: QualificationTimerObserver,
  ) {}

  now(): Date {
    return this.base.now();
  }

  forOwner(owner: QualificationTimerOwner): Clock {
    return {
      now: () => this.now(),
      setTimeout: (callback, delayMs) => this.set(owner, callback, delayMs),
      clearTimeout: (handle) => this.clear(handle),
    };
  }

  pause(): void {
    if (this.paused) throw new Error('资格时钟重复暂停');
    this.paused = true;
    for (const timer of this.timers.values()) this.disarm(timer);
  }

  resume(): void {
    if (!this.paused) throw new Error('资格时钟未暂停');
    this.paused = false;
    if (this.stopped) return;
    const ordered = [...this.timers.values()].sort(
      (a, b) =>
        a.deadline - b.deadline || OWNERS.indexOf(a.owner) - OWNERS.indexOf(b.owner) || a.id - b.id,
    );
    for (const timer of ordered) this.arm(timer);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers.values()) this.disarm(timer);
    this.timers.clear();
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  private set(owner: QualificationTimerOwner, callback: () => void, delayMs: number): TimerHandle {
    if (this.stopped) throw new Error('资格时钟已停止');
    if (this.paused) throw new Error('资格冻结期间新增定时器');
    const deadline = this.now().getTime() + Math.max(0, delayMs);
    if (!Number.isFinite(deadline) || !Number.isSafeInteger(this.nextId)) {
      throw new Error('资格定时器时间无效');
    }
    const timer: OwnedTimer = {
      id: this.nextId++,
      owner,
      callback,
      deadline,
      generation: 0,
      handle: null,
      identity: null,
    };
    this.timers.set(timer.id, timer);
    try {
      this.arm(timer);
    } catch (error) {
      this.timers.delete(timer.id);
      throw error;
    }
    return { kind: 'timer', id: timer.id };
  }

  private arm(timer: OwnedTimer): void {
    const generation = ++timer.generation;
    timer.handle = this.base.setTimeout(
      () => {
        if (
          this.paused ||
          this.stopped ||
          timer.generation !== generation ||
          !this.timers.has(timer.id)
        )
          return;
        this.disarm(timer);
        this.timers.delete(timer.id);
        timer.callback();
      },
      Math.max(0, timer.deadline - this.now().getTime()),
    );
    try {
      timer.identity = this.observer.register(timer.owner);
    } catch (error) {
      this.base.clearTimeout(timer.handle);
      timer.handle = null;
      throw error;
    }
  }

  private disarm(timer: OwnedTimer): void {
    ++timer.generation;
    if (timer.handle !== null) {
      this.base.clearTimeout(timer.handle);
      timer.handle = null;
      if (timer.identity === null) throw new Error('资格定时器缺少所有权');
      this.observer.unregister(timer.identity);
      timer.identity = null;
    }
  }

  private clear(handle: TimerHandle): void {
    const timer = this.timers.get(handle.id);
    if (timer === undefined) return;
    this.observer.assertMutable?.();
    this.disarm(timer);
    this.timers.delete(timer.id);
  }
}
