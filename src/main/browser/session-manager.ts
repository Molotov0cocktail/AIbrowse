// Persistent session management: persist: 分区懒加载单例，多 Profile 预留接口.
// Contract source: doc/detailed-design.md §2.4/§7（Q3 决议，定稿）.
// 所有 Tab view 共用持久分区 → 重启后 Cookie / 登录状态保留（First_stage.md §九）。

import { session, type Session } from 'electron';

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
      this.sessions.set(profile, result);
    }
    return result;
  }

  private partitionFor(profile: string): string {
    // 'main' 使用定稿分区名；未来多 Profile 按 profile 名派生（Personal/School/Work）
    return profile === 'main' ? PERSIST_PARTITION : `${PERSIST_PARTITION}-${profile}`;
  }
}
