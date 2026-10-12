export interface NormalQuitPorts {
  closeSnapshotAdmission(): void;
  pendingSnapshots(): number;
  askToStop(count: number, signal: AbortSignal): Promise<'stop' | 'wait'>;
  stopSnapshots(): Promise<void>;
  shutdown(): Promise<void>;
  finish(): Promise<void>;
  isFailureActive(): boolean;
  reportFailure(): void;
}

export class NormalQuitCoordinator {
  private phase: 'idle' | 'draining' | 'finishing' | 'finished' | 'failed' | 'interrupted' = 'idle';
  private prompt: AbortController | null = null;
  private stopping = false;

  constructor(private readonly ports: NormalQuitPorts) {}

  request(): void {
    if (this.ports.isFailureActive()) {
      this.interrupt();
      return;
    }
    if (this.phase === 'idle') {
      this.phase = 'draining';
      try {
        this.ports.closeSnapshotAdmission();
        void this.complete(this.ports.shutdown());
      } catch {
        this.fail();
      }
    }
    if (this.phase !== 'draining' || this.prompt !== null || this.stopping) return;
    const count = this.ports.pendingSnapshots();
    if (count <= 0) return;
    const prompt = new AbortController();
    this.prompt = prompt;
    void this.choose(count, prompt);
  }

  interrupt(): void {
    this.phase = 'interrupted';
    this.prompt?.abort();
  }

  private async choose(count: number, prompt: AbortController): Promise<void> {
    try {
      let choice: 'stop' | 'wait';
      try {
        choice = await this.ports.askToStop(Math.min(1_000_000, count), prompt.signal);
      } catch {
        // A failed native prompt grants no cancellation authority.
        return;
      }
      if (
        choice !== 'stop' ||
        prompt.signal.aborted ||
        this.phase !== 'draining' ||
        this.ports.isFailureActive() ||
        this.ports.pendingSnapshots() <= 0
      )
        return;
      this.stopping = true;
      await this.ports.stopSnapshots();
    } catch {
      this.fail();
    } finally {
      if (this.prompt === prompt) this.prompt = null;
    }
  }

  private async complete(shutdown: Promise<void>): Promise<void> {
    try {
      await shutdown;
      if (this.phase !== 'draining' || this.ports.isFailureActive()) return;
      this.phase = 'finishing';
      this.prompt?.abort();
      await this.ports.finish();
      if (this.phase === 'finishing') this.phase = 'finished';
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    if (this.phase === 'failed' || this.phase === 'interrupted') return;
    this.phase = 'failed';
    this.prompt?.abort();
    this.ports.reportFailure();
  }
}

export function snapshotQuitMessage(count: number, signal: AbortSignal) {
  return {
    type: 'question' as const,
    title: '退出 AIbrowse',
    message: `仍有 ${Math.min(1_000_000, Math.max(0, Math.floor(count)))} 个页面快照请求尚未完成`,
    detail:
      '停止会关闭相关页面并取消这些快照请求，随后正常完成数据保存并退出。选择继续等待后，可再次关闭窗口重新选择。',
    buttons: ['停止快照并退出', '继续等待'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    signal,
  };
}
