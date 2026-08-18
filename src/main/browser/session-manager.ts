// Persistent session management: persist: 分区懒加载单例，多 Profile 预留接口.
// Contract source: doc/detailed-design.md §2.4/§7（Q3 决议，定稿）+ §11（权限默认拒绝，安全补丁）.
// 所有 Tab view 共用持久分区 → 重启后 Cookie / 登录状态保留（First_stage.md §九）。

import { session, type Session } from 'electron';
import { logWarn } from '../logger';
import { redactUrlForLog } from '../../shared/url';
import { resolvePermissionCheck, resolvePermissionRequest } from './permission-policy';

export const PERSIST_PARTITION = 'persist:aibrowse';

export interface SessionManager {
  // 本阶段仅 'main'；未来多 Profile（Personal/School/Work）时按 profile 名映射 persist: 分区
  getSession(profile?: string): Session;
}

export class AppSessionManager implements SessionManager {
  private readonly sessions = new Map<string, Session>();

  getSession(profile = 'main'): Session {
    let result = this.sessions.get(profile);
    if (result === undefined) {
      result = session.fromPartition(this.partitionFor(profile));
      this.applySecurityDefaults(result); // 安全补丁：双权限处理器默认拒绝（§11）
      this.sessions.set(profile, result);
    }
    return result;
  }

  // 官方要求 setPermissionRequestHandler 与 setPermissionCheckHandler 同时实现才是完整权限处理
  // （多数 Web API 先走 check、被拒后再走 request）；两者在分区首次创建时注册一次（单例语义），
  // 自动覆盖未来所有 profile 派生分区。策略决策委托 permission-policy 纯函数（默认拒绝，可单测）。
  private applySecurityDefaults(target: Session): void {
    target.setPermissionRequestHandler((wc, permission, callback, details) => {
      // details.requestingUrl 为空时回退到当前 URL（防御：畸形请求同样走默认拒绝 + 日志）
      const requestingUrl = details.requestingUrl !== '' ? details.requestingUrl : wc.getURL();
      const allowed = resolvePermissionRequest(permission, requestingUrl);
      if (!allowed) {
        logWarn(
          'browser',
          `已拒绝网页权限请求（permission=${permission}，来源=${redactUrlForLog(requestingUrl)}）`,
        );
      }
      callback(allowed);
    });
    target.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      // check 先于 request 被调用（官方：多数 Web API 先 check 后 request）；参数保留签名完整
      void wc;
      void details;
      return resolvePermissionCheck(permission, requestingOrigin);
    });
  }

  private partitionFor(profile: string): string {
    // 'main' 使用定稿分区名；未来多 Profile 按 profile 名派生（Personal/School/Work）
    return profile === 'main' ? PERSIST_PARTITION : `${PERSIST_PARTITION}-${profile}`;
  }
}
