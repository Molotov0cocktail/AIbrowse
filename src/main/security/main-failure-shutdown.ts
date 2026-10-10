type FailureReason = 'main-error' | 'ui-unavailable';

interface MainFailureShutdownPorts {
  stopAdmission(): void;
  notify(reason: FailureReason, signal: AbortSignal): void | Promise<void>;
  drain(): Promise<void>;
  hasGuardianFinishStarted?(): boolean;
  finishGuardian(): Promise<void>;
  exit(code: number): void;
}

/** Unknown main failures retire this process; incomplete drain is never normal exit. */
export class MainFailureShutdown {
  private started = false;
  private exited = false;
  private deadline = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private notificationTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly notificationController = new AbortController();

  constructor(private readonly ports: MainFailureShutdownPorts) {}

  isActive(): boolean {
    return this.started;
  }

  begin(reason: FailureReason = 'main-error'): void {
    if (this.started) return;
    this.started = true;
    this.deadline = performance.now() + 10_000;
    this.timer = setTimeout(() => this.exit(), 10_000);
    this.notificationTimer = setTimeout(() => this.notificationController.abort(), 9_000);
    try {
      this.ports.stopAdmission();
    } catch {
      this.exit();
      return;
    }
    if (!this.inTime()) return;
    const signal = this.notificationController.signal;
    if (performance.now() >= this.deadline - 1_000 || this.ports.hasGuardianFinishStarted?.())
      this.notificationController.abort();
    let notification: Promise<void> = Promise.resolve();
    try {
      if (!signal.aborted)
        notification = Promise.resolve(this.ports.notify(reason, signal)).catch(() => undefined);
    } catch {
      // Notification must never prevent owned drain or abnormal process exit.
    }
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = () => resolve();
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', cancelled, { once: true });
    });
    const notified = Promise.race([notification, cancellation]).then(() => {
      clearTimeout(this.notificationTimer);
      signal.removeEventListener('abort', cancelled);
    });
    void (async () => {
      if (!this.inTime()) return;
      await this.ports.drain();
      if (!this.inTime()) return;
      // An existing retirement grace cannot be restarted or spent waiting for its old ack.
      if (this.ports.hasGuardianFinishStarted?.()) {
        this.exit();
        return;
      }
      await notified;
      if (!this.inTime()) return;
      // Guardian grace is for native process retirement, never for waiting on user input.
      if (!this.ports.hasGuardianFinishStarted?.()) await this.ports.finishGuardian();
      if (!this.inTime()) return;
      this.exit();
    })().catch(() => this.exit());
  }

  private inTime(): boolean {
    if (this.exited) return false;
    if (performance.now() < this.deadline) return true;
    this.exit();
    return false;
  }

  private exit(): void {
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this.timer);
    clearTimeout(this.notificationTimer);
    this.notificationController.abort();
    this.ports.exit(1);
  }
}
