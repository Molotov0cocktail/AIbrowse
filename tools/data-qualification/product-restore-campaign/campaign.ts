import {
  LIMITS,
  need,
  type Action,
  type OrdinaryLease,
  type Ports,
  type Observer,
} from './contract';
import type { Identity, Scene } from '../product-restore-process/protocol';
import type { Variant } from '../product-restore-fixtures/seed';

/** Own original operations until settlement. A deadline rejection is never an IO close receipt. */
export class Campaign {
  readonly pending = new Set<Promise<unknown>>();
  readonly deadline: number;
  private stopped = false;
  private sequence = 0;
  private offlineSpent = 0;
  private identity: Identity | null = null;
  private owner = '';
  private observer: Observer | null = null;
  constructor(
    readonly scene: Scene,
    private readonly ports: Ports,
    deadline?: number,
    preflightElapsedMs = 0,
  ) {
    need(
      Number.isSafeInteger(preflightElapsedMs) &&
        preflightElapsedMs >= 0 &&
        preflightElapsedMs < LIMITS.offline,
    );
    this.offlineSpent = preflightElapsedMs;
    this.deadline = Math.min(deadline ?? Infinity, ports.now() + LIMITS[scene]);
    need(Number.isFinite(this.deadline) && this.deadline > ports.now());
  }
  private check(until = this.deadline): void {
    need(!this.stopped && this.ports.now() < Math.min(until, this.deadline), '恢复场景原期限耗尽');
  }
  stop(): void {
    if (!this.stopped) {
      this.stopped = true;
      this.ports.stop();
    }
  }
  async finishEvidence(work: () => Promise<void>): Promise<void> {
    await this.offline(work);
  }
  private step<T>(work: () => Promise<T>, until = this.deadline): Promise<T> {
    this.check(until);
    const original = Promise.resolve().then(work);
    this.pending.add(original);
    void original.then(
      () => this.pending.delete(original),
      () => this.pending.delete(original),
    );
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.stop();
          reject(new Error('恢复场景原期限耗尽'));
        },
        Math.max(0, Math.min(until, this.deadline) - this.ports.now()),
      );
      void original.then(
        (value) => {
          clearTimeout(timer);
          try {
            this.check(until);
            resolve(value);
          } catch (error) {
            this.stop();
            reject(error);
          }
        },
        (error) => {
          clearTimeout(timer);
          this.stop();
          reject(error);
        },
      );
    });
  }
  private async offline(work: () => Promise<void>): Promise<void> {
    const start = this.ports.now();
    try {
      await this.step(work, start + LIMITS.offline - this.offlineSpent);
    } finally {
      this.offlineSpent += this.ports.now() - start;
    }
  }
  private next(): number {
    need(++this.sequence <= LIMITS.actions);
    return this.sequence;
  }
  private async ui(
    action: Action,
    options: { target?: string; variant?: Variant; deadline?: number } = {},
  ): Promise<void> {
    need(this.identity);
    const deadline = Math.min(
      this.deadline,
      options.deadline ?? this.deadline,
      this.ports.now() + LIMITS.ui,
    );
    const request = {
      scene: this.scene,
      sequence: this.next(),
      action,
      identity: this.identity,
      deadline,
      ...options,
    };
    // Options cannot replace the tighter absolute UI deadline.
    request.deadline = deadline;
    const receipt = await this.step(
      () => this.ports.ui(request),
      Math.min(this.deadline, deadline + 5000),
    );
    this.check(deadline);
    this.owner = receipt.mainWindowHandle;
  }
  private async boot(kind: 'initial' | 'B' | 'cold', action: Action): Promise<OrdinaryLease> {
    const deadline = Math.min(this.deadline, this.ports.now() + LIMITS.boot);
    const lease = await this.step(() => this.ports.launch(kind, deadline), deadline);
    this.identity = lease.identity;
    await this.ui(action, { deadline: Math.min(deadline, lease.bootDeadline) });
    return lease;
  }
  private async close(lease?: OrdinaryLease): Promise<void> {
    const deadline = Math.min(this.deadline, this.ports.now() + LIMITS.close);
    const retirement = lease
      ? await this.step(() => this.ports.holdOrdinary(lease.identity, deadline), deadline)
      : null;
    if (retirement) await this.step(() => retirement.ready(), deadline);
    await this.ui('Close', { deadline });
    if (retirement) {
      await this.step(() => retirement.retired(), deadline);
      need(
        (await this.step(() => retirement.closed, deadline)) === 0 && retirement.pendingOwned === 0,
      );
    } else {
      need(this.observer);
      const observer = this.observer;
      await this.step(() => observer.finish(), deadline);
      need((await this.step(() => observer.closed, deadline)) === 0 && observer.pendingOwned === 0);
    }
    await this.step(() => this.ports.assertProductGone(deadline), deadline);
    this.identity = null;
  }
  private async read(variant: 'A' | 'H'): Promise<void> {
    for (const action of ['ReadSources', 'ReadResearch', 'ReadWatch', 'ReadConversation'] as const)
      await this.ui(action, { variant });
  }
  private async confirm(transition: 1 | 2, approved: boolean): Promise<void> {
    need(this.identity);
    const sequence = this.next();
    const purpose = this.scene === 'P' && transition === 1 ? 'partial' : 'restore';
    if (approved) {
      need(this.observer);
      await this.step(() => this.observer!.arm(sequence));
    }
    const request = {
      scene: this.scene,
      transition,
      sequence,
      purpose,
      approved,
      identity: this.identity,
      mainWindowHandle: this.owner,
      deadline: Math.min(this.deadline, this.ports.now() + LIMITS.ui),
    } as const;
    await this.step(
      () => this.ports.confirm(request),
      Math.min(this.deadline, request.deadline + 5000),
    );
    this.check(request.deadline);
    if (approved) await this.step(() => this.observer!.decide('approved'));
  }
  private async restore(transition: 1 | 2, target: string, variant: 'A' | 'H'): Promise<void> {
    await this.ui('OpenRestore');
    await this.ui('CancelOpen');
    await this.ui('WaitCancelled');
    await this.ui('OpenRestore');
    await this.ui('SelectRestore', { target });
    await this.confirm(transition, false);
    await this.ui('WaitCancelled');
    await this.ui('OpenRestore');
    await this.ui('SelectRestore', { target });
    const deadline = Math.min(this.deadline, this.ports.now() + LIMITS.transfer);
    await this.confirm(transition, true);
    need(this.observer);
    const accepted = await this.step(() => this.observer!.waitSuccessor(), deadline);
    this.identity = accepted.identity;
    await this.ui('BootHealthy', { deadline: Math.min(deadline, accepted.bootDeadline) });
    await this.step(() => this.observer!.assertCurrent(), deadline);
    await this.read(variant);
    await this.close();
    await this.offline(() => this.ports.verify(variant, false));
  }
  async run(): Promise<{ scene: Scene; actions: number; offlineMs: number }> {
    try {
      await this.offline(() => this.ports.prepare(this.scene));
      if (this.scene === 'R') {
        const a = await this.boot('initial', 'BootHealthy');
        await this.ui('OpenBackup');
        const until = Math.min(this.deadline, this.ports.now() + LIMITS.transfer);
        await this.ui('SaveBackup', { target: this.ports.backupA, deadline: until });
        await this.ui('WaitBackupCompleted', { deadline: until });
        await this.offline(() => this.ports.inspectBackup());
        await this.close(a);
        await this.offline(() => this.ports.installB());
        // The B launch is owned by the successor observer, without a redundant ordinary lease.
        await this.boot('B', 'BootHealthy');
      } else {
        await this.boot('initial', 'BootPartial');
      }
      need(this.identity);
      this.observer = await this.step(() => this.ports.observe(this.identity!, this.deadline));
      await this.step(() => this.observer!.ready());
      if (this.scene === 'P') {
        await this.ui('OpenPartial');
        await this.confirm(1, false);
        await this.ui('WaitCancelled');
        await this.ui('OpenPartial');
        const partialDeadline = Math.min(this.deadline, this.ports.now() + LIMITS.partial);
        await this.confirm(1, true);
        // Product partial shutdown enforces drain20 in the bound implementation. The observer
        // proves retirement and additionally bounds successor admission by its original boot60.
        const accepted = await this.step(
          () => this.observer!.waitSuccessor(),
          partialDeadline + LIMITS.boot,
        );
        this.identity = accepted.identity;
        await this.ui('BootRecovery', { deadline: accepted.bootDeadline });
        await this.offline(() => this.ports.verifyRecoveryEntry());
        await this.step(() => this.observer!.assertCurrent());
      }
      const variant = this.scene === 'R' ? 'A' : 'H';
      await this.restore(
        this.scene === 'R' ? 1 : 2,
        this.scene === 'R' ? this.ports.backupA : this.ports.backupH,
        variant,
      );
      const cold = await this.boot('cold', 'BootHealthy');
      await this.read(variant);
      await this.close(cold);
      await this.offline(() => this.ports.verify(variant, true));
      await this.offline(() => this.ports.finalBinding());
      need(this.pending.size === 0 && this.observer.pendingOwned === 0);
      return { scene: this.scene, actions: this.sequence, offlineMs: this.offlineSpent };
    } catch (error) {
      this.stop();
      throw error;
    }
  }
}
