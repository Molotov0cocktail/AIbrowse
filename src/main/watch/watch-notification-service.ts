import type { InAppNotificationDto } from '../../shared/types/watch-ipc';
import type { WatchRule } from '../../shared/types/watch';
import { buildInAppNotification } from './notification-policy';

interface PrivacyProjection {
  eventKind: string;
  importance: 'normal' | 'important';
  itemCount: number;
}

function parsePrivacy(raw: string): PrivacyProjection | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !Object.keys(value).every((key) => ['eventKind', 'importance', 'itemCount'].includes(key))
    )
      return null;
    const v = value as Record<string, unknown>;
    if (
      typeof v['eventKind'] !== 'string' ||
      (v['importance'] !== 'normal' && v['importance'] !== 'important') ||
      typeof v['itemCount'] !== 'number' ||
      !Number.isSafeInteger(v['itemCount']) ||
      v['itemCount'] < 0
    )
      return null;
    return { eventKind: v['eventKind'], importance: v['importance'], itemCount: v['itemCount'] };
  } catch {
    return null;
  }
}

export class WatchNotificationService {
  private draining = false;
  constructor(
    private readonly repository: () => NotificationRepository | null,
    private readonly deliver: (notification: InAppNotificationDto) => boolean,
    private readonly audit: (result: string) => void,
    private readonly channel: 'in-app' | 'windows' = 'in-app',
    private readonly sourceName: (sourceId: string) => string | null = () => null,
  ) {}

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const repo = this.repository();
      if (repo === null) return;
      for (let batch = 0; batch < 10; batch += 1) {
        const pending = repo.listPendingNotifications(this.channel, 20);
        if (pending.length === 0) break;
        for (const row of pending) {
          if (!repo.claimPendingNotification(row.id, new Date().toISOString())) continue;
          const privacy = parsePrivacy(row.privacyJson);
          if (privacy === null) {
            repo.finishClaimedNotification(row.id, 'failed', new Date().toISOString());
            this.audit('failed');
            continue;
          }
          let delivered = false;
          try {
            const rule = row.ruleId === null ? null : repo.getRule(row.ruleId);
            delivered = this.deliver(
              buildInAppNotification({
                notificationId: row.id,
                subjectType: row.subjectType,
                subjectId: row.subjectId,
                accessMode: rule?.accessMode ?? 'public',
                showDetails: rule?.showDetails ?? false,
                importance: privacy.importance,
                sourceName:
                  rule === null
                    ? '来源'
                    : (this.sourceName(rule.sourceId) ?? `信源 ${rule.sourceId.slice(0, 8)}`),
                changeCount: privacy.itemCount,
                fieldLabels: [privacy.eventKind],
                createdAt: row.createdAt,
              }),
            );
          } catch {
            delivered = false;
          }
          repo.finishClaimedNotification(
            row.id,
            delivered ? 'sent' : 'failed',
            new Date().toISOString(),
          );
          this.audit(delivered ? 'sent' : 'failed');
        }
        if (pending.length < 20) break;
      }
    } finally {
      this.draining = false;
    }
  }
}

export interface NotificationRepository {
  listPendingNotifications(
    channel: 'in-app' | 'windows',
    limit: number,
  ): Array<{
    id: string;
    ruleId: string | null;
    subjectType: 'event' | 'digest';
    subjectId: string;
    channel: 'in-app' | 'windows';
    dedupeKey: string;
    privacyJson: string;
    createdAt: string;
  }>;
  claimPendingNotification(id: string, nowIso: string): boolean;
  finishClaimedNotification(id: string, state: 'sent' | 'failed', nowIso: string): boolean;
  getRule(id: string): WatchRule | null;
}
