import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';

// Electron 43.7.7 emits this main-process event before its public window-open
// handler. Its native callback retains the initiating frame, CSP, referrer,
// sandbox restrictions and original request body. Never reconstruct that request.
const QUALIFIED_ELECTRON_VERSION = '43.7.7';

export interface NativePopupNavigationLease {
  readonly sandboxFlags: number;
  navigate(contents: WebContents): boolean;
}

interface NativeDispatch {
  live: boolean;
  url: string;
  frameName: string;
  disposition: string;
  referrerUrl: string;
  referrerPolicy: string;
  postData: unknown;
  sandboxFlags: number;
  navigate: (contents: WebContents) => void;
}

export class NativePopupNavigation {
  private pending: NativeDispatch | null = null;
  private disposed = false;

  constructor(private readonly contents: WebContents) {
    contents.prependListener('-new-window', this.capture);
  }

  take(details: Electron.HandlerDetails): NativePopupNavigationLease | null {
    const current = this.pending;
    this.pending = null;
    if (
      this.disposed ||
      current === null ||
      !current.live ||
      current.url !== details.url ||
      current.frameName !== details.frameName ||
      current.disposition !== details.disposition ||
      current.referrerUrl !== details.referrer.url ||
      current.referrerPolicy !== details.referrer.policy ||
      (current.postData ?? undefined) !== details.postBody?.data
    ) {
      if (current !== null) current.live = false;
      return null;
    }
    let used = false;
    return {
      sandboxFlags: current.sandboxFlags,
      navigate: (target) => {
        if (used || !current.live || this.disposed || target.isDestroyed()) return false;
        used = true;
        current.live = false;
        current.navigate(target);
        return true;
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pending !== null) this.pending.live = false;
    this.pending = null;
    // The pinned native event is absent from Electron's public overload list.
    EventEmitter.prototype.removeListener.call(this.contents, '-new-window', this.capture);
  }

  private readonly capture = (...args: unknown[]): void => {
    if (this.pending !== null) this.pending.live = false;
    this.pending = null;
    if (
      this.disposed ||
      process.versions.electron !== QUALIFIED_ELECTRON_VERSION ||
      args.length !== 9
    )
      return;
    const [
      event,
      url,
      frameName,
      disposition,
      features,
      referrer,
      postData,
      sandboxFlags,
      navigate,
    ] = args;
    if (
      event === null ||
      typeof event !== 'object' ||
      !('preventDefault' in event) ||
      typeof event.preventDefault !== 'function' ||
      typeof url !== 'string' ||
      typeof frameName !== 'string' ||
      typeof disposition !== 'string' ||
      typeof features !== 'string' ||
      referrer === null ||
      typeof referrer !== 'object' ||
      !('url' in referrer) ||
      typeof referrer.url !== 'string' ||
      !('policy' in referrer) ||
      typeof referrer.policy !== 'string' ||
      (postData != null && !Array.isArray(postData)) ||
      typeof sandboxFlags !== 'number' ||
      !Number.isSafeInteger(sandboxFlags) ||
      sandboxFlags < 0 ||
      sandboxFlags > 0xffffffff ||
      typeof navigate !== 'function'
    )
      return;
    const current: NativeDispatch = {
      live: true,
      url,
      frameName,
      disposition,
      referrerUrl: referrer.url,
      referrerPolicy: referrer.policy,
      postData,
      sandboxFlags,
      navigate: navigate as (contents: WebContents) => void,
    };
    this.pending = current;
    queueMicrotask(() => {
      current.live = false;
      if (this.pending === current) this.pending = null;
    });
  };
}
