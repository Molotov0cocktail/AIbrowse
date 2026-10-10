type NativeNotificationEvent = 'show' | 'click' | 'failed' | 'close';
type NativeNotificationListener = (event?: unknown) => void;

export interface NativeNotificationLike {
  on(event: NativeNotificationEvent, listener: NativeNotificationListener): void;
  removeListener(event: NativeNotificationEvent, listener: NativeNotificationListener): void;
  show(): void;
  close(): void;
}

export interface WindowsNotificationFactory {
  create(options: { title: string; body: string; silent: boolean }): NativeNotificationLike;
}

interface RetainedNotification {
  native: NativeNotificationLike;
  retire(): boolean;
}

export class WindowsNotificationSink {
  private readonly retained = new Set<RetainedNotification>();
  private disposed = false;

  constructor(
    private readonly factory: WindowsNotificationFactory,
    private readonly route: (subjectType: 'event' | 'digest', subjectId: string) => void,
    private readonly audit: (result: 'shown' | 'failed' | 'clicked') => void,
    private readonly captureRouteGuard: () => () => boolean = () => () => true,
  ) {}

  show(input: {
    subjectType: 'event' | 'digest';
    subjectId: string;
    title: string;
    body: string;
    important: boolean;
  }): boolean {
    if (this.disposed) return false;
    if (this.retained.size >= 200) {
      this.report('failed');
      return false;
    }
    let retained: RetainedNotification | null = null;
    try {
      const canRoute = this.captureRouteGuard();
      const native = this.factory.create({
        title: input.title,
        body: input.body,
        silent: !input.important,
      });
      let active = true;
      let shown = false;
      let failed = false;
      const listeners: Array<[NativeNotificationEvent, NativeNotificationListener]> = [];
      const entry: RetainedNotification = {
        native,
        retire: () => {
          if (!active) return false;
          active = false;
          this.retained.delete(entry);
          for (const [event, listener] of listeners) native.removeListener(event, listener);
          return true;
        },
      };
      retained = entry;
      this.retained.add(entry);
      const listen = (
        event: NativeNotificationEvent,
        listener: NativeNotificationListener,
      ): void => {
        listeners.push([event, listener]);
        native.on(event, listener);
      };
      listen('show', () => {
        if (!active || this.disposed || shown) return;
        shown = true;
        this.report('shown');
      });
      listen('failed', () => {
        if (!entry.retire()) return;
        failed = true;
        this.report('failed');
      });
      listen('click', () => {
        if (!entry.retire() || this.disposed) return;
        try {
          if (!canRoute()) return;
          this.route(input.subjectType, input.subjectId);
          this.report('clicked');
        } catch {
          this.report('failed');
        }
      });
      listen('close', (event) => {
        if (!active || this.disposed || typeof event !== 'object' || event === null) return;
        const reason = 'reason' in event ? event.reason : undefined;
        // A timed-out banner remains clickable in Notification Center.
        if (reason === 'userCanceled' || reason === 'applicationHidden') entry.retire();
      });
      if (this.disposed) {
        entry.retire();
        native.close();
        return false;
      }
      native.show();
      return !failed;
    } catch {
      if (retained === null || retained.retire()) this.report('failed');
      try {
        retained?.native.close();
      } catch {
        // Cleanup never revives callbacks or changes a claimed terminal result.
      }
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of [...this.retained]) {
      entry.retire();
      try {
        entry.native.close();
      } catch {
        // Process shutdown still owns native teardown if close itself fails.
      }
    }
  }

  private report(result: 'shown' | 'failed' | 'clicked'): void {
    if (this.disposed) return;
    this.audit(result);
  }
}
