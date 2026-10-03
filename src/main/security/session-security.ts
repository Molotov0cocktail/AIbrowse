import type { Session } from 'electron';
import { logWarn } from '../logger';

export interface SessionSecurityOptions {
  /**
   * Release and remote-tab sessions keep the secure default. Unpackaged production
   * preview may disable this for its legacy loadFile document and subresources.
   */
  readonly blockFileRequests?: boolean;
}

const installedSessions = new WeakMap<Session, boolean>();

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

  target.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
    logWarn('security', '已拒绝 Session 权限请求');
  });
  target.setPermissionCheckHandler(() => false);

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
