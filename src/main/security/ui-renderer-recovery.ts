interface UiRendererRecoveryPorts {
  invalidate(): void;
  load(): Promise<void>;
  choose(allowRetry: boolean): Promise<'retry' | 'exit'>;
  exit(): void;
  isAlive(): boolean;
  now(): number;
}

/** Reuses one trusted window and service graph; never replays a business action. */
export class UiRendererRecovery {
  private readonly attempts: number[] = [];
  private state: 'idle' | 'loading' | 'choosing' | 'stopped' = 'idle';
  private epoch = 0;
  private manualUsed = false;
  private manualLoading = false;
  private loadingDeadline = 0;
  private loadFinished = false;
  private documentReady = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ports: UiRendererRecoveryPorts) {}

  crashed(): void {
    if (this.state === 'stopped' || !this.ports.isAlive()) return;
    try {
      this.ports.invalidate();
    } catch {
      this.stop();
      return;
    }
    if (this.state === 'choosing') return;
    this.epoch += 1;
    clearTimeout(this.timer);
    if (this.manualLoading) {
      this.offerChoice(false);
      return;
    }
    const now = this.ports.now();
    while (this.attempts.length > 0 && now - this.attempts[0]! >= 60_000) this.attempts.shift();
    if (this.attempts.length >= 2) {
      this.offerChoice(!this.manualUsed);
      return;
    }
    this.attempts.push(now);
    this.reload(false);
  }

  dispose(): void {
    this.state = 'stopped';
    this.epoch += 1;
    clearTimeout(this.timer);
  }

  /** Called only after main accepts RendererReady for the current document token. */
  rendererReady(): void {
    if (this.state !== 'loading') return;
    this.documentReady = true;
    this.finishLoading(this.epoch);
  }

  private current(epoch: number): boolean {
    return this.state !== 'stopped' && this.epoch === epoch && this.ports.isAlive();
  }

  private reload(manual: boolean): void {
    const epoch = ++this.epoch;
    const deadline = (this.loadingDeadline = this.ports.now() + 10_000);
    this.state = 'loading';
    this.manualLoading = manual;
    this.loadFinished = false;
    this.documentReady = false;
    clearTimeout(this.timer);
    const failed = (): void => this.loadingFailed(epoch);
    this.timer = setTimeout(failed, 10_000);
    const inTime = (): boolean => {
      if (!this.current(epoch)) return false;
      if (this.ports.now() < deadline) return true;
      failed();
      return false;
    };
    // Leave the native crash callback before invoking Electron loadURL.
    void Promise.resolve()
      .then(() => {
        if (!inTime()) return;
        return this.ports.load();
      })
      .then(() => {
        if (!inTime()) return;
        this.loadFinished = true;
        this.finishLoading(epoch);
      }, failed);
  }

  private loadingFailed(epoch: number): void {
    if (this.state !== 'loading' || !this.current(epoch)) return;
    clearTimeout(this.timer);
    this.epoch += 1;
    this.offerChoice(!this.manualLoading && !this.manualUsed);
  }

  private finishLoading(epoch: number): void {
    if (this.state !== 'loading' || !this.current(epoch)) return;
    if (this.ports.now() >= this.loadingDeadline) {
      this.loadingFailed(epoch);
      return;
    }
    if (!this.loadFinished || !this.documentReady) return;
    clearTimeout(this.timer);
    this.state = 'idle';
    this.manualLoading = false;
  }

  private offerChoice(allowRetry: boolean): void {
    const epoch = ++this.epoch;
    this.state = 'choosing';
    this.manualLoading = false;
    clearTimeout(this.timer);
    void Promise.resolve()
      .then(() => (this.current(epoch) ? this.ports.choose(allowRetry) : 'exit'))
      .then(
        (choice) => {
          if (!this.current(epoch)) return;
          if (choice === 'retry' && allowRetry && !this.manualUsed) {
            this.manualUsed = true;
            this.reload(true);
          } else this.stop();
        },
        () => {
          if (this.current(epoch)) this.stop();
        },
      );
  }

  private stop(): void {
    this.dispose();
    this.ports.exit();
  }
}
