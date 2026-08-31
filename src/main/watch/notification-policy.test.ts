import { describe, expect, it } from 'vitest';
import { buildInAppNotification } from './notification-policy';

const id = '11111111-1111-4111-8111-111111111111';

describe('D9 NotificationPolicy', () => {
  it('session 默认固定泛化且不泄露敌手详情', () => {
    const out = buildInAppNotification({
      notificationId: id,
      subjectType: 'event',
      subjectId: id,
      accessMode: 'session',
      showDetails: false,
      importance: 'important',
      sourceName: '<script>token?q=secret</script>',
      changeCount: 2,
      fieldLabels: ['Authorization', 'Cookie'],
      createdAt: '2026-08-31T00:00:00.000Z',
    });
    expect(out.title).toBe('AIbrowse 监控提醒');
    expect(out.body).toBe('受保护来源发生变化');
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('dedupe key 仅由闭合身份字段组成', () => {
    const out = buildInAppNotification({
      notificationId: id,
      subjectType: 'digest',
      subjectId: id,
      accessMode: 'public',
      showDetails: true,
      importance: 'normal',
      sourceName: '示例\n来源',
      changeCount: 3,
      fieldLabels: ['价格\u202e', '<img onerror>'],
      createdAt: '2026-08-31T00:00:00.000Z',
    });
    expect(out.dedupeKey).toBe(`in-app|digest|${id}|1`);
    expect(out.body).not.toMatch(/[\r\n\u202e]/u);
  });
});
