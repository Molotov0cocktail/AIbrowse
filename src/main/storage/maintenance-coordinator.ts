import { randomUUID } from 'node:crypto';
import { MaintenanceAdmission } from './maintenance-admission';

export interface MaintenanceParticipant {
  pauseForMaintenance(generation: number): boolean;
  drainForMaintenance(generation: number): Promise<void>;
  prepareResumeAfterMaintenance(generation: number): boolean;
  resumeAfterMaintenance(generation: number): boolean;
}

export interface MaintenanceTicket {
  readonly operationId: string;
  readonly generation: number;
  readonly deadlineMonoMs: number;
}

export interface OriginalMaintenanceRecoveryOptions {
  operationId: string;
  originalAbsoluteDeadline: number;
  // Main-owned proof: original data, no switch/shutdown and all children exited.
  isCurrent: () => boolean;
}

type Failure =
  | 'busy'
  | 'deadline'
  | 'cancelled'
  | 'participant-failed'
  | 'reconcile-failed'
  | 'resume-failed'
  | 'recovery-rejected'
  | 'shutdown';
export type QuiescenceResult =
  { ok: true; ticket: MaintenanceTicket } | { ok: false; reason: Failure };

interface ActiveMaintenance {
  ticket: MaintenanceTicket;
  phase: 'draining' | 'ready' | 'failed';
  failure: Failure | null;
  pending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  finish: (result: QuiescenceResult) => void;
  completion: Promise<void>;
  complete: () => void;
  recoveryGuard: (() => boolean) | null;
}

// Main-only barrier. It owns no parser, SQL or paths. Native validation has its
// separate utility-process deadline; this timer only revokes permission to proceed.
export class MaintenanceCoordinator {
  readonly admission = new MaintenanceAdmission();
  private generation = 0;
  private active: ActiveMaintenance | null = null;
  private stopped = false;

  constructor(
    private readonly participants: readonly MaintenanceParticipant[],
    private readonly reconcile: (ticket: MaintenanceTicket) => Promise<void>,
    private readonly now: () => number = () => performance.now(),
  ) {}

  acquire(deadlineMonoMs: number): Promise<QuiescenceResult> {
    if (this.stopped) return Promise.resolve({ ok: false, reason: 'shutdown' });
    if (this.active !== null) return Promise.resolve({ ok: false, reason: 'busy' });
    const remaining = deadlineMonoMs - this.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 2_147_483_647) {
      return Promise.resolve({ ok: false, reason: 'deadline' });
    }
    const generation = this.generation + 1;
    if (!Number.isSafeInteger(generation))
      return Promise.resolve({ ok: false, reason: 'shutdown' });
    this.generation = generation;
    return this.begin(generation, deadlineMonoMs, null);
  }

  recoverOriginal(options: OriginalMaintenanceRecoveryOptions): Promise<QuiescenceResult> {
    if (this.stopped) return Promise.resolve({ ok: false, reason: 'shutdown' });
    const original = this.active;
    if (
      original === null ||
      original.phase !== 'failed' ||
      original.pending ||
      original.ticket.operationId !== options.operationId ||
      original.ticket.deadlineMonoMs !== options.originalAbsoluteDeadline ||
      !this.admission.isPausedForMaintenance(original.ticket.generation)
    )
      return Promise.resolve({ ok: false, reason: 'recovery-rejected' });
    const remaining = options.originalAbsoluteDeadline - this.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 2_147_483_647)
      return Promise.resolve({ ok: false, reason: 'deadline' });
    let current = false;
    try {
      current = options.isCurrent() === true;
    } catch {
      /* Reject an unavailable proof. */
    }
    if (this.stopped) return Promise.resolve({ ok: false, reason: 'shutdown' });
    if (
      !current ||
      this.active !== original ||
      original.pending ||
      !this.admission.isPausedForMaintenance(original.ticket.generation)
    )
      return Promise.resolve({ ok: false, reason: 'recovery-rejected' });
    return this.begin(
      original.ticket.generation,
      original.ticket.deadlineMonoMs,
      options.isCurrent,
    );
  }

  private begin(
    generation: number,
    deadlineMonoMs: number,
    recoveryGuard: (() => boolean) | null,
  ): Promise<QuiescenceResult> {
    const remaining = deadlineMonoMs - this.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 2_147_483_647)
      return Promise.resolve({ ok: false, reason: 'deadline' });
    const ticket = Object.freeze({ operationId: randomUUID(), generation, deadlineMonoMs });
    let finish!: (result: QuiescenceResult) => void;
    const result = new Promise<QuiescenceResult>((resolve) => {
      finish = resolve;
    });
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const record: ActiveMaintenance = {
      ticket,
      phase: 'draining',
      failure: null,
      pending: true,
      timer: null,
      finish,
      completion,
      complete,
      recoveryGuard,
    };
    this.active = record;
    let allPaused = this.admission.pauseForMaintenance(generation);
    const paused: MaintenanceParticipant[] = [];
    // Complete the entire synchronous seal before any cancellation callback can run.
    for (const participant of this.participants) {
      try {
        if (participant.pauseForMaintenance(generation)) paused.push(participant);
        else allPaused = false;
      } catch {
        allPaused = false;
      }
    }
    record.timer = setTimeout(() => this.fail(record, 'deadline'), Math.ceil(remaining));
    if (!allPaused) this.fail(record, 'participant-failed');
    void this.drain(record, paused);
    return result;
  }

  status(): {
    phase: 'idle' | 'draining' | 'ready' | 'failed';
    operationId: string | null;
    pending: boolean;
    reason: Failure | null;
  } {
    const current = this.active;
    return current === null
      ? { phase: 'idle', operationId: null, pending: false, reason: null }
      : {
          phase: current.phase,
          operationId: current.ticket.operationId,
          pending: current.pending,
          reason: current.failure,
        };
  }

  cancel(operationId: string): boolean {
    const current = this.active;
    if (
      current === null ||
      current.ticket.operationId !== operationId ||
      (current.phase !== 'draining' && current.phase !== 'ready')
    )
      return false;
    this.fail(current, 'cancelled');
    return true;
  }

  isQuiescent(ticket: MaintenanceTicket): boolean {
    const current = this.active;
    return (
      current !== null &&
      current.ticket === ticket &&
      current.phase === 'ready' &&
      this.valid(current)
    );
  }

  assertCurrentDraining(ticket: MaintenanceTicket): void {
    const current = this.active;
    if (
      current === null ||
      current.ticket !== ticket ||
      current.phase !== 'draining' ||
      !this.valid(current)
    ) {
      throw new Error('维护操作已失效，不能继续协调数据');
    }
  }

  resume(ticket: MaintenanceTicket): boolean {
    const current = this.active;
    if (
      this.stopped ||
      current === null ||
      current.ticket !== ticket ||
      current.phase !== 'ready' ||
      current.pending ||
      !this.valid(current)
    )
      return false;
    // Preparation may read local scheduling metadata. No gate opens on failure.
    try {
      for (const participant of this.participants) {
        if (!this.valid(current)) return false;
        if (!participant.prepareResumeAfterMaintenance(ticket.generation)) {
          this.fail(current, 'resume-failed');
          return false;
        }
      }
      if (!this.valid(current)) return false;
      if (!this.admission.prepareResumeAfterMaintenance(ticket.generation)) {
        this.fail(current, 'resume-failed');
        return false;
      }
      for (const participant of this.participants) {
        if (!this.valid(current)) return false;
        if (!participant.resumeAfterMaintenance(ticket.generation)) {
          this.fail(current, 'resume-failed');
          return false;
        }
      }
      if (!this.valid(current)) return false;
      if (!this.admission.resumeAfterMaintenance(ticket.generation)) {
        this.fail(current, 'resume-failed');
        return false;
      }
    } catch {
      this.fail(current, 'resume-failed');
      return false;
    }
    this.active = null;
    return true;
  }

  shutdown(): void {
    this.stopped = true;
    this.admission.beginShutdown();
    if (this.active !== null) this.fail(this.active, 'shutdown');
  }

  // This is actual work completion, not the early failure/cancellation receipt.
  waitForIdle(): Promise<void> {
    return this.active?.completion ?? Promise.resolve();
  }

  private async drain(
    record: ActiveMaintenance,
    paused: readonly MaintenanceParticipant[],
  ): Promise<void> {
    try {
      const waits = paused.map((participant) => {
        try {
          return participant.drainForMaintenance(record.ticket.generation);
        } catch {
          return Promise.reject(new Error('维护参与者排水失败'));
        }
      });
      waits.push(this.admission.drainForMaintenance(record.ticket.generation));
      const settled = await Promise.allSettled(waits);
      if (settled.some((value) => value.status === 'rejected'))
        this.fail(record, 'participant-failed');
      if (!this.valid(record)) return;
      try {
        await this.reconcile(record.ticket);
      } catch {
        this.fail(record, 'reconcile-failed');
        return;
      }
      if (!this.valid(record)) return;
      record.phase = 'ready';
      this.clearTimer(record);
      if (record.recoveryGuard !== null) {
        // All asynchronous work has settled. Complete every prepare before opening
        // participants, then open the coordinator admission in the same turn.
        record.pending = false;
        if (!this.resume(record.ticket)) {
          this.fail(record, 'resume-failed');
          return;
        }
      }
      record.finish({ ok: true, ticket: record.ticket });
    } finally {
      record.pending = false;
      record.complete();
    }
  }

  private valid(record: ActiveMaintenance): boolean {
    if (this.active !== record || this.stopped || record.failure !== null) return false;
    const now = this.now();
    if (!Number.isFinite(now) || now >= record.ticket.deadlineMonoMs) {
      this.fail(record, 'deadline');
      return false;
    }
    if (record.recoveryGuard !== null) {
      let current = false;
      try {
        current = record.recoveryGuard() === true;
      } catch {
        /* Fail closed. */
      }
      if (this.active !== record || this.stopped || record.failure !== null) return false;
      if (!current) {
        this.fail(record, 'recovery-rejected');
        return false;
      }
      const afterProof = this.now();
      if (!Number.isFinite(afterProof) || afterProof >= record.ticket.deadlineMonoMs) {
        this.fail(record, 'deadline');
        return false;
      }
    }
    return true;
  }

  private clearTimer(record: ActiveMaintenance): void {
    if (record.timer !== null) clearTimeout(record.timer);
    record.timer = null;
  }

  private fail(record: ActiveMaintenance, reason: Failure): void {
    if (record.failure !== null) return;
    record.failure = reason;
    record.phase = 'failed';
    this.clearTimer(record);
    record.finish({ ok: false, reason });
  }
}
