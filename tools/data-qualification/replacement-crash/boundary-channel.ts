export class BoundaryChannel {
  private acknowledge: (() => void) | null = null;

  accept(message: unknown): void {
    if (message !== 'continue' || this.acknowledge === null) return;
    const done = this.acknowledge;
    this.acknowledge = null;
    done();
  }

  async pause(send: () => Promise<void>): Promise<void> {
    if (this.acknowledge !== null) throw new Error('边界协议状态非法');
    const waiting = new Promise<void>((resolve) => {
      this.acknowledge = resolve;
    });
    try {
      await send();
      await waiting;
    } catch (error) {
      this.acknowledge = null;
      throw error;
    }
  }
}
