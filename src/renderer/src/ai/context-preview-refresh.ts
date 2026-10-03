import type { TabInfo, TabsState } from '../../../shared/types/browser';
import type { ContextPreview } from '../../../shared/types/conversation';

interface PreviewRequest {
  revision: number;
}

// Local UI state; unavailable never changes the main-process ContextPreview schema.
export type ContextPreviewState = ContextPreview | 'unavailable' | null;

interface ContextPreviewRefreshOptions {
  read(): Promise<ContextPreview | null>;
  publish(preview: ContextPreviewState): void;
}

// Badge refreshes may coalesce; ask/agent collection never uses this coordinator.
export class ContextPreviewRefresh {
  private readonly pending = new Map<string, PreviewRequest>();
  private active: TabInfo | null = null;
  private hasTabState = false;
  private revision = 0;
  private disposed = false;

  constructor(private readonly options: ContextPreviewRefreshOptions) {}

  updateTabs(state: TabsState): void {
    if (this.disposed) return;
    this.hasTabState = true;
    const liveIds = new Set(state.tabs.map((tab) => tab.id));
    for (const id of this.pending.keys()) {
      if (!liveIds.has(id)) this.pending.delete(id);
    }
    const active = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
    if (active?.id !== this.active?.id || active?.url !== this.active?.url) {
      this.options.publish(null);
    }
    this.active = active;
    this.refresh();
  }

  initialStateUnavailable(): void {
    // Each effect owns one coordinator. Disposed or superseded initial reads
    // cannot replace the state already supplied by a newer tabs event/effect.
    if (!this.disposed && !this.hasTabState) this.options.publish('unavailable');
  }

  refresh(): void {
    if (this.disposed || !this.hasTabState) return;
    this.revision += 1;
    const active = this.active;
    if (active === null) {
      this.options.publish({
        tabId: null,
        url: null,
        title: null,
        readyState: null,
        mode: 'none',
        hasSelection: false,
        selectionLength: 0,
        thin: false,
        degraded: false,
      });
      return;
    }
    if (active.state === 'error') {
      this.options.publish('unavailable');
      return;
    }
    // Electron queues scripts during a main-frame load. Wait for the existing
    // tabs update to report readiness instead of adding another native waiter.
    if (active.state !== 'ready') {
      this.options.publish(null);
      return;
    }
    this.start(active.id);
  }

  dispose(): void {
    this.disposed = true;
    this.active = null;
    this.pending.clear();
  }

  private start(tabId: string): void {
    if (this.pending.has(tabId)) return;
    const request: PreviewRequest = { revision: this.revision };
    this.pending.set(tabId, request);
    void this.collect(tabId, request);
  }

  private isCurrent(tabId: string, request: PreviewRequest): boolean {
    return (
      !this.disposed &&
      this.pending.get(tabId) === request &&
      this.active?.id === tabId &&
      this.active.state === 'ready' &&
      this.revision === request.revision
    );
  }

  private async collect(tabId: string, request: PreviewRequest): Promise<void> {
    try {
      const next = await this.options.read();
      if (this.isCurrent(tabId, request)) {
        // Main may report no active tab after disposal without a tabs push.
        const noActiveTab = next?.tabId === null && next.mode === 'none';
        this.options.publish(next?.tabId === tabId || noActiveTab ? next : 'unavailable');
      }
    } catch {
      // A preview failure says nothing about the fresh collection performed by ask.
      if (this.isCurrent(tabId, request)) this.options.publish('unavailable');
    } finally {
      if (!this.disposed && this.pending.get(tabId) === request) {
        this.pending.delete(tabId);
        if (
          this.active?.id === tabId &&
          this.active.state === 'ready' &&
          this.revision !== request.revision
        ) {
          // A burst retains one dirty revision, not one queued read per event.
          this.start(tabId);
        }
      }
    }
  }
}
