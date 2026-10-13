import type { WebFrameMain } from 'electron';

/** Main-process-only capability; never exposed through the browser tool interface. */
export interface DownloadLease {
  readonly token: string;
  isCurrent(): boolean;
}

export interface NativeDownloadSnapshot {
  readonly url: string;
  readonly urlChain: readonly string[];
  readonly filename: string;
  readonly hasUserGesture: boolean;
  readonly initiatorOrigin: string;
}

export interface DownloadGestureTransfer {
  readonly token: string;
  readonly expiresAt: number;
  readonly initialUrl: string;
  readonly referrer: Electron.Referrer;
}

export interface DownloadGestureRecord {
  readonly token: string;
  readonly expiresAt: number;
  readonly generation: number;
  readonly frame: WebFrameMain;
  readonly origin: string;
  readonly initialUrl: string | null;
  navigationStarted: boolean;
  consumed: boolean;
}

export const DOWNLOAD_GESTURE_LIFETIME_MS = 10_000;
