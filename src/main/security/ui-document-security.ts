import type { WebContents } from 'electron';
import { resolveUiNavigationAllowed, type UiNavigationPolicy } from '../ui-navigation-policy';
import { UiDocumentGuard } from './ui-document-guard';
import { IPC } from '../../shared/types/ipc';

interface UiDocumentSecurityOptions {
  entry: string;
  policy: UiNavigationPolicy;
  onDenied?(kind: 'navigation' | 'redirect' | 'frame' | 'window', url?: string): void;
  onRecovery?(): void;
  onRecoveryFailed(): void;
}

/** Product and Electron qualification share the exact document lifecycle wiring. */
export function installUiDocumentSecurity(
  contents: WebContents,
  options: UiDocumentSecurityOptions,
): UiDocumentGuard {
  const guard = new UiDocumentGuard(options.entry);
  let recoveries = 0;
  const identity = () => ({ owner: contents, frame: contents.mainFrame, url: contents.getURL() });
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) guard.beginNavigation();
  });
  contents.on('did-frame-navigate', (_event, url, _code, _status, isMainFrame) => {
    if (!isMainFrame) return;
    const committed = { owner: contents, frame: contents.mainFrame, url };
    guard.commit(committed);
    if (guard.token(committed) !== null) {
      contents.send(IPC.UiDocumentReady);
      return;
    }
    if (recoveries >= 1) return;
    recoveries += 1;
    options.onRecovery?.();
    // Stopping during this native callback can crash Chromium; queue a fixed reload.
    setImmediate(() => {
      if (!contents.isDestroyed()) {
        void contents.loadURL(options.entry).catch(() => options.onRecoveryFailed());
      }
    });
  });
  contents.on('will-navigate', (details) => {
    if (resolveUiNavigationAllowed(details.url, options.policy)) return;
    details.preventDefault();
    guard.rejectNavigation(identity());
    options.onDenied?.('navigation', details.url);
  });
  contents.on('will-redirect', (details) => {
    if (resolveUiNavigationAllowed(details.url, options.policy)) return;
    details.preventDefault();
    guard.rejectNavigation(identity());
    options.onDenied?.('redirect', details.url);
  });
  contents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    details.preventDefault();
    options.onDenied?.('frame', details.url);
  });
  contents.setWindowOpenHandler(() => {
    options.onDenied?.('window');
    return { action: 'deny' };
  });
  contents.on('render-process-gone', () => guard.invalidate());
  contents.once('destroyed', () => guard.invalidate());
  return guard;
}
