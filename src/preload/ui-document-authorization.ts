/** A commit notification only permits one new handshake; main remains the authority. */
export class UiDocumentAuthorization {
  private readonly result: Promise<string | null>;
  private resolve!: (token: string | null) => void;
  private started = false;
  private settled = false;
  private authorized = false;
  private committed = false;
  private waitingForCommit = false;
  private attempts = 0;
  private deadline = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly request: () => Promise<string | null>) {
    this.result = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  open(): Promise<string | null> {
    if (!this.started && !this.settled) {
      this.started = true;
      this.deadline = performance.now() + 10_000;
      this.timer = setTimeout(() => this.finish(null), 10_000);
      this.requestToken();
    }
    return this.result;
  }

  documentCommitted(): void {
    if (this.settled) return;
    this.committed = true;
    if (this.waitingForCommit && this.attempts === 1) this.requestToken();
  }

  isAuthorized(): boolean {
    return this.authorized;
  }

  dispose(): void {
    this.authorized = false;
    this.finish(null);
  }

  private requestToken(): void {
    if (this.settled) return;
    if (this.attempts >= 2 || performance.now() >= this.deadline) {
      this.finish(null);
      return;
    }
    this.attempts += 1;
    this.waitingForCommit = false;
    void Promise.resolve()
      .then(() => {
        if (this.settled || performance.now() >= this.deadline) {
          this.finish(null);
          return null;
        }
        return this.request();
      })
      .then(
        (token) => {
          if (this.settled) return;
          if (performance.now() >= this.deadline) {
            this.finish(null);
            return;
          }
          if (typeof token === 'string') {
            this.finish(token);
            return;
          }
          if (this.attempts === 2) {
            this.finish(null);
            return;
          }
          this.waitingForCommit = true;
          if (this.committed) this.requestToken();
        },
        () => this.finish(null),
      );
  }

  private finish(token: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.authorized = typeof token === 'string';
    clearTimeout(this.timer);
    this.resolve(token);
  }
}
