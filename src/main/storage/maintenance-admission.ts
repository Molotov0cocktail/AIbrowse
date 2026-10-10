// A root-operation gate. Accepted work keeps its lease until all owned
// continuations settle; pausing only rejects new roots, never their final writes.
export class MaintenanceAdmission {
  private stopped = false;
  private generation: number | null = null;
  private highestGeneration = 0;
  private drainedGeneration: number | null = null;
  private epoch = 0;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  isOpen(): boolean {
    return !this.stopped && this.generation === null;
  }

  captureEpoch(): number {
    return this.epoch;
  }

  isPausedForMaintenance(generation: number): boolean {
    return !this.stopped && this.generation === generation;
  }

  isCurrent(epoch: number): boolean {
    return this.isOpen() && epoch === this.epoch;
  }

  enter(): (() => void) | null {
    if (!this.isOpen()) return null;
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        for (const resolve of this.waiters.splice(0)) resolve();
      }
    };
  }

  beginShutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.epoch += 1;
    this.drainedGeneration = null;
  }

  drain(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  pauseForMaintenance(generation: number): boolean {
    if (this.stopped || !Number.isSafeInteger(generation) || generation < 1) return false;
    if (this.generation !== null) return this.generation === generation;
    if (generation <= this.highestGeneration) return false;
    this.highestGeneration = generation;
    this.generation = generation;
    this.drainedGeneration = null;
    this.epoch += 1;
    return true;
  }

  async drainForMaintenance(generation: number): Promise<void> {
    this.assertPaused(generation);
    await this.drain();
    this.assertPaused(generation);
    this.drainedGeneration = generation;
  }

  resumeAfterMaintenance(generation: number): boolean {
    if (!this.prepareResumeAfterMaintenance(generation)) return false;
    this.generation = null;
    this.drainedGeneration = null;
    return true;
  }

  prepareResumeAfterMaintenance(generation: number): boolean {
    return !(
      this.stopped ||
      this.generation !== generation ||
      this.drainedGeneration !== generation ||
      this.inFlight !== 0
    );
  }

  private assertPaused(generation: number): void {
    if (this.stopped || this.generation !== generation) throw new Error('维护世代已失效');
  }
}
