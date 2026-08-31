import { describe, expect, it } from 'vitest';
import {
  WatchNotificationService,
  type NotificationRepository,
} from './watch-notification-service';

describe('D9 notification outbox drain', () => {
  it('pending 先 claim 为 uncertain，成功后 sent；重复 drain 不二次发送', async () => {
    let state: 'pending' | 'uncertain' | 'sent' = 'pending';
    let deliveries = 0;
    const repo: NotificationRepository = {
      listPendingNotifications: () =>
        state === 'pending'
          ? [
              {
                id: '00000000-0000-4000-8000-000000000001',
                ruleId: null,
                subjectType: 'event',
                subjectId: '00000000-0000-4000-8000-000000000002',
                channel: 'in-app',
                dedupeKey: 'in-app|event|id|1',
                privacyJson: '{"eventKind":"changed","importance":"normal","itemCount":1}',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            ]
          : [],
      claimPendingNotification: () => {
        if (state !== 'pending') return false;
        state = 'uncertain';
        return true;
      },
      finishClaimedNotification: (_id, next) => {
        if (state !== 'uncertain') return false;
        state = next as 'sent';
        return true;
      },
      getRule: () => null,
    };
    const service = new WatchNotificationService(
      () => repo,
      () => {
        deliveries += 1;
        return true;
      },
      () => undefined,
    );
    await service.drain();
    await service.drain();
    expect(state).toBe('sent');
    expect(deliveries).toBe(1);
  });

  it('无订阅 delivery 失败后闭合为 failed，不重放 uncertain', async () => {
    let finished = '';
    const repo: NotificationRepository = {
      listPendingNotifications: () => [
        {
          id: '00000000-0000-4000-8000-000000000001',
          ruleId: null,
          subjectType: 'event',
          subjectId: '00000000-0000-4000-8000-000000000002',
          channel: 'in-app',
          dedupeKey: 'k',
          privacyJson: '{"eventKind":"changed","importance":"important","itemCount":2}',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      claimPendingNotification: () => true,
      finishClaimedNotification: (_id, state) => {
        finished = state;
        return true;
      },
      getRule: () => null,
    };
    await new WatchNotificationService(
      () => repo,
      () => false,
      () => undefined,
    ).drain();
    expect(finished).toBe('failed');
  });
});
