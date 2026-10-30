import type { Session, WebContents } from 'electron';
import { logWarn } from '../logger';

export interface SessionSecurityOptions {
  /**
   * Release and remote-tab sessions keep the secure default. Unpackaged production
   * preview may disable this for its legacy loadFile document and subresources.
   */
  readonly blockFileRequests?: boolean;
}

const installedSessions = new WeakMap<Session, boolean>();
const fullscreenPolicies = new WeakMap<WebContents, (phase: 'check' | 'request') => boolean>();

/** Main-process registration only; no renderer or Session-wide permission grant. */
export function registerFullscreenPolicy(
  contents: WebContents,
  policy: (phase: 'check' | 'request') => boolean,
): () => void {
  fullscreenPolicies.set(contents, policy);
  return () => {
    if (fullscreenPolicies.get(contents) === policy) fullscreenPolicies.delete(contents);
  };
}

function allowFullscreen(
  contents: WebContents | null,
  permission: string,
  url: string,
  phase: 'check' | 'request',
): boolean {
  if (permission !== 'fullscreen' || contents === null) return false;
  try {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      return false;
    return fullscreenPolicies.get(contents)?.(phase) === true;
  } catch {
    return false;
  }
}

/** Applies the same fail-closed capability boundary to every Electron Session. */
export function installSessionSecurity(
  target: Session,
  options: SessionSecurityOptions = {},
): void {
  const blockFileRequests = options.blockFileRequests !== false;
  const installedMode = installedSessions.get(target);
  if (installedMode !== undefined) {
    if (installedMode !== blockFileRequests) {
      throw new Error('同一 Session 不得以不同 file: 策略重复装配');
    }
    return;
  }

  target.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = allowFullscreen(webContents, permission, details.requestingUrl, 'request');
    callback(allowed);
    if (!allowed) logWarn('security', '已拒绝 Session 权限请求');
  });
  target.setPermissionCheckHandler((webContents, permission, origin) =>
    allowFullscreen(webContents, permission, origin, 'check'),
  );

  target.on('will-download', (event) => {
    event.preventDefault();
    logWarn('security', '已取消未授权下载');
  });

  if (blockFileRequests) {
    target.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (_details, callback) => {
      callback({ cancel: true });
    });
  }
  installedSessions.set(target, blockFileRequests);
}
